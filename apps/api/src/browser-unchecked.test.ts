/**
 * Browser checks that did not happen are never silently blind, and fairness never starves a monitor:
 * - runtime errors and deferrals are recorded as visible runs; errors mark a monitor unchecked after 3 in a row,
 *   deferrals only when they have lasted 3 intervals (a deferred check is retried within a minute);
 * - a workspace's browser monitors due together are checked one after another, never deferred by its own gate;
 * - owners and admins get one digest per workspace (at most one an hour) listing every unchecked monitor;
 * - a real run clears the state in the database, whatever the in-memory snapshot says.
 */
import type { AlertDelivery, Monitor, NewBrowserRun, NewCheck, Repo, UncheckedDigest } from "@montral/repo";
import { afterEach, describe, expect, it, vi } from "vitest";

type Next = { kind: "deferred" | "error" | "run"; error: string };
const next: Next[] = [];
/** browser checks in flight per workspace, as the real per-workspace gate would see them */
const inFlight = new Map<string, number>();
let gateModel = false;
vi.mock("./browser-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("./browser-check")>();
  const runOutcome = () => ({ ok: true, latencyMs: 10, browser: { ok: true, kind: "run", usedSecrets: true, steps: [{ action: "goto", ms: 10, ok: true }], failedStep: null, error: null, statusCode: 200, durationMs: 10, blockedRequests: 0, popupsClosed: 0 } });
  const notRun = (n: Next) => ({ ok: false, inconclusive: true, error: n.error, browser: { ok: false, kind: n.kind, usedSecrets: true, steps: [], failedStep: null, error: n.error, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 } });
  return {
    ...real,
    browserCheck: async (m: { organizationId: string }) => {
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

const { checkMany, checkOne, sendUncheckedDigests, shouldMarkUnchecked, DEFERRED_RETRY_MS } = await import("./scheduler");
const { BROWSER_BUSY, BROWSER_UNCHECKED_AFTER, RUNNER_UNREACHABLE } = await import("./browser-check");
const { configureEmail, setMailTransport } = await import("./email");

function fake() {
  const runs: (NewBrowserRun & { createdAt: Date })[] = [];
  const checks: NewCheck[] = [];
  const states: { id: string; state: Record<string, unknown> }[] = [];
  const deliveries: Partial<AlertDelivery>[] = [];
  const marked: string[] = [];
  const cleared: string[] = [];
  const repo = {
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
  return { repo, runs, checks, states, deliveries, marked, cleared };
}

const browserMonitor = (over: Partial<Monitor> = {}) => ({ id: "b1", organizationId: "o", projectId: "p", name: "Journey", type: "browser", target: "https://example.com/", regions: ["auto"], status: "up", consecutiveFailures: 0, consecutiveSlow: 0, failureThreshold: 3, slowThresholdMs: 5000, slowAlertAfter: 0, channelIds: [], paused: false, intervalSec: 300, uncheckedSince: null, browserSecretsVersion: 4, browser: { steps: [{ action: "goto", url: "https://example.com/" }], timeoutMs: 30_000, screenshot: "never" }, ...over }) as unknown as Monitor;

afterEach(() => { next.length = 0; gateModel = false; setMailTransport(undefined); });

describe("when a browser monitor counts as unchecked", () => {
  const at = (minAgo: number, kind: string) => ({ kind, createdAt: new Date(Date.now() - minAgo * 60_000) });
  it("runtime errors count at once: 3 in the streak", () => {
    expect(shouldMarkUnchecked([at(0, "error"), at(5, "error"), at(10, "error")], 300)).toBe(true);
    expect(shouldMarkUnchecked([at(0, "error"), at(5, "error"), at(10, "run"), at(15, "error")], 300)).toBe(false);
    expect(shouldMarkUnchecked([at(0, "error"), at(1, "deferred"), at(5, "error"), at(6, "error")], 300)).toBe(true);
  });
  it("capacity deferrals count only once they have lasted 3 intervals", () => {
    // a busy moment: many deferrals, retried within minutes
    expect(shouldMarkUnchecked(Array.from({ length: 8 }, (_, i) => at(i, "deferred")), 300)).toBe(false);
    // deferred for more than 3 intervals (15 minutes at 5-minute intervals)
    expect(shouldMarkUnchecked([at(0, "deferred"), at(8, "deferred"), at(16, "deferred")], 300)).toBe(true);
    expect(shouldMarkUnchecked([at(0, "deferred"), at(16, "run")], 300)).toBe(false);
    expect(shouldMarkUnchecked([], 300)).toBe(false);
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

  it("a deferred check is retried within a minute or two, and a few deferrals never mark the monitor", async () => {
    const { repo, states, marked } = fake();
    next.push({ kind: "deferred", error: BROWSER_BUSY }, { kind: "deferred", error: BROWSER_BUSY }, { kind: "deferred", error: BROWSER_BUSY });
    const before = Date.now();
    for (let i = 0; i < 3; i++) await checkOne(repo, browserMonitor());
    const retry = states[0].state.nextCheckAt as Date;
    expect(retry.getTime()).toBeGreaterThanOrEqual(before + DEFERRED_RETRY_MS);
    expect(retry.getTime()).toBeLessThanOrEqual(Date.now() + 2 * DEFERRED_RETRY_MS);
    expect(marked).toEqual([]);
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
