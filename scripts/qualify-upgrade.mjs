#!/usr/bin/env node
// Upgrade, rollback and disaster-recovery qualification of the self-hosted Node build against a real, disposable
// local PostgreSQL. Everything is synthetic and local: the monitoring target, alert webhook and webhook senders are
// this script; nothing leaves the runner.
//
//   A. Upgrade. The previous release candidate (UPGRADE_OLD_DIR, a checkout of 17f55c1 with apps/api/dist/server.mjs
//      built) starts on an empty database and is seeded through its API: users and a workspace member, projects,
//      monitors of several types, alert channels, incidents with timelines, status pages (public with a custom domain,
//      password, members-only with a share link), webhook inboxes with events, maintenance windows and an API key.
//      It is stopped, a pre-upgrade backup is taken (pg_dump -Fc), and HEAD starts on the same database (its
//      migrations run). Every seeded entity must read back the same through HEAD's API (counts and fields), the old
//      session, sign-in, the API key, the share link, the password page, the custom domain and the webhook events
//      must work, and HEAD's scheduler must check monitors on its own tick.
//   B. Rollback. The supported rollback is restoring the pre-upgrade backup into a fresh database and starting the
//      OLD build on it: data must match the backup's SHA-256 table fingerprints and read back through the old API.
//      Starting the OLD build on the UPGRADED schema must fail safely: it refuses to start (migration history ahead
//      of the build) without changing a single row or catalog object.
//   C. Disaster recovery. With HEAD running on the upgraded data, a backup is taken twice while it keeps running:
//      pg_dump -Fc from an exported snapshot (exact SHA-256 fingerprints of that snapshot) and the documented
//      docker compose command (`docker exec -i <postgres> pg_dump -U montral -Fc <db>`, MONTRAL_PG_CONTAINER).
//      The server is killed and the database dropped; the documented restore (createdb + pg_restore --no-owner in the
//      PostgreSQL container) rebuilds it under a new name, HEAD starts on it and the app is verified (RTO measured).
//      The snapshot dump is restored into another new database and compared table by table and catalog by catalog.
//
// Safety: TEST_DATABASE_URL must be 127.0.0.1/localhost, without query parameters, naming a montral_test_* database.
// Every database this script creates or drops is that name plus a fixed suffix, also montral_test_*.
// Output: a JSON summary (UPGRADE_SUMMARY_PATH) and `UPGRADE_QUALIFICATION_PASS: ...`, or a non-zero exit.
import { spawn, execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcp } from "node:net";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import postgres from "../packages/db-pg/node_modules/postgres/src/index.js";

const run = promisify(execFile);
const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL database (montral_test_*)");
const baseUrl = new URL(connection);
const DB_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const baseDb = decodeURIComponent(baseUrl.pathname.slice(1));
if (!["127.0.0.1", "localhost"].includes(baseUrl.hostname) || baseUrl.search !== "" || !baseDb.startsWith("montral_test_") || !DB_NAME.test(baseDb)) {
  throw new Error("Upgrade qualification refuses any non-local or non-disposable database (127.0.0.1/localhost, montral_test_*, no query parameters)");
}
const OLD_DIR = resolve(process.env.UPGRADE_OLD_DIR ?? "");
const NEW_DIR = resolve(process.env.UPGRADE_NEW_DIR ?? ".");
const OLD_REF = process.env.UPGRADE_OLD_REF ?? "17f55c1";
const PG_CONTAINER = process.env.MONTRAL_PG_CONTAINER ?? "";
const SUMMARY_PATH = resolve(process.env.UPGRADE_SUMMARY_PATH ?? "upgrade-summary.json");
for (const [label, dir] of [["old", OLD_DIR], ["new", NEW_DIR]]) {
  if (!existsSync(join(dir, "apps/api/dist/server.mjs"))) throw new Error(`${label} build missing: ${dir}/apps/api/dist/server.mjs (pnpm --filter @montral/api build:node)`);
}
if (!/^[0-9a-f]{12,64}$/.test(PG_CONTAINER)) throw new Error("Set MONTRAL_PG_CONTAINER to the PostgreSQL container id: the documented docker compose backup and restore run inside it");

const dbUrl = (name) => { const u = new URL(connection); u.pathname = "/" + name; return u.href; };
const DBS = { upgrade: `${baseDb}_up`, rollback: `${baseDb}_rb`, dr: `${baseDb}_dr_new`, drSnapshot: `${baseDb}_dr_snap` };
for (const name of Object.values(DBS)) if (!/^montral_test_[a-z0-9_]+$/.test(name) || name.length > 63) throw new Error(`refusing database name ${name}`);
const PG_USER = decodeURIComponent(baseUrl.username || "montral");
const pgEnv = { ...process.env, PGHOST: baseUrl.hostname, PGPORT: baseUrl.port || "5432", PGUSER: PG_USER, PGPASSWORD: decodeURIComponent(baseUrl.password || "") };

const SECRET = "montral-upgrade-qualification-only-never-production";
const PASSWORD = "synthetic upgrade qualification";
const PAGE_PASSWORD = "synthetic-partners-2026";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, message) => { if (!ok) { failures.push(message); console.error("FAIL: " + message); } else console.log("ok   " + message); return ok; };
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const summary = { qualification: "montral-upgrade-rollback-dr", oldRef: OLD_REF, startedAt: new Date().toISOString(), node: process.version, timingsMs: {}, phases: {} };
const timed = async (key, fn) => { const t0 = performance.now(); try { return await fn(); } finally { summary.timingsMs[key] = Math.round(performance.now() - t0); } };

// ── database helpers ──────────────────────────────────────────────────────────
const admin = postgres(connection, { max: 1, onnotice: () => {} });
const clients = new Map();
const db = (name) => { if (!clients.has(name)) clients.set(name, postgres(dbUrl(name), { max: 2, onnotice: () => {} })); return clients.get(name); };
async function closeDb(name) { const c = clients.get(name); clients.delete(name); if (c) await c.end({ timeout: 5 }).catch(() => {}); }
async function dropDb(name) { await closeDb(name); await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
async function createDb(name) { await dropDb(name); await admin.unsafe(`CREATE DATABASE "${name}"`); }
const quote = (t) => '"' + t.replaceAll('"', '""') + '"';
async function tables(sql) {
  return (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`).map((r) => r.table_name);
}
/** Per table: row count and an order-independent SHA-256 over every row's full JSON value (as scripts/qualify-backup.mjs). */
async function fingerprints(sql) {
  const out = {};
  for (const t of await tables(sql)) {
    const [r] = await sql.unsafe(`SELECT count(*)::int AS n, encode(sha256(convert_to(coalesce(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex') AS f
      FROM (SELECT encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') AS h FROM public.${quote(t)} r) x`);
    out[t] = { n: r.n, f: r.f };
  }
  return out;
}
/** Executable schema: columns, indexes, constraints, triggers (with enabled state) and functions, hashed per object. */
async function catalog(sql) {
  const rows = await sql.unsafe(`
    SELECT 'column:' || r.relname || '.' || a.attname AS k, format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS v
      FROM pg_attribute a JOIN pg_class r ON r.oid = a.attrelid JOIN pg_namespace n ON n.oid = r.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND r.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'index:' || indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL SELECT 'constraint:' || r.relname || '.' || c.conname, pg_get_constraintdef(c.oid, true) || '|' || c.convalidated::text
      FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public'
    UNION ALL SELECT 'trigger:' || r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid, true) || '|' || t.tgenabled::text
      FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
    UNION ALL SELECT 'function:' || p.oid::regprocedure::text, pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f'`);
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}
const diffKeys = (a, b, eq = (x, y) => JSON.stringify(x) === JSON.stringify(y)) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !eq(a[k], b[k]));
const migrationsApplied = async (sql) => (await sql`SELECT count(*)::int AS n FROM public.__drizzle_migrations`)[0].n;

// ── tools: host pg_dump/pg_restore (version-matched) and the documented commands inside the PostgreSQL container ──
async function hostTool(name, args) { return run(name, args, { env: pgEnv, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }); }
/** `docker exec -i <container> <cmd...>` with optional stdin file / stdout file: what `docker compose exec -T postgres ...` runs. */
async function inContainer(args, { stdinFile, stdoutFile } = {}) {
  const proc = spawn("docker", ["exec", "-i", PG_CONTAINER, ...args], {
    stdio: [stdinFile ? "pipe" : "ignore", stdoutFile ? "pipe" : "inherit", "pipe"],
  });
  let err = "";
  proc.stderr.on("data", (chunk) => { err = (err + chunk).slice(-4000); });
  const exited = new Promise((resolveExit, rejectExit) => {
    proc.once("error", rejectExit);
    proc.once("close", (code) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`docker exec ${args[0]} exited ${code}: ${err}`));
    });
  });
  // A child exit does not imply that the destination file has flushed its buffered bytes.
  // pipeline waits for writable 'finish' and propagates both read and write failures.
  const transfers = [];
  if (stdinFile) transfers.push(pipeline(createReadStream(stdinFile), proc.stdin));
  if (stdoutFile) transfers.push(pipeline(proc.stdout, createWriteStream(stdoutFile, { flags: "wx" })));
  try {
    await Promise.all([exited, ...transfers]);
  } catch (error) {
    proc.kill();
    await Promise.allSettled([exited, ...transfers]);
    throw error;
  }
}

// ── synthetic target: monitors, the alert webhook and nothing else ───────────
const alerts = [];
const target = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url === "/alert") alerts.push(body.slice(0, 2000));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", service: "synthetic upgrade target" }));
  });
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const targetBase = `http://127.0.0.1:${target.address().port}`;
const freePort = () => new Promise((r) => { const s = createTcp(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

// ── server processes (one at a time, same port and secret) ───────────────────
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let server = null;
let temp = null; // backups of this run; removed in finally whatever happens
const spawned = [];
function start(label, dir, database) {
  const proc = spawn(process.execPath, [join(dir, "apps/api/dist/server.mjs")], {
    cwd: dir,
    env: {
      ...process.env, DATABASE_URL: dbUrl(database), PORT: String(port), BIND_HOST: "127.0.0.1",
      WEB_ORIGIN: base, BETTER_AUTH_URL: base, WEB_DIST: join(dir, "apps/web/dist-missing-on-purpose"),
      BETTER_AUTH_SECRET: SECRET, CRON_SECRET: "montral-upgrade-qualification-cron-only", ALLOW_PRIVATE_TARGETS: "true",
      MONTRAL_BILLING_ENABLED: "false", MONTRAL_METERING_ENABLED: "false", SMTP_URL: "", EMAIL_FROM: "", SELFCHECK_URLS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.label = label;
  proc.log = "";
  proc.exitInfo = null;
  proc.exited = new Promise((r) => proc.once("exit", (code, signal) => { proc.exitInfo = { code, signal }; r(proc.exitInfo); }));
  for (const s of [proc.stdout, proc.stderr]) { s.setEncoding("utf8"); s.on("data", (c) => { proc.log = (proc.log + c).slice(-20_000); }); }
  spawned.push(proc);
  return proc;
}
async function healthy(proc, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitInfo) throw new Error(`${proc.label} exited during startup ${JSON.stringify(proc.exitInfo)}:\n${proc.log.slice(-3000)}`);
    try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(1500) })).ok) return Date.now() - t0; } catch {}
    await sleep(200);
  }
  throw new Error(`${proc.label} not healthy within ${timeoutMs} ms:\n${proc.log.slice(-3000)}`);
}
async function stop(proc, signal = "SIGTERM") {
  if (!proc || proc.exitInfo) return proc?.exitInfo;
  proc.kill(signal);
  const exit = await Promise.race([proc.exited, sleep(15_000).then(() => null)]);
  if (!exit) { proc.kill("SIGKILL"); return proc.exited; }
  return exit;
}

// ── HTTP client ──────────────────────────────────────────────────────────────
const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
async function call(method, path, { cookie, key, body, project, headers = {}, redirect = "follow" } = {}) {
  const res = await fetch(base + path, {
    method, redirect,
    headers: {
      origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}), ...(key ? { "x-api-key": key } : {}), ...(project ? { "x-project-id": project } : {}), ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, res, cookie: cookieOf(res) };
}
/** A request addressed to another Host (fetch cannot override Host): what the reverse proxy forwards for a custom domain. */
function viaHost(host, path, cookie) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host, ...(cookie ? { cookie } : {}) }, timeout: 30_000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolvePromise({ status: res.statusCode, text }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
const must = (r, status, what) => { if (r.status !== status) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 400)}`); return r.body; };
const list = (body) => (Array.isArray(body) ? body : Object.values(body ?? {}).find(Array.isArray) ?? []);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

// ── seed (through the OLD build's API) ───────────────────────────────────────
const seed = { ids: {} };
async function signUp(label) {
  const email = `upgrade-${label}-${Date.now().toString(36)}@example.test`;
  const r = await call("POST", "/api/auth/sign-up/email", { body: { email, name: `Upgrade ${label}`, password: PASSWORD } });
  const user = must(r, 200, `sign up ${label}`).user;
  // Email verification is out of scope (no mail server): mark the synthetic address verified, as the e2e tests do.
  await db(DBS.upgrade)`UPDATE "user" SET email_verified = true WHERE id = ${user.id}`;
  const login = await call("POST", "/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
  must(login, 200, `sign in ${label}`);
  const me = must(await call("GET", "/api/me", { cookie: login.cookie }), 200, `me ${label}`);
  return { email, id: user.id, cookie: login.cookie, orgId: me.organization.id, projectId: me.projectId };
}
async function seedOld() {
  const owner = await signUp("owner");
  const member = await signUp("member");
  const other = await signUp("other");
  Object.assign(seed, { owner, member, other });
  const c = owner.cookie;
  const invite = must(await call("POST", "/api/auth/organization/invite-member", { cookie: c, body: { organizationId: owner.orgId, email: member.email, role: "member" } }), 200, "invite member");
  must(await call("POST", "/api/auth/organization/accept-invitation", { cookie: member.cookie, body: { invitationId: invite.id } }), 200, "accept invitation");
  const p2 = must(await call("POST", "/api/projects", { cookie: c, body: { name: "Payments" } }), 201, "project");
  seed.ids.projects = [owner.projectId, p2.id];

  const hook = must(await call("POST", "/api/channels", { cookie: c, body: { type: "webhook", name: "Ops webhook", config: { url: `${targetBase}/alert` } } }), 201, "webhook channel");
  const mail = must(await call("POST", "/api/channels", { cookie: c, body: { type: "email", name: "On-call mail", config: { to: owner.email } } }), 201, "email channel");
  seed.ids.channels = [hook.id, mail.id];

  const mon = async (body, project) => must(await call("POST", "/api/monitors", { cookie: c, project, body }), 201, `monitor ${body.name}`).id;
  const m = {
    api: await mon({ name: "Public API", type: "http", target: `${targetBase}/health`, intervalSec: 60, keyword: "ok", channelIds: [hook.id], tags: ["prod"] }),
    json: await mon({ name: "Status JSON", type: "http", target: `${targetBase}/status.json`, intervalSec: 60, jsonPath: "status", jsonExpected: "ok", jsonMatch: "equals" }),
    tcp: await mon({ name: "Database port", type: "tcp", target: `127.0.0.1:${target.address().port}`, intervalSec: 120 }),
    heartbeat: await mon({ name: "Nightly backup", type: "heartbeat", intervalSec: 86400, graceSec: 3600 }),
    dns: await mon({ name: "Resolver", type: "dns", target: "example.com", intervalSec: 3600, dnsRecordType: "A" }),
    domain: await mon({ name: "Registrar", type: "domain", target: "example.com", intervalSec: 86400 }),
    payments: await mon({ name: "Payments API", type: "http", target: `${targetBase}/payments`, intervalSec: 60 }, p2.id),
    paymentsCron: await mon({ name: "Payments cron", type: "heartbeat", intervalSec: 3600, graceSec: 600 }, p2.id),
  };
  // no network beyond the runner: the DNS and domain monitors exist (type coverage) but are paused
  for (const id of [m.dns, m.domain]) must(await call("PATCH", `/api/monitors/${id}`, { cookie: c, body: { paused: true } }), 200, "pause");
  seed.ids.monitors = m;

  const inc = async (title, updates, extra = {}, project) => {
    const created = must(await call("POST", "/api/incidents", { cookie: c, project, body: { title, body: updates[0][1], ...extra } }), 201, `incident ${title}`);
    for (const [status, body] of updates.slice(1)) must(await call("POST", `/api/incidents/${created.id}/updates`, { cookie: c, project, body: { status, body } }), 201, `update ${title}`);
    return created.id;
  };
  seed.ids.incidents = [
    await inc("Elevated API errors", [["investigating", "Error rate above 5 %."], ["identified", "A bad deploy."], ["monitoring", "Rolled back."], ["resolved", "Error rate normal for 30 minutes."]], { monitorId: m.api }),
    await inc("Degraded dashboard", [["investigating", "Slow page loads."], ["identified", "Cache node down."]], { severity: "minor" }),
    await inc("Card payments delayed", [["investigating", "Provider latency."], ["monitoring", "Provider recovered."]], { monitorId: m.payments }, p2.id),
  ];

  const page = async (body) => must(await call("POST", "/api/status-pages", { cookie: c, body }), 201, `status page ${body.slug}`);
  const tag = Date.now().toString(36);
  const pub = await page({ slug: `up-public-${tag}`, title: "Acme status", monitorIds: [m.api, m.json, m.tcp] });
  const pw = await page({ slug: `up-partners-${tag}`, title: "Partner status", visibility: "password", password: PAGE_PASSWORD, monitorIds: [m.api] });
  const members = await page({ slug: `up-audit-${tag}`, title: "Auditor status", visibility: "members", monitorIds: [m.json] });
  const link = must(await call("POST", `/api/status-pages/${members.id}/share-links`, { cookie: c, body: { label: "Auditor", expiresInHours: 168 } }), 201, "share link");
  const domain = `status-${tag}.example.test`;
  must(await call("PUT", `/api/status-pages/${pub.id}/domain`, { cookie: c, body: { domain } }), 200, "custom domain");
  // DNS proof is out of scope here (custom-domain e2e tests cover it): mark the claimed domain verified, as DNS would.
  await db(DBS.upgrade)`UPDATE status_page SET custom_domain_verified_at = now(), custom_domain_checked_at = now() WHERE id = ${pub.id}`;
  seed.ids.pages = { pub: pub.id, pw: pw.id, members: members.id };
  seed.slugs = { pub: pub.slug, pw: pw.slug, members: members.slug };
  seed.domain = domain;
  seed.shareLinkId = link.id;
  seed.shareToken = new URL(link.url).searchParams.get("t");

  const inbox = async (name, project) => must(await call("POST", "/api/hooks/inboxes", { cookie: c, project, body: { name } }), 201, `inbox ${name}`);
  const billing = await inbox("Billing provider mock");
  const payments = await inbox("Payments callbacks", p2.id);
  seed.inboxes = { billing, payments };
  for (const [i, ib] of [[1, billing], [2, billing], [3, billing], [4, payments]]) {
    const r = await call("POST", ib.path, { body: { event: `synthetic.${i}`, amount: i * 100, currency: "EUR" }, headers: { "x-event-type": `test-${i}` } });
    if (r.status !== 202) throw new Error(`webhook event ${i}: HTTP ${r.status}`);
  }

  const day = 86400_000;
  const win = async (body) => must(await call("POST", "/api/maintenance", { cookie: c, body }), 201, `maintenance ${body.name}`).id;
  const at = new Date(Math.ceil(Date.now() / 3600_000) * 3600_000 + 7 * day);
  seed.ids.maintenance = [
    await win({ name: "Database upgrade", startsAt: at.toISOString(), endsAt: new Date(+at + 2 * 3600_000).toISOString(), monitorIds: [m.api, m.tcp] }),
    await win({ name: "Weekly patching", startsAt: new Date(+at + day).toISOString(), endsAt: new Date(+at + day + 3600_000).toISOString(), recurrence: { frequency: "weekly", timeZone: "UTC", until: new Date(+at + 60 * day).toISOString() } }),
  ];

  const key = must(await call("POST", "/api/auth/api-key/create", { cookie: c, body: { name: "CI deploys", metadata: { organizationId: owner.orgId } } }), 200, "api key");
  seed.apiKey = key.key;
  seed.ids.apiKey = key.id;
  must(await call("POST", "/api/monitors", { cookie: other.cookie, body: { name: "Other tenant", type: "heartbeat", intervalSec: 3600 } }), 201, "other tenant monitor");
}

// ── what the app shows: an API snapshot of everything seeded ─────────────────
const MONITOR_KEYS = ["id", "name", "type", "target", "intervalSec", "timeoutMs", "paused", "keyword", "keywordMode", "jsonPath", "jsonExpected", "jsonMatch", "graceSec", "method", "expectedStatus", "projectId", "tags", "channelIds", "failureThreshold"];
async function snapshot(cookie) {
  const s = {};
  const get = async (path, project) => must(await call("GET", path, { cookie, project }), 200, `GET ${path}`);
  s.me = pick((await get("/api/me")).user ?? {}, ["id", "email", "name"]);
  s.projects = list(await get("/api/projects")).map((p) => pick(p, ["id", "name"])).sort((a, b) => a.id.localeCompare(b.id));
  s.monitors = {};
  s.channels = {};
  s.inboxes = {};
  s.maintenance = {};
  for (const pid of seed.ids.projects) {
    s.monitors[pid] = list(await get("/api/monitors", pid)).map((m) => pick(m, MONITOR_KEYS)).sort((a, b) => a.id.localeCompare(b.id));
    s.channels[pid] = list(await get("/api/channels", pid)).map((ch) => pick(ch, ["id", "name", "type", "enabled", "config"])).sort((a, b) => a.id.localeCompare(b.id));
    s.maintenance[pid] = list(await get("/api/maintenance", pid)).map((w) => pick(w, ["id", "name", "startsAt", "endsAt", "monitorIds", "seriesId"])).sort((a, b) => `${a.startsAt}${a.id}`.localeCompare(`${b.startsAt}${b.id}`));
    const inboxes = list(await get("/api/hooks/inboxes", pid)).map((i) => pick(i, ["id", "name"])).sort((a, b) => a.id.localeCompare(b.id));
    for (const ib of inboxes) {
      const events = list(await get(`/api/hooks/inboxes/${ib.id}/events`, pid)).map((e) => ({ ...pick(e, ["id", "method", "body"]), type: e.headers?.["x-event-type"] }));
      ib.events = events.sort((a, b) => a.id.localeCompare(b.id));
    }
    s.inboxes[pid] = inboxes;
  }
  s.incidents = [];
  for (const id of seed.ids.incidents) {
    const d = await get(`/api/incidents/${id}`);
    s.incidents.push({ ...pick(d, ["id", "number", "title", "severity", "monitorId", "projectId", "resolvedAt", "auto"]), updates: (d.updates ?? []).map((u) => pick(u, ["id", "status", "body", "visibility"])) });
  }
  s.pages = [];
  for (const id of Object.values(seed.ids.pages)) {
    const p = await get(`/api/status-pages/${id}`);
    s.pages.push(pick(p, ["id", "slug", "title", "visibility", "customDomain", "customDomainVerifiedAt", "monitorIds", "theme", "projectId"]));
  }
  s.shareLinks = list(await get(`/api/status-pages/${seed.ids.pages.members}/share-links`)).map((l) => pick(l, ["id", "label", "expiresAt"]));
  s.apiKeys = list(await get("/api/auth/api-key/list")).map((k) => pick(k, ["id", "name", "start", "prefix"])).sort((a, b) => a.id.localeCompare(b.id));
  return s;
}
/** Every field of `before` must read back the same in `after` (fields only one side has are reported, not failed). */
function compareSnapshots(label, before, after) {
  const problems = [];
  const walk = (a, b, path) => {
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) { problems.push(`${path}: ${Array.isArray(b) ? b.length : typeof b} items, expected ${a.length}`); return; }
      a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`));
    } else if (a && typeof a === "object") {
      if (!b || typeof b !== "object") { problems.push(`${path}: missing`); return; }
      for (const k of Object.keys(a)) walk(a[k], b[k], `${path}.${k}`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${path}: ${JSON.stringify(b)?.slice(0, 120)} != ${JSON.stringify(a)?.slice(0, 120)}`);
  };
  walk(before, after, label);
  return problems;
}
const counts = (s) => ({
  projects: s.projects.length,
  monitors: Object.values(s.monitors).flat().length,
  // workspace-wide channels are listed in every project: count each once
  channels: new Set(Object.values(s.channels).flat().map((c) => c.id)).size,
  incidents: s.incidents.length,
  incidentUpdates: s.incidents.reduce((n, i) => n + i.updates.length, 0),
  statusPages: s.pages.length,
  shareLinks: s.shareLinks.length,
  inboxes: Object.values(s.inboxes).flat().length,
  webhookEvents: Object.values(s.inboxes).flat().reduce((n, i) => n + i.events.length, 0),
  maintenanceWindows: Object.values(s.maintenance).flat().length,
  apiKeys: s.apiKeys.length,
});

/** Behaviour that must keep working on a build/database pair: sessions, sign-in, API key, share link, password page, custom domain, webhooks. */
async function behaviour(label, { existingCookie, newEvent = true } = {}) {
  const r = {};
  if (existingCookie) r.existingSession = (await call("GET", "/api/me", { cookie: existingCookie })).status === 200;
  const login = await call("POST", "/api/auth/sign-in/email", { body: { email: seed.owner.email, password: PASSWORD } });
  r.signIn = login.status === 200;
  r.wrongPasswordRefused = (await call("POST", "/api/auth/sign-in/email", { body: { email: seed.owner.email, password: "not the password" } })).status === 401;
  const viaKey = await call("GET", "/api/monitors", { key: seed.apiKey, project: seed.ids.projects[0] });
  r.apiKey = viaKey.status === 200 && list(viaKey.body).some((m) => m.id === seed.ids.monitors.api);
  r.memberSeesWorkspace = false;
  const memberLogin = await call("POST", "/api/auth/sign-in/email", { body: { email: seed.member.email, password: PASSWORD } });
  if (memberLogin.status === 200) {
    const active = await call("POST", "/api/auth/organization/set-active", { cookie: memberLogin.cookie, body: { organizationId: seed.owner.orgId } });
    const mc = active.cookie || memberLogin.cookie;
    const mm = await call("GET", "/api/monitors", { cookie: mc, project: seed.ids.projects[0] });
    r.memberSeesWorkspace = mm.status === 200 && list(mm.body).some((m) => m.id === seed.ids.monitors.api);
  }
  const otherLogin = await call("POST", "/api/auth/sign-in/email", { body: { email: seed.other.email, password: PASSWORD } });
  const om = await call("GET", "/api/monitors", { cookie: otherLogin.cookie });
  r.tenantIsolation = om.status === 200 && !list(om.body).some((m) => m.id === seed.ids.monitors.api) && (await call("GET", `/api/incidents/${seed.ids.incidents[0]}`, { cookie: otherLogin.cookie })).status === 404;
  const followed = await call("GET", `/api/public/status/_/access?t=${seed.shareToken}`, { redirect: "manual" });
  r.shareLink = followed.status === 303 && (await call("GET", `/api/public/status/${seed.slugs.members}`, { cookie: followed.cookie })).status === 200;
  r.membersPageClosedWithoutLink = (await call("GET", `/api/public/status/${seed.slugs.members}`)).status === 404;
  const unlocked = await call("POST", "/api/public/status/_/unlock", { body: { slug: seed.slugs.pw, password: PAGE_PASSWORD } });
  r.passwordPage = (unlocked.status === 204 || unlocked.status === 200) && (await call("GET", `/api/public/status/${seed.slugs.pw}`, { cookie: unlocked.cookie })).status === 200;
  r.passwordPageClosedWithoutPassword = (await call("GET", `/api/public/status/${seed.slugs.pw}`)).status === 401;
  const viaDomain = await viaHost(seed.domain, `/api/public/status/${seed.slugs.pub}`);
  r.customDomain = viaDomain.status === 200 && viaDomain.text.includes("Acme status");
  r.customDomainServesNothingElse = (await viaHost(seed.domain, "/api/monitors", login.cookie)).status === 404;
  const events = await call("GET", `/api/hooks/inboxes/${seed.inboxes.billing.id}/events`, { cookie: login.cookie, project: seed.ids.projects[0] });
  r.webhookEventsReadable = events.status === 200 && list(events.body).filter((e) => /synthetic\.[123]/.test(e.body ?? "")).length === 3;
  if (newEvent) {
    const posted = await call("POST", seed.inboxes.billing.path, { body: { event: `after.${label}` } });
    const again = await call("GET", `/api/hooks/inboxes/${seed.inboxes.billing.id}/events`, { cookie: login.cookie, project: seed.ids.projects[0] });
    r.webhookReceiverAccepts = posted.status === 202 && list(again.body).some((e) => (e.body ?? "").includes(`after.${label}`));
  }
  for (const [k, ok] of Object.entries(r)) check(ok, `${label}: ${k}`);
  return { results: r, cookie: login.cookie };
}

/** The server's own scheduler checks an HTTP monitor after `since` (a result row it recorded). */
async function schedulerTick(label, database, since) {
  const t0 = Date.now();
  while (Date.now() - t0 < 100_000) {
    const [r] = await db(database)`SELECT count(*)::int AS n FROM check_result WHERE monitor_id IN ${db(database)([seed.ids.monitors.api, seed.ids.monitors.json, seed.ids.monitors.payments])} AND checked_at > ${since}`;
    if (r.n > 0) return check(true, `${label}: scheduler tick checked monitors (${r.n} new results within ${Math.round((Date.now() - t0) / 1000)} s)`);
    await sleep(2000);
  }
  return check(false, `${label}: scheduler tick checked monitors within 100 s`);
}
const noSchedulerErrors = (label, proc) => check(!/monitor scheduler failed|check batch failed|scheduler: a tick has been running/.test(proc.log), `${label}: no scheduler failure logged`);

// ══ run ══════════════════════════════════════════════════════════════════════
try {
  for (const name of Object.values(DBS)) await dropDb(name);
  await createDb(DBS.upgrade);

  // ── A. upgrade ─────────────────────────────────────────────────────────────
  log(`A: old build (${OLD_REF}) on an empty database`);
  server = start(`old ${OLD_REF}`, OLD_DIR, DBS.upgrade);
  summary.timingsMs.oldStartEmpty = await healthy(server);
  const oldMigrations = await migrationsApplied(db(DBS.upgrade));
  await timed("seedOld", seedOld);
  await sleep(35_000); // let the old scheduler record results, as a running installation would have
  const beforeOld = await snapshot(seed.owner.cookie);
  const oldBehaviour = await behaviour("old build before upgrade", { newEvent: false });
  check(Object.values(oldBehaviour.results).every(Boolean), "old build: the seeded workspace works before the upgrade (baseline)");
  const oldExit = await stop(server);
  check(oldExit?.code === 0, `old build: graceful stop (exit ${JSON.stringify(oldExit)})`);
  noSchedulerErrors("old build", server);
  const preUpgrade = await fingerprints(db(DBS.upgrade));
  const preUpgradeCatalog = await catalog(db(DBS.upgrade));
  // the seed must have produced exactly what was created, so no later comparison can pass on empty lists
  const expected = { projects: 2, monitors: 8, channels: 2, incidents: 3, incidentUpdates: 8, statusPages: 3, shareLinks: 1, inboxes: 2, webhookEvents: 4, maintenanceWindows: 10, apiKeys: 1 };
  check(JSON.stringify(counts(beforeOld)) === JSON.stringify(expected), `seed: the old API lists exactly the seeded entities ${JSON.stringify(counts(beforeOld))}`);
  summary.seeded = { counts: counts(beforeOld), oldMigrations, tables: Object.keys(preUpgrade).length, rows: Object.values(preUpgrade).reduce((n, t) => n + t.n, 0), nonEmptyTables: Object.values(preUpgrade).filter((t) => t.n > 0).length };
  log("seeded", JSON.stringify(summary.seeded));

  // pre-upgrade backup: the documented step before every upgrade (also the rollback path, B)
  temp = mkdtempSync(join(tmpdir(), "montral-upgrade-"));
  summary.tempDir = temp;
  const preDump = join(temp, "pre-upgrade.dump");
  // the documented backup command (`docker compose exec -T postgres pg_dump -U montral -Fc montral > montral-pre-upgrade.dump`)
  await timed("preUpgradeBackup", () => inContainer(["pg_dump", "-U", PG_USER, "-Fc", DBS.upgrade], { stdoutFile: preDump }));
  summary.preUpgradeDumpBytes = statSync(preDump).size;

  log("A: HEAD on the same database");
  const upgradeStarted = new Date();
  server = start("HEAD", NEW_DIR, DBS.upgrade);
  summary.timingsMs.headUpgradeStartToHealthy = await healthy(server);
  const newMigrations = await migrationsApplied(db(DBS.upgrade));
  summary.phases.upgrade = { migrationsBefore: oldMigrations, migrationsAfter: newMigrations, appliedByUpgrade: newMigrations - oldMigrations };
  check(newMigrations >= oldMigrations, `upgrade: migration history extended (${oldMigrations} -> ${newMigrations})`);
  const afterUpgrade = await snapshot(seed.owner.cookie);
  const upgradeDiff = compareSnapshots("upgrade", beforeOld, afterUpgrade);
  check(upgradeDiff.length === 0, `upgrade: every seeded entity reads back identically through HEAD's API (${upgradeDiff.slice(0, 8).join("; ")})`);
  check(JSON.stringify(counts(afterUpgrade)) === JSON.stringify(counts(beforeOld)), `upgrade: entity counts unchanged ${JSON.stringify(counts(afterUpgrade))}`);
  // Rows the upgrade must not touch: every pre-upgrade table keeps its rows (HEAD may only add rows: sessions, checks).
  const postUpgradeCounts = await fingerprints(db(DBS.upgrade));
  const lostRows = Object.entries(preUpgrade).filter(([t, v]) => !postUpgradeCounts[t] || postUpgradeCounts[t].n < v.n).map(([t]) => t);
  check(lostRows.length === 0, `upgrade: no table lost rows (${lostRows.join(", ")})`);
  const upgradeBehaviour = await behaviour("HEAD after upgrade", { existingCookie: seed.owner.cookie });
  await schedulerTick("HEAD after upgrade", DBS.upgrade, upgradeStarted);
  noSchedulerErrors("HEAD after upgrade", server);
  summary.phases.upgrade.behaviour = upgradeBehaviour.results;
  summary.phases.upgrade.counts = counts(afterUpgrade);
  const headExit = await stop(server);
  check(headExit?.code === 0, `HEAD: graceful stop (exit ${JSON.stringify(headExit)})`);

  // ── B. rollback ────────────────────────────────────────────────────────────
  // (b1) the old build on the upgraded schema must refuse to start and leave everything as it was
  const upgradedFp = await fingerprints(db(DBS.upgrade));
  const upgradedCatalog = await catalog(db(DBS.upgrade));
  const upgradedMigrations = await migrationsApplied(db(DBS.upgrade));
  log("B: old build on the upgraded schema");
  // the documented read-only check (/docs/self-host): the old build's migrate-plain --check names the reason
  const precheck = await run(process.execPath, ["migrate-plain.mjs", "--check"], { cwd: join(OLD_DIR, "packages/db-pg"), env: { ...process.env, DATABASE_URL: dbUrl(DBS.upgrade) }, timeout: 60_000 })
    .then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e) => ({ code: e.code, out: String(e.stdout ?? "") + String(e.stderr ?? "") }));
  summary.phases.oldMigrateCheckOnUpgradedSchema = { exit: precheck.code, reason: (precheck.out.match(/Database migration history[^\n]*/) ?? [null])[0] };
  check(precheck.code !== 0 && /history is ahead of this build/.test(precheck.out), `rollback: the old build's migrate-plain --check refuses the upgraded schema (${summary.phases.oldMigrateCheckOnUpgradedSchema.reason})`);
  server = start(`old ${OLD_REF} on upgraded schema`, OLD_DIR, DBS.upgrade);
  const t0 = Date.now();
  let served = false;
  while (!server.exitInfo && Date.now() - t0 < 150_000) {
    try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })).ok) { served = true; break; } } catch {}
    await sleep(500);
  }
  const oldOnNew = { served, exit: server.exitInfo, secondsToExit: server.exitInfo ? Math.round((Date.now() - t0) / 1000) : null, /* builds before the startup refusal (17f55c1) retry ~60 s and exit with this generic message; the reason itself is proven by migrate-plain --check above */ genericRetryExit: server.log.includes("Database connection/migration unavailable after bounded startup retries") };
  if (served) {
    // It started anyway: that is acceptable only if it works on the new schema. Record and verify.
    oldOnNew.mode = "works";
    const b = await behaviour("old build on upgraded schema", { newEvent: false });
    oldOnNew.behaviour = b.results;
    await stop(server);
  } else {
    oldOnNew.mode = "fails safely";
    await stop(server, "SIGKILL");
  }
  summary.phases.oldBuildOnUpgradedSchema = oldOnNew;
  log("old on upgraded schema", JSON.stringify(oldOnNew));
  check(oldOnNew.mode === "fails safely" ? oldOnNew.exit && oldOnNew.exit.code !== 0 && oldOnNew.genericRetryExit : Object.values(oldOnNew.behaviour).every(Boolean),
    `rollback: the old build on the upgraded schema ${oldOnNew.mode === "fails safely" ? "never serves: it retries its migration and exits " + JSON.stringify(oldOnNew.exit) + " after " + oldOnNew.secondsToExit + " s with the generic 'Database connection/migration unavailable after bounded startup retries' (this build predates the specific refusal)" : "works"}`);
  if (oldOnNew.mode === "fails safely") {
    const afterAttempt = await fingerprints(db(DBS.upgrade));
    const changed = diffKeys(upgradedFp, afterAttempt);
    check(changed.length === 0, `rollback: the refused start changed no row (${changed.join(", ")})`);
    const catalogChanged = diffKeys(upgradedCatalog, await catalog(db(DBS.upgrade)));
    check(catalogChanged.length === 0 && (await migrationsApplied(db(DBS.upgrade))) === upgradedMigrations, `rollback: the refused start changed no schema object or migration history (${catalogChanged.slice(0, 5).join(", ")})`);
  }

  // (b1') HEAD on a schema newer than itself (a migration it does not know): it must refuse at once with the fixed
  // message, never listen, never enter the retry loop, and change nothing.
  log("B: HEAD on a future schema");
  const [{ next }] = await db(DBS.upgrade)`SELECT coalesce(max(created_at), 0)::bigint + 1 AS next FROM public.__drizzle_migrations`;
  await db(DBS.upgrade)`INSERT INTO public.__drizzle_migrations (hash, created_at) VALUES ('synthetic-future-migration-not-known-to-this-build', ${next})`;
  const futureFp = await fingerprints(db(DBS.upgrade));
  server = start("HEAD on a future schema", NEW_DIR, DBS.upgrade);
  const tf = Date.now();
  let futureServed = false;
  while (!server.exitInfo && Date.now() - tf < 30_000) {
    try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })).ok) { futureServed = true; break; } } catch {}
    await sleep(200);
  }
  const future = { served: futureServed, exit: server.exitInfo, msToExit: server.exitInfo ? Date.now() - tf : null,
    clearMessage: server.log.includes("database schema is newer than this Montral build; restore the pre-upgrade backup or run the newer build"),
    retried: /retrying|bounded startup retries/.test(server.log) };
  await stop(server, "SIGKILL");
  summary.phases.headOnFutureSchema = future;
  check(!future.served && future.exit?.code === 1 && future.clearMessage && !future.retried && future.msToExit !== null && future.msToExit < 15_000,
    `rollback: HEAD on a schema newer than itself exits 1 at once (${future.msToExit} ms) with "database schema is newer than this Montral build; ...", without retrying or listening`);
  check(diffKeys(futureFp, await fingerprints(db(DBS.upgrade))).length === 0, "rollback: HEAD's refusal changed no row");
  await db(DBS.upgrade)`DELETE FROM public.__drizzle_migrations WHERE hash = 'synthetic-future-migration-not-known-to-this-build'`;
  check(diffKeys(upgradedFp, await fingerprints(db(DBS.upgrade))).length === 0, "rollback: synthetic future migration removed, database back to the upgraded state");

  // (b2) supported rollback: restore the pre-upgrade backup into a fresh database and start the old build on it
  log("B: restore the pre-upgrade backup into a new database, old build on it");
  // the documented rollback: an EMPTY database (never --clean over the upgraded one), restored with the container's tools
  await dropDb(DBS.rollback);
  await timed("rollbackRestore", async () => {
    await inContainer(["createdb", "-U", PG_USER, DBS.rollback]);
    await inContainer(["pg_restore", "-U", PG_USER, "-d", DBS.rollback, "--no-owner", "--exit-on-error"], { stdinFile: preDump });
  });
  const rolledBack = await fingerprints(db(DBS.rollback));
  const rbDiff = diffKeys(preUpgrade, rolledBack);
  check(rbDiff.length === 0, `rollback: restored database equals the pre-upgrade state, every table's row count and SHA-256 fingerprint (${rbDiff.join(", ")})`);
  const rbCatalog = diffKeys(preUpgradeCatalog, await catalog(db(DBS.rollback)));
  check(rbCatalog.length === 0, `rollback: restored schema equals the pre-upgrade schema (${rbCatalog.slice(0, 5).join(", ")})`);
  server = start(`old ${OLD_REF} on restored backup`, OLD_DIR, DBS.rollback);
  summary.timingsMs.rollbackOldStartToHealthy = await healthy(server);
  const rbSnap = await snapshot(seed.owner.cookie);
  const rbSnapDiff = compareSnapshots("rollback", beforeOld, rbSnap);
  check(rbSnapDiff.length === 0, `rollback: every seeded entity reads back through the old API (${rbSnapDiff.slice(0, 8).join("; ")})`);
  summary.phases.rollback = { behaviour: (await behaviour("old build on restored pre-upgrade backup", { existingCookie: seed.owner.cookie })).results, migrations: await migrationsApplied(db(DBS.rollback)) };
  check(summary.phases.rollback.migrations === oldMigrations, `rollback: migration history is the old build's (${summary.phases.rollback.migrations})`);
  await stop(server);
  await dropDb(DBS.rollback);

  // ── C. disaster recovery ───────────────────────────────────────────────────
  log("C: HEAD running on the upgraded data; live backups");
  const drStarted = new Date();
  server = start("HEAD (production stand-in)", NEW_DIR, DBS.upgrade);
  await healthy(server);
  const drBaseline = await snapshot(seed.owner.cookie);
  await schedulerTick("HEAD before disaster", DBS.upgrade, drStarted);
  // (c1) pg_dump -Fc from an exported snapshot, fingerprinted inside the same snapshot: exact even while the app writes
  const snapDump = join(temp, "dr-snapshot.dump");
  const reserved = await db(DBS.upgrade).reserve();
  let snapshotFp;
  try {
    await reserved`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const [{ id }] = await reserved`SELECT pg_export_snapshot() AS id`;
    snapshotFp = await fingerprints(reserved);
    await timed("drSnapshotBackup", () => hostTool("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--snapshot=${id}`, "--file", snapDump, dbUrl(DBS.upgrade)]));
    await reserved`COMMIT`;
  } finally { reserved.release(); }
  // (c2) the documented backup command, run as operators run it (`docker compose exec -T postgres pg_dump -U montral -Fc montral > montral.dump`)
  const docDump = join(temp, "dr-documented.dump");
  const liveBefore = await fingerprints(db(DBS.upgrade));
  await timed("drDocumentedBackup", () => inContainer(["pg_dump", "-U", PG_USER, "-Fc", DBS.upgrade], { stdoutFile: docDump }));
  const liveAfter = await fingerprints(db(DBS.upgrade));
  summary.phases.disasterRecovery = { snapshotDumpBytes: statSync(snapDump).size, documentedDumpBytes: statSync(docDump).size };
  await hostTool("pg_restore", ["--list", docDump]).then(({ stdout }) => check(stdout.includes("TABLE DATA") && stdout.includes("organization"), "dr: the documented dump is a readable custom-format archive"));

  // the disaster: the server dies and the database is gone
  log("C: kill the server and drop the database");
  await stop(server, "SIGKILL");
  await dropDb(DBS.upgrade);
  check((await admin`SELECT 1 FROM pg_database WHERE datname = ${DBS.upgrade}`).length === 0, "dr: the source database is gone");
  const rtoStart = performance.now();
  const stage = {};
  const mark = (k, from) => { stage[k] = Math.round(performance.now() - from); return performance.now(); };
  // documented restore on a brand-new database name, with the PostgreSQL container's own tools
  let t = performance.now();
  await inContainer(["createdb", "-U", PG_USER, DBS.dr]);
  t = mark("createdb", t);
  await inContainer(["pg_restore", "-U", PG_USER, "-d", DBS.dr, "--no-owner", "--exit-on-error"], { stdinFile: docDump });
  t = mark("pgRestore", t);
  server = start("HEAD on restored database", NEW_DIR, DBS.dr);
  await healthy(server);
  t = mark("startToHealthy", t);
  const drBehaviour = await behaviour("HEAD after disaster recovery", { existingCookie: seed.owner.cookie, newEvent: false });
  const drSnap = await snapshot(seed.owner.cookie);
  t = mark("verification", t);
  const rtoMs = Math.round(performance.now() - rtoStart);
  Object.assign(summary.phases.disasterRecovery, { rtoMs, rtoStagesMs: stage, behaviour: drBehaviour.results });
  log("RTO", rtoMs, JSON.stringify(stage));
  const drDiff = compareSnapshots("dr", drBaseline, drSnap);
  check(drDiff.length === 0, `dr: every seeded entity reads back after recovery (${drDiff.slice(0, 8).join("; ")})`);
  // integrity of the documented (live) dump: tables that did not change while it ran must match exactly; tables the
  // running app wrote to must hold between what they had before and after the dump
  const stable = Object.keys(liveBefore).filter((k) => liveAfter[k] && liveBefore[k].f === liveAfter[k].f);
  const moving = Object.keys(liveBefore).filter((k) => !stable.includes(k));
  summary.phases.disasterRecovery.documentedDump = { stableTables: stable.length, tablesWrittenDuringDump: moving };
  await schedulerTick("HEAD after disaster recovery", DBS.dr, new Date(Date.now() - 1000));
  noSchedulerErrors("HEAD after disaster recovery", server);
  const drExit = await stop(server);
  check(drExit?.code === 0, `HEAD after recovery: graceful stop (exit ${JSON.stringify(drExit)})`);
  // exactness of the documented dump: restore it once more into a scratch database before any app runs on it
  await createDb(DBS.drSnapshot);
  await inContainer(["pg_restore", "-U", PG_USER, "-d", DBS.drSnapshot, "--no-owner", "--exit-on-error"], { stdinFile: docDump });
  const docExact = await fingerprints(db(DBS.drSnapshot));
  const stableDrift = stable.filter((k) => !docExact[k] || docExact[k].f !== liveBefore[k].f);
  const movingOut = moving.filter((k) => !docExact[k] || docExact[k].n < Math.min(liveBefore[k].n, liveAfter[k].n) || docExact[k].n > Math.max(liveBefore[k].n, liveAfter[k].n));
  check(stableDrift.length === 0, `dr: documented dump restores every table the app did not write during the dump with an identical SHA-256 fingerprint (${stable.length} tables; drift: ${stableDrift.join(", ")})`);
  check(movingOut.length === 0, `dr: tables written while the documented dump ran restore with a row count between before and after (${moving.join(", ") || "none"}; out of range: ${movingOut.join(", ")})`);
  await dropDb(DBS.drSnapshot);
  // exact restore: the snapshot dump into another new database equals its snapshot, every table and every catalog object
  await createDb(DBS.drSnapshot);
  await timed("drSnapshotRestore", () => hostTool("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", dbUrl(DBS.drSnapshot), snapDump]));
  const snapRestored = await fingerprints(db(DBS.drSnapshot));
  const snapDiff = diffKeys(snapshotFp, snapRestored);
  check(snapDiff.length === 0, `dr: snapshot dump restores every table with the snapshot's row count and SHA-256 fingerprint (${Object.keys(snapshotFp).length} tables, ${Object.values(snapshotFp).reduce((n, v) => n + v.n, 0)} rows; drift: ${snapDiff.join(", ")})`);
  const catalogDrift = diffKeys(upgradedCatalog, await catalog(db(DBS.drSnapshot)));
  check(catalogDrift.length === 0, `dr: restored schema equals the running schema (columns, indexes, constraints, triggers, functions) (${catalogDrift.slice(0, 5).join(", ")})`);
  summary.phases.disasterRecovery.snapshot = { tables: Object.keys(snapshotFp).length, rows: Object.values(snapshotFp).reduce((n, v) => n + v.n, 0) };
  await dropDb(DBS.drSnapshot);
  await dropDb(DBS.dr);
} catch (error) {
  failures.push("aborted: " + (error?.stack ?? String(error)).slice(0, 3000));
  console.error(error);
  for (const p of spawned) if (p.log) console.error(`── ${p.label} log tail ──\n${p.log.slice(-3000)}`);
} finally {
  for (const p of spawned) if (p.exitInfo === null) p.kill("SIGKILL");
  if (temp) rmSync(temp, { recursive: true, force: true });
  target.closeAllConnections?.();
  target.close();
  for (const name of [...clients.keys()]) await closeDb(name);
  for (const name of Object.values(DBS)) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
}

summary.finishedAt = new Date().toISOString();
summary.alertsReceived = alerts.length;
summary.failures = failures;
summary.pass = failures.length === 0;
writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (failures.length) {
  console.error(`UPGRADE_QUALIFICATION_FAIL: ${failures.length} failure(s)\n - ` + failures.join("\n - "));
  process.exit(1);
}
const dr = summary.phases.disasterRecovery;
console.log(`UPGRADE_QUALIFICATION_PASS: ${OLD_REF} -> HEAD upgrade kept every seeded entity (${JSON.stringify(summary.seeded.counts)}); ` +
  `pre-upgrade backup restored and served by the old build; old build on the upgraded schema ${summary.phases.oldBuildOnUpgradedSchema.mode}; ` +
  `disaster recovery RTO ${(dr.rtoMs / 1000).toFixed(1)} s (${JSON.stringify(dr.rtoStagesMs)}), snapshot restore exact over ${dr.snapshot.tables} tables`);
