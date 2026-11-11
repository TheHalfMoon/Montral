import type { Monitor, ProbeRegionState, Repo } from "@montral/repo";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckOutcome } from "./checker";

// The scheduler's own check (`auto`) is scripted: each test says what this location sees.
const local = vi.hoisted(() => ({ outcome: { ok: true, statusCode: 200, latencyMs: 30 } as CheckOutcome, calls: 0 }));
vi.mock("./checker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./checker")>()),
  runCheck: async () => { local.calls++; return local.outcome; },
}));

const { DRAINED, combine, confirmLocally, configureProbes, drainedRegions, measure, needsConfirmation, requiredFailures, resetProbeRegionCache, runInRegion } = await import("./probes");
const { capRegions, planRegionCap, withinPlanRegions } = await import("./regions");
const { withinCredits } = await import("./scheduler");

const run = (region: string, ok: boolean, latencyMs = 100) => ({ region, outcome: { ok, statusCode: ok ? 200 : 503, latencyMs, error: ok ? undefined : "Expected 200, got 503" } });
const down = (region: string) => ({ region, unreachable: "Probe unreachable" });

describe("multi-region confirmation rules", () => {
  it("needs a strict majority of the listed regions, or the monitor's own number capped by them", () => {
    expect(requiredFailures(3)).toBe(2);
    expect(requiredFailures(4)).toBe(3);
    expect(requiredFailures(3, 1)).toBe(1);
    expect(requiredFailures(3, 5)).toBe(3);
  });

  it("asks for confirmation only when missing regions lowered the bar", () => {
    const three = ["us-east", "eu-central", "ap-southeast"];
    // all answered: the verdict is the monitor's own rule, no confirmation
    expect(needsConfirmation(three, combine([run("us-east", false), run("eu-central", false), run("ap-southeast", true)])!)).toBe(false);
    // one answered and failed, two unreachable: combine says down, but 1 < 2 needed of 3
    const lone = combine([run("us-east", false), down("eu-central"), down("ap-southeast")])!;
    expect(lone.out.ok).toBe(false);
    expect(needsConfirmation(three, lone)).toBe(true);
    // two failed of two that answered: already a majority of three
    expect(needsConfirmation(three, combine([run("us-east", false), run("eu-central", false), down("ap-southeast")])!)).toBe(false);
    // "all three must fail", one unreachable, the two that answered agree: the existing cap alerts without confirmation
    expect(needsConfirmation(three, combine([run("us-east", false), run("eu-central", false), down("ap-southeast")], 3)!, 3)).toBe(false);
    // "two must fail", only one answered: a single region's view, confirmed first
    expect(needsConfirmation(three, combine([run("us-east", false), down("eu-central"), down("ap-southeast")], 2)!, 2)).toBe(true);
    // "any region": one failure is enough, never confirmed
    expect(needsConfirmation(three, combine([run("us-east", false), down("eu-central"), down("ap-southeast")], 1)!, 1)).toBe(false);
    // a passing run, a single-region monitor and a monitor that already votes from this location are left alone
    expect(needsConfirmation(three, combine([run("us-east", true), down("eu-central"), down("ap-southeast")])!)).toBe(false);
    expect(needsConfirmation(["us-east"], combine([run("us-east", false)])!)).toBe(false);
    expect(needsConfirmation(["auto", "us-east", "eu-central"], combine([run("us-east", false), down("eu-central"), down("auto")])!)).toBe(false);
  });

  it("passes the run when this location does not confirm, keeping the failing region on record", () => {
    const lone = combine([run("us-east", false), down("eu-central"), down("ap-southeast")])!;
    const r = confirmLocally(lone, { ok: true, statusCode: 200, latencyMs: 40 }, 3);
    expect(r.out).toMatchObject({ ok: true, statusCode: 200, latencyMs: 40 });
    expect(r.results.map((x) => [x.region, x.ok])).toEqual([["us-east", false], ["auto", true]]);
    expect(r.note).toBe("1 of 1 regions failed, 2 unavailable; not confirmed from this location");
  });

  it("fails the run when this location confirms", () => {
    const lone = combine([run("us-east", false), down("eu-central"), down("ap-southeast")])!;
    const r = confirmLocally(lone, { ok: false, error: "Connection refused" }, 3);
    expect(r.out.ok).toBe(false);
    expect(r.out.error).toBe("Expected 200, got 503");
    expect(r.note).toBe("1 of 1 regions failed, 2 unavailable; confirmed from this location");
    // "all three must fail", two unreachable: this location's failure is the second vote the capped rule needs
    const loneOfThree = combine([run("us-east", false), down("eu-central"), down("ap-southeast")], 3)!;
    expect(confirmLocally(loneOfThree, { ok: false }, 3, 3).out.ok).toBe(false);
    expect(confirmLocally(loneOfThree, { ok: true }, 3, 3).out.ok).toBe(true);
  });

  it("keeps the regions' verdict when this location cannot check either", () => {
    const lone = combine([run("us-east", false), down("eu-central"), down("ap-southeast")])!;
    const r = confirmLocally(lone, null, 3);
    expect(r.out.ok).toBe(false);
    expect(r.results).toHaveLength(1);
    expect(r.note).toContain("this location could not confirm");
  });
});

/** Probe URLs answer from this table; a region not listed is down. */
const answers: Record<string, { ok: boolean; statusCode?: number; latencyMs?: number; error?: string }> = {};
const asked: string[] = [];
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  if (!u.startsWith("https://probe.test/")) return realFetch(input, init);
  const id = u.split("/").pop()!;
  asked.push(id);
  const a = answers[id];
  if (!a) throw new Error("connect ECONNREFUSED 10.0.0.1:443 token=secret");
  return new Response(JSON.stringify(a), { headers: { "content-type": "application/json" } });
});
afterAll(() => { vi.unstubAllGlobals(); configureProbes({}); });

const PROBES = { "us-east": "https://probe.test/p/us-east", "eu-central": "https://probe.test/p/eu-central", "ap-southeast": "https://probe.test/p/ap-southeast" };
const monitor = (extra: Partial<Monitor> = {}) => ({
  id: "m1", organizationId: "w1", type: "http", target: "https://example.com", method: "GET", expectedStatus: 200, timeoutMs: 1000,
  regions: ["us-east", "eu-central", "ap-southeast"], minRegionsFailing: 0, ...extra,
}) as Monitor;

/** A repo with just the probe-region methods, recording health writes. */
function stateRepo(states: Partial<ProbeRegionState>[] = []) {
  const health: [string, boolean, string | undefined][] = [];
  const repo = {
    probeRegionStates: vi.fn(async () => states.map((st) => ({ drained: false, ...st }) as ProbeRegionState)),
    noteProbeHealth: vi.fn(async (region: string, answered: boolean, reason?: string) => { health.push([region, answered, reason]); }),
  };
  return { repo: repo as unknown as Repo, health, calls: repo };
}

describe("measure with unreachable and drained probes", () => {
  beforeEach(() => {
    configureProbes({ PROBE_REGIONS: JSON.stringify(PROBES), PROBE_SECRET: "probe-secret-for-tests" });
    resetProbeRegionCache();
    for (const k of Object.keys(answers)) delete answers[k];
    asked.length = 0;
    local.calls = 0;
    local.outcome = { ok: true, statusCode: 200, latencyMs: 30 };
  });

  it("does not let one region page while the other two probes are down", async () => {
    answers["us-east"] = { ok: false, statusCode: 503, error: "Expected 200, got 503" };
    const r = await measure(monitor());
    expect(local.calls).toBe(1);
    expect(r.out.ok).toBe(true);
    expect(r.results.map((x) => x.region)).toEqual(["us-east", "auto"]);
    expect(r.note).toContain("not confirmed");
  });

  it("still alerts when this location sees the outage too", async () => {
    answers["us-east"] = { ok: false, statusCode: 503, error: "Expected 200, got 503" };
    local.outcome = { ok: false, error: "Expected 200, got 503" };
    const r = await measure(monitor());
    expect(r.out.ok).toBe(false);
    expect(r.note).toContain("confirmed from this location");
  });

  it("does not ask this location when the regions that answered already agree", async () => {
    answers["us-east"] = { ok: false, statusCode: 503 };
    answers["eu-central"] = { ok: false, statusCode: 503 };
    const r = await measure(monitor());
    expect(r.out.ok).toBe(false);
    expect(local.calls).toBe(0);
  });

  it("skips a drained region without asking it, and confirms its vote locally", async () => {
    const { repo } = stateRepo([{ region: "eu-central", drained: true }, { region: "ap-southeast", drained: true }]);
    answers["us-east"] = { ok: false, statusCode: 503 };
    answers["eu-central"] = { ok: false, statusCode: 503 };
    answers["ap-southeast"] = { ok: false, statusCode: 503 };
    const r = await measure(monitor(), repo);
    expect(asked).toEqual(["us-east"]);
    expect(r.out.ok).toBe(true);
    expect(r.results.map((x) => x.region)).toEqual(["us-east", "auto"]);
    expect(await runInRegion("eu-central", monitor(), repo)).toEqual({ region: "eu-central", unreachable: DRAINED });
  });

  it("falls back to this location when every region of the monitor is drained", async () => {
    const { repo } = stateRepo([{ region: "us-east", drained: true }]);
    const r = await measure(monitor({ regions: ["us-east"] }), repo);
    expect(asked).toEqual([]);
    expect(r.results.map((x) => x.region)).toEqual(["auto"]);
  });

  it("reads the drained set once for concurrent checks and keeps the last one if the database fails", async () => {
    const { repo, calls } = stateRepo([{ region: "eu-central", drained: true }]);
    await Promise.all([drainedRegions(repo), drainedRegions(repo), drainedRegions(repo)]);
    expect(calls.probeRegionStates).toHaveBeenCalledTimes(1);
    resetProbeRegionCache();
    expect([...(await drainedRegions(repo))]).toEqual(["eu-central"]);
    // a later failed read (cache expired) keeps the drains known so far
    calls.probeRegionStates.mockRejectedValueOnce(new Error("db down"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      expect([...(await drainedRegions(repo))]).toEqual(["eu-central"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records probe health at most once a minute per region, and at once when it flips, without secrets", async () => {
    const { repo, health } = stateRepo();
    answers["us-east"] = { ok: true, statusCode: 200 };
    await runInRegion("us-east", monitor(), repo);
    await runInRegion("us-east", monitor(), repo);
    expect(health).toEqual([["us-east", true, undefined]]);
    delete answers["us-east"];
    await runInRegion("us-east", monitor(), repo);
    await runInRegion("us-east", monitor(), repo);
    expect(health).toEqual([["us-east", true, undefined], ["us-east", false, "Probe unreachable"]]);
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("never fails a check because health could not be written", async () => {
    const { repo, calls } = stateRepo();
    calls.noteProbeHealth.mockRejectedValue(new Error("db down"));
    answers["us-east"] = { ok: true, statusCode: 200 };
    expect(await runInRegion("us-east", monitor(), repo)).toMatchObject({ region: "us-east", outcome: { ok: true } });
  });
});

describe("plan region cap at run time", () => {
  const three = monitor();
  const metered = (maxRegions: unknown, failClosed = true) => ({ failClosed, plan: async () => ({ id: "p", name: "P", maxActiveMonitors: null, minIntervalSec: 60, maxRegions }) as never });

  it("keeps the first regions a downgraded plan allows, and leaves everything else alone", () => {
    expect(capRegions(three, 2)).toEqual(["us-east", "eu-central"]);
    expect(capRegions(three, 3)).toBe(three.regions);
    expect(capRegions(three, null)).toBe(three.regions);
    expect(capRegions(monitor({ type: "postgres" }), 1)).toEqual(three.regions);
  });

  it("reads the cap, and fails closed only where metering is on", async () => {
    expect(await planRegionCap(metered(2), "w1")).toBe(2);
    expect(await planRegionCap(metered(null), "w1")).toBeNull();
    expect(await planRegionCap({ plan: async () => null }, "w1")).toBeNull();
    expect(await planRegionCap(metered(0), "w1")).toBe("unavailable");
    expect(await planRegionCap(metered("2"), "w1")).toBe("unavailable");
    expect(await planRegionCap(metered(0, false), "w1")).toBeNull();
    const broken = (failClosed: boolean) => ({ failClosed, plan: async () => { throw new Error("catalog invalid"); } });
    expect(await planRegionCap(broken(true), "w1")).toBe("unavailable");
    expect(await planRegionCap(broken(false), "w1")).toBeNull();
  });

  it("does not read the plan when no monitor runs from several regions", async () => {
    const plan = vi.fn(async () => null);
    const single = [monitor({ regions: ["us-east"] }), monitor({ id: "m2", regions: ["auto"] })];
    expect(await withinPlanRegions(single, "w1", { plan })).toBe(single);
    expect(plan).not.toHaveBeenCalled();
  });

  it("drops only the multi-region monitors of a workspace whose plan cannot be read", async () => {
    const list = [three, monitor({ id: "m2", regions: ["us-east"] }), monitor({ id: "hb", type: "heartbeat", regions: ["auto"] })];
    const out = await withinPlanRegions(list, "w1", { failClosed: true, plan: async () => { throw new Error("down"); } });
    expect(out.map((m) => m.id)).toEqual(["m2", "hb"]);
  });

  it("charges and runs a downgraded monitor for the regions its plan allows", async () => {
    const spent: number[] = [];
    const entitlements = { ...metered(2), spendCredits: async (_w: string, n: number) => { spent.push(n); return n; }, creditBalance: async () => null, spendEmails: async (_w: string, n: number) => n, emailBalance: async () => null };
    const out = await withinCredits([three], entitlements as never);
    expect(spent).toEqual([2]);
    expect(out.map((m) => m.regions)).toEqual([["us-east", "eu-central"]]);
  });

  it("changes nothing for the community edition", async () => {
    const { unmetered } = await import("./entitlements");
    const out = await withinCredits([three], unmetered);
    expect(out).toEqual([three]);
  });
});

describe("operator probe region view", () => {
  it("derives a status from the drain flag and last-seen health", async () => {
    const { probeRegionView, PROBE_SILENT_AFTER_MS } = await import("./operator");
    const now = Date.parse("2026-11-11T12:00:00Z");
    const base = { region: "us-east", drained: false, drainedAt: null, drainedBy: null, drainNote: null, lastAnswerAt: null, lastUnreachableAt: null, lastUnreachableReason: null, unreachableSince: null };
    expect(probeRegionView("us-east", "US East", undefined, 0, now)).toMatchObject({ status: "unknown", configured: true, drained: false, lastAnswerAt: null });
    expect(probeRegionView("us-east", "US East", { ...base, lastAnswerAt: new Date(now - 1000) }, 4, now)).toMatchObject({ status: "up", monitors: 4 });
    expect(probeRegionView("us-east", "US East", { ...base, lastAnswerAt: new Date(now - PROBE_SILENT_AFTER_MS - 1) }, 0, now).status).toBe("unknown");
    expect(probeRegionView("us-east", "US East", { ...base, lastAnswerAt: new Date(now - 1000), unreachableSince: new Date(now - 500), lastUnreachableReason: "Probe unreachable" }, 0, now)).toMatchObject({ status: "unreachable", lastUnreachableReason: "Probe unreachable" });
    expect(probeRegionView("old-region", null, { ...base, region: "old-region", drained: true, drainNote: "Synthetic note" }, 0, now)).toMatchObject({ status: "drained", configured: false, name: "old-region", drainNote: "Synthetic note" });
  });
});
