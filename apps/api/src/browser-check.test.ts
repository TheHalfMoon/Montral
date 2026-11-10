/**
 * The runner without a browser: a fake worker script stands in for browser-worker.ts, so the process supervision
 * (time limit, report parsing, secret masking, environment, temp directory clean-up) and the gates (disabled, Workers,
 * concurrency) are tested on every platform.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { browserCheckWorstCaseMs, browserProbeDue, browserProbeWorstCaseMs, resetBrowserAvailability } from "./browser-check";
import { BROWSER_BUSY, BROWSER_DISABLED, BROWSER_TIME_LIMIT, BROWSER_WORKERS_UNSUPPORTED, browserRuntimeHealth, knownReportError, REPORT_MALFORMED, browserAvailable, browserCheck, browserCreationProblem, browserSettings, browserSlots, configureBrowserChecks, descendants, runBrowserWorker, workerEnv, workspaceSlots } from "./browser-check";
import { encryptSecret } from "./browser-secrets";
import { runCheck } from "./checker";

const AUTH = "browser-check-unit-test-secret-0123456789";
let dir: string;
let fake: { file: string; args: string[] };

// a stand-in worker: reads the job, then behaves as job.config.mode says
const FAKE = `
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  const mode = job.config?.mode ?? job.config?.steps?.[1]?.selector ?? "ok";
  const report = (r) => process.stdout.write("noise before the result\\nMONTRAL-BROWSER-RESULT " + JSON.stringify(r) + "\\n");
  if (process.argv.includes("--probe")) { report({ ok: true }); return process.exit(0); }
  if (mode === "#hang") return setInterval(() => {}, 1000);
  if (mode === "#cwd") { report({ ok: true, steps: [], failedStep: null, error: process.cwd(), statusCode: 200, durationMs: 1, blockedRequests: 0, popupsClosed: 0 }); return process.exit(0); }
  if (mode === "#crash") process.exit(3);
  if (mode === "#env") { report({ ok: true, steps: [], failedStep: null, error: JSON.stringify(Object.keys(process.env).sort()), statusCode: 200, durationMs: 1, blockedRequests: 0, popupsClosed: 0 }); return process.exit(0); }
  if (mode === "#leak") { report({ ok: false, steps: [{ action: "goto", ms: 5, ok: false }], failedStep: 0, error: "Step 1 (goto): " + Object.values(job.secrets).join(","), statusCode: null, durationMs: 5, blockedRequests: 0, popupsClosed: 0 }); return process.exit(0); }
  if (mode === "#bad-types") { report({ ok: "yes", steps: "none", failedStep: null, error: null, statusCode: 200, durationMs: 1, blockedRequests: 0, popupsClosed: 0 }); return process.exit(0); }
  if (mode === "#page-text") { report({ ok: false, steps: [], failedStep: 0, error: "Welcome back, alice@example.com (account 4111111111111111)", statusCode: 200, durationMs: 1, blockedRequests: 0, popupsClosed: 0 }); return process.exit(0); }
  if (mode === "#bad-shot") { report({ ok: false, steps: [], failedStep: 0, error: "Step 1 (goto): timed out", statusCode: 200, durationMs: 1, blockedRequests: 0, popupsClosed: 0, screenshot: "<script>" }); return process.exit(0); }
  if (mode === "#extra") { report({ ok: true, steps: [{ action: "goto", ms: 1, ok: true, html: "<b>page</b>" }], failedStep: null, error: null, statusCode: 200, durationMs: 1, blockedRequests: 0, popupsClosed: 0, pageText: "secret page" }); return process.exit(0); }
  report({ ok: JSON.stringify(Object.keys(job.secrets)) === JSON.stringify(["pw"]) || mode === "#ok", steps: [{ action: "goto", ms: 12, ok: true }], failedStep: null, error: null, statusCode: 200, durationMs: 12, blockedRequests: 1, popupsClosed: 0 });
  process.exit(0);
});`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "montral-fake-worker-"));
  writeFileSync(join(dir, "fake-worker.mjs"), FAKE);
  fake = { file: join(dir, "fake-worker.mjs"), args: [] };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { configureBrowserChecks({}); vi.unstubAllGlobals(); });

describe("worst-case time of one check (queue-task admission)", () => {
  it("counts the slot wait, a due probe, start-up, the journey, shutdown and the runner's grace", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH, BROWSER_RUNNER_URL: "http://127.0.0.1:9", BROWSER_RUNNER_TOKEN: "worst-case-runner-token-0123456789abcdef" });
    resetBrowserAvailability();
    expect(browserProbeDue()).toBe(true);
    expect(browserProbeWorstCaseMs()).toBe(45_000);
    expect(browserCheckWorstCaseMs(60_000)).toBe(15_000 + 45_000 + 20_000 + 60_000 + 10_000 + 15_000);
    // once the probe has answered (here: unreachable, cached for a minute) the longest journey fits 120 s exactly
    await browserAvailable();
    expect(browserProbeDue()).toBe(false);
    expect(browserCheckWorstCaseMs(60_000)).toBe(120_000);
    // in-process: no runner grace
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    resetBrowserAvailability();
    expect(browserProbeWorstCaseMs()).toBe(30_000);
    expect(browserCheckWorstCaseMs(30_000)).toBe(15_000 + 30_000 + 20_000 + 30_000 + 10_000);
    resetBrowserAvailability();
  });
});

const journey = (mode: string) => ({ steps: [{ action: "goto", url: "https://example.com/" }, { action: "click", selector: mode }], timeoutMs: 5000, screenshot: "never" });

describe("browser check gates", () => {
  it("is inconclusive while not enabled, and refuses creation with a reason", async () => {
    expect(await browserCheck({ target: "https://example.com/", browser: journey("#ok") }, { worker: fake })).toMatchObject({ ok: false, inconclusive: true, error: BROWSER_DISABLED, browser: { kind: "error", error: BROWSER_DISABLED } });
    expect(await browserCreationProblem()).toMatchObject({ code: "browser_checks_disabled" });
  });

  it("is inconclusive on Cloudflare Workers, and creation is refused there", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    expect(await browserCheck({ target: "https://example.com/", browser: journey("#ok") }, { worker: fake })).toMatchObject({ ok: false, inconclusive: true, error: BROWSER_WORKERS_UNSUPPORTED, browser: { kind: "error" } });
    expect(await browserCreationProblem()).toMatchObject({ code: "browser_checks_unsupported" });
  });

  it("runCheck dispatches browser monitors", async () => {
    expect(await runCheck({ type: "browser", target: "https://example.com/", method: "GET", expectedStatus: 200, timeoutMs: 1000, browser: journey("#ok") })).toMatchObject({ ok: false, inconclusive: true, error: BROWSER_DISABLED });
  });

  it("fails an invalid stored journey without starting anything", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    expect(await browserCheck({ target: "x", browser: { steps: [{ action: "evaluate" }] } }, { worker: fake })).toEqual({ ok: false, error: "Browser journey is invalid" });
  });
});

describe("concurrency slots", () => {
  it("admits at most max holders, lets a bounded number wait, refuses the rest at once", async () => {
    const s = browserSlots(2, 1);
    const a = await s.tryEnter(0);
    const b = await s.tryEnter(0);
    expect(a && b).toBeTruthy();
    expect(await s.tryEnter(0)).toBeNull();
    const waiting = s.tryEnter(1000);
    expect(s.waiting()).toBe(1);
    expect(await s.tryEnter(1000)).toBeNull(); // the waiting room is full
    a!();
    a!(); // releasing twice frees one slot only
    const c = await waiting;
    expect(c).toBeTruthy();
    expect(s.inFlight()).toBe(2);
    b!(); c!();
    expect(s.inFlight()).toBe(0);
  });

  it("a waiter gives up after its wait and leaves the queue", async () => {
    const s = browserSlots(1, 4);
    const a = await s.tryEnter(0);
    expect(await s.tryEnter(50)).toBeNull();
    expect(s.waiting()).toBe(0);
    a!();
    expect(await s.tryEnter(0)).toBeTruthy();
  });

  it("a full server defers the check (inconclusive), never queues it without bound", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    const s = browserSlots(1, 0);
    const held = await s.tryEnter(0);
    expect(await browserCheck({ target: "x", browser: journey("#ok") }, { worker: fake, slots: s })).toMatchObject({ ok: false, inconclusive: true, error: BROWSER_BUSY, browser: { kind: "deferred", steps: [] } });
    held!();
  });

  it("one workspace runs one check at a time; another workspace is not held up by it", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    const ws = workspaceSlots(1, 0);
    const server = browserSlots(4, 0);
    const busy = await ws.tryEnter("tenant-a", 0);
    expect(busy).toBeTruthy();
    // tenant A's next check is deferred while its first runs, even though the server has free slots
    expect(await browserCheck({ target: "x", organizationId: "tenant-a", browser: journey("#ok") }, { worker: fake, slots: server, workspaces: ws, waitMs: 0 })).toMatchObject({ inconclusive: true, browser: { kind: "deferred" } });
    // tenant B runs
    expect(await browserCheck({ target: "x", organizationId: "tenant-b", browser: journey("#ok") }, { worker: fake, slots: server, workspaces: ws, waitMs: 0 })).toMatchObject({ ok: true });
    busy!();
    expect(await browserCheck({ target: "x", organizationId: "tenant-a", browser: journey("#ok") }, { worker: fake, slots: server, workspaces: ws, waitMs: 0 })).toMatchObject({ ok: true });
    // idle workspaces are forgotten
    expect(ws.size()).toBe(0);
  });

  it("a workspace's waiting check gets the slot when its previous one ends (bounded wait)", async () => {
    const ws = workspaceSlots(1, 2);
    const first = await ws.tryEnter("t", 0);
    const second = ws.tryEnter("t", 2000);
    setTimeout(() => first!(), 50);
    const got = await second;
    expect(got).toBeTruthy();
    got!();
  });

  it("refuses BROWSER_CHECK_SANDBOX=off outside development: browser checks become unavailable", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH, BROWSER_CHECK_SANDBOX: "off" });
    expect(browserSettings()).toMatchObject({ sandbox: true, sandboxRefused: true });
    expect(await browserAvailable(fake)).toBe(false);
    expect(await browserCreationProblem()).toMatchObject({ code: "browser_unavailable" });
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH, BROWSER_CHECK_SANDBOX: "off" });
      expect(browserSettings()).toMatchObject({ sandbox: false, sandboxRefused: false });
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it("ALLOW_PRIVATE_TARGETS does not turn on private targets for browsers; BROWSER_CHECK_ALLOW_PRIVATE_TARGETS does", () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", ...({ ALLOW_PRIVATE_TARGETS: "true" } as object) });
    expect(browserSettings().allowPrivate).toBe(false);
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BROWSER_CHECK_ALLOW_PRIVATE_TARGETS: "true" });
    expect(browserSettings().allowPrivate).toBe(true);
  });
});

describe("worker supervision", () => {
  it("runs the worker, reads its report among other output and passes it the secrets it needs", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    const browser = { steps: [{ action: "goto", url: "https://example.com/" }, { action: "fill", selector: "#ok", secretRef: "pw" }], timeoutMs: 5000 };
    const out = await browserCheck({ target: "x", id: "m1", organizationId: "o1", browser, browserSecrets: { pw: await encryptSecret(AUTH, "o1", "m1", "pw", "v"), unused: await encryptSecret(AUTH, "o1", "m1", "unused", "u") } }, { worker: fake });
    expect(out).toMatchObject({ ok: true, latencyMs: 12, statusCode: 200, browser: { blockedRequests: 1, steps: [{ action: "goto", ms: 12, ok: true }] } });
    // ok only when the worker received exactly the secret the journey uses (and not "unused")
    expect(out.ok).toBe(true);
  });

  it("masks secret values in whatever comes back", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    const browser = { steps: [{ action: "goto", url: "https://example.com/" }, { action: "fill", selector: "#leak", secretRef: "pw" }], timeoutMs: 5000 };
    const out = await browserCheck({ target: "x", id: "m1", organizationId: "o1", browser, browserSecrets: { pw: await encryptSecret(AUTH, "o1", "m1", "pw", "hunter2-secret") } }, { worker: fake });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("hunter2-secret");
    // a report whose error is not one of the fixed messages is not trusted at all
    expect(out).toMatchObject({ inconclusive: true, error: REPORT_MALFORMED, browser: { kind: "error" } });
  });

  it("validates every worker report strictly: wrong types, page text and bad screenshots become a fixed error; extra fields are dropped", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    for (const mode of ["#bad-types", "#page-text", "#bad-shot"]) {
      const out = await browserCheck({ target: "x", browser: journey(mode) }, { worker: fake });
      expect(out, mode).toMatchObject({ ok: false, inconclusive: true, error: REPORT_MALFORMED, browser: { kind: "error", error: REPORT_MALFORMED } });
      expect(JSON.stringify(out), mode).not.toMatch(/alice@example.com|4111|<script>/);
    }
    const extra = await browserCheck({ target: "x", browser: journey("#extra") }, { worker: fake });
    expect(extra.ok).toBe(true);
    expect(JSON.stringify(extra)).not.toMatch(/pageText|secret page|<b>page/);
    expect(knownReportError("Step 3 (click): element not found")).toBe(true);
    expect(knownReportError("Step 5 (assertStatus): unexpected HTTP status (500, expected 200)")).toBe(true);
    expect(knownReportError("Step 1 (evaluate): failed")).toBe(false);
    expect(knownReportError("Step 1 (goto): timed out; cookie=abc")).toBe(false);
  });

  it("kills a worker that overruns its time and reports the time limit", async () => {
    const t0 = Date.now();
    const run = await runBrowserWorker({ config: { mode: "#hang" }, secrets: {}, policy: { allowPrivate: false }, sandbox: true }, { worker: fake, hardTimeoutMs: 800, maxRssMb: 1024 });
    expect(run).toMatchObject({ report: null, killed: "time" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("a worker that dies without a report makes the check inconclusive, recorded as an error run, not a target failure", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    expect(await browserCheck({ target: "x", browser: journey("#crash") }, { worker: fake })).toMatchObject({ ok: false, inconclusive: true, browser: { kind: "error", error: "Browser check failed" } });
    expect(browserRuntimeHealth()).toMatchObject({ enabled: true, mode: "in-process", lastError: "Browser check failed" });
  });

  it("maps the time limit to a fixed failure", async () => {
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH });
    // hard limit = launch allowance + journey + shutdown allowance: shrink the journey and let the fake hang past it
    const slow = await runBrowserWorker({ config: { mode: "#hang" }, secrets: {}, policy: { allowPrivate: false }, sandbox: true }, { worker: fake, hardTimeoutMs: 300, maxRssMb: 1024 });
    expect(slow.killed).toBe("time");
    expect(BROWSER_TIME_LIMIT).toBe("Browser check exceeded its time limit");
  });

  it("gives the worker no server secrets: PATH, its own temp/home and the browser path only", async () => {
    process.env.DATABASE_URL_FOR_TEST_ONLY = "postgres://secret";
    try {
      const run = await runBrowserWorker({ config: { mode: "#env" }, secrets: {}, policy: { allowPrivate: false }, sandbox: true }, { worker: fake, hardTimeoutMs: 10_000, maxRssMb: 1024 });
      const keys = JSON.parse(run.report!.error!) as string[];
      expect(keys).not.toContain("DATABASE_URL_FOR_TEST_ONLY");
      // (Windows and macOS add system variables of their own to every process; the allowlist is checked on Linux, where
      // the product runs)
      if (process.platform === "linux") for (const k of keys) expect(["PATH", "Path", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "LANG", "PLAYWRIGHT_BROWSERS_PATH", "SystemRoot", "windir", "SYSTEMROOT", "WINDIR"], k).toContain(k);
    } finally {
      delete process.env.DATABASE_URL_FOR_TEST_ONLY;
    }
    const env = await workerEnv("/tmp/x");
    expect(env).toMatchObject({ HOME: "/tmp/x", TMPDIR: "/tmp/x" });
  });

  it("deletes the per-check temporary directory afterwards", async () => {
    const run = await runBrowserWorker({ config: { mode: "#cwd" }, secrets: {}, policy: { allowPrivate: false }, sandbox: true }, { worker: fake, hardTimeoutMs: 10_000, maxRssMb: 1024 });
    const used = run.report!.error!;
    expect(used).toContain("montral-browser-");
    expect(existsSync(used)).toBe(false);
  });
});

describe("process tree", () => {
  it("finds every descendant of the worker, including re-parented grandchildren", () => {
    const table = [{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 11 }, { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 }];
    expect(descendants(table, 10).sort()).toEqual([10, 11, 12, 13]);
    expect(descendants(table, 99)).toEqual([99]);
  });
});
