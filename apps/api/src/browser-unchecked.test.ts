/**
 * Browser checks that did not happen are never silently blind, and fairness never starves a monitor:
 * - runtime errors are recorded as visible runs and mark a monitor unchecked after 3 in a row;
 * - capacity deferrals are a streak on the monitor (no run row per retry, one 'deferred' row per interval at most, no
 *   credits) and mark it unchecked once the streak has lasted 3 intervals, however long the interval;
 * - a workspace's browser monitors due together are checked one after another, never deferred by its own gate, within
 *   a time budget per queue task (the rest deferred), and one workspace never holds two queue slots;
 * - owners and admins get one digest per workspace (at most one an hour) listing every unchecked monitor, and the alert
 *   log gets one row per project naming only that project's monitors;
 * - a real run clears the state in the database, whatever the in-memory snapshot says.
 */
import type { AlertDelivery, Monitor, NewBrowserRun, NewCheck, Repo, UncheckedDigest } from "@montral/repo";
import { afterEach, describe, expect, it, vi } from "vitest";

type Next = { kind: "deferred" | "error" | "run"; error: string };
const next: Next[] = [];
/** browser checks in flight per workspace, as the real per-workspace gate would see them */
const inFlight = new Map<string, number>();
let gateModel = false;
/** fake clock for the queue-task budget: each slow check "takes" slowMs of it; release lets a check finish */
const clock = { t: 0 };
let slowMs = 0;
let hold: Promise<void> | null = null;
/** journeys actually handed to the browser runtime */
let launched = 0;
vi.mock("./browser-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("./browser-check")>();
  const runOutcome = () => ({ ok: true, latencyMs: 10, browser: { ok: true, kind: "run", usedSecrets: true, steps: [{ action: "goto", ms: 10, ok: true }], failedStep: null, error: null, statusCode: 200, durationMs: 10, blockedRequests: 0, popupsClosed: 0 } });
  const notRun = (n: Next) => ({ ok: false, inconclusive: true, error: n.error, browser: { ok: false, kind: n.kind, usedSecrets: true, steps: [], failedStep: null, error: n.error, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 } });
  return {
    ...real,
    browserCheck: async (m: { organizationId: string }) => {
      launched++;
      if (hold) await hold;
      if (slowMs) { clock.t += slowMs; return runOutcome(); }
      if (gateModel) {
        // one per workspace, no waiting: a second concurrent check of the same workspace would be deferred
        if ((inFlight.get(m.organizationId) ?? 0) >= 1) return notRun({ kind: "deferred", error: real.BROWSER_BUSY });
        inFlight.set(m.organizationId, 1);
        await new Promise((r) => setTimeout(r, 20));
        inFlight.set(m.organizationId, 0);
        return runOutcome();
      }
      const n = next.shift() ?? { kind: "error", error: real.RUNNER_UNREACHABLE };
      return n.kind === "run" ? runOutcome() : notRun(n);
    },
  };
});

const { checkMany, checkOne, deferBrowserCheck, reserveCredits, spendAllOrNothing, deferredTooLong, sendUncheckedDigests, shouldMarkUnchecked, BROWSER_TASK_BUDGET_MS, DEFERRED_RETRY_MS } = await import("./scheduler");
const { BROWSER_BUSY, BROWSER_UNCHECKED_AFTER, RUNNER_UNREACHABLE } = await import("./browser-check");
const { configureEmail, setMailTransport } = await import("./email");

function fake() {
  const runs: (NewBrowserRun & { createdAt: Date })[] = [];
  const checks: NewCheck[] = [];
  const states: { id: string; state: Record<string, unknown> }[] = [];
  const deliveries: Partial<AlertDelivery>[] = [];
  const marked: string[] = [];
  const cleared: string[] = [];
  const credits: { workspace: string; n: number }[] = [];
  const refunds: { workspace: string; n: number }[] = [];
  let allowance = Infinity;
  const deferral = new Map<string, Date>();
  const deferredNotes: string[] = [];
  const repo = {
    noteBrowserDeferral: async (id: string) => {
      deferredNotes.push(id);
      if (!deferral.has(id)) deferral.set(id, new Date());
      return { deferredSince: deferral.get(id)! };
    },
    clearBrowserDeferral: async (id: string) => void deferral.delete(id),
    recordBrowserRun: async (r: NewBrowserRun) => void runs.unshift({ ...r, createdAt: new Date() }),
    recentBrowserRunKinds: async (id: string, limit: number) => runs.filter((r) => r.monitorId === id).slice(0, limit).map((r) => ({ kind: r.kind ?? "run", createdAt: r.createdAt })),
    markUnchecked: async (id: string) => { marked.push(id); return true; },
    clearUnchecked: async (id: string) => void cleared.push(id),
    recordObservation: async () => true,
    underMaintenance: async () => false,
    recordCheck: async (c: NewCheck) => void checks.push(c),
    recordRecoveryProgress: async () => ({ successes: 1, ready: true }),
    setMonitorState: async (id: string, state: Record<string, unknown>) => void states.push({ id, state }),
    hasOpenIncident: async () => false,
    openIncidents: async () => [],
    logDeliveries: async (rows: Partial<AlertDelivery>[]) => void deliveries.push(...rows),
  } as unknown as Repo;
  const entitlements = {
    spendCredits: async (workspace: string, n: number) => { const g = Math.max(0, Math.min(n, allowance)); allowance -= g; credits.push({ workspace, n: g }); return g; },
    refundCredits: async (workspace: string, n: number) => { allowance += n; refunds.push({ workspace, n }); },
  } as never;
  const setAllowance = (n: number) => { allowance = n; };
  const net = () => credits.reduce((a, c) => a + c.n, 0) - refunds.reduce((a, c) => a + c.n, 0);
  return { repo, runs, checks, states, deliveries, marked, cleared, credits, refunds, net, setAllowance, deferral, deferredNotes, entitlements };
}

const browserMonitor = (over: Partial<Monitor> = {}) => ({ id: "b1", organizationId: "o", projectId: "p", name: "Journey", type: "browser", target: "https://example.com/", regions: ["auto"], status: "up", consecutiveFailures: 0, consecutiveSlow: 0, failureThreshold: 3, slowThresholdMs: 5000, slowAlertAfter: 0, channelIds: [], paused: false, intervalSec: 300, uncheckedSince: null, browserSecretsVersion: 4, browser: { steps: [{ action: "goto", url: "https://example.com/" }], timeoutMs: 30_000, screenshot: "never" }, ...over }) as unknown as Monitor;

afterEach(() => { launched = 0; next.length = 0; gateModel = false; slowMs = 0; hold = null; clock.t = 0; setMailTransport(undefined); });

describe("when a browser monitor counts as unchecked", () => {
  const at = (minAgo: number, kind: string) => ({ kind, createdAt: new Date(Date.now() - minAgo * 60_000) });
  it("runtime errors count at once: 3 in the streak", () => {
    expect(shouldMarkUnchecked([at(0, "error"), at(5, "error"), at(10, "error")], 300)).toBe(true);
    expect(shouldMarkUnchecked([at(0, "error"), at(5, "error"), at(10, "run"), at(15, "error")], 300)).toBe(false);
    expect(shouldMarkUnchecked([at(0, "error"), at(1, "deferred"), at(5, "error"), at(6, "error")], 300)).toBe(true);
  });
  it("capacity deferrals are judged by how long the streak on the monitor has lasted, not by stored rows", () => {
    // rows never decide it: a busy moment's deferred rows mark nothing
    expect(shouldMarkUnchecked(Array.from({ length: 8 }, (_, i) => at(i, "deferred")), 300)).toBe(false);
    expect(shouldMarkUnchecked([], 300)).toBe(false);
    const now = Date.now();
    expect(deferredTooLong(new Date(now - 14 * 60_000), 300, now)).toBe(false);
    expect(deferredTooLong(new Date(now - 15 * 60_000), 300, now)).toBe(true);
    // a 30-minute interval: 89 minutes is not yet 3 intervals, 90 is
    expect(deferredTooLong(new Date(now - 89 * 60_000), 1800, now)).toBe(false);
    expect(deferredTooLong(new Date(now - 90 * 60_000), 1800, now)).toBe(true);
  });
});

describe("browser checks that did not happen", () => {
  it("records them as runs, marks the monitor after 3 runtime errors, and sends nothing from the check itself", async () => {
    const { repo, runs, checks, states, deliveries, marked } = fake();
    next.push(...Array.from({ length: BROWSER_UNCHECKED_AFTER }, () => ({ kind: "error" as const, error: RUNNER_UNREACHABLE })));
    for (let i = 0; i < BROWSER_UNCHECKED_AFTER; i++) await checkOne(repo, browserMonitor());
    expect(runs.map((r) => r.kind)).toEqual(["error", "error", "error"]);
    expect(checks).toEqual([]);
    expect(states).toEqual([]);
    expect(marked).toEqual(["b1"]);
    expect(deliveries).toEqual([]); // the digest goes out from housekeeping, aggregated per workspace
  });

  it("a deferred check is retried within a minute or two, stores no run row itself, and a few deferrals never mark the monitor", async () => {
    const { repo, runs, states, marked, deferredNotes } = fake();
    next.push({ kind: "deferred", error: BROWSER_BUSY }, { kind: "deferred", error: BROWSER_BUSY }, { kind: "deferred", error: BROWSER_BUSY });
    const before = Date.now();
    for (let i = 0; i < 3; i++) expect(await checkOne(repo, browserMonitor())).toBe("deferred");
    const retry = states[0].state.nextCheckAt as Date;
    expect(retry.getTime()).toBeGreaterThanOrEqual(before + DEFERRED_RETRY_MS);
    expect(retry.getTime()).toBeLessThanOrEqual(Date.now() + 2 * DEFERRED_RETRY_MS);
    expect(runs).toEqual([]); // the repository stores at most one 'deferred' row per interval (browser-check.e2e)
    expect(deferredNotes).toEqual(["b1", "b1", "b1"]);
    expect(marked).toEqual([]);
  });

  it("a 30-minute monitor deferred for 3 intervals is marked unchecked, however many retries were kept", async () => {
    const { repo, marked, deferral } = fake();
    const m = browserMonitor({ intervalSec: 1800 });
    const start = Date.now();
    deferral.set("b1", new Date(start));
    // retries every 45-105 s for 89 minutes: never marked
    for (let t = 0; t < 89 * 60_000; t += 75_000) await deferBrowserCheck(repo, m, BROWSER_BUSY, start + t);
    expect(marked).toEqual([]);
    await deferBrowserCheck(repo, m, BROWSER_BUSY, start + 90 * 60_000);
    expect(marked).toEqual(["b1"]);
  });

  it("a real run or a runtime error ends the deferral streak", async () => {
    const { repo, deferral } = fake();
    deferral.set("b1", new Date(Date.now() - 60_000));
    next.push({ kind: "run", error: "" });
    await checkOne(repo, browserMonitor());
    expect(deferral.has("b1")).toBe(false);
    deferral.set("b1", new Date(Date.now() - 60_000));
    next.push({ kind: "error", error: RUNNER_UNREACHABLE });
    await checkOne(repo, browserMonitor());
    expect(deferral.has("b1")).toBe(false);
  });

  it("takes credits before launching a journey and gives them back when it did not happen: a run is charged exactly once", async () => {
    const { repo, credits, refunds, net, entitlements } = fake();
    next.push({ kind: "deferred", error: BROWSER_BUSY }, { kind: "error", error: RUNNER_UNREACHABLE }, { kind: "run", error: "" });
    for (let i = 0; i < 3; i++) await checkMany(repo, [browserMonitor()], entitlements);
    expect(launched).toBe(3);
    expect(credits.map((c) => c.n)).toEqual([1, 1, 1]); // reserved before each launch
    expect(refunds).toEqual([{ workspace: "o", n: 1 }, { workspace: "o", n: 1 }]); // the deferral and the runtime error
    expect(net()).toBe(1);
  });

  it("a workspace without credits launches no journey and records nothing (not a deferral, not unchecked)", async () => {
    const { repo, runs, states, marked, deferredNotes, setAllowance, entitlements } = fake();
    setAllowance(0);
    for (let i = 0; i < 5; i++) await checkMany(repo, [browserMonitor(), browserMonitor({ id: "b2" })], entitlements);
    expect(launched).toBe(0);
    expect(runs).toEqual([]);
    expect(states).toEqual([]);
    expect(deferredNotes).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("with one credit left, one journey runs and the next is not launched; a partial grant is given back", async () => {
    const { repo, runs, refunds, net, setAllowance, entitlements } = fake();
    setAllowance(1);
    next.push({ kind: "run", error: "" }, { kind: "run", error: "" });
    await checkMany(repo, [browserMonitor({ id: "a" }), browserMonitor({ id: "b" })], entitlements);
    expect(launched).toBe(1);
    expect(runs.map((r) => r.monitorId)).toEqual(["a"]);
    expect(net()).toBe(1);
    // a reservation costing 2 with 1 left: the 1 granted is given back and the check must not run
    setAllowance(1);
    expect(await reserveCredits("o", { type: "http", regions: ["eu", "us"] } as Monitor, entitlements)).toBeNull();
    // a failing ledger: an unmetered deployment runs the journey uncharged, a metered one (failClosed) does not run it
    const failing = { ...(entitlements as object), spendCredits: async () => { throw new Error("ledger down"); } };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await reserveCredits("o", { type: "browser", regions: ["auto"] } as Monitor, failing as never)).toBe(0);
      expect(await reserveCredits("o", { type: "browser", regions: ["auto"] } as Monitor, { ...failing, failClosed: true } as never)).toBeNull();
    } finally {
      quiet.mockRestore();
    }
    expect(refunds.at(-1)).toEqual({ workspace: "o", n: 1 });
  });

  it("books the charge and its refund at the same instant, even across a UTC month boundary", async () => {
    const { repo } = fake();
    const charged: Date[] = [];
    const refunded: Date[] = [];
    // the clock passes midnight UTC on the 1st during the reservation; the refund must still name the charged instant
    // (the very value passed to the charge: a second clock reading could fall in the new month)
    const ent = { spendCredits: async (_w: string, n: number, at?: Date) => { charged.push(at!); vi.setSystemTime(new Date("2026-12-01T00:00:00.500Z")); return n; }, refundCredits: async (_w: string, _n: number, at?: Date) => { refunded.push(at!); } } as never;
    // the run is deferred for capacity, so its credits come back
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-30T23:59:59.999Z"));
      next.push({ kind: "deferred", error: BROWSER_BUSY });
      await checkMany(repo, [browserMonitor({ id: "edge" })], ent);
    } finally {
      vi.useRealTimers();
    }
    expect(charged).toHaveLength(1);
    expect(refunded).toHaveLength(1);
    expect(refunded[0]).toBe(charged[0]);
    expect(refunded[0].toISOString()).toBe("2026-11-30T23:59:59.999Z");
    expect(charged[0].toISOString()).toBe("2026-11-30T23:59:59.999Z");
  });

  it("a manual check that cannot be paid in full gives the partial grant back at the charged instant", async () => {
    const refunds: { n: number; at?: Date }[] = [];
    const at = new Date("2026-11-30T23:59:59.999Z");
    const ent = { spendCredits: async (_w: string, n: number) => Math.max(0, n - 1), refundCredits: async (_w: string, n: number, when?: Date) => { refunds.push({ n, at: when }); } } as never;
    expect(await spendAllOrNothing("o", 3, ent, at)).toBe(false);
    expect(refunds).toEqual([{ n: 2, at }]);
    expect(await spendAllOrNothing("o", 1, ent, at)).toBe(false); // nothing granted: nothing to give back
    expect(refunds).toHaveLength(1);
    const full = { spendCredits: async (_w: string, n: number) => n, refundCredits: async () => { throw new Error("no refund expected"); } } as never;
    expect(await spendAllOrNothing("o", 2, full, at)).toBe(true);
  });

  it("a real run records its secrets version and clears the state in the database even when the snapshot says it is not unchecked", async () => {
    const { repo, runs, cleared } = fake();
    next.push({ kind: "run", error: "" });
    await checkOne(repo, browserMonitor({ uncheckedSince: null }));
    expect(runs[0]).toMatchObject({ kind: "run", usedSecrets: true, secretsVersion: 4 });
    expect(cleared).toEqual(["b1"]);
  });
});

describe("fairness never starves a workspace's monitors", () => {
  it("3 browser monitors of one workspace due together are all checked, every cycle", async () => {
    gateModel = true;
    const { repo, runs } = fake();
    const monitors = ["a", "b", "c"].map((id) => browserMonitor({ id, name: id }));
    const other = browserMonitor({ id: "x", organizationId: "other", name: "x" });
    for (let cycle = 0; cycle < 3; cycle++) await checkMany(repo, [...monitors, other], { spendCredits: async (_w: string, n: number) => n } as never);
    for (const id of ["a", "b", "c", "x"]) {
      const mine = runs.filter((r) => r.monitorId === id);
      expect(mine.map((r) => r.kind), id).toEqual(["run", "run", "run"]);
    }
  });
});

describe("a queue task's browser time is bounded", () => {
  it("4 browser monitors of 90 s each due together: the task returns within its budget and defers the rest", async () => {
    slowMs = 90_000;
    const { repo, runs, states, deferredNotes, credits, entitlements } = fake();
    // a 45-second journey: worst case 90 s, so a second one can never fit after the first in 120 s
    const monitors = ["a", "b", "c", "d"].map((id) => browserMonitor({ id, name: id, browser: { steps: [{ action: "goto", url: "https://example.com/" }], timeoutMs: 45_000, screenshot: "never" } as never }));
    await checkMany(repo, monitors, entitlements, { now: () => clock.t });
    expect(clock.t).toBeLessThan(BROWSER_TASK_BUDGET_MS);
    expect(runs.map((r) => r.monitorId)).toEqual(["a"]);
    expect(deferredNotes).toEqual(["b", "c", "d"]);
    // deferred, not failed: retried within a minute or two
    for (const id of ["b", "c", "d"]) expect(states.find((s) => s.id === id)?.state.nextCheckAt).toBeInstanceOf(Date);
    expect(credits).toHaveLength(1);
  });

  it("checks that fit run one after another within the budget", async () => {
    slowMs = 10_000;
    const { repo, runs, deferredNotes, entitlements } = fake();
    const monitors = ["a", "b", "c"].map((id) => browserMonitor({ id, name: id }));
    await checkMany(repo, monitors, entitlements, { now: () => clock.t });
    expect(runs.map((r) => r.monitorId).sort()).toEqual(["a", "b", "c"]);
    expect(deferredNotes).toEqual([]);
  });

  it("one workspace never holds two queue slots: a second task while one runs defers its monitors", async () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    const { repo, runs, deferredNotes, entitlements } = fake();
    next.push({ kind: "run", error: "" }, { kind: "run", error: "" });
    const first = checkMany(repo, [browserMonitor({ id: "a" })], entitlements);
    await new Promise((r) => setTimeout(r, 10));
    await checkMany(repo, [browserMonitor({ id: "b" })], entitlements);
    expect(deferredNotes).toEqual(["b"]);
    // another workspace is not held up
    const third = checkMany(repo, [browserMonitor({ id: "x", organizationId: "other" })], entitlements);
    await new Promise((r) => setTimeout(r, 10));
    expect(deferredNotes).toEqual(["b"]);
    hold = null;
    release();
    await Promise.all([first, third]);
    expect(runs.map((r) => r.monitorId).sort()).toEqual(["a", "x"]);
  });
});

describe("digest to owners and admins", () => {
  const digest = (n: number): UncheckedDigest => ({ organizationId: "o", monitors: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `Journey ${i}`, projectId: "p", reason: RUNNER_UNREACHABLE })) });

  it("a runner outage with 10 monitors sends one digest per manager, listing all 10, and none again within the hour", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    configureEmail({ EMAIL_FROM: "alerts@example.com" } as never);
    setMailTransport(async (m) => void sent.push(m));
    let pending = [digest(10)];
    let window = 0;
    const notified: string[] = [];
    const deliveries: Partial<AlertDelivery>[] = [];
    const repo = {
      pendingUncheckedDigests: async () => pending,
      markUncheckedNotified: async (ids: string[]) => { notified.push(...ids); pending = []; },
      withinLimit: async () => ++window <= 1,
      managerEmails: async () => ["owner@example.com", "admin@example.com"],
      logDeliveries: async (rows: Partial<AlertDelivery>[]) => void deliveries.push(...rows),
    } as unknown as Repo;
    await sendUncheckedDigests(repo);
    expect(sent.map((m) => m.to).sort()).toEqual(["admin@example.com", "owner@example.com"]);
    expect(sent[0].subject).toBe("10 browser monitors are not being checked");
    for (let i = 0; i < 10; i++) expect(sent[0].text).toContain(`Journey ${i}: ${RUNNER_UNREACHABLE}`);
    expect(notified).toHaveLength(10);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ kind: "monitor.unchecked", status: "sent" });
    // more monitors go unchecked within the hour: they wait for the next window
    pending = [digest(3)];
    await sendUncheckedDigests(repo);
    expect(sent).toHaveLength(2);
    expect(notified).toHaveLength(10);
  });

  it("logs one alert-log row per project, naming only that project's monitors", async () => {
    configureEmail({ EMAIL_FROM: "alerts@example.com" } as never);
    setMailTransport(async () => {});
    const deliveries: Partial<AlertDelivery>[] = [];
    const d: UncheckedDigest = { organizationId: "o", monitors: [
      { id: "m1", name: "Checkout journey", projectId: "p1", reason: RUNNER_UNREACHABLE },
      { id: "m2", name: "Secret launch page", projectId: "p2", reason: RUNNER_UNREACHABLE },
      { id: "m3", name: "Login journey", projectId: "p1", reason: RUNNER_UNREACHABLE },
    ] };
    const repo = {
      pendingUncheckedDigests: async () => [d],
      markUncheckedNotified: async () => {},
      withinLimit: async () => true,
      managerEmails: async () => ["owner@example.com"],
      logDeliveries: async (rows: Partial<AlertDelivery>[]) => void deliveries.push(...rows),
    } as unknown as Repo;
    await sendUncheckedDigests(repo);
    expect(deliveries.map((r) => r.projectId).sort()).toEqual(["p1", "p2"]);
    expect(deliveries.some((r) => r.projectId == null)).toBe(false);
    const p1 = deliveries.find((r) => r.projectId === "p1")!;
    const p2 = deliveries.find((r) => r.projectId === "p2")!;
    expect(p1.statusMessage).toContain("Checkout journey");
    expect(p1.statusMessage).toContain("Login journey");
    expect(`${p1.statusMessage} ${p1.monitorName}`).not.toContain("Secret launch page");
    expect(`${p2.statusMessage} ${p2.monitorName}`).not.toMatch(/Checkout|Login/);
  });

  it("respects the workspace's e-mail allowance", async () => {
    const sent: string[] = [];
    configureEmail({ EMAIL_FROM: "alerts@example.com" } as never);
    setMailTransport(async (m) => void sent.push(m.to));
    const deliveries: Partial<AlertDelivery>[] = [];
    const repo = {
      pendingUncheckedDigests: async () => [digest(2)],
      markUncheckedNotified: async () => {},
      withinLimit: async () => true,
      managerEmails: async () => ["owner@example.com", "admin@example.com"],
      logDeliveries: async (rows: Partial<AlertDelivery>[]) => void deliveries.push(...rows),
    } as unknown as Repo;
    await sendUncheckedDigests(repo, { spendEmails: async () => 1 } as never);
    expect(sent).toHaveLength(1);
    expect(deliveries.map((d) => d.status).sort()).toEqual(["sent", "skipped"]);
  });
});
