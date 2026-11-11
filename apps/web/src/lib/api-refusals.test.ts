import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The API client in a stubbed browser: a suspended workspace and a used-up allowance are recognised from the refusal
// itself, and the shell is told (events), so pages never have to show the raw error.
let events: string[];
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("API refusals the shell reacts to", () => {
  beforeEach(() => {
    vi.resetModules();
    events = [];
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => { events.push(e.type); return true; }, location: { pathname: "/app" } });
    vi.stubGlobal("location", { pathname: "/app", href: "" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a 403 workspace_suspended marks the workspace suspended once, and switching workspace clears it", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "This workspace is suspended. Contact support.", code: "workspace_suspended" }));
    const { api, isSuspended, resetCache, ApiError } = await import("./api");
    expect(isSuspended()).toBe(false);
    await expect(api.monitors()).rejects.toBeInstanceOf(ApiError);
    await expect(api.channels()).rejects.toMatchObject({ status: 403, code: "workspace_suspended" });
    expect(isSuspended()).toBe(true);
    expect(events.filter((e) => e === "montral:suspended")).toHaveLength(1);
    resetCache();
    expect(isSuspended()).toBe(false);
  });

  it("any other 403 is not a suspension", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "Only owners", code: "forbidden" }));
    const { api, isSuspended } = await import("./api");
    await expect(api.monitors()).rejects.toMatchObject({ status: 403 });
    expect(isSuspended()).toBe(false);
    expect(events).toEqual([]);
  });

  it("a quota refusal keeps its reset date and asks the usage banner to refresh", async () => {
    vi.stubGlobal("fetch", answer(402, { error: "No credits left this period", code: "credits_exhausted", resetsAt: "2026-12-01T00:00:00.000Z" }));
    const { api } = await import("./api");
    await expect(api.checkNow("m1")).rejects.toMatchObject({ status: 402, code: "credits_exhausted", resetsAt: "2026-12-01T00:00:00.000Z" });
    expect(events).toEqual(["montral:usage"]);
  });

  it("a plan-limit refusal (not a used-up allowance) does not refresh the banner", async () => {
    vi.stubGlobal("fetch", answer(402, { error: "limit", code: "monitor_limit", upgradeUrl: "/app/billing" }));
    const { api } = await import("./api");
    await expect(api.createMonitor({ name: "x" })).rejects.toMatchObject({ code: "monitor_limit", upgradeUrl: "/app/billing", resetsAt: undefined });
    expect(events).toEqual([]);
  });

  it("a refusal from the previous workspace, answered after a switch, does not flag the new one", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => {
      release = () => done(new Response(JSON.stringify({ error: "suspended", code: "workspace_suspended" }), { status: 403 }));
    })));
    const { api, isSuspended, resetCache } = await import("./api");
    const pending = api.monitors();
    resetCache(); // switched workspace while the request was in flight
    release();
    await expect(pending).rejects.toMatchObject({ code: "workspace_suspended" });
    expect(isSuspended()).toBe(false);
    expect(events).toEqual([]);
  });

  it("a later workspace call that succeeds in the same workspace lifts the notice; public config does not", async () => {
    const fetchMock = answer(403, { error: "suspended", code: "workspace_suspended" });
    vi.stubGlobal("fetch", fetchMock);
    const { api, isSuspended } = await import("./api");
    await expect(api.monitors()).rejects.toBeTruthy();
    expect(isSuspended()).toBe(true);
    vi.stubGlobal("fetch", answer(200, {}));
    await api.config();
    expect(isSuspended()).toBe(true);
    await api.projects();
    expect(isSuspended()).toBe(false);
    expect(events).toEqual(["montral:suspended", "montral:unsuspended"]);
  });

  it("while suspended, the periodic re-check (no-store /me) clears the notice on its first success, not on a refusal", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "suspended", code: "workspace_suspended" }));
    const { api, isSuspended, recheckSuspension, SUSPENSION_RECHECK_MS } = await import("./api");
    await expect(api.monitors()).rejects.toBeTruthy();
    expect(SUSPENSION_RECHECK_MS).toBe(60_000);
    // still suspended: the re-check is refused, nothing changes and nothing throws
    await recheckSuspension();
    expect(isSuspended()).toBe(true);
    const ok = answer(200, { userId: "u" });
    vi.stubGlobal("fetch", ok);
    await recheckSuspension();
    expect(ok).toHaveBeenCalledWith("/api/me", expect.objectContaining({ cache: "no-store" }));
    expect(isSuspended()).toBe(false);
    expect(events).toEqual(["montral:suspended", "montral:unsuspended"]);
  });
});

