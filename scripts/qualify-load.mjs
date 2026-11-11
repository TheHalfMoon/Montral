#!/usr/bin/env node
// Load, capacity and backpressure qualification for the self-hosted Node build
// (apps/api/dist/server.mjs) against a real, disposable local PostgreSQL
// database. Everything it touches is local and synthetic: a monitoring target
// HTTP server inside this script, synthetic monitors, synthetic webhooks.
//
//   1. Monitoring throughput: N HTTP monitors (60 s, the API's minimum
//      interval) driven by the server's own 30 s scheduler tick. Measures
//      checks/min, rows written, completion lag (due time -> recorded result),
//      DB connections, RSS, and per-monitor result counts (no lost/duplicate).
//   2. Backpressure: the target answers after 10 s so work piles up until the
//      512-message local queue refuses batches and claims are released. Asserts
//      bounded backlog/RSS, a live process, /health answering, no watchdog
//      exit; then the target recovers and the drain time is measured.
//   3. Webhook ingestion: concurrent POSTs across 50 inboxes (all within the
//      120/min per-inbox limit) plus bursts at one hot inbox (429s and the
//      250-event retention cap).
//   4. API read load: /api/monitors (whole N-monitor project) and the public
//      status page (full board and summary).
//   5. Restart with DB_POOL_MAX=2 and repeat mixed load: bounded degradation.
// Finally the server is stopped gracefully and database invariants are checked
// (no duplicate run generations, results == observations == rollup totals ==
// target requests per monitor).
//
// Output: a JSON summary (also written to LOAD_SUMMARY_PATH) and a final
// `LOAD_QUALIFICATION_PASS: ...` line, or a non-zero exit listing failures.
import { spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import postgres from "../packages/db-pg/node_modules/postgres/src/index.js";

const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL database");
const dbUrl = new URL(connection);
// No query parameters at all: libpq/postgres.js accept ?host= (and similar), which could
// silently redirect the connection away from the local hostname checked here.
if (!["127.0.0.1", "localhost"].includes(dbUrl.hostname) || !/^\/montral_test_[a-zA-Z0-9_]+$/.test(dbUrl.pathname) || dbUrl.search !== "") {
  throw new Error("Load qualification refuses any non-local or non-disposable database");
}

// ── configuration (defaults are what CI runs) ────────────────────────────────
const N = Number(process.env.LOAD_MONITORS ?? 4000);
const INTERVAL_SEC = 60; // the API's minimum interval (routes/monitors.ts)
const SLOW_MS = 10_000; // backpressure: target answers after 10 s ...
const CHECK_TIMEOUT_MS = 15_000; // ... inside the monitors' 15 s timeout, so checks succeed slowly
const WARMUP_MS = 90_000;
const P1_WINDOW_MS = 300_000;
const P5_LOAD_MS = 240_000;
// Both servers run with a 512 MB V8 old space. Uncapped, V8 sizes its heap from host RAM (a 4 GB old space on the
// 16 GB runner) and collects lazily, so RSS measures how much garbage V8 chose to keep, not what the server needs.
// Seen: phase 4 (/api/monitors, 5.6 MB of JSON, ten at a time) on the uncapped first server peaked at 780-1078 MB RSS
// across runs of the same commit (1027.7 / 1038.5 / 1077.9 MB failed the 1024 MB bound in runs 42879433274,
// 42921654043, 42776206602) and then fell back (1078 -> 944, 1039 -> 913), while the capped phase-5 server, serving the
// same list continuously next to webhooks and status reads, stayed at 466-488 MB. A local simulation of ten concurrent
// 4,000-monitor lists peaked at 700-1180 MB RSS uncapped, from run to run of identical work, and at 600-690 MB with the
// cap, without a heap OOM. With the cap,
// retention still fails the run (a heap OOM kills the server); reclaimable garbage is collected instead of counted.
// 512 MB is what V8 itself picks on a 2 GB host (a quarter of RAM), leaving the rest of the 1024 MB RSS bound to
// young generation, code, Buffers and native memory.
const SERVER_OLD_SPACE_MB = 512;
const cappedHeap = () => ({ NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${SERVER_OLD_SPACE_MB}`].filter(Boolean).join(" ") });
const SUMMARY_PATH = resolve(process.env.LOAD_SUMMARY_PATH ?? "load-summary.json");
const APP = "montral-load-qa"; // application_name of this script's own DB connections

// Design constants the thresholds are derived from (apps/api/src/server.ts,
// scheduler.ts, local-check-queue.ts). These are correctness bounds, not tuned timings.
const TICK_S = 30; // scheduler tick
const MAX_SLOT_DELAY_S = 5 * 8; // stable per-monitor queue slot delay
const QUEUE_CAPACITY = 512; // local queue reservations (messages)
const MESSAGE_SIZE = 25; // monitors per message
const CLAIM_ROUND = 1000; // monitors claimed per round (one round may be in hand, unsent)
const QUEUE_CONCURRENCY = 4; // local queue messages processed at once (LOCAL_CHECK_CONCURRENCY)

const T = {
  // A result is due within one tick + the slot delay; 20 s margin for the check itself and DB writes.
  lagP95Sec: TICK_S + MAX_SLOT_DELAY_S + 20,
  // Per monitor in a 300 s window at a 60 s interval: 5 expected; one boundary shift either way.
  perMonitorMin: P1_WINDOW_MS / 1000 / INTERVAL_SEC - 1,
  perMonitorMax: P1_WINDOW_MS / 1000 / INTERVAL_SEC + 1,
  // Claimed-but-unstarted runs can never exceed the queue's reservations plus one unsent claim round.
  maxOutstandingRuns: QUEUE_CAPACITY * MESSAGE_SIZE + CLAIM_ROUND,
  maxRssMb: 1024,
  maxBackpressureRssGrowthMb: 256,
  maxHealthMs: 5000,
  // DB_POOL_MAX=2 cannot keep up with N monitors at 60 s; the floor is "bounded", not "fast":
  // lag p95 under 5 minutes (the watchdog's stall horizon) while every monitor is still checked.
  pool2LagP95Sec: 300,
  recoveryMaxSec: 600,
  // No starvation at normal load and after recovery: a monitor goes at most two intervals plus one tick without a
  // result (one run may be coalesced into a check that started up to half an interval earlier, and dispatch adds up to
  // a tick). Only the DB_POOL_MAX=2 overload phase uses the looser interval + 300 s bound below (pool2LagP95Sec).
  maxGapNormalSec: 2 * INTERVAL_SEC + TICK_S,
  // Run coalescing (beginRuns): a queued run is skipped when a check of its monitor started after it was claimed and
  // either that check is under half an interval old or the run is stale (its lease deadline passed more than a tick +
  // slot delay ago). A drained backlog therefore collapses into the first stale check, while every run claimed after
  // the latest check still starts, at least one tick after the previous claim. Targets: at most 2 results per
  // monitor within 10 s (one tick minus claim jitter and one check) and at most 3 within one interval. Before
  // coalescing a recovered backlog replayed every queued run: up to 6 results in 120 s.
  // The 10 s bound holds for runs that START after recovery: of three such runs a < b < c, b was claimed after a
  // started (a run claimed before a started is covered by a, or held back while a is in flight, for half an interval:
  // it can only start 30 s after a) and likewise c after b started; b's and c's claims are a tick apart, so c starts
  // more than 30 s after a. A run already in flight
  // when the target recovered (started under the 10 s target) is not a queued run and can land in the same 10 s as
  // the next two; it is counted apart (see p2.coalescing) and bounded by maxRunsInFlight.
  coalesceTickWindowSec: TICK_S - 5 - CHECK_TIMEOUT_MS / 1000,
  coalesceMaxPerTick: 2,
  coalesceMaxPerInterval: 3,
  // runs started but not yet recorded: beginRuns stamps a message's runs when it starts, and at most 4 run at once
  maxRunsInFlight: QUEUE_CONCURRENCY * MESSAGE_SIZE,
  requestTimeoutMs: 30_000, // any request slower than this counts as an error
  maxDbConnections: 10, // DB_POOL_MAX default
  maxDbConnectionsPool2: 2,
  hotInboxLimitPerWindow: 120, // montral-hooks.ts: 120 events / 60 s per inbox
  retention: 250, // montral-hooks.ts: newest 250 events per inbox
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
// Comparisons against a bound only pass for a real, finite measurement: an empty sample
// set (null, NaN, +/-Infinity) must fail the qualification, never pass vacuously.
const num = (v) => typeof v === "number" && Number.isFinite(v);
const le = (v, bound) => num(v) && v <= bound;
const ge = (v, bound) => num(v) && v >= bound;
const check = (ok, message) => { if (!ok) { failures.push(message); console.error("FAIL: " + message); } return ok; };
const pct = (values, p) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const latencyStats = (ms) => ({ n: ms.length, p50: round(pct(ms, 50)), p95: round(pct(ms, 95)), p99: round(pct(ms, 99)), max: round(pct(ms, 100)) });
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
async function until(label, fn, timeout, every = 1000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label}` + (last ? ` (${last.message})` : ""));
}
const freePort = () => new Promise((ok, fail) => {
  const s = createTcp();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});
async function pool(total, concurrency, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (next < total) await fn(next++);
  }));
}

// ── local monitoring target ───────────────────────────────────────────────────
let targetDelay = 0;
const hits = new Uint32Array(N);
let targetInFlight = 0;
let targetMaxInFlight = 0;
const target = createServer((req, res) => {
  const m = /^\/m\/(\d+)$/.exec(req.url ?? "");
  if (!m || Number(m[1]) >= N) { res.statusCode = 404; return void res.end(); }
  hits[Number(m[1])]++;
  targetInFlight++;
  targetMaxInFlight = Math.max(targetMaxInFlight, targetInFlight);
  const done = () => { targetInFlight--; res.statusCode = 200; res.end("ok"); };
  if (targetDelay) setTimeout(done, targetDelay); else done();
});
target.keepAliveTimeout = 30_000;
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const targetBase = `http://127.0.0.1:${target.address().port}`;

// ── database (this script's own connections are tagged and excluded) ─────────
const sql = postgres(connection, { max: 3, onnotice: () => {}, connection: { application_name: APP } });

// ── server process management ─────────────────────────────────────────────────
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let child;
let serverLog = "";
const logCounts = { queueRejected: 0, watchdogExit: 0, schedulerFailed: 0, checkBatchFailed: 0, maintenanceFailed: 0 };
const spawned = [];
function startServer(extraEnv = {}) {
  const proc = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
    env: {
      ...process.env,
      DATABASE_URL: connection,
      PORT: String(port),
      BIND_HOST: "127.0.0.1",
      WEB_ORIGIN: base,
      BETTER_AUTH_URL: base,
      WEB_DIST: resolve("apps/web/dist-missing-on-purpose"),
      BETTER_AUTH_SECRET: "montral-load-qualification-only-never-production",
      CRON_SECRET: "montral-load-qualification-cron-only",
      ALLOW_PRIVATE_TARGETS: "true",
      MONTRAL_BILLING_ENABLED: "false",
      MONTRAL_METERING_ENABLED: "false",
      SMTP_URL: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  proc.exitInfo = null;
  proc.exited = new Promise((r) => proc.once("exit", (code, signal) => { proc.exitInfo = { code, signal }; r(proc.exitInfo); }));
  for (const s of [proc.stdout, proc.stderr]) {
    s.setEncoding("utf8");
    s.on("data", (c) => {
      for (const line of c.split("\n")) {
        if (line.includes("could not queue checks")) logCounts.queueRejected++;
        else if (/stalled; exiting|has been running for over/.test(line)) logCounts.watchdogExit++;
        else if (line.includes("monitor scheduler failed")) logCounts.schedulerFailed++;
        else if (line.includes("check batch failed")) logCounts.checkBatchFailed++;
        else if (line.includes("montral maintenance failed")) logCounts.maintenanceFailed++;
      }
      if (!/severity_local|routine:|file: '|line: '|code: '|^\s*[{}]/m.test(c)) serverLog = (serverLog + c).slice(-8000);
    });
  }
  return proc;
}
const alive = () => child && child.exitInfo === null;
async function waitHealthy(proc) {
  await until("server /health", async () => {
    if (proc.exitInfo) throw new Error(`server exited during startup ${JSON.stringify(proc.exitInfo)}: ${serverLog}`);
    return (await fetch(base + "/health", { signal: AbortSignal.timeout(1500) })).ok;
  }, 60_000, 250);
}
async function stopServer(label) {
  const t0 = Date.now();
  child.kill("SIGTERM");
  const exit = await Promise.race([child.exited, sleep(15_000).then(() => null)]);
  if (!exit) { child.kill("SIGKILL"); await child.exited; }
  check(exit && exit.code === 0, `${label}: graceful SIGTERM under load exits 0 (got ${JSON.stringify(exit)})`);
  return { exit, ms: Date.now() - t0 };
}

// ── HTTP client ───────────────────────────────────────────────────────────────
let cookie = "";
async function timed(method, path, { headers = {}, body, auth = false } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, {
      method,
      headers: { ...(auth && cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), origin: base, ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(T.requestTimeoutMs),
    });
    const text = await res.text();
    return { status: res.status, ms: performance.now() - t0, text, res };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, error: e?.name ?? "error" };
  }
}
async function api(method, path, body, headers = {}) {
  const r = await timed(method, path, { body, headers, auth: true });
  const set = r.res?.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ");
  if (set) cookie = set;
  let json = null;
  try { json = JSON.parse(r.text ?? ""); } catch {}
  return { status: r.status, body: json };
}
const statusTally = (results) => {
  const t = {};
  for (const r of results) t[r.status] = (t[r.status] ?? 0) + 1;
  return t;
};
const fiveXx = (results) => results.filter((r) => r.status >= 500).length;
const errorsOf = (results, ok) => results.filter((r) => !ok.includes(r.status)).length;

// ── samplers: health latency, RSS, DB connections, queue backlog ─────────────
let phase = "startup";
const phaseStats = {};
const ps = () => (phaseStats[phase] ??= { healthMs: [], healthFail: 0, rssMb: [], conns: [], activeConns: [], lockWaits: [], outstanding: [] });
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (m) return Number(m[1]) / 1024;
  } catch {}
  try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024; } catch { return null; }
}
let samplersOn = true;
const healthLoop = (async () => {
  while (samplersOn) {
    if (alive()) {
      const r = await timed("GET", "/health");
      if (r.status === 200) ps().healthMs.push(r.ms); else if (alive()) ps().healthFail++;
      const mb = rssMb(child.pid);
      if (mb) ps().rssMb.push(mb);
    }
    await sleep(1000);
  }
})();
// Claimed runs that were neither released nor recorded, over the last 30 minutes (longer than any
// backlog this script can build: the slow phase is capped at 10 min + 90 s).
const outstandingQuery = () => sql`
  select count(*)::int as n from load_claim_log c
  where c.kind = 'claim' and c.at > now() - interval '30 minutes'
    and not exists (select 1 from load_claim_log r where r.kind = 'release' and r.monitor_id = c.monitor_id and r.generation = c.generation)
    and not exists (select 1 from monitor_observation o where o.monitor_id = c.monitor_id and o.generation = c.generation)
    -- a run older than the latest started one, or covered by a check that started after its claim (coalesced), can never start
    and not exists (select 1 from monitor m where m.id = c.monitor_id and (c.generation <= m.last_run_generation or c.generation <= m.checked_through_generation))`;
let dbSamples = 0;
const samplerErrors = [];
const dbLoop = (async () => {
  while (samplersOn) {
    try {
      const [a] = await sql`
        select count(*)::int as conns,
               (count(*) filter (where state = 'active'))::int as active,
               (count(*) filter (where wait_event_type = 'Lock'))::int as lock_waits
        from pg_stat_activity
        where datname = current_database() and backend_type = 'client backend' and application_name <> ${APP}`;
      ps().conns.push(a.conns); ps().activeConns.push(a.active); ps().lockWaits.push(a.lock_waits);
      if (++dbSamples % 3 === 0) { // the anti-join is the heaviest sample; every 15 s
        const [o] = await outstandingQuery();
        ps().outstanding.push(o.n);
      }
    } catch (e) {
      // A failed sample is a failed measurement, not a silent gap.
      if (samplersOn) samplerErrors.push(`${phase}: ${e?.message ?? e}`.slice(0, 300));
    }
    await sleep(5000);
  }
})();
const maxOf = (a) => (a.length ? Math.max(...a) : null); // null, never -Infinity or 0, when nothing was sampled
const minOf = (a) => (a.length ? Math.min(...a) : null);
function summarizePhase(name) {
  const s = phaseStats[name];
  if (!s) return null;
  return {
    samples: { health: s.healthMs.length + s.healthFail, rss: s.rssMb.length, db: s.conns.length, outstanding: s.outstanding.length },
    health: { ...latencyStats(s.healthMs), failures: s.healthFail },
    // every 10th 1 s sample, so a plateau can be told from steady growth
    rssMb: { min: round(minOf(s.rssMb)), max: round(maxOf(s.rssMb)), last: round(s.rssMb.at(-1) ?? null), series10s: s.rssMb.filter((_, i) => i % 10 === 0).map((v) => Math.round(v)) },
    dbConnections: { max: maxOf(s.conns), maxActive: maxOf(s.activeConns), maxLockWaits: maxOf(s.lockWaits) },
    outstandingRuns: { max: maxOf(s.outstanding), last: s.outstanding.at(-1) ?? null },
  };
}

// Each measured phase must actually have been sampled; otherwise its bounds would be vacuous.
function checkSamples(name, s) {
  check(!!s && s.samples.health > 0 && s.samples.rss > 0 && s.samples.db > 0,
    `${name}: health, RSS and DB samples exist (${JSON.stringify(s?.samples)})`);
  if (["p1_throughput", "p2_backpressure", "p2_recovery", "p5_pool2"].includes(name))
    check(!!s && s.samples.outstanding > 0, `${name}: outstanding-run samples exist (${s?.samples.outstanding})`);
}

// ── measurement queries ───────────────────────────────────────────────────────
let orgId;
async function windowStats(from, to) {
  const [c] = await sql`select count(*)::int as n from check_result where checked_at >= ${from} and checked_at < ${to}`;
  const [lag] = await sql`
    select count(*)::int as n,
      percentile_cont(0.5) within group (order by extract(epoch from o.observed_at - c.due_at)::float8) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from o.observed_at - c.due_at)::float8) as p95,
      percentile_cont(0.99) within group (order by extract(epoch from o.observed_at - c.due_at)::float8) as p99,
      max(extract(epoch from o.observed_at - c.due_at)::float8) as max
    from monitor_observation o
    join load_claim_log c on c.kind = 'claim' and c.monitor_id = o.monitor_id and c.generation = o.generation
    where o.observed_at >= ${from} and o.observed_at < ${to}`;
  const minutes = (to - from) / 60_000;
  return {
    windowSec: Math.round((to - from) / 1000),
    checkResults: c.n,
    checksPerMinute: round(c.n / minutes),
    completionLagSec: { n: lag.n, p50: round(lag.p50), p95: round(lag.p95), p99: round(lag.p99), max: round(lag.max) },
  };
}
/** Longest stretch without a result per monitor in [from, to], window edges included (seconds). */
async function maxGap(from, to) {
  const rows = await sql`
    with o as (
      select m.id, extract(epoch from x.observed_at)::float8 as t from monitor m
      left join monitor_observation x on x.monitor_id = m.id and x.observed_at >= ${from} and x.observed_at < ${to}
      where m.organization_id = ${orgId}),
    g as (
      select id, coalesce(max(gap), ${(to - from) / 1000}::float8) as gap from (
        select id, t - coalesce(lag(t) over (partition by id order by t), ${from.getTime() / 1000}::float8) as gap from o where t is not null
        union all select id, ${to.getTime() / 1000}::float8 - max(t) from o where t is not null group by id
        union all select id, null from o group by id having count(t) = 0) z group by id)
    select max(gap)::float8 as max, count(*)::int as monitors from g`;
  return { maxSec: round(rows[0].max), monitors: rows[0].monitors };
}
async function perMonitorCounts(from, to) {
  const rows = await sql`
    select m.id, count(o.id)::int as n from monitor m
    left join monitor_observation o on o.monitor_id = m.id and o.observed_at >= ${from} and o.observed_at < ${to}
    where m.organization_id = ${orgId} group by m.id`;
  const counts = rows.map((r) => r.n);
  const histogram = {};
  for (const n of counts) histogram[n] = (histogram[n] ?? 0) + 1;
  return { monitors: rows.length, min: minOf(counts), max: maxOf(counts), histogram };
}
const releasesSince = async (from) => (await sql`select count(*)::int as n from load_claim_log where kind = 'release' and at >= ${from}`)[0].n;

const summary = {
  qualification: "montral-load-backpressure",
  startedAt: new Date().toISOString(),
  node: process.version,
  host: { platform: process.platform, cpus: (await import("node:os")).cpus().length, memGb: round((await import("node:os")).totalmem() / 2 ** 30) },
  config: { monitors: N, intervalSec: INTERVAL_SEC, slowTargetMs: SLOW_MS, checkTimeoutMs: CHECK_TIMEOUT_MS, tickSec: TICK_S, queueCapacityMessages: QUEUE_CAPACITY, messageSize: MESSAGE_SIZE, serverMaxOldSpaceMb: SERVER_OLD_SPACE_MB },
  thresholds: T,
  phases: {},
};

try {
  // ── setup ──────────────────────────────────────────────────────────────────
  child = startServer(cappedHeap()); // see SERVER_OLD_SPACE_MB
  await waitHealthy(child); // migrations are applied before the server listens
  // Test-only instrumentation in the disposable database: one statement-level
  // trigger logs each claim (run_generation + 1, with the due time it claimed)
  // and each release (next_check_at moved back, same generation). The app's
  // queries are unchanged; this adds one small INSERT ... SELECT per UPDATE statement.
  await sql.unsafe(`
    create table if not exists load_claim_log (
      monitor_id uuid not null, generation integer not null, kind text not null,
      due_at timestamptz, at timestamptz not null default clock_timestamp());
    create index if not exists load_claim_log_key on load_claim_log (monitor_id, generation);
    create index if not exists load_claim_log_at on load_claim_log (at);
    create or replace function load_claim_log_fn() returns trigger language plpgsql as $f$
    begin
      insert into load_claim_log (monitor_id, generation, kind, due_at)
      select n.id, n.run_generation,
             case when n.run_generation = o.run_generation + 1 then 'claim' else 'release' end,
             o.next_check_at
      from new_rows n join old_rows o on o.id = n.id
      where n.run_generation = o.run_generation + 1
         or (n.run_generation = o.run_generation and n.next_check_at < o.next_check_at and n.type <> 'heartbeat');
      -- a run that started (beginRuns): tells a coalesced run (never began) from one that began and lost its result
      insert into load_claim_log (monitor_id, generation, kind)
      select n.id, n.last_run_generation, 'start'
      from new_rows n join old_rows o on o.id = n.id
      where n.last_run_generation > o.last_run_generation;
      return null;
    end $f$;
    drop trigger if exists load_claim_log_trg on monitor;
    create trigger load_claim_log_trg after update on monitor
      referencing old table as old_rows new table as new_rows
      for each statement execute function load_claim_log_fn();`);

  const email = `load-qa-${Date.now()}@example.test`;
  const signup = await api("POST", "/api/auth/sign-up/email", { email, name: "Synthetic load QA", password: "synthetic load qualification" });
  if (signup.status !== 200) throw new Error("signup failed: " + JSON.stringify(signup));
  await api("GET", "/api/monitors"); // resolves (and creates if needed) the default project
  const projects = await api("GET", "/api/projects");
  const p0 = (Array.isArray(projects.body) ? projects.body : projects.body?.projects ?? [])[0];
  if (!p0?.id) throw new Error("no default project: " + JSON.stringify(projects));
  [{ organization_id: orgId }] = await sql`select organization_id from project where id = ${p0.id}`;

  // N monitors with due times spread over one interval (as monitors created over time would be).
  const seeded = await sql`
    insert into monitor (organization_id, project_id, name, type, target, interval_sec, timeout_ms, failure_threshold, next_check_at)
    select ${orgId}::text, ${p0.id}::uuid, 'Load ' || lpad(i::text, 5, '0'), 'http', ${targetBase}::text || '/m/' || i::text,
           ${INTERVAL_SEC}::int, ${CHECK_TIMEOUT_MS}::int, 3,
           now() + make_interval(secs => ((i * 7919) % ${INTERVAL_SEC * 1000}::int) / 1000.0)
    from generate_series(0, ${N - 1}::int) i
    returning id, target`;
  const indexOf = new Map(seeded.map((r) => [r.id, Number(r.target.split("/m/")[1])]));
  check(seeded.length === N, `seeded ${N} monitors`);
  // Public status page over 50 of them, created through the API.
  const pageSlug = `load-qa-${Date.now().toString(36)}`;
  const page = await api("POST", "/api/status-pages", { slug: pageSlug, title: "Load QA", monitorIds: seeded.slice(0, 50).map((r) => r.id) }, { "x-project-id": p0.id });
  if (page.status !== 201 && page.status !== 200) throw new Error("status page creation failed: " + JSON.stringify(page));
  log(`setup done: ${N} monitors -> ${targetBase}, status page ${pageSlug}`);

  // ── 1. monitoring throughput ───────────────────────────────────────────────
  phase = "p1_throughput";
  const p1Start = Date.now();
  await sleep(WARMUP_MS);
  const w1From = new Date();
  await sleep(P1_WINDOW_MS);
  const w1To = new Date();
  if (!alive()) throw new Error("server exited during throughput phase: " + serverLog);
  await sleep(15_000); // let checks completed before w1To finish their writes
  const p1 = await windowStats(w1From, w1To);
  p1.perMonitor = await perMonitorCounts(w1From, w1To);
  p1.maxGapWithoutResult = await maxGap(w1From, w1To);
  const [rows1] = await sql`select (select count(*) from check_result)::int as check_results, (select count(*) from monitor_observation)::int as observations`;
  p1.rowsTotal = rows1;
  p1.releases = await releasesSince(new Date(p1Start));
  p1.targetMaxInFlight = targetMaxInFlight;
  p1.resources = summarizePhase("p1_throughput");
  summary.phases.throughput = p1;
  log("phase 1", JSON.stringify(p1));
  check(p1.perMonitor.monitors === N, "phase 1: every seeded monitor counted");
  check(ge(p1.perMonitor.min, T.perMonitorMin), `phase 1: no lost checks (min results per monitor ${p1.perMonitor.min} >= ${T.perMonitorMin})`);
  check(le(p1.perMonitor.max, T.perMonitorMax), `phase 1: no duplicate checks (max results per monitor ${p1.perMonitor.max} <= ${T.perMonitorMax})`);
  check(p1.maxGapWithoutResult.monitors === N && le(p1.maxGapWithoutResult.maxSec, T.maxGapNormalSec), `phase 1: no starvation, every monitor checked at least every ${T.maxGapNormalSec} s (two intervals + one tick; longest gap ${p1.maxGapWithoutResult.maxSec} s)`);
  check(le(p1.completionLagSec.p95, T.lagP95Sec), `phase 1: completion lag p95 ${p1.completionLagSec.p95}s <= ${T.lagP95Sec}s`);
  check(p1.releases === 0, `phase 1: no backpressure releases at nominal load (got ${p1.releases})`);
  check(le(p1.resources.dbConnections.max, T.maxDbConnections), `phase 1: server DB connections ${p1.resources.dbConnections.max} <= pool max ${T.maxDbConnections}`);
  const p1OutstandingMax = p1.resources.outstandingRuns.max ?? 0; // absence fails checkSamples below

  // ── 2. backpressure: slow target, then recovery ────────────────────────────
  phase = "p2_backpressure";
  targetMaxInFlight = 0;
  targetDelay = SLOW_MS;
  const slowFrom = new Date();
  log(`phase 2: target now answers after ${SLOW_MS} ms`);
  let capReachedAt = null;
  const slowDeadline = Date.now() + 600_000;
  while (Date.now() < slowDeadline) {
    await sleep(10_000);
    if (!alive()) throw new Error("server exited under backpressure: " + JSON.stringify(child.exitInfo) + serverLog);
    if (!capReachedAt && (await releasesSince(slowFrom)) > 0) { capReachedAt = Date.now(); log("phase 2: queue capacity reached, claims released"); }
    if (capReachedAt && Date.now() - capReachedAt >= 90_000) break; // hold at capacity for three ticks
  }
  const slowTo = new Date();
  const p2 = {
    slowSec: Math.round((slowTo - slowFrom) / 1000),
    capacityReachedAfterSec: capReachedAt ? Math.round((capReachedAt - slowFrom.getTime()) / 1000) : null,
    releasesUnderBackpressure: await releasesSince(slowFrom),
    queueRejectionLogLines: logCounts.queueRejected,
    targetMaxInFlight,
    duringSlow: await windowStats(slowFrom, slowTo),
    resources: summarizePhase("p2_backpressure"),
  };
  check(capReachedAt !== null, "phase 2: the local queue reached capacity and refused work (backpressure exercised)");
  check(le(p2.resources.outstandingRuns.max, T.maxOutstandingRuns), `phase 2: outstanding runs ${p2.resources.outstandingRuns.max} <= ${T.maxOutstandingRuns} (512 messages x 25 + one claim round)`);
  check(num(p1.resources.rssMb.max) && le(p2.resources.rssMb.max - p1.resources.rssMb.max, T.maxBackpressureRssGrowthMb), `phase 2: RSS growth under backpressure ${round(p2.resources.rssMb.max - p1.resources.rssMb.max)} MB <= ${T.maxBackpressureRssGrowthMb} MB`);
  check(p2.resources.health.failures === 0 && le(p2.resources.health.max, T.maxHealthMs), `phase 2: /health answered every probe within ${T.maxHealthMs} ms (max ${p2.resources.health.max}, failures ${p2.resources.health.failures})`);
  check(logCounts.watchdogExit === 0 && alive(), "phase 2: watchdog did not restart the process");
  check(p2.targetMaxInFlight <= 4 * 20, `phase 2: concurrent checks ${p2.targetMaxInFlight} <= 80 (4 messages x 20)`);

  phase = "p2_recovery";
  targetDelay = 0;
  const recoverFrom = Date.now();
  log("phase 2: target recovered");
  let recoveredAt = null;
  let lastLag = null;
  while (Date.now() - recoverFrom < T.recoveryMaxSec * 1000) {
    await sleep(10_000);
    if (!alive()) throw new Error("server exited during recovery: " + serverLog);
    const to = new Date();
    const w = await windowStats(new Date(to - 60_000), to);
    lastLag = w.completionLagSec;
    const [o] = await outstandingQuery();
    if (w.completionLagSec.n > 0 && le(w.completionLagSec.p95, T.lagP95Sec) && o.n <= Math.max(p1OutstandingMax * 1.5, p1OutstandingMax + 500)) {
      recoveredAt = Date.now();
      break;
    }
  }
  p2.recoverySec = recoveredAt ? Math.round((recoveredAt - recoverFrom) / 1000) : null;
  p2.lagAtRecovery = lastLag;
  check(recoveredAt !== null, `phase 2: backlog drained and lag p95 back within ${T.lagP95Sec}s within ${T.recoveryMaxSec}s (last window ${JSON.stringify(lastLag)})`);
  // Steady state again: a full post-recovery window, every monitor checked.
  const w2From = new Date();
  await sleep(120_000);
  const w2To = new Date();
  await sleep(15_000);
  p2.afterRecovery = await windowStats(w2From, w2To);
  p2.afterRecovery.perMonitor = await perMonitorCounts(w2From, w2To);
  p2.afterRecovery.maxGapWithoutResult = await maxGap(new Date(recoveredAt ?? w2From.getTime()), w2To);
  // Catch-up: runs queued while the target was slow execute late once it recovers.
  const [catchUp] = await sql`
    select max(n)::int as max_per_monitor from (
      select o.monitor_id, count(*) as n from monitor_observation o
      where o.observed_at >= ${new Date(recoverFrom)} and o.observed_at < ${new Date(recoverFrom + 120_000)} group by o.monitor_id) x`;
  p2.maxResultsPerMonitorInFirst120sOfRecovery = catchUp.max_per_monitor;
  // Run coalescing: a queued run whose monitor got a result after the run was claimed is skipped, so the backlog no
  // longer replays as a burst of checks. Densest stretch of results per monitor from the moment the target recovered
  // to the end of the post-recovery window, over any one-interval and any one-tick (minus jitter) window.
  // Each result carries the time its run started (the logged beginRuns start of its generation).
  const allObs = await sql`
    select o.monitor_id::text as id, o.generation, extract(epoch from o.observed_at)::float8 as t,
      (select extract(epoch from min(s.at))::float8 from load_claim_log s
        where s.kind = 'start' and s.monitor_id = o.monitor_id and s.generation = o.generation) as started
    from monitor_observation o
    join monitor m on m.id = o.monitor_id and m.organization_id = ${orgId}
    where o.observed_at >= ${new Date(recoverFrom)} and o.observed_at < ${w2To} order by o.monitor_id, o.observed_at`;
  // Runs in flight when the target recovered: started (stamped by beginRuns) under the slow target, recorded after
  // recovery. Coalescing cannot skip them: they were already checking. A message's 25 runs are stamped together and
  // checked 20 at a time, 10 s each, so such a result lands up to ~20 s after its stamp, and can fall in the same 10 s
  // as two post-recovery runs of its monitor: a queued run claimed after the in-flight one started (which that check
  // must not cover: "a run that started before the claim never holds it back", docs/evidence/2026-11-09-load-
  // backpressure.md, #54), then the run claimed after that one started. Run 42921692743 failed the per-tick bound with
  // one monitor at 3 (3,914 at 1, 85 at 2); three post-recovery runs cannot do that (see T), so one of the three was in
  // flight. The per-tick bound is asserted, unchanged, on runs that started after recovery; results of runs in flight
  // at recovery are bounded apart (T.maxRunsInFlight) and reported with the timelines of monitors they push over 2.
  // A result without a logged start counts as post-recovery (stricter).
  const recoverSec = recoverFrom / 1000;
  const inFlight = allObs.filter((o) => o.started !== null && o.started < recoverSec);
  const obs = allObs.filter((o) => !(o.started !== null && o.started < recoverSec));
  const densest = (windowSec, obs) => {
    let max = 0, monitorsOver = {}, i = 0;
    const over = []; // monitors above the per-tick bound, for the diagnostics below
    while (i < obs.length) {
      let j = i;
      while (j < obs.length && obs[j].id === obs[i].id) j++;
      let worst = 0;
      for (let a = i, b = i; b < j; b++) {
        while (obs[b].t - obs[a].t >= windowSec) a++;
        worst = Math.max(worst, b - a + 1);
      }
      max = Math.max(max, worst);
      monitorsOver[worst] = (monitorsOver[worst] ?? 0) + 1;
      if (worst > T.coalesceMaxPerTick) over.push(obs[i].id);
      i = j;
    }
    return { max, histogram: monitorsOver, over };
  };
  const { over: _o1, ...perInterval } = densest(INTERVAL_SEC, allObs);
  const { over: _o2, ...perTick } = densest(T.coalesceTickWindowSec, obs);
  const { over: denseWithInFlight, ...perTickAllResults } = densest(T.coalesceTickWindowSec, allObs);
  // The run timeline (seconds from recovery) of monitors whose densest 10 s exceeds the bound once results of runs in
  // flight at recovery are counted: evidence of which runs made it, in the summary rather than lost with the database.
  const timelines = [];
  for (const id of denseWithInFlight.slice(0, 5)) {
    const events = await sql`
      select kind, generation, round((extract(epoch from at)::float8 - ${recoverSec})::numeric, 2)::float8 as at,
        round((extract(epoch from due_at)::float8 - ${recoverSec})::numeric, 2)::float8 as due
      from load_claim_log where monitor_id = ${id} and at >= ${new Date(recoverFrom - 300_000)} and at < ${w2To}
      union all
      select 'result', generation, round((extract(epoch from observed_at)::float8 - ${recoverSec})::numeric, 2)::float8, null
      from monitor_observation where monitor_id = ${id} and observed_at >= ${new Date(recoverFrom - 300_000)} and observed_at < ${w2To}
      order by 3`;
    timelines.push({ monitor: id, events: events.map((e) => [e.kind, e.generation, e.at, e.due]) });
  }
  p2.coalescing = {
    windowFrom: new Date(recoverFrom).toISOString(), windowTo: w2To.toISOString(), results: allObs.length,
    resultsOfRunsStartedAfterRecovery: obs.length,
    inFlightAtRecovery: { results: inFlight.length, monitors: new Set(inFlight.map((o) => o.id)).size, lastResultSec: round(maxOf(inFlight.map((o) => o.t - recoverSec))) },
    perInterval, perTick, perTickAllResults, timelines,
  };
  p2.recoveryResources = summarizePhase("p2_recovery");
  summary.phases.backpressure = p2;
  log("phase 2", JSON.stringify(p2));
  check(p2.afterRecovery.perMonitor.monitors === N && ge(p2.afterRecovery.perMonitor.min, 1), `phase 2: every one of ${N} monitors checked again after recovery (no starvation; counted ${p2.afterRecovery.perMonitor.monitors}, min ${p2.afterRecovery.perMonitor.min})`);
  check(p2.afterRecovery.maxGapWithoutResult.monitors === N && le(p2.afterRecovery.maxGapWithoutResult.maxSec, T.maxGapNormalSec), `phase 2: after recovery every monitor checked at least every ${T.maxGapNormalSec} s (longest gap ${p2.afterRecovery.maxGapWithoutResult.maxSec} s)`);
  check(le(p2.afterRecovery.completionLagSec.p95, T.lagP95Sec), `phase 2: post-recovery lag p95 ${p2.afterRecovery.completionLagSec.p95}s <= ${T.lagP95Sec}s`);
  check(p2.coalescing.results > 0 && le(p2.coalescing.perInterval.max, T.coalesceMaxPerInterval), `phase 2: stale runs coalesced, at most ${T.coalesceMaxPerInterval} results per monitor within any ${INTERVAL_SEC} s after recovery (max ${p2.coalescing.perInterval.max}, ${JSON.stringify(p2.coalescing.perInterval.histogram)})`);
  check(p2.coalescing.resultsOfRunsStartedAfterRecovery > 0 && le(p2.coalescing.perTick.max, T.coalesceMaxPerTick), `phase 2: at most ${T.coalesceMaxPerTick} results per monitor within any ${T.coalesceTickWindowSec} s from runs started after recovery (max ${p2.coalescing.perTick.max}, ${JSON.stringify(p2.coalescing.perTick.histogram)}; with the ${p2.coalescing.inFlightAtRecovery.results} results of runs in flight at recovery: max ${p2.coalescing.perTickAllResults.max})`);
  check(le(p2.coalescing.inFlightAtRecovery.results, T.maxRunsInFlight), `phase 2: results of runs in flight when the target recovered ${p2.coalescing.inFlightAtRecovery.results} <= ${T.maxRunsInFlight} (running messages x ${MESSAGE_SIZE})`);

  // ── 3 + 4. webhooks and API reads (monitoring keeps running underneath) ────
  phase = "p3_webhooks";
  const inboxes = [];
  for (let p = 0; p < 5; p++) {
    const proj = await api("POST", "/api/projects", { name: `Load QA hooks ${p}` });
    if (proj.status !== 201) throw new Error("project creation failed: " + JSON.stringify(proj));
    for (let i = 0; i < 10; i++) {
      const inbox = await api("POST", "/api/hooks/inboxes", { name: `load-${p}-${i}` }, { "x-project-id": proj.body.id });
      if (inbox.status !== 201) throw new Error("inbox creation failed: " + JSON.stringify(inbox));
      inboxes.push(inbox.body);
    }
  }
  const hot = (await api("POST", "/api/hooks/inboxes", { name: "load-hot" }, { "x-project-id": p0.id })).body;
  if (!hot?.path) throw new Error("hot inbox creation failed");
  const hookPayload = (seq) => JSON.stringify({ event: "synthetic.load", seq, data: "x".repeat(160) });
  const post = (path, seq) => timed("POST", path, { body: hookPayload(seq), headers: { "x-request-id": `load-${seq}`, "x-event-type": "synthetic.load", origin: "https://sender.example.test" } });

  async function fanOut(total, label, seqBase) {
    const results = new Array(total);
    const t0 = performance.now();
    await pool(total, 50, async (i) => { results[i] = await post(inboxes[i % inboxes.length].path, seqBase + i); });
    const sec = (performance.now() - t0) / 1000;
    const accepted = results.filter((r) => r.status === 202).length;
    return { label, total, concurrency: 50, inboxes: inboxes.length, seconds: round(sec, 2), acceptedPerSec: round(accepted / sec), accepted, statuses: statusTally(results), latencyMs: latencyStats(results.map((r) => r.ms)), fiveXx: fiveXx(results) };
  }
  const fan = await fanOut(5000, "fan-out", 0);
  const storedRows = await sql`select inbox_id::text, count(*)::int as n, count(distinct headers->>'x-request-id')::int as ids from montral_hook_event where inbox_id::text in ${sql(inboxes.map((i) => i.id))} group by inbox_id`;
  fan.stored = storedRows.reduce((a, r) => a + r.n, 0);
  fan.storedDistinctRequestIds = storedRows.reduce((a, r) => a + r.ids, 0);
  check(fan.fiveXx === 0 && fan.accepted === 5000, `webhooks: all 5000 fan-out POSTs accepted with 202 (statuses ${JSON.stringify(fan.statuses)})`);
  check(fan.stored === fan.accepted && fan.storedDistinctRequestIds === fan.accepted, `webhooks: stored ${fan.stored} (distinct ${fan.storedDistinctRequestIds}) == accepted ${fan.accepted}`);

  // Hot inbox: three bursts of 200, each in a fresh 60 s rate-limit window; API reads run between bursts.
  const bursts = [];
  async function burst(n) {
    const results = new Array(200);
    const t0 = performance.now();
    await pool(200, 50, async (i) => { results[i] = await post(hot.path, 100_000 + n * 1000 + i); });
    bursts.push({ burst: n, seconds: round((performance.now() - t0) / 1000, 2), statuses: statusTally(results), accepted: results.filter((r) => r.status === 202).length, latencyMs: latencyStats(results.map((r) => r.ms)), fiveXx: fiveXx(results) });
  }
  let burstStart = Date.now();
  await burst(1);

  phase = "p4_reads";
  const reads = {};
  async function readLoad(label, path, total, concurrency, extra = {}) {
    const results = new Array(total);
    const t0 = performance.now();
    await pool(total, concurrency, async (i) => { results[i] = await timed("GET", path, extra); });
    const sec = (performance.now() - t0) / 1000;
    reads[label] = { path: path.replace(pageSlug, ":slug"), total, concurrency, seconds: round(sec, 2), perSec: round(total / sec), statuses: statusTally(results), errors: errorsOf(results, [200]), latencyMs: latencyStats(results.map((r) => r.ms)), responseBytes: results.find((r) => r.text)?.text.length ?? 0 };
  }
  await readLoad("monitorsList", "/api/monitors", 100, 10, { auth: true, headers: { "x-project-id": p0.id } });
  await readLoad("statusSummary", `/api/public/status/${pageSlug}/summary`, 2000, 50);
  await readLoad("statusPage", `/api/public/status/${pageSlug}`, 500, 20);
  for (const [label, r] of Object.entries(reads)) check(r.errors === 0, `reads: ${label} ${r.total} requests all 200 within ${T.requestTimeoutMs} ms (statuses ${JSON.stringify(r.statuses)})`);
  reads.resources = summarizePhase("p4_reads");
  summary.phases.apiReads = reads;
  log("phase 4", JSON.stringify(reads));

  phase = "p3_webhooks";
  await sleep(Math.max(0, burstStart + 62_000 - Date.now()));
  burstStart = Date.now();
  await burst(2);
  await sleep(Math.max(0, burstStart + 62_000 - Date.now()));
  await burst(3);
  const [hotStored] = await sql`select count(*)::int as n from montral_hook_event where inbox_id = ${hot.id}`;
  const hotAccepted = bursts.reduce((a, b) => a + b.accepted, 0);
  const hotRes = { requests: 600, accepted: hotAccepted, rateLimited: bursts.reduce((a, b) => a + (b.statuses[429] ?? 0), 0), stored: hotStored.n, expectedStored: Math.min(hotAccepted, T.retention), bursts };
  for (const b of bursts) {
    check(b.fiveXx === 0, `webhooks: hot burst ${b.burst} has no 5xx`);
    check(b.accepted === T.hotInboxLimitPerWindow && (b.statuses[429] ?? 0) === 200 - T.hotInboxLimitPerWindow, `webhooks: hot burst ${b.burst} accepted exactly ${T.hotInboxLimitPerWindow}, rest 429 (${JSON.stringify(b.statuses)})`);
  }
  check(hotAccepted > T.retention, `webhooks: hot inbox accepted ${hotAccepted} > ${T.retention} so retention is exercised`);
  check(hotRes.stored === hotRes.expectedStored, `webhooks: hot inbox stored ${hotRes.stored} == min(accepted, ${T.retention}) = ${hotRes.expectedStored}`);
  summary.phases.webhooks = { fanOut: fan, hotInbox: hotRes, resources: summarizePhase("p3_webhooks") };
  log("phase 3", JSON.stringify(summary.phases.webhooks));

  // Startup and shutdown are excluded: /health is expected to be unavailable there.
  for (const name of Object.keys(phaseStats).filter((n) => n.startsWith("p"))) {
    const s = summarizePhase(name);
    checkSamples(name, s);
    check(s.health.failures === 0 && le(s.health.max, T.maxHealthMs), `${name}: /health always answered within ${T.maxHealthMs} ms (max ${s.health.max}, failures ${s.health.failures})`);
    check(le(s.rssMb.max, T.maxRssMb), `${name}: RSS ${s.rssMb.max} MB <= ${T.maxRssMb} MB`);
    check(le(s.dbConnections.max, T.maxDbConnections), `${name}: server DB connections ${s.dbConnections.max} <= ${T.maxDbConnections}`);
  }
  phase = "stopping";
  const stopWindows = [];
  stopWindows.push(Date.now());
  summary.firstServerStop = await stopServer("server (pool 10)");

  // ── 5. DB connection exhaustion: DB_POOL_MAX=2 under mixed load ────────────
  phase = "startup2";
  // An uncapped first run reached 1150 MB RSS here; the same old-space cap as the first server (SERVER_OLD_SPACE_MB).
  child = startServer({ DB_POOL_MAX: "2", ...cappedHeap() });
  await waitHealthy(child);
  phase = "p5_pool2";
  const p5From = new Date();
  const p5Reads = [];
  const p5Monitors = [];
  let p5Running = true;
  const readers = Array.from({ length: 20 }, async (_, k) => {
    while (p5Running) {
      if (k < 2) p5Monitors.push(await timed("GET", "/api/monitors", { auth: true, headers: { "x-project-id": p0.id } }));
      else p5Reads.push(await timed("GET", `/api/public/status/${pageSlug}/summary`));
    }
  });
  await sleep(30_000);
  const fan5 = await fanOut(2000, "fan-out under DB_POOL_MAX=2", 200_000);
  await sleep(Math.max(0, p5From.getTime() + P5_LOAD_MS - Date.now()));
  p5Running = false;
  await Promise.all(readers);
  const p5To = new Date();
  if (!alive()) throw new Error("server exited with DB_POOL_MAX=2: " + JSON.stringify(child.exitInfo) + serverLog);
  await sleep(15_000);
  const p5 = await windowStats(new Date(p5From.getTime() + 60_000), p5To);
  p5.perMonitor = await perMonitorCounts(new Date(p5From.getTime() + 60_000), p5To);
  p5.statusSummary = { total: p5Reads.length, statuses: statusTally(p5Reads), errors: errorsOf(p5Reads, [200]), latencyMs: latencyStats(p5Reads.map((r) => r.ms)) };
  p5.monitorsList = { total: p5Monitors.length, statuses: statusTally(p5Monitors), errors: errorsOf(p5Monitors, [200]), latencyMs: latencyStats(p5Monitors.map((r) => r.ms)) };
  const stored5 = await sql`select count(*)::int as n from montral_hook_event where inbox_id::text in ${sql(inboxes.map((i) => i.id))}`;
  fan5.storedTotalAllInboxes = stored5[0].n;
  p5.webhooks = fan5;
  p5.resources = summarizePhase("p5_pool2");
  p5.maxOldSpaceMb = SERVER_OLD_SPACE_MB;
  summary.phases.dbPool2 = p5;
  log("phase 5", JSON.stringify(p5));
  checkSamples("p5_pool2", p5.resources);
  check(le(p5.resources.dbConnections.max, T.maxDbConnectionsPool2), `phase 5: server DB connections ${p5.resources.dbConnections.max} <= DB_POOL_MAX 2`);
  check(p5.statusSummary.errors === 0 && p5.monitorsList.errors === 0, `phase 5: reads degrade without errors or ${T.requestTimeoutMs} ms timeouts (summary ${JSON.stringify(p5.statusSummary.statuses)}, monitors ${JSON.stringify(p5.monitorsList.statuses)})`);
  check(fan5.fiveXx === 0 && fan5.accepted === 2000, `phase 5: all 2000 webhooks accepted (statuses ${JSON.stringify(fan5.statuses)})`);
  check(fan5.storedTotalAllInboxes === 5000 + 2000, `phase 5: stored webhook events ${fan5.storedTotalAllInboxes} == accepted 7000`);
  // No starvation. With 2 connections the server cannot keep 4,000 monitors at 60 s (that is the point of the phase),
  // so a fixed ~3-minute window may legitimately miss a monitor whose check lands just outside it (seen: lag up to
  // 216 s against a 181 s window). The real invariant: after the phase-5 server started, every monitor gets a check
  // from it within its interval plus the lag bound. Only phase-5 observations count (phase 4 ran on another server),
  // and the server keeps running while we wait for stragglers, up to that deadline.
  const starveDeadline = p5From.getTime() + (INTERVAL_SEC + T.pool2LagP95Sec) * 1000;
  const unchecked = async () => (await sql`
    select count(*)::int as n from monitor m
    where m.organization_id = ${orgId}
      and not exists (select 1 from monitor_observation o where o.monitor_id = m.id and o.observed_at >= ${p5From})`)[0].n;
  let missing = await unchecked();
  while (missing > 0 && Date.now() < starveDeadline && alive()) {
    await sleep(5_000);
    missing = await unchecked();
  }
  p5.monitorsWithoutPhase5Check = missing;
  p5.allCheckedWithinSec = missing === 0 ? Math.round((Date.now() - p5From.getTime()) / 1000) : null;
  check(p5.perMonitor.monitors === N, `phase 5: every one of ${N} monitors counted`);
  check(missing === 0, `phase 5: no monitor starved with DB_POOL_MAX=2 (${missing} of ${N} without a check from the phase-5 server ${INTERVAL_SEC + T.pool2LagP95Sec} s after it started)`);
  // Steady state from one minute in (the first minute carries the restart gap between servers, which is not
  // monitoring lag); the first minute itself is covered by the starvation deadline above.
  check(Number.isFinite(p5.completionLagSec.max) && le(p5.completionLagSec.max, T.pool2LagP95Sec), `phase 5: worst completion lag ${p5.completionLagSec.max}s <= ${T.pool2LagP95Sec}s (steady state)`);
  // Correctness floor for an under-provisioned pool: monitoring degrades but stays bounded.
  check(le(p5.completionLagSec.p95, T.pool2LagP95Sec), `phase 5: completion lag p95 ${p5.completionLagSec.p95}s <= ${T.pool2LagP95Sec}s with DB_POOL_MAX=2`);
  check(p5.resources.health.failures === 0 && le(p5.resources.health.max, T.maxHealthMs), `phase 5: /health within ${T.maxHealthMs} ms (max ${p5.resources.health.max})`);
  check(le(p5.resources.rssMb.max, T.maxRssMb), `phase 5: RSS ${p5.resources.rssMb.max} MB <= ${T.maxRssMb} MB`);
  phase = "stopping";
  stopWindows.push(Date.now());
  summary.secondServerStop = await stopServer("server (pool 2)");

  // ── final integrity, on a quiescent database ───────────────────────────────
  phase = "final";
  samplersOn = false;
  const [dup] = await sql`select count(*)::int as n from (select monitor_id, generation from monitor_observation where generation is not null group by 1, 2 having count(*) > 1) x`;
  const perMonitor = await sql`
    select m.id::text as id,
      (select count(*) from check_result r where r.monitor_id = m.id)::int as results,
      (select count(*) from monitor_observation o where o.monitor_id = m.id)::int as observations,
      (select coalesce(sum(total), 0) from check_rollup u where u.monitor_id = m.id)::int as rollup,
      m.run_generation, m.last_run_generation, m.coverage_generation
    from monitor m where m.organization_id = ${orgId}`;
  let mismatchObs = 0, mismatchRollup = 0, mismatchHits = 0, phantom = 0, genOrder = 0, totalResults = 0, totalHits = 0;
  for (const r of perMonitor) {
    const h = hits[indexOf.get(r.id)];
    totalResults += r.results; totalHits += h;
    if (r.results !== r.observations) mismatchObs++;
    if (r.results !== r.rollup) mismatchRollup++;
    if (r.results !== h) mismatchHits++;
    if (r.results > h) phantom++;
    if (r.last_run_generation > r.run_generation || r.coverage_generation > r.run_generation) genOrder++;
  }
  const [claims] = await sql`select (count(*) filter (where kind = 'claim'))::int as claims, (count(*) filter (where kind = 'release'))::int as releases from load_claim_log`;
  // Claimed, not released and never recorded: coalesced (a later check covered them, never checked or billed) or cut
  // off by a server stop. Counted explicitly, so a skipped run is visible rather than absorbed by the totals.
  // Claimed, not released and never recorded, classified by whether the run began (logged starts):
  //  - skipped before start: coalesced by beginRuns (or older than a started run); never checked, never billed;
  //  - started without a result: began and lost its result (crash, inconclusive probe, rejected write). Outside the
  //    two graceful stops (30 s around each) this must be zero: nothing is crashed on purpose in this qualification.
  const stopMarks = stopWindows.map((t) => new Date(t).toISOString());
  const [unrecorded] = await sql`
    with lost as (
      select c.monitor_id, c.generation, exists (select 1 from load_claim_log s where s.kind = 'start' and s.monitor_id = c.monitor_id and s.generation = c.generation) as started,
             (select min(s.at) from load_claim_log s where s.kind = 'start' and s.monitor_id = c.monitor_id and s.generation = c.generation) as started_at
      from load_claim_log c
      where c.kind = 'claim'
        and not exists (select 1 from load_claim_log r where r.kind = 'release' and r.monitor_id = c.monitor_id and r.generation = c.generation)
        and not exists (select 1 from monitor_observation o where o.monitor_id = c.monitor_id and o.generation = c.generation))
    select (count(*) filter (where not started))::int as coalesced,
           (count(*) filter (where started))::int as started_without_result,
           (count(*) filter (where started and not exists (
              select 1 from unnest(${stopMarks}::timestamptz[]) w(at) where lost.started_at between w.at - interval '30 seconds' and w.at + interval '30 seconds')))::int as started_without_result_outside_stops
    from lost`;
  summary.integrity = {
    monitors: perMonitor.length, totalCheckResults: totalResults, totalTargetRequests: totalHits,
    duplicateRunGenerations: dup.n, resultObservationMismatches: mismatchObs, resultRollupMismatches: mismatchRollup,
    resultTargetRequestMismatches: mismatchHits, resultsWithoutTargetRequest: phantom, generationOrderViolations: genOrder,
    claimsLogged: claims.claims, releasesLogged: claims.releases,
    claimedRunsWithoutResult: claims.claims - claims.releases - totalResults,
    skippedBeforeStart: unrecorded.coalesced, startedWithoutResult: unrecorded.started_without_result,
    startedWithoutResultOutsideStops: unrecorded.started_without_result_outside_stops, serverLogCounts: logCounts,
  };
  log("integrity", JSON.stringify(summary.integrity));
  summary.integrity.samplerErrors = samplerErrors;
  check(samplerErrors.length === 0, `samplers: no DB sampling errors (${samplerErrors.length}: ${samplerErrors.slice(0, 3).join(" | ")})`);
  check(dup.n === 0, `integrity: no run generation recorded twice (${dup.n})`);
  check(mismatchObs === 0, `integrity: check results == observations for every monitor (${mismatchObs} mismatches)`);
  check(mismatchRollup === 0, `integrity: rollup totals == check results for every monitor (${mismatchRollup} mismatches)`);
  check(mismatchHits === 0, `integrity: every target request produced exactly one result, none lost (${mismatchHits} monitors differ, ${totalHits} requests vs ${totalResults} results)`);
  check(unrecorded.coalesced + unrecorded.started_without_result === claims.claims - claims.releases - totalResults, `integrity: every claimed run is a result, a release, skipped before start (coalesced) or started without a result (${unrecorded.coalesced} skipped, ${unrecorded.started_without_result} started without result)`);
  check(unrecorded.started_without_result_outside_stops === 0, `integrity: no run that started lost its result outside the graceful stops (${unrecorded.started_without_result_outside_stops}; ${unrecorded.started_without_result} within 30 s of a stop)`);
  check(genOrder === 0, `integrity: run generations ordered (${genOrder} violations)`);
  check(logCounts.watchdogExit === 0, "integrity: no watchdog exit logged");
  check(logCounts.schedulerFailed === 0 && logCounts.checkBatchFailed === 0, `integrity: no scheduler tick or check batch failures logged (${JSON.stringify(logCounts)})`);
} catch (error) {
  failures.push("aborted: " + (error?.message ?? String(error)).slice(0, 2000));
  console.error("server log tail:\n" + serverLog.split("\n").slice(-30).join("\n"));
} finally {
  samplersOn = false;
  for (const proc of spawned) if (proc.exitInfo === null) proc.kill("SIGKILL");
  await Promise.allSettled([healthLoop, dbLoop]);
  target.closeAllConnections?.();
  target.close();
  await sql.end({ timeout: 2 }).catch(() => {});
}

summary.finishedAt = new Date().toISOString();
summary.failures = failures;
summary.pass = failures.length === 0;
writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (failures.length) {
  console.error(`LOAD_QUALIFICATION_FAIL: ${failures.length} failure(s)\n - ` + failures.join("\n - "));
  process.exit(1);
}
const p1s = summary.phases.throughput, p2s = summary.phases.backpressure, w = summary.phases.webhooks.fanOut;
console.log(`LOAD_QUALIFICATION_PASS: ${N} monitors at ${p1s.checksPerMinute} checks/min (lag p95 ${p1s.completionLagSec.p95}s), ` +
  `no lost or duplicated checks (${summary.integrity.totalCheckResults} results == target requests), ` +
  `queue capped under backpressure and drained in ${p2s.recoverySec}s, ${w.acceptedPerSec} webhooks/s accepted, ` +
  `429 + 250-event retention exact, no 5xx, DB_POOL_MAX=2 degraded without errors`);
