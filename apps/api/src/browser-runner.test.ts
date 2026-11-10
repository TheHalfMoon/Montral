/**
 * The app <-> browser-runner channel: HMAC per request, replay and clock-skew refusal, bounded bodies, signed responses,
 * and the runner never trusting a job's policy to be looser than its own. Runs with a fake job runner (no browser).
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserCheck, browserRuntimeHealth, browserSlots, configureBrowserChecks, resetBrowserAvailability, RUNNER_MALFORMED, RUNNER_UNREACHABLE, type WorkerOptions, type WorkerRun } from "./browser-check";
import { createRunnerServer } from "./browser-runner";
import { callRunner, MAX_REQUEST_BYTES, nonceCache, openSecrets, RUNNER_HEADER, RunnerError, sealSecrets, signRequest, verifyRequest, verifyResponse } from "./browser-runner-protocol";
import type { WorkerJob } from "./browser-worker";

const TOKEN = "runner-test-token-0123456789abcdef0123456789";
const seen: { job: WorkerJob; opts: WorkerOptions }[] = [];
const fakeRun = async (job: WorkerJob, opts: WorkerOptions): Promise<WorkerRun> => {
  seen.push({ job, opts });
  if (opts.probe) return { report: null, probeOk: true, killed: null, peakRssMb: 1, cpuMs: 1, exitCode: 0 };
  if ((job.config as { hold?: number } | null)?.hold) await new Promise((r) => setTimeout(r, (job.config as { hold: number }).hold));
  const mode = (job.config as { steps?: { selector?: string }[] } | null)?.steps?.[1]?.selector;
  if (mode === "#malformed") return { report: { ok: "maybe", steps: [], error: "<html>page</html>" } as never, killed: null, peakRssMb: 1, cpuMs: 1, exitCode: 0 };
  return { report: { ok: true, steps: [{ action: "goto", ms: 5, ok: true }], failedStep: null, error: null, statusCode: 200, durationMs: 5, blockedRequests: 0, popupsClosed: 0 }, killed: null, peakRssMb: 100, cpuMs: 50, exitCode: 0, dir: "/tmp/montral-browser-secret-path" };
};

let server: Server;
let base = "";
beforeAll(async () => {
  server = await createRunnerServer({ token: TOKEN, slots: browserSlots(1, 0), run: fakeRun, maxRssMb: 1024, maxHardTimeoutMs: 95_000 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const job = (extra: Partial<WorkerJob> = {}): WorkerJob => ({ config: { steps: [] }, secrets: { pw: "x" }, policy: { allowPrivate: false }, sandbox: false, ...extra });
const raw = async (path: string, body: string, header?: string) => {
  const r = await fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...(header ? { [RUNNER_HEADER]: header } : {}) } });
  return { status: r.status, text: await r.text(), signature: r.headers.get(RUNNER_HEADER) };
};

describe("browser-runner channel", () => {
  it("refuses a token shorter than 32 characters at start-up", async () => {
    await expect(createRunnerServer({ token: "short", slots: browserSlots(1, 0), run: fakeRun, maxRssMb: 1024 })).rejects.toThrow(/at least 32/);
  });

  it("runs a signed job and signs its answer; health needs no signature and says nothing else", async () => {
    const r = await callRunner<{ run: WorkerRun }>(base, TOKEN, "/v1/run", { job: job(), hardTimeoutMs: 30_000, maxRssMb: 512 }, 10_000);
    expect(r.status).toBe(200);
    expect(r.body.run.report?.ok).toBe(true);
    // the runner's local paths never go back
    expect(JSON.stringify(r.body)).not.toContain("montral-browser-secret-path");
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    expect((await callRunner<{ ok: boolean }>(base, TOKEN, "/v1/probe", {}, 10_000)).body).toEqual({ ok: true });
  });

  it("refuses unsigned, wrongly signed, stale and replayed requests, and oversized bodies", async () => {
    const body = JSON.stringify({ job: job(), hardTimeoutMs: 1000, maxRssMb: 512 });
    expect((await raw("/v1/run", body)).status).toBe(401);
    const wrong = await signRequest("another-token-0123456789abcdef0123456789", "POST", "/v1/run", body);
    expect(await raw("/v1/run", body, wrong.header)).toMatchObject({ status: 401, signature: null });
    const stale = await signRequest(TOKEN, "POST", "/v1/run", body, Date.now() - 5 * 60_000);
    // every refusal looks the same from outside (no reason, no signature)
    expect(await raw("/v1/run", body, stale.header)).toEqual({ status: 401, text: JSON.stringify({ error: "unauthorized" }), signature: null });
    const fresh = await signRequest(TOKEN, "POST", "/v1/run", body);
    expect((await raw("/v1/run", body, fresh.header)).status).toBe(200);
    expect(await raw("/v1/run", body, fresh.header)).toEqual({ status: 401, text: JSON.stringify({ error: "unauthorized" }), signature: null });
    // the signature covers the body and the path
    const tampered = await signRequest(TOKEN, "POST", "/v1/run", body);
    expect((await raw("/v1/run", body.replace("512", "4096"), tampered.header)).status).toBe(401);
    const otherPath = await signRequest(TOKEN, "POST", "/v1/probe", body);
    expect((await raw("/v1/run", body, otherPath.header)).status).toBe(401);
    const big = JSON.stringify({ pad: "x".repeat(MAX_REQUEST_BYTES + 1) });
    expect((await raw("/v1/run", big, (await signRequest(TOKEN, "POST", "/v1/run", big)).header)).status).toBe(413);
    await expect(callRunner(base, TOKEN, "/v1/run", { pad: "x".repeat(MAX_REQUEST_BYTES) }, 5000)).rejects.toBeInstanceOf(RunnerError);
  });

  it("the app refuses an answer that was not signed by the runner for this request", async () => {
    expect(await verifyResponse(TOKEN, "a".repeat(32), 200, "{}", "s=" + "0".repeat(64))).toBe(false);
    await expect(callRunner(base, "another-token-0123456789abcdef0123456789", "/v1/run", { job: job() }, 5000)).rejects.toMatchObject({ why: "unsigned" });
  });

  it("answers busy when its own slots are full (the app records the check as deferred)", async () => {
    const holding = callRunner(base, TOKEN, "/v1/run", { job: job({ config: { hold: 400 } }), hardTimeoutMs: 1000, maxRssMb: 512 }, 10_000);
    await new Promise((r) => setTimeout(r, 100));
    const busy = await callRunner<{ busy: true }>(base, TOKEN, "/v1/run", { job: job(), hardTimeoutMs: 1000, maxRssMb: 512 }, 10_000);
    expect(busy).toMatchObject({ status: 429, body: { busy: true } });
    expect((await holding).status).toBe(200);
  });

  it("makes every job's policy at least as strict as its own: no test allowances, never the app or itself, sandbox on, bounded limits", async () => {
    seen.length = 0;
    await callRunner(base, TOKEN, "/v1/run", { job: job({ policy: { allowPrivate: true, extraAllowed: ["10.0.0.9:80"] }, testAbortAfterMs: 5, executablePath: "/evil" }), hardTimeoutMs: 10_000_000, maxRssMb: 100_000 }, 10_000);
    const { job: ran, opts } = seen[0];
    expect(ran.policy.extraAllowed).toBeUndefined();
    expect(ran.policy.allowPrivate).toBe(true);
    expect(ran.policy.deny).toEqual(expect.arrayContaining(["127.0.0.1"]));
    expect(ran.sandbox).toBe(true);
    expect(ran.testAbortAfterMs).toBeUndefined();
    expect(ran.executablePath).toBeUndefined();
    expect(opts.hardTimeoutMs).toBe(95_000);
    expect(opts.maxRssMb).toBe(1024);
  });

  it("nonce cache: one use per nonce, bounded, entries expire", async () => {
    const n = nonceCache(3);
    expect(n.use("a", 0)).toBe(true);
    expect(n.use("a", 1)).toBe(false);
    n.use("b", 2); n.use("c", 3); n.use("d", 4);
    expect(n.size()).toBe(3);
    expect(n.use("a", 10 * 60_000)).toBe(true);
    const body = "{}";
    const s = await signRequest(TOKEN, "POST", "/v1/probe", body);
    const cache = nonceCache();
    expect(await verifyRequest(TOKEN, "POST", "/v1/probe", body, s.header, cache)).toMatchObject({ ok: true });
    expect(await verifyRequest(TOKEN, "POST", "/v1/probe", body, s.header, cache)).toMatchObject({ ok: false, why: "replay" });
    expect(await verifyRequest(TOKEN, "POST", "/v1/probe", body, "t=1,n=zz,s=00", cache)).toMatchObject({ ok: false, why: "missing" });
  });
});

describe("browser-runner from the app's side", () => {
  const journey = (mode: string) => ({ target: "https://example.com/", id: "m1", organizationId: "o1", browser: { steps: [{ action: "goto", url: "https://example.com/" }, { action: "click", selector: mode }], timeoutMs: 5000 } });
  const configure = (url: string) => { configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: "app-secret-0123456789abcdef", BROWSER_RUNNER_URL: url, BROWSER_RUNNER_TOKEN: TOKEN }); resetBrowserAvailability(); };

  it("secrets travel sealed with a key from the token: not readable in the request, opened by the runner only", async () => {
    const sealed = await sealSecrets(TOKEN, { password: "hunter2-in-transit" });
    expect(sealed).not.toContain("hunter2");
    expect(await openSecrets(TOKEN, sealed)).toEqual({ password: "hunter2-in-transit" });
    expect(await openSecrets("another-token-0123456789abcdef0123456789", sealed)).toBeNull();
    expect(await openSecrets(TOKEN, sealed.slice(0, -4) + "AAA=")).toBeNull();
    seen.length = 0;
    const r = await callRunner(base, TOKEN, "/v1/run", { job: job({ secrets: {} }), sealedSecrets: sealed, hardTimeoutMs: 1000, maxRssMb: 512 }, 10_000);
    expect(r.status).toBe(200);
    expect(seen[0].job.secrets).toEqual({ password: "hunter2-in-transit" });
    // a sealed blob that does not open is refused
    expect((await callRunner(base, TOKEN, "/v1/run", { job: job(), sealedSecrets: "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", hardTimeoutMs: 1000, maxRssMb: 512 }, 10_000)).status).toBe(400);
  });

  it("runs through the runner, and a malformed runner answer becomes a fixed error run (never stored as is)", async () => {
    configure(base);
    try {
      expect(await browserCheck(journey("#ok"))).toMatchObject({ ok: true, browser: { kind: "run" } });
      const bad = await browserCheck(journey("#malformed"));
      expect(bad).toMatchObject({ ok: false, inconclusive: true, error: RUNNER_MALFORMED, browser: { kind: "error", error: RUNNER_MALFORMED } });
      expect(JSON.stringify(bad)).not.toContain("<html>");
    } finally {
      configureBrowserChecks({});
    }
  });

  it("an unreachable runner gives an error run and shows in the runtime health", async () => {
    configure("http://127.0.0.1:9");
    try {
      const out = await browserCheck(journey("#ok"));
      expect(out).toMatchObject({ ok: false, inconclusive: true, browser: { kind: "error" } });
      expect(browserRuntimeHealth()).toMatchObject({ enabled: true, mode: "runner", available: false, lastError: RUNNER_UNREACHABLE });
    } finally {
      configureBrowserChecks({});
    }
  });
});
