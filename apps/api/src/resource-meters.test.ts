/**
 * The resource meters (SaaS stage 3): browser-check seconds reserved at the configured journey timeout and refunded
 * after the run, and one webhook event per captured request. Arithmetic and failure behaviour without a database; the
 * PostgreSQL ledger itself is covered by montral-metering.e2e.test.ts. Synthetic values only.
 */
import type { Monitor, NewBrowserRun, NewCheck, Repo } from "@montral/repo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entitlements, Meter } from "./entitlements";

type Next = "run" | "deferred" | "error";
const next: Next[] = [];
const clock = { t: 0 };
let runMs = 0;
let launched = 0;
vi.mock("./browser-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("./browser-check")>();
  return {
    ...real,
    browserCheck: async () => {
      launched++;
      clock.t += runMs;
      const n = next.shift() ?? "run";
      if (n === "run") return { ok: true, latencyMs: 10, browser: { ok: true, kind: "run", usedSecrets: false, steps: [], failedStep: null, error: null, statusCode: 200, durationMs: runMs, blockedRequests: 0, popupsClosed: 0 } };
      const error = n === "deferred" ? real.BROWSER_BUSY : real.RUNNER_UNREACHABLE;
      return { ok: false, inconclusive: true, error, browser: { ok: false, kind: n, usedSecrets: false, steps: [], failedStep: null, error, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 } };
    },
  };
});

const { browserSecondsFor, checkMany, reserveBrowserSeconds, unusedBrowserSeconds, BROWSER_METERING_UNAVAILABLE, BROWSER_QUOTA_EXHAUSTED } = await import("./scheduler");
const { chargeWebhookEvent } = await import("./montral-hooks");

afterEach(() => { next.length = 0; clock.t = 0; runMs = 0; launched = 0; vi.useRealTimers(); });

const browserMonitor = (over: Partial<Monitor> = {}) => ({ id: "b1", organizationId: "o", projectId: "p", name: "Journey", type: "browser", target: "https://example.com/", regions: ["auto"], status: "up", consecutiveFailures: 0, consecutiveSlow: 0, failureThreshold: 3, slowThresholdMs: 5000, slowAlertAfter: 0, channelIds: [], paused: false, intervalSec: 300, uncheckedSince: null, browserSecretsVersion: 0, browser: { steps: [{ action: "goto", url: "https://example.com/" }], timeoutMs: 30_000, screenshot: "never" }, ...over }) as unknown as Monitor;

function fake(opts: { deferredSince?: Date; observationFails?: boolean } = {}) {
  const runs: NewBrowserRun[] = [];
  const checks: NewCheck[] = [];
  const notes: { id: string; reason: string }[] = [];
  const marked: string[] = [];
  let since: Date | undefined = opts.deferredSince;
  const repo = {
    noteBrowserDeferral: async (id: string, _i: number, reason: string) => { notes.push({ id, reason }); since ??= new Date(); return { deferredSince: since }; },
    clearBrowserDeferral: async () => { since = undefined; },
    recordBrowserRun: async (r: NewBrowserRun) => void runs.push(r),
    recentBrowserRunKinds: async () => [],
    markUnchecked: async (id: string) => { marked.push(id); return true; },
    clearUnchecked: async () => {},
    recordObservation: async () => { if (opts.observationFails) throw new Error("database gone"); return true; },
    underMaintenance: async () => false,
    recordCheck: async (c: NewCheck) => void checks.push(c),
    recordRecoveryProgress: async () => ({ successes: 1, ready: true }),
    setMonitorState: async () => {},
    hasOpenIncident: async () => false,
    openIncidents: async () => [],
    logDeliveries: async () => {},
  } as unknown as Repo;
  return { repo, runs, checks, notes, marked };
}

/** A metered ledger in memory: per meter an allowance, every spend and refund with the instant it names. */
function ledger(seconds: number, credits = 1000) {
  const left: Record<string, number> = { credits, browserSeconds: seconds, webhookEvents: 3 };
  const log: { op: "spend" | "refund"; meter: string; n: number; at?: Date }[] = [];
  const spend = (meter: string, n: number, at?: Date) => { const g = Math.max(0, Math.min(n, left[meter])); left[meter] -= g; log.push({ op: "spend", meter, n: g, at }); return g; };
  const refund = (meter: string, n: number, at?: Date) => { left[meter] += n; log.push({ op: "refund", meter, n, at }); };
  const entitlements: Entitlements = {
    failClosed: true,
    spendCredits: async (_w, n, at) => spend("credits", n, at),
    refundCredits: async (_w, n, at) => refund("credits", n, at),
    creditBalance: async () => null, spendEmails: async (_w, n) => n, emailBalance: async () => null, plan: async () => null,
    spendMeter: async (_w, meter: Meter, n, at) => spend(meter, n, at),
    refundMeter: async (_w, meter: Meter, n, at) => refund(meter, n, at),
  };
  return { entitlements, left, log };
}

describe("browser seconds arithmetic", () => {
  it("reserves the configured journey timeout rounded up to whole seconds", () => {
    expect(browserSecondsFor(browserMonitor())).toBe(30);
    expect(browserSecondsFor(browserMonitor({ browser: { steps: [], timeoutMs: 12_001 } as never }))).toBe(13);
    expect(browserSecondsFor(browserMonitor({ browser: { steps: [], timeoutMs: 60_000 } as never }))).toBe(60);
    // a stored configuration without a timeout uses the journey default, never zero
    expect(browserSecondsFor(browserMonitor({ browser: { steps: [] } as never }))).toBe(30);
    expect(browserSecondsFor(browserMonitor({ browser: null as never }))).toBe(30);
  });

  it("refunds what a run did not use, never negative, everything when it did not happen", () => {
    expect(unusedBrowserSeconds(30, 10_200, "done")).toBe(19); // 11 s used (rounded up)
    expect(unusedBrowserSeconds(30, 0, "done")).toBe(30);
    expect(unusedBrowserSeconds(30, 30_000, "done")).toBe(0);
    expect(unusedBrowserSeconds(30, 95_000, "done")).toBe(0); // slot wait and start-up can exceed the journey: never negative
    expect(unusedBrowserSeconds(30, 12_000, "skipped")).toBe(18);
    expect(unusedBrowserSeconds(30, 25_000, "deferred")).toBe(30);
    expect(unusedBrowserSeconds(30, 25_000, "error")).toBe(30);
    expect(unusedBrowserSeconds(0, 1_000, "error")).toBe(0); // nothing reserved (self-hosted): nothing to give back
    expect(unusedBrowserSeconds(30, Number.NaN, "done")).toBe(30);
  });
});

describe("browser checks against the browser-seconds allowance", () => {
  it("reserves the timeout at the credit charge's instant and refunds the unused seconds at that same instant", async () => {
    const { repo, runs } = fake();
    const { entitlements, left, log } = ledger(100);
    runMs = 10_200;
    await checkMany(repo, [browserMonitor()], entitlements, { now: () => clock.t });
    expect(launched).toBe(1);
    expect(runs.map((r) => r.kind)).toEqual(["run"]);
    const credit = log.find((e) => e.meter === "credits" && e.op === "spend")!;
    const reserve = log.find((e) => e.meter === "browserSeconds" && e.op === "spend")!;
    const refund = log.find((e) => e.meter === "browserSeconds" && e.op === "refund")!;
    expect(reserve).toMatchObject({ n: 30 });
    expect(refund).toMatchObject({ n: 19 });
    expect(reserve.at).toBe(credit.at);
    expect(refund.at).toBe(credit.at);
    expect(left.browserSeconds).toBe(100 - 11);
  });

  it("gives every reserved second back when the check was deferred or the runtime failed", async () => {
    const { repo } = fake();
    const { entitlements, left } = ledger(100);
    next.push("deferred", "error");
    runMs = 4_000;
    await checkMany(repo, [browserMonitor()], entitlements, { now: () => clock.t });
    await checkMany(repo, [browserMonitor()], entitlements, { now: () => clock.t });
    expect(launched).toBe(2);
    expect(left.browserSeconds).toBe(100);
    expect(left.credits).toBe(1000);
  });

  it("does not run a check the remaining seconds cannot cover: partial grant and credits given back, a deferral noted, no result", async () => {
    const { repo, runs, checks, notes } = fake();
    const { entitlements, left, log } = ledger(29);
    await checkMany(repo, [browserMonitor()], entitlements, { now: () => clock.t });
    expect(launched).toBe(0);
    expect(runs).toEqual([]);
    expect(checks).toEqual([]);
    expect(notes).toEqual([{ id: "b1", reason: BROWSER_QUOTA_EXHAUSTED }]);
    expect(left).toMatchObject({ browserSeconds: 29, credits: 1000 });
    expect(log.filter((e) => e.op === "refund").map((e) => e.meter).sort()).toEqual(["browserSeconds", "credits"]);
  });

  it("fails closed when the ledger fails: nothing runs, no result is recorded, credits are given back, the streak grows", async () => {
    const { repo, runs, checks, notes } = fake();
    const { entitlements, left } = ledger(100);
    entitlements.spendMeter = async () => { throw new Error("ledger down"); };
    await checkMany(repo, [browserMonitor()], entitlements, { now: () => clock.t });
    expect(launched).toBe(0);
    expect(runs).toEqual([]);
    expect(checks).toEqual([]);
    expect(notes).toEqual([{ id: "b1", reason: BROWSER_METERING_UNAVAILABLE }]);
    expect(left.credits).toBe(1000);
    // a malformed grant never authorizes a run either
    entitlements.spendMeter = async () => 31;
    expect(await reserveBrowserSeconds("o", browserMonitor(), entitlements, new Date())).toEqual({ ok: false, reason: "unavailable" });
    // an unmetered (fail-open) entitlement with a failing meter runs uncounted
    entitlements.spendMeter = async () => { throw new Error("ledger down"); };
    expect(await reserveBrowserSeconds("o", browserMonitor(), { ...entitlements, failClosed: false }, new Date())).toEqual({ ok: true, seconds: 0 });
  });

  it("a long metering outage marks the monitor unchecked instead of leaving it silently healthy", async () => {
    const m = browserMonitor({ intervalSec: 300 });
    // the credit ledger itself is down (the first metered call of a browser check)
    const down = { ...ledger(100).entitlements, spendCredits: async () => { throw new Error("ledger down"); } };
    // a streak that started less than 3 intervals ago: noted, not yet marked
    const fresh = fake({ deferredSince: new Date(Date.now() - 2 * 300_000) });
    await checkMany(fresh.repo, [m], down, { now: () => clock.t });
    expect(fresh.notes).toEqual([{ id: "b1", reason: BROWSER_METERING_UNAVAILABLE }]);
    expect(fresh.marked).toEqual([]);
    // lasting 3 intervals: marked unchecked (which sends the managers' digest from housekeeping)
    const old = fake({ deferredSince: new Date(Date.now() - 3 * 300_000 - 1_000) });
    await checkMany(old.repo, [m], down, { now: () => clock.t });
    expect(old.marked).toEqual(["b1"]);
    expect(launched).toBe(0);
    // a malformed credit grant counts the same way
    const odd = fake();
    await checkMany(odd.repo, [m], { ...ledger(100).entitlements, spendCredits: async () => 99 }, { now: () => clock.t });
    expect(odd.notes).toEqual([{ id: "b1", reason: BROWSER_METERING_UNAVAILABLE }]);
    // plain credit exhaustion keeps its old behaviour: nothing recorded
    const broke = fake();
    await checkMany(broke.repo, [m], ledger(100, 0).entitlements, { now: () => clock.t });
    expect(broke.notes).toEqual([]);
  });

  it("gives every reserved second back when the check throws unexpectedly", async () => {
    const { repo } = fake({ observationFails: true });
    const { entitlements, left } = ledger(100);
    runMs = 7_000;
    await checkMany(repo, [browserMonitor()], entitlements, { now: () => clock.t });
    expect(launched).toBe(1);
    expect(left.browserSeconds).toBe(100);
  });

  it("self-hosted (no meter) runs browser checks exactly as before", async () => {
    const { repo, runs } = fake();
    await checkMany(repo, [browserMonitor()], { spendCredits: async (_w: string, n: number) => n } as never, { now: () => clock.t });
    expect(launched).toBe(1);
    expect(runs.map((r) => r.kind)).toEqual(["run"]);
  });

  it("books reservation and refund in the month the credits were charged in, across a UTC month boundary", async () => {
    const { repo } = fake();
    const { entitlements, log } = ledger(100);
    const spendCredits = entitlements.spendCredits;
    // the clock passes midnight UTC on the 1st while the credits are taken
    entitlements.spendCredits = async (w, n, at) => { const g = await spendCredits(w, n, at); vi.setSystemTime(new Date("2026-12-01T00:00:00.500Z")); return g; };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T23:59:59.999Z"));
    runMs = 3_000;
    await checkMany(repo, [browserMonitor()], entitlements, { now: () => clock.t });
    vi.useRealTimers();
    const seconds = log.filter((e) => e.meter === "browserSeconds");
    expect(seconds.map((e) => e.op)).toEqual(["spend", "refund"]);
    for (const e of seconds) expect(e.at!.toISOString()).toBe("2026-11-30T23:59:59.999Z");
  });
});

describe("webhook event charge", () => {
  it("counts one event per capture, refuses with 429 until the next UTC month when used up", async () => {
    const { entitlements } = ledger(0);
    const at = new Date("2026-11-30T23:59:00.000Z");
    for (let i = 0; i < 3; i++) expect(await chargeWebhookEvent(entitlements, "o", at)).toEqual({ ok: true, charged: 1 });
    const refused = await chargeWebhookEvent(entitlements, "o", at);
    expect(refused).toMatchObject({ ok: false, status: 429, body: { code: "webhook_quota_exhausted" } });
    expect((refused as { retryAfter: number }).retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("answers Retry-After with the seconds left until the next period start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T23:59:00.000Z"));
    const refused = await chargeWebhookEvent({ ...ledger(0).entitlements, spendMeter: async () => 0 }, "o", new Date());
    expect(refused).toMatchObject({ status: 429, retryAfter: 60 });
  });

  it("fails closed with 503 when the ledger fails in a metered deployment, captures uncounted otherwise", async () => {
    const failing = { ...ledger(0).entitlements, spendMeter: async () => { throw new Error("ledger down"); } };
    expect(await chargeWebhookEvent(failing, "o", new Date())).toMatchObject({ ok: false, status: 503, body: { code: "metering_unavailable" } });
    expect(await chargeWebhookEvent({ ...failing, failClosed: false }, "o", new Date())).toEqual({ ok: true, charged: 0 });
    // a malformed grant is not permission
    expect(await chargeWebhookEvent({ ...failing, spendMeter: async () => 7 }, "o", new Date())).toMatchObject({ ok: false, status: 429 });
  });

  it("self-hosted (no meter) captures without counting", async () => {
    expect(await chargeWebhookEvent({ spendCredits: async (_w: string, n: number) => n } as never, "o", new Date())).toEqual({ ok: true, charged: 0 });
  });
});
