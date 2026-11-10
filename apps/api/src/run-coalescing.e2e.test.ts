import { createServer, type Server } from "node:http";
import { openDatabase } from "@montral/db-pg";
import type { Database } from "@montral/repo";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { unmetered } from "./entitlements";
import { BROWSER_BUSY } from "./browser-check";
import { checkOne, deferBrowserCheck, processCheckMessage, type CheckMessage } from "./scheduler";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "coalescing-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, ALLOW_PRIVATE_TARGETS: "true" };

/**
 * Run coalescing on real PostgreSQL (beginRuns + recordObservation). Claims are simulated by moving run_generation the
 * way claimDue does; every check hits a local HTTP target, so `requests` counts real checks and `credits` what was billed.
 */
describe.skipIf(!url)("stale run coalescing (PostgreSQL)", () => {
  let db: Database;
  let server: Server;
  let requests = 0;
  let delayMs = 0;
  let credits = 0;
  let cookie = "";
  const entitlements = { ...unmetered, spendCredits: async (_org: string, n: number) => { credits += n; return n; } };
  const app = createApp(openDatabase);
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(origin + path, { ...init, headers: { origin, cookie, "content-type": "application/json" } }), env as never);

  beforeAll(async () => {
    server = createServer((_req, res) => { requests++; setTimeout(() => res.end("ok"), delayMs); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    db = openDatabase(url!, { max: 4 });
    await db.migrate();
    const signed = await call("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email: `coalesce-${crypto.randomUUID()}@example.com`, name: "Coalesce", password: "correct horse battery" }) });
    expect(signed.status).toBe(200);
    cookie = signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  });
  afterAll(async () => {
    await db?.close(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => { requests = 0; credits = 0; delayMs = 0; });

  async function monitor() {
    const created = await call("/api/monitors", { method: "POST", body: JSON.stringify({ name: "Coalesce", type: "http", target: `http://127.0.0.1:${(server.address() as { port: number }).port}`, intervalSec: 3600 }) });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    // never due for a real scheduler tick of another test file sharing this database: only this file's claims run it
    await db.query("UPDATE monitor SET next_check_at = now() + interval '1 day' WHERE id = $1", [id]);
    return id;
  }
  /** a claim: run_generation moves to `g` (what claimDue does), and the run's message */
  async function claim(id: string, g: number): Promise<CheckMessage> {
    await db.query("UPDATE monitor SET run_generation = $2 WHERE id = $1", [id, g]);
    return { ids: [id], at: [new Date(Date.now() + 3600_000 + g).toISOString()], generations: [g] };
  }
  const run = (msg: CheckMessage) => processCheckMessage(db.repo, msg, entitlements);
  const results = async (id: string) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM check_result WHERE monitor_id = $1", [id]))[0].n;

  it("two queued runs for one monitor end in one check: the later one is superseded, not checked and not billed", async () => {
    const id = await monitor();
    const first = await claim(id, 1);
    const second = await claim(id, 2); // claimed while the first still waited in the queue (backlog)
    await run(first);
    await run(second);
    expect(requests).toBe(1);
    expect(credits).toBe(1);
    expect(await results(id)).toBe(1);
    // a run claimed after that result is a new interval: it is checked
    await run(await claim(id, 3));
    expect(requests).toBe(2);
    expect(await results(id)).toBe(2);
  });

  it("a backlog of six queued runs drains as one check", async () => {
    const id = await monitor();
    const queued: CheckMessage[] = [];
    for (let g = 1; g <= 6; g++) queued.push(await claim(id, g));
    for (const msg of queued) await run(msg);
    expect(requests).toBe(1);
    expect(credits).toBe(1);
    expect(await results(id)).toBe(1);
  });

  it("a run claimed before the latest check started (here a manual check) is skipped; one claimed after it runs", async () => {
    const id = await monitor();
    await run(await claim(id, 1));
    expect(requests).toBe(1);
    const stale = await claim(id, 2);
    const [m] = await db.repo.monitorsByIds([id]);
    await checkOne(db.repo, m, entitlements); // a manual check that started after run 2 was claimed
    expect(requests).toBe(2);
    await run(stale);
    expect(requests).toBe(2);
    await run(await claim(id, 3));
    expect(requests).toBe(3);
  });

  it("steady schedule: every run claimed after the previous result is checked, none is skipped", async () => {
    const id = await monitor();
    for (let g = 1; g <= 5; g++) await run(await claim(id, g));
    expect(requests).toBe(5);
    expect(credits).toBe(5);
    expect(await results(id)).toBe(5);
  });

  it("a slow run that started before the next claim but finished after it does not swallow the next run", async () => {
    delayMs = 600;
    const id = await monitor();
    const first = run(await claim(id, 1));
    await new Promise((r) => setTimeout(r, 200)); // run 1 is checking now
    const next = await claim(id, 2); // the next interval is claimed while run 1 is still in flight
    await first; // run 1 records after run 2 was claimed
    expect(requests).toBe(1);
    await run(next);
    expect(requests).toBe(2); // run 2 is a new interval: checked, not superseded
    expect(credits).toBe(2);
  });

  it("a monitor that is late on every run is not thinned out: a covering check older than half an interval supersedes nothing", async () => {
    const id = await monitor();
    const first = await claim(id, 1);
    const second = await claim(id, 2); // both claimed before run 1 starts, as when every run starts after the next claim
    await run(first);
    expect(requests).toBe(1);
    // run 2 starts about an interval after run 1 did (a steady, late schedule, not a backlog)
    await db.query("UPDATE monitor SET checked_started_at = checked_started_at - interval '31 minutes', run_started_at = run_started_at - interval '31 minutes' WHERE id = $1", [id]);
    await run(second);
    expect(requests).toBe(2);
    expect(credits).toBe(2);
  });

  it("a stale queued run (its lease deadline long past, as after a slow-target backlog) is skipped even when the covering check is older", async () => {
    const id = await monitor();
    const first = await claim(id, 1);
    await claim(id, 2);
    // run 2's message, delayed in the queue: its deadline (the next run's due time) passed five minutes ago
    const stale: CheckMessage = { ids: [id], at: [new Date(Date.now() - 5 * 60_000).toISOString()], generations: [2] };
    await run(first);
    await db.query("UPDATE monitor SET checked_started_at = checked_started_at - interval '31 minutes', run_started_at = run_started_at - interval '31 minutes' WHERE id = $1", [id]);
    await run(stale);
    expect(requests).toBe(1);
    expect(credits).toBe(1);
  });

  it("two and three workers starting queued runs of one monitor at once check it once", async () => {
    delayMs = 300; // the first check is still in flight when the others start
    const id = await monitor();
    const a = await claim(id, 1);
    const b = await claim(id, 2);
    await Promise.all([run(a), run(b)]);
    expect(requests).toBe(1);
    expect(credits).toBe(1);

    const other = await monitor();
    requests = 0; credits = 0;
    const msgs = [await claim(other, 1), await claim(other, 2), await claim(other, 3)];
    await Promise.all(msgs.map(run));
    expect(requests).toBe(1);
    expect(credits).toBe(1);
    expect(await results(other)).toBe(1);
    // and the interval after is checked again
    await run(await claim(other, 4));
    expect(requests).toBe(2);
  });

  it("an earlier run that died without a result holds a newer one back only for its timeout plus the margin", async () => {
    const id = await monitor();
    await claim(id, 1);
    const next = await claim(id, 2);
    // run 1 started after run 2 was claimed (a backlog: it is checking run 2's interval) and its worker died
    await db.query("UPDATE monitor SET last_run_generation = 1, run_started_through_generation = 2, run_started_at = now() WHERE id = $1", [id]);
    await run(next);
    expect(requests).toBe(0); // still within run 1's lease: it may yet record
    await db.query("UPDATE monitor SET run_started_at = now() - interval '1 minute' WHERE id = $1", [id]);
    await run(next);
    expect(requests).toBe(1); // the lease passed: no permanent block, no lost interval
    await run(next);
    expect(requests).toBe(1); // and that run is still started at most once
  });

  it("a run that started before this run was claimed never holds it back, even within its lease (60 s monitor, starts 20 s apart)", async () => {
    const id = await monitor();
    await db.query("UPDATE monitor SET interval_sec = 60 WHERE id = $1", [id]);
    await claim(id, 1);
    // run 1 started 20 s ago, before run 2 was claimed, and has not recorded (slow, or its worker died)
    await db.query("UPDATE monitor SET last_run_generation = 1, run_started_through_generation = 1, run_started_at = now() - interval '20 seconds' WHERE id = $1", [id]);
    await run(await claim(id, 2));
    expect(requests).toBe(1); // run 2 is checked: no skipped interval
    expect(credits).toBe(1);
  });

  it("a worker that dies in a backlog costs at most the one interval it was checking", async () => {
    const id = await monitor();
    await claim(id, 1);
    const second = await claim(id, 2);
    // run 1 started with run 2 already claimed, then its worker died without a result
    await db.query("UPDATE monitor SET last_run_generation = 1, run_started_through_generation = 2, run_started_at = now() WHERE id = $1", [id]);
    await run(second);
    expect(requests).toBe(0); // run 2's interval was being checked by run 1
    // the next interval: run 3 is claimed after run 1 started, so run 1's lease does not hold it back
    await run(await claim(id, 3));
    expect(requests).toBe(1);
  });

  // Browser capacity deferrals (scheduler.ts deferBrowserCheck) record no observation and re-queue the monitor a minute
  // or two later; that re-queued run is a new claim and must start. Runs that beginRuns skips never reach a check, so
  // they never count as deferrals.
  const begin = (msg: CheckMessage) => db.repo.beginRuns([{ id: msg.ids[0], token: new Date(msg.at![0]), generation: msg.generations![0] }]);
  const deferredRuns = async (id: string) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM browser_check_run WHERE monitor_id = $1 AND kind = 'deferred'", [id]))[0].n;
  async function defer(id: string) {
    const [m] = await db.repo.monitorsByIds([id]);
    await deferBrowserCheck(db.repo, m, BROWSER_BUSY);
    const [{ due }] = await db.query<{ due: Date }>("SELECT next_check_at AS due FROM monitor WHERE id = $1", [id]);
    expect(new Date(due).getTime()).toBeLessThan(Date.now() + 3 * 60_000); // re-queued soon
    // keep a real scheduler tick of another test file from claiming it: only this test's claims run it
    await db.query("UPDATE monitor SET next_check_at = now() + interval '1 day' WHERE id = $1", [id]);
  }

  it("a browser deferral's re-queued run is a new claim: it starts, never coalesced away", async () => {
    const id = await monitor();
    expect(await begin(await claim(id, 1))).toEqual([id]);
    await defer(id);
    expect(await begin(await claim(id, 2))).toEqual([id]);
    expect(await deferredRuns(id)).toBe(1);
  });

  it("in a backlog, a run skipped before it started adds no deferral, and the deferral's re-queued run still starts", async () => {
    const id = await monitor();
    const a = await claim(id, 1);
    const b = await claim(id, 2);
    expect(await begin(a)).toEqual([id]);
    await defer(id);
    const [{ since }] = await db.query<{ since: Date }>("SELECT deferred_since AS since FROM monitor WHERE id = $1", [id]);
    // b was claimed before a started: a's lease holds it back (coalesced), and nothing is checked or deferred for it
    await run(b);
    expect(requests).toBe(0);
    expect(credits).toBe(0);
    expect(await deferredRuns(id)).toBe(1);
    expect(await db.query("SELECT deferred_since AS since FROM monitor WHERE id = $1", [id])).toEqual([{ since }]);
    // the deferral's re-queue is claimed after a started: it starts
    expect(await begin(await claim(id, 3))).toEqual([id]);
  });
});
