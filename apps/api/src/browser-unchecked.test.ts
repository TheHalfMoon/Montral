/**
 * Browser checks that did not happen are never silently blind: deferred runs (capacity full) and runtime errors (runner
 * unreachable or refusing, Chromium not starting, no report) are recorded as visible runs; after BROWSER_UNCHECKED_AFTER
 * in a row the monitor is marked unchecked and its owners and admins are told, once per streak; a real run clears it.
 */
import type { AlertDelivery, Monitor, NewBrowserRun, NewCheck, Repo } from "@montral/repo";
import { describe, expect, it, vi } from "vitest";

const next: { kind: "deferred" | "error" | "run"; error: string }[] = [];
vi.mock("./browser-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("./browser-check")>();
  return {
    ...real,
    browserCheck: async () => {
      const n = next.shift() ?? { kind: "error", error: real.RUNNER_UNREACHABLE };
      if (n.kind === "run") return { ok: true, latencyMs: 10, browser: { ok: true, kind: "run", usedSecrets: true, steps: [{ action: "goto", ms: 10, ok: true }], failedStep: null, error: null, statusCode: 200, durationMs: 10, blockedRequests: 0, popupsClosed: 0 } };
      return { ok: false, inconclusive: true, error: n.error, browser: { ok: false, kind: n.kind, usedSecrets: true, steps: [], failedStep: null, error: n.error, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 } };
    },
  };
});

const { checkOne } = await import("./scheduler");
const { BROWSER_BUSY, BROWSER_UNCHECKED_AFTER, RUNNER_UNREACHABLE, RUNNER_REJECTED } = await import("./browser-check");

function fake() {
  const runs: NewBrowserRun[] = [];
  const checks: NewCheck[] = [];
  const states: unknown[] = [];
  const deliveries: Partial<AlertDelivery>[] = [];
  const monitor = { uncheckedSince: null as Date | null };
  const repo = {
    recordBrowserRun: async (r: NewBrowserRun) => void runs.unshift(r),
    consecutiveUncheckedBrowserRuns: async (_id: string, limit: number) => { const i = runs.slice(0, limit).findIndex((r) => r.kind === "run"); return i === -1 ? Math.min(runs.length, limit) : i; },
    markUnchecked: async () => { if (monitor.uncheckedSince) return false; monitor.uncheckedSince = new Date(); return true; },
    clearUnchecked: async () => { monitor.uncheckedSince = null; },
    managerEmails: async () => ["owner@example.com", "admin@example.com"],
    logDeliveries: async (rows: Partial<AlertDelivery>[]) => void deliveries.push(...rows),
    recordObservation: async () => true,
    underMaintenance: async () => false,
    recordCheck: async (c: NewCheck) => void checks.push(c),
    recordRecoveryProgress: async () => ({ successes: 1, ready: true }),
    setMonitorState: async (_id: string, s: unknown) => void states.push(s),
    hasOpenIncident: async () => false,
    openIncidents: async () => [],
  } as unknown as Repo;
  return { repo, runs, checks, states, deliveries, monitor };
}

const browserMonitor = (over: Partial<Monitor> = {}) => ({ id: "b1", organizationId: "o", projectId: "p", name: "Journey", type: "browser", target: "https://example.com/", regions: ["auto"], status: "up", consecutiveFailures: 0, consecutiveSlow: 0, failureThreshold: 3, slowThresholdMs: 5000, slowAlertAfter: 0, channelIds: [], paused: false, uncheckedSince: null, browser: { steps: [{ action: "goto", url: "https://example.com/" }], timeoutMs: 30_000, screenshot: "never" }, ...over }) as unknown as Monitor;

describe("browser checks that did not happen", () => {
  it("records runtime errors and deferrals as visible runs; after N in a row marks the monitor unchecked and tells owners and admins once", async () => {
    const { repo, runs, checks, states, deliveries, monitor } = fake();
    next.push({ kind: "error", error: RUNNER_UNREACHABLE }, { kind: "deferred", error: BROWSER_BUSY }, { kind: "error", error: RUNNER_REJECTED });
    for (let i = 0; i < BROWSER_UNCHECKED_AFTER; i++) await checkOne(repo, browserMonitor());
    expect(runs.map((r) => r.kind)).toEqual(["error", "deferred", "error"]);
    expect(runs[0]).toMatchObject({ ok: false, error: RUNNER_REJECTED, usedSecrets: true });
    // nothing about the target is recorded, and the status is left as it was
    expect(checks).toEqual([]);
    expect(states).toEqual([]);
    expect(monitor.uncheckedSince).toBeInstanceOf(Date);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ kind: "monitor.unchecked", channelName: "Owners and admins (email)", monitorName: "Journey" });
    expect(deliveries[0].statusMessage).toContain(RUNNER_REJECTED);
    // the streak goes on: no second notice
    next.push({ kind: "error", error: RUNNER_UNREACHABLE });
    await checkOne(repo, browserMonitor({ uncheckedSince: monitor.uncheckedSince }));
    expect(deliveries).toHaveLength(2);
    // a real run clears the state, and a later streak notifies again
    next.push({ kind: "run", error: "" });
    await checkOne(repo, browserMonitor({ uncheckedSince: monitor.uncheckedSince }));
    expect(monitor.uncheckedSince).toBeNull();
    expect(runs[0]).toMatchObject({ kind: "run", ok: true, usedSecrets: true });
    expect(checks).toHaveLength(1);
    next.push(...Array.from({ length: BROWSER_UNCHECKED_AFTER }, () => ({ kind: "error" as const, error: RUNNER_UNREACHABLE })));
    for (let i = 0; i < BROWSER_UNCHECKED_AFTER; i++) await checkOne(repo, browserMonitor());
    expect(deliveries).toHaveLength(4);
  });

  it("fewer than N in a row do not mark or notify", async () => {
    const { repo, deliveries, monitor } = fake();
    next.push(...Array.from({ length: BROWSER_UNCHECKED_AFTER - 1 }, () => ({ kind: "error" as const, error: RUNNER_UNREACHABLE })));
    for (let i = 0; i < BROWSER_UNCHECKED_AFTER - 1; i++) await checkOne(repo, browserMonitor());
    expect(monitor.uncheckedSince).toBeNull();
    expect(deliveries).toEqual([]);
  });

  it("logs a skipped notice when the workspace has no owner or admin address", async () => {
    const { repo, deliveries } = fake();
    (repo as unknown as { managerEmails: () => Promise<string[]> }).managerEmails = async () => [];
    next.push(...Array.from({ length: BROWSER_UNCHECKED_AFTER }, () => ({ kind: "error" as const, error: RUNNER_UNREACHABLE })));
    for (let i = 0; i < BROWSER_UNCHECKED_AFTER; i++) await checkOne(repo, browserMonitor());
    expect(deliveries).toEqual([expect.objectContaining({ kind: "monitor.unchecked", status: "skipped" })]);
  });
});
