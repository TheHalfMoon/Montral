#!/usr/bin/env node
// Multi-node infrastructure qualification for the self-hosted Node build, on real disposable containers:
//   PostgreSQL 17 primary + streaming replica (synchronous commit), Toxiproxy between Montral and the database.
//   A. Network partition: the database path is black-holed for 45 s (connections hang, no RST). Montral keeps
//      serving, opens no false incident, and resumes checks when the path heals.
//   B. Primary failure + replica promotion: the primary is killed, the replica promoted and the proxy repointed.
//      Montral reconnects without a restart; every committed incident is on the promoted node (synchronous
//      replication), the open incident is the same row, no duplicate is created, and recovery resolves it.
// Requires Docker and the built server (apps/api/dist/server.mjs). Run in CI only; it creates and removes its
// own containers and network, all prefixed montral-fo-.
import { execFileSync, spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { createServer } from "node:http";
import { resolve } from "node:path";
import postgres from "../packages/db-pg/node_modules/postgres/src/index.js";

const sh = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeout) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}` + (last ? ` (${last.message})` : ""));
}
const freePort = () => new Promise((ok, fail) => {
  const s = createTcp();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});
// Scheduler bounds: 30 s tick + up to 40 s per-monitor queue slot + 10 s interval, plus margin.
const CHECK_WINDOW_MS = 110_000;
const NET = "montral-fo-net";
const PW = "montral-failover-only";
const toxi = (path, method = "GET", body) => fetch(`http://127.0.0.1:${toxiPort}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { if (!r.ok) throw new Error(`toxiproxy ${method} ${path}: ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.json(); });

const toxiPort = await freePort();
const proxyPort = await freePort();
const primaryPort = await freePort();
const replicaPort = await freePort();
const cleanup = () => {
  for (const c of ["montral-fo-proxy", "montral-fo-replica", "montral-fo-primary"]) { try { sh(["rm", "-f", c]); } catch {} }
  try { sh(["network", "rm", NET]); } catch {}
};
cleanup();

// ── controllable monitoring target ────────────────────────────────────────────
let mode = "up";
const target = createServer((_, res) => { res.statusCode = mode === "up" ? 200 : 503; res.end(mode); });
await new Promise((r) => target.listen(0, "0.0.0.0", r));
const targetUrl = `http://127.0.0.1:${target.address().port}/health`;

// Same image for primary and replica; CI runs the oldest supported major and the one docker-compose.yml ships.
const PG_IMAGE = process.env.MONTRAL_FAILOVER_PG_IMAGE || "postgres:17";
let child;
let log = "";
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
const summary = [];
try {
  sh(["network", "create", NET]);
  // primary: replication enabled; any standby may connect with the same credentials
  sh(["run", "-d", "--name", "montral-fo-primary", "--network", NET, "-p", `127.0.0.1:${primaryPort}:5432`,
    "-e", `POSTGRES_PASSWORD=${PW}`, "-e", "POSTGRES_USER=montral", "-e", "POSTGRES_DB=montral_test_failover",
    PG_IMAGE, "-c", "wal_level=replica", "-c", "max_wal_senders=5", "-c", "hot_standby=on", "-c", "wal_keep_size=256MB"]);
  const primaryUrl = `postgres://montral:${PW}@127.0.0.1:${primaryPort}/montral_test_failover`;
  const primary = postgres(primaryUrl, { max: 1, onnotice: () => {} });
  await until("primary ready", async () => (await primary`select 1 as ok`)[0].ok === 1, 60_000);
  sh(["exec", "montral-fo-primary", "bash", "-c", "echo 'host replication all all scram-sha-256' >> \"$PGDATA/pg_hba.conf\""]);
  await primary`select pg_reload_conf()`;

  // replica: base backup with -R (standby.signal + primary_conninfo), then run as a hot standby
  sh(["run", "-d", "--name", "montral-fo-replica", "--network", NET, "-p", `127.0.0.1:${replicaPort}:5432`,
    "-e", `PGPASSWORD=${PW}`, "--user", "postgres", "--entrypoint", "bash", PG_IMAGE, "-c",
    "rm -rf /tmp/pgdata && until pg_basebackup -h montral-fo-primary -U montral -D /tmp/pgdata -R -X stream -d 'application_name=montral_replica'; do sleep 1; done && chmod 700 /tmp/pgdata && exec postgres -D /tmp/pgdata -c hot_standby=on"]);
  await until("replica streaming", async () => (await primary`select count(*)::int as n from pg_stat_replication where state = 'streaming'`)[0].n === 1, 90_000);
  // synchronous commit: a commit returns only once the standby has it, so promotion loses no committed row
  await primary`alter system set synchronous_standby_names = 'montral_replica'`;
  await primary`select pg_reload_conf()`;
  await until("replica synchronous", async () => (await primary`select sync_state from pg_stat_replication`)[0]?.sync_state === "sync", 30_000);
  // Negative control: with the standby paused, a commit on the primary must not be acknowledged.
  await primary`create table if not exists failover_probe (id serial primary key, at timestamptz default now())`;
  sh(["pause", "montral-fo-replica"]);
  const pending = primary`insert into failover_probe default values returning id`.then(() => "acknowledged", (e) => "failed: " + e.message);
  const early = await Promise.race([pending, sleep(4000).then(() => "waiting")]);
  sh(["unpause", "montral-fo-replica"]);
  if (early !== "waiting") throw new Error("a commit was acknowledged without the synchronous standby (" + early + ")");
  if ((await pending) !== "acknowledged") throw new Error("the commit did not complete once the standby resumed");
  summary.push("setup: primary + synchronous streaming replica (a commit waits for the standby: verified by pausing it)");

  // toxiproxy in front of the primary
  sh(["run", "-d", "--name", "montral-fo-proxy", "--network", NET, "-p", `127.0.0.1:${toxiPort}:8474`, "-p", `127.0.0.1:${proxyPort}:6432`,
    "ghcr.io/shopify/toxiproxy:2.9.0"]);
  await until("toxiproxy api", () => toxi("/version").then(() => true), 30_000);
  await toxi("/proxies", "POST", { name: "pg", listen: "0.0.0.0:6432", upstream: "montral-fo-primary:5432", enabled: true });
  const viaProxy = `postgres://montral:${PW}@127.0.0.1:${proxyPort}/montral_test_failover`;

  // Montral on the proxied connection
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
    env: { ...process.env, DATABASE_URL: viaProxy, PORT: String(port), BIND_HOST: "127.0.0.1", WEB_ORIGIN: base, BETTER_AUTH_URL: base,
      WEB_DIST: resolve("apps/web/dist-missing-on-purpose"), BETTER_AUTH_SECRET: "montral-failover-qualification-only-secret",
      CRON_SECRET: "montral-failover-qualification-cron-only", DISABLE_SIGNUP: "true", ALLOW_PRIVATE_TARGETS: "true", SMTP_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [child.stdout, child.stderr]) { s.setEncoding("utf8"); s.on("data", (c) => { if (!/severity_local|routine:|file: '|line: '|code: '|^\s*[{}]/m.test(c)) log = (log + c).slice(-8000); }); }
  // /health answers without the database; a lookup of a page that does not exist needs a working database (404 vs 5xx)
  const healthy = () => fetch(base + "/api/public/status/failover-probe-none/summary", { signal: AbortSignal.timeout(3000) }).then((r) => r.status === 404, () => false);
  await until("server healthy", healthy, 60_000);

  const orgId = "failover-qa-" + crypto.randomUUID();
  await primary`insert into organization (id, name, slug, created_at) values (${orgId}, 'Failover QA', ${orgId}, now())`;
  const [project] = await primary`insert into project (organization_id, name) values (${orgId}, 'Failover QA') returning id`;
  const [{ id: monitorId }] = await primary`
    insert into monitor (organization_id, project_id, name, type, target, interval_sec, timeout_ms, failure_threshold, next_check_at)
    values (${orgId}, ${project.id}, 'Failover target', 'http', ${targetUrl}, 10, 5000, 1, now()) returning id`;
  const okResults = async (db) => (await db`select count(*)::int as n from check_result where monitor_id = ${monitorId} and ok`)[0].n;
  const incidentsOn = (db) => db`select id, resolved_at from incident where monitor_id = ${monitorId} and auto order by started_at`;
  await until("first successful check", async () => (await okResults(primary)) > 0, CHECK_WINDOW_MS);

  // ── A. network partition ────────────────────────────────────────────────────
  const okBeforePartition = await okResults(primary);
  // timeout toxic with timeout 0: data stops flowing in both directions and connections hang (a black hole)
  await toxi("/proxies/pg/toxics", "POST", { name: "blackhole_down", type: "timeout", stream: "downstream", attributes: { timeout: 0 } });
  await toxi("/proxies/pg/toxics", "POST", { name: "blackhole_up", type: "timeout", stream: "upstream", attributes: { timeout: 0 } });
  const partitionEnd = Date.now() + 45_000; // spans a scheduler tick
  await sleep(5000);
  // read directly from the primary (not through the proxy): nothing may be written while the path is black-holed
  const duringStart = await okResults(primary);
  let dbAnswered = false;
  while (Date.now() < partitionEnd) {
    if (exited(child)) throw new Error("server exited during the network partition: " + log);
    if (await healthy()) dbAnswered = true;
    await sleep(2000);
  }
  const duringEnd = await okResults(primary);
  if (duringEnd !== duringStart) throw new Error(`checks were recorded through a black-holed path (${duringStart} -> ${duringEnd}): the partition did not take effect`);
  if (dbAnswered) throw new Error("a database-backed request succeeded during the partition: the partition did not take effect");
  await toxi("/proxies/pg/toxics/blackhole_down", "DELETE");
  await toxi("/proxies/pg/toxics/blackhole_up", "DELETE");
  if (exited(child)) throw new Error("server exited when the partition healed");
  await until("health after partition", healthy, 30_000);
  await until("checks resume after partition", async () => (await okResults(primary)) > okBeforePartition, CHECK_WINDOW_MS);
  if ((await incidentsOn(primary)).length !== 0) throw new Error("a network partition opened an incident for a healthy target");
  summary.push("A: 45 s black-holed database path (verified: no writes and no database-backed answers during it) survived; checks resumed; no false incident");

  // an outage incident, committed on the primary (and, synchronously, on the replica)
  mode = "down";
  await until("outage incident open", async () => (await incidentsOn(primary)).some((i) => !i.resolved_at), CHECK_WINDOW_MS);
  const [openBefore] = (await incidentsOn(primary)).filter((i) => !i.resolved_at);
  const resultsBefore = (await primary`select count(*)::int as n from check_result where monitor_id = ${monitorId}`)[0].n;

  // ── B. primary failure and replica promotion ────────────────────────────────
  sh(["kill", "montral-fo-primary"]);
  await primary.end({ timeout: 1 }).catch(() => {});
  const replicaUrl = `postgres://montral:${PW}@127.0.0.1:${replicaPort}/montral_test_failover`;
  const promoted = postgres(replicaUrl, { max: 1, onnotice: () => {} });
  await promoted`select pg_promote(true, 60)`;
  await until("replica promoted", async () => (await promoted`select pg_is_in_recovery() as r`)[0].r === false, 60_000);
  // Every row committed before the failure is on the promoted node (synchronous replication).
  const replicated = await incidentsOn(promoted);
  if (!replicated.some((i) => i.id === openBefore.id && !i.resolved_at)) throw new Error("open incident missing on the promoted replica");
  const resultsOnReplica = (await promoted`select count(*)::int as n from check_result where monitor_id = ${monitorId}`)[0].n;
  if (resultsOnReplica < resultsBefore) throw new Error(`committed check results lost in failover: ${resultsOnReplica} < ${resultsBefore}`);
  await toxi("/proxies/pg", "POST", { upstream: "montral-fo-replica:5432", enabled: true });
  const failoverAt = Date.now();
  if (exited(child)) throw new Error("server exited during failover: " + log);
  await until("health after failover", healthy, 60_000);
  // writes reach the new primary: failing checks keep being recorded, still one open incident
  await until("checks recorded on the promoted primary", async () => (await promoted`select count(*)::int as n from check_result where monitor_id = ${monitorId}`)[0].n > resultsOnReplica, CHECK_WINDOW_MS);
  const during = (await incidentsOn(promoted)).filter((i) => !i.resolved_at);
  if (during.length !== 1 || during[0].id !== openBefore.id) throw new Error("failover changed the open incident set");
  mode = "up";
  await until("incident resolved on the promoted primary", async () => (await incidentsOn(promoted)).every((i) => i.resolved_at), CHECK_WINDOW_MS);
  const all = await incidentsOn(promoted);
  if (all.length !== 1) throw new Error("expected exactly one incident across the failover, found " + all.length);
  if (exited(child)) throw new Error("server exited after failover");
  summary.push(`B: primary killed, replica promoted, no committed row lost; server reconnected without restart and wrote to the new primary within ${Math.round((Date.now() - failoverAt) / 1000)} s; same single incident resolved`);
  await promoted.end({ timeout: 1 });

  for (const line of summary) console.log(line);
  console.log(`FAILOVER_PASS: network partition and primary promotion qualified on real PostgreSQL primary/replica containers (${PG_IMAGE})`);
} catch (error) {
  console.error("server log tail:\n" + log.split("\n").slice(-30).join("\n"));
  try { console.error("primary logs:\n" + sh(["logs", "--tail", "20", "montral-fo-primary"])); } catch {}
  try { console.error("replica logs:\n" + sh(["logs", "--tail", "20", "montral-fo-replica"])); } catch {}
  throw error;
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  target.close();
  cleanup();
}
