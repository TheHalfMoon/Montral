#!/usr/bin/env node
// Real-process crash and database-loss recovery qualification for the
// self-hosted Node build. Graceful SIGTERM is covered elsewhere; this script
// proves the cases a clean shutdown does not:
//   A. SIGKILL while a check is in flight: the abandoned claim is retried
//      after restart and the monitor reaches the correct state.
//   B. SIGKILL during an outage: restart does not open a duplicate incident,
//      and recovery resolves the single open one.
//   C. Database connections are killed and refused for a while: the running
//      process keeps serving and checking once PostgreSQL accepts again.
// Uses only a disposable local PostgreSQL database and a local HTTP target.
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { createServer } from "node:http";
import { resolve } from "node:path";
import postgres from "../packages/db-pg/node_modules/postgres/src/index.js";

const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL database");
const dbUrl = new URL(connection);
if (!["127.0.0.1", "localhost"].includes(dbUrl.hostname) || !/^\/montral_test_[a-zA-Z0-9_]+$/.test(dbUrl.pathname)) {
  throw new Error("Crash qualification refuses any non-local or non-disposable database");
}
const dbName = dbUrl.pathname.slice(1);
// Scheduler bounds (apps/api/src/server.ts and scheduler.ts): a 30 s tick, then
// a stable per-monitor queue slot delay of up to 5 x 8 s, then the 10 s interval
// below. Any check is therefore due, queued and started within this window.
const CHECK_WINDOW_MS = (30 + 40 + 10 + 20) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeout) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}` + (last ? ` (${last.message})` : ""));
}
const freePort = () => new Promise((ok, fail) => {
  const s = createTcp();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});

// ── controllable monitoring target ────────────────────────────────────────────
let mode = "up"; // up | down | hang
let requests = 0;
const requestTimes = [];
const hung = new Set();
const target = createServer((req, res) => {
  requests++;
  requestTimes.push(Date.now());
  if (mode === "hang") { hung.add(res); res.on("close", () => hung.delete(res)); return; }
  res.statusCode = mode === "up" ? 200 : 503;
  res.end(mode);
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const targetUrl = `http://127.0.0.1:${target.address().port}/health`;
const setMode = (m) => { mode = m; for (const res of hung) res.destroy(); };

// ── disposable fixtures ───────────────────────────────────────────────────────
const sql = postgres(connection, { max: 2, onnotice: () => {} });
const admin = postgres({ ...pgOptions(dbUrl), database: "postgres", max: 1, onnotice: () => {} });
function pgOptions(u) {
  return { host: u.hostname, port: Number(u.port || 5432), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let child;
let log = "";
const spawned = [];
function spawnServer(p) {
  const origin = `http://127.0.0.1:${p}`;
  const proc = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
    env: {
      ...process.env,
      DATABASE_URL: connection,
      PORT: String(p),
      BIND_HOST: "127.0.0.1",
      WEB_ORIGIN: origin,
      BETTER_AUTH_URL: origin,
      WEB_DIST: resolve("apps/web/dist-missing-on-purpose"),
      BETTER_AUTH_SECRET: "montral-crash-qualification-only-never-production",
      CRON_SECRET: "montral-crash-qualification-cron-only",
      DISABLE_SIGNUP: "true",
      ALLOW_PRIVATE_TARGETS: "true",
      SMTP_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc); // killed in finally even if startup never completes
  let exited = null;
  proc.once("exit", (code, signal) => { exited = { code, signal }; });
  for (const s of [proc.stdout, proc.stderr]) {
    s.setEncoding("utf8");
    // PostgreSQL NOTICE objects from idempotent migrations are noise here.
    s.on("data", (c) => { if (!/severity_local|routine:|file: '|line: '|code: '|^\s*[{}]/m.test(c)) log = (log + `[${p}] ` + c).slice(-6000); });
  }
  const deadline = Date.now() + 40_000;
  return (async () => {
    while (Date.now() < deadline) {
      // A crash at startup fails immediately instead of after the timeout.
      if (exited) throw new Error(`server on ${p} exited during startup ${JSON.stringify(exited)}: ${log}`);
      const ok = await fetch(origin + "/health", { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
      if (ok) return proc;
      await sleep(250);
    }
    throw new Error(`server on ${p} did not become healthy within 40s: ${log}`);
  })();
}
async function startServer() {
  log = "";
  child = await spawnServer(port);
}
async function sigkill() {
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  child.kill("SIGKILL");
  const exit = await exited;
  if (exit.signal !== "SIGKILL") throw new Error("server was not killed by SIGKILL: " + JSON.stringify(exit));
}

const orgId = "crash-qa-" + crypto.randomUUID();
let monitorId;
let second;
const summary = [];
try {
  // The server applies migrations on start; fixtures are inserted after that.
  await startServer();
  await sql`insert into organization (id, name, slug, created_at) values (${orgId}, 'Crash QA', ${orgId}, now())`;
  const [project] = await sql`insert into project (organization_id, name) values (${orgId}, 'Crash QA') returning id`;
  // Interval 10 s against a 30 s scheduler tick: every tick finds it due.
  // A long timeout keeps a hung check in flight long enough to kill it.
  [{ id: monitorId }] = await sql`
    insert into monitor (organization_id, project_id, name, type, target, interval_sec, timeout_ms, failure_threshold, next_check_at)
    values (${orgId}, ${project.id}, 'Crash QA target', 'http', ${targetUrl}, 10, 25000, 1, now())
    returning id`;
  const results = () => sql`select ok, checked_at from check_result where monitor_id = ${monitorId} order by checked_at`;
  const monitor = async () => (await sql`select status, run_generation, last_run_generation, next_check_at from monitor where id = ${monitorId}`)[0];
  const incidents = () => sql`select id, resolved_at from incident where monitor_id = ${monitorId} and auto order by started_at`;

  if (!process.env.CRASH_QA_ONLY_D) {
  // ── A. SIGKILL with a check in flight ──────────────────────────────────────
  setMode("hang");
  const before = requests;
  await until("a check to reach the hung target", () => requests > before, CHECK_WINDOW_MS);
  const inflight = await monitor();
  if (inflight.last_run_generation < 1) throw new Error("check began without recording its run generation");
  const resultsBeforeKill = (await results()).length;
  await sigkill();
  setMode("up");
  if ((await results()).length !== resultsBeforeKill) throw new Error("a killed in-flight check still recorded a result");
  const restartedAt = Date.now();
  await startServer();
  // The abandoned claim already advanced next_check_at by one interval; a tick
  // after restart must pick the monitor up again (after its slot delay)
  // without any operator action.
  await until("first successful check after SIGKILL restart", async () => (await results()).some((r) => r.ok), CHECK_WINDOW_MS);
  // The result row is written before the status update (separate steps by
  // design; an interrupted step is redone by the next check), so wait for it.
  const afterA = await until("monitor status up after recovery", async () => { const m = await monitor(); return m.status === "up" && m; }, 15_000);
  if (afterA.last_run_generation <= inflight.last_run_generation) throw new Error("no newer run generation after restart");
  const firstRetry = requestTimes.find((t) => t >= restartedAt);
  summary.push(`A: in-flight check killed, no result recorded; retried ${Math.round((firstRetry - restartedAt) / 1000)}s after restart and up (bound ${CHECK_WINDOW_MS / 1000}s)`);

  // ── B. SIGKILL during an outage: exactly one incident ─────────────────────
  setMode("down");
  await until("auto incident opened for the outage", async () => (await incidents()).some((i) => !i.resolved_at), CHECK_WINDOW_MS);
  const opened = (await incidents()).filter((i) => !i.resolved_at);
  if (opened.length !== 1) throw new Error("expected one open auto incident, found " + opened.length);
  // Kill while the next outage check is in flight, then keep failing.
  setMode("hang");
  const beforeB = requests;
  await until("an outage check in flight", () => requests > beforeB, CHECK_WINDOW_MS);
  await sigkill();
  setMode("down");
  await startServer();
  const failuresAfterRestart = (await results()).filter((r) => !r.ok).length;
  await until("another failed check after restart", async () => (await results()).filter((r) => !r.ok).length > failuresAfterRestart, CHECK_WINDOW_MS);
  const stillOpen = (await incidents()).filter((i) => !i.resolved_at);
  if (stillOpen.length !== 1 || stillOpen[0].id !== opened[0].id) throw new Error("restart during an outage changed the open incident set");
  await until("monitor down during the continuing outage", async () => (await monitor()).status === "down", 15_000);
  setMode("up");
  await until("outage incident resolved after recovery", async () => (await incidents()).every((i) => i.resolved_at), CHECK_WINDOW_MS);
  const allB = await incidents();
  if (allB.length !== 1) throw new Error("expected exactly one auto incident overall, found " + allB.length);
  await until("monitor up after outage recovery", async () => (await monitor()).status === "up", 15_000);
  summary.push("B: SIGKILL mid-outage kept one incident; recovery resolved it");

  // ── C. database connections killed and refused ────────────────────────────
  const okBefore = (await results()).filter((r) => r.ok).length;
  await admin.unsafe(`alter database "${dbName}" allow_connections false`);
  try {
    // Kill every server connection; reconnects are refused while disallowed.
    const killOthers = () => admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${dbName} and pid <> pg_backend_pid()`;
    await killOthers();
    const outageEnd = Date.now() + 40_000; // spans at least one scheduler tick
    while (Date.now() < outageEnd) { await killOthers(); await sleep(2000); }
  } finally {
    await admin.unsafe(`alter database "${dbName}" allow_connections true`);
  }
  // Our own fixture client was disconnected too; postgres.js reconnects lazily.
  // Surviving the outage in-process is the claim: an exit here is a failure.
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited during the database outage (code ${child.exitCode}, signal ${child.signalCode})`);
  await until("health endpoint after database outage", async () => (await fetch(base + "/health", { signal: AbortSignal.timeout(1500) })).ok, 20_000);
  await until("checks resume after database outage", async () => (await results()).filter((r) => r.ok).length > okBefore, CHECK_WINDOW_MS);
  const db = await fetch(base + "/api/config", { signal: AbortSignal.timeout(3000) });
  if (!db.ok) throw new Error("API not serving after database outage: " + db.status);
  if ((await incidents()).length !== 1) throw new Error("database outage created an incident for a healthy target");
  if (child.exitCode !== null) throw new Error("server exited after the database outage");
  summary.push("C: process survived a 40s database outage and resumed checks");

  }
  // ── D. two workers on one database during an outage ───────────────────────
  // Every claimed run is started at most once (SKIP LOCKED claims plus
  // generation-guarded starts), so recorded results must equal started runs
  // and the outage must still produce exactly one incident.
  second = await spawnServer(await freePort());
  const gen0 = (await monitor()).last_run_generation;
  const res0 = (await results()).length;
  const inc0 = (await incidents()).length;
  setMode("down");
  await until("outage incident with two workers", async () => (await incidents()).some((i) => !i.resolved_at), CHECK_WINDOW_MS);
  await sleep(65_000); // at least two more ticks of each process
  await until("every started run recorded exactly one result", async () =>
    (await results()).length - res0 === (await monitor()).last_run_generation - gen0, 15_000);
  const startedRuns = (await monitor()).last_run_generation - gen0;
  if (startedRuns < 2) throw new Error("too few runs with two workers: " + startedRuns);
  const openD = (await incidents()).filter((i) => !i.resolved_at);
  // An outage soon after a resolution reopens that incident (flap handling)
  // instead of opening a new one, so the total may stay the same.
  const totalD = (await incidents()).length;
  if (openD.length !== 1 || totalD < inc0 || totalD > inc0 + 1) {
    const timeline = await sql`select started_at, resolved_at, severity, (select count(*) from incident_update u where u.incident_id = i.id) as updates from incident i where monitor_id = ${monitorId} and auto order by started_at`;
    const checks = await sql`select ok, checked_at from check_result where monitor_id = ${monitorId} order by checked_at desc limit 12`;
    console.error("incident timeline:", JSON.stringify(timeline), "recent checks:", JSON.stringify(checks));
    throw new Error("two workers produced duplicate incidents");
  }
  setMode("up");
  await until("outage resolved with two workers", async () => (await incidents()).every((i) => i.resolved_at), CHECK_WINDOW_MS);
  summary.push(`D: two workers ran ${startedRuns} runs with ${startedRuns} results and one incident`);

  for (const line of summary) console.log(line);
  console.log("CRASH_RECOVERY_PASS: SIGKILL in-flight retry, no duplicate incident across SIGKILL, database outage recovery, two-worker dedupe");
} catch (error) {
  console.error("server log tail:\n" + log.split("\n").slice(-25).join("\n"));
  throw error;
} finally {
  for (const proc of spawned) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  setMode("up");
  target.close();
  await admin.unsafe(`alter database "${dbName}" allow_connections true`).catch(() => {});
  await sql.end({ timeout: 2 }).catch(() => {});
  await admin.end({ timeout: 2 }).catch(() => {});
}
