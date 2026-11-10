/**
 * The isolated process one browser check runs in (started by browser-check.ts, one process per check, never reused).
 *
 * Reads one job (JSON) from stdin, runs it in a fresh headless Chromium with a fresh incognito context, writes one result
 * line to stdout and exits. Nothing of a run survives it: the browser profile and every temporary file live in the
 * per-check directory the parent created (TMPDIR / HOME) and deletes afterwards.
 *
 * Inside: the egress proxy (browser-egress.ts) is Chromium's only route out; Playwright routing refuses non-network
 * schemes before they reach it; service workers and downloads are blocked; popups are closed as they open; dialogs
 * are dismissed. The parent enforces time, memory and CPU limits from outside and kills this whole process tree.
 *
 * `--probe`: start Chromium with the same options and stop it again (is a browser available on this server?).
 */
import { browserConfigSchema, MAX_SCREENSHOT_BYTES, maskSecrets, stepError, stepTimeout, STEP_FAILURES, urlMatches, type BrowserRunReport, type BrowserStep, type BrowserStepResult, type StepFailure } from "./browser-steps";
import { DEFAULT_EGRESS_LIMITS, EGRESS_HEADER, schemeAllowed, startEgressProxy, type EgressLimits, type EgressPolicy } from "./browser-egress";

export type WorkerJob = {
  config: unknown;
  secrets: Record<string, string>;
  policy: Omit<EgressPolicy, "resolve">;
  limits?: Partial<EgressLimits>;
  executablePath?: string;
  sandbox: boolean;
  userAgent?: string;
  /** renderer V8 heap cap, MiB */
  rendererHeapMb?: number;
  launchTimeoutMs?: number;
  /** test seam only (never set from the API): abort this worker this long after Chromium started, to prove a crashed worker leaves no Chromium behind */
  testAbortAfterMs?: number;
};

export const RESULT_PREFIX = "MONTRAL-BROWSER-RESULT ";
const MAX_JOB_BYTES = 256 * 1024;

/** Chromium flags every check runs with (on top of Playwright's headless defaults). */
export function chromiumArgs(heapMb: number): string[] {
  return [
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--metrics-recording-only",
    "--mute-audio",
    "--dns-prefetch-disable",
    "--disable-quic",
    "--no-pings",
    // Chromium's own resolver answers nothing: every name goes to the egress proxy, which resolves and validates it
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    // WebRTC may only use UDP through the proxy, which has none: no STUN/TURN to arbitrary or private addresses
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--renderer-process-limit=2",
    `--js-flags=--max-old-space-size=${heapMb}`,
  ];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += (c as Buffer).length;
    if (size > MAX_JOB_BYTES) throw new Error("job too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function emit(report: unknown, secrets: string[]) {
  process.stdout.write(RESULT_PREFIX + maskSecrets(JSON.stringify(report), secrets) + "\n");
}

type Launched = { browser: import("playwright-core").Browser; close: () => Promise<void> };

async function launch(job: WorkerJob, proxyPort: number): Promise<Launched> {
  // a variable specifier keeps bundlers from inlining playwright-core: it is installed only where browser checks run
  const pkg = "playwright-core";
  const { chromium } = (await import(pkg)) as typeof import("playwright-core");
  const browser = await chromium.launch({
    headless: true,
    executablePath: job.executablePath || undefined,
    chromiumSandbox: job.sandbox,
    timeout: job.launchTimeoutMs ?? 20_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
    args: chromiumArgs(job.rendererHeapMb ?? 256),
  });
  return { browser, close: async () => { await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]); } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Step-level failure carrying one of the fixed reasons. */
class StepFailed extends Error {
  constructor(readonly why: StepFailure, readonly extra = "") { super(why); }
}

async function run(job: WorkerJob): Promise<BrowserRunReport> {
  const parsed = browserConfigSchema.safeParse(job.config);
  const empty: BrowserRunReport = { ok: false, steps: [], failedStep: null, error: "Browser journey is invalid", statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 };
  if (!parsed.success) return empty;
  const config = parsed.data;
  const limits = { ...DEFAULT_EGRESS_LIMITS, ...(job.limits ?? {}) };
  const proxy = await startEgressProxy(job.policy, limits);
  let launched: Launched | undefined;
  const results: BrowserStepResult[] = [];
  let statusCode: number | null = null;
  let mainBlocked = false;
  let crashed = false;
  let popupsClosed = 0;
  let screenshot: string | undefined;
  let failure: { index: number; error: string } | null = null;
  let networkError = false;
  let journeyStart = Date.now();
  try {
    launched = await launch(job, proxy.port);
    if (job.testAbortAfterMs) setTimeout(() => process.abort(), job.testAbortAfterMs);
    const context = await launched.browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 720 },
      userAgent: job.userAgent,
      permissions: [],
    });
    // the first line of the egress policy: anything that is not an ordinary web request never reaches the network stack
    // (host and address decisions are the proxy's alone, made with the address it then dials)
    await context.route("**/*", (route) => {
      if (!schemeAllowed(route.request().url())) {
        proxy.stats.blocked++;
        return route.abort("blockedbyclient");
      }
      return route.fallback();
    });
    const page = await context.newPage();
    context.on("page", (p) => { if (p !== page) { popupsClosed++; void p.close().catch(() => {}); } });
    page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
    page.on("crash", () => { crashed = true; });
    page.on("response", (r) => {
      try {
        if (r.frame() !== page.mainFrame() || !r.request().isNavigationRequest()) return;
        statusCode = r.status();
        if (r.headers()[EGRESS_HEADER] === "blocked") mainBlocked = true;
      } catch { /* detached frame */ }
    });
    const secretSelectors: string[] = [];
    journeyStart = Date.now();
    const deadline = journeyStart + config.timeoutMs;
    for (let i = 0; i < config.steps.length; i++) {
      const step = config.steps[i];
      const t0 = Date.now();
      const left = deadline - t0;
      if (left <= 0) { failure = { index: i, error: stepError(i, step.action, "timeout") }; break; }
      const budget = Math.max(1, Math.min(stepTimeout(step), left));
      const blockedBefore = proxy.stats.events.length;
      mainBlocked = false;
      // a step ends as soon as the page crashes or goes past the transfer limit, not at its timeout
      let watch: ReturnType<typeof setInterval> | undefined;
      const stopped = new Promise<never>((_, reject) => {
        watch = setInterval(() => {
          if (crashed) reject(new StepFailed("crashed"));
          else if (proxy.stats.limitHit === "transfer") reject(new StepFailed("transfer"));
        }, 100);
      });
      stopped.catch(() => {});
      try {
        await Promise.race([runStep(page, step, budget, job.secrets, () => statusCode), stopped]).finally(() => clearInterval(watch));
        if (step.action === "fill" && step.secretRef) secretSelectors.push(step.selector);
        if (mainBlocked) throw new StepFailed("blocked");
        // a page may finish loading on a cut-off body: the limit itself is the failure
        if (proxy.stats.limitHit === "transfer") throw new StepFailed("transfer");
        results.push({ action: step.action, ms: Date.now() - t0, ok: true });
      } catch (e) {
        results.push({ action: step.action, ms: Date.now() - t0, ok: false });
        const tunnelBlocked = proxy.stats.events.slice(blockedBefore).some((ev) => ev.kind === "blocked");
        const why = classify(e, { crashed, transfer: proxy.stats.limitHit === "transfer", tunnelBlocked, mainBlocked });
        if (why.why === "navigation") networkError = true;
        failure = { index: i, error: stepError(i, step.action, why.why, why.extra) };
        break;
      }
    }
    if (failure && config.screenshot === "on_failure" && !crashed) screenshot = await capture(page, secretSelectors);
  } catch (e) {
    // the browser itself did not start or went away: reported to the parent, which decides (inconclusive)
    const msg = e instanceof Error ? e.message : "";
    if (!launched) return { ...empty, error: "launch" };
    failure ??= { index: results.length, error: /crash|closed|disconnected/i.test(msg) ? stepError(results.length, "goto", "crashed") : "Browser check failed" };
  } finally {
    await launched?.close();
    await proxy.close();
  }
  return {
    ok: !failure,
    steps: results,
    failedStep: failure?.index ?? null,
    error: failure?.error ?? null,
    statusCode,
    durationMs: Date.now() - journeyStart,
    blockedRequests: proxy.stats.blocked,
    popupsClosed,
    ...(networkError ? { networkError } : {}),
    ...(screenshot ? { screenshot } : {}),
  };
}

function classify(e: unknown, s: { crashed: boolean; transfer: boolean; tunnelBlocked: boolean; mainBlocked: boolean }): { why: StepFailure; extra?: string } {
  if (e instanceof StepFailed) return { why: e.why, extra: e.extra };
  if (s.crashed) return { why: "crashed" };
  if (s.transfer) return { why: "transfer" };
  if (s.mainBlocked) return { why: "blocked" };
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  if (/net::ERR_TUNNEL_CONNECTION_FAILED|net::ERR_BLOCKED_BY_CLIENT|net::ERR_ACCESS_DENIED|net::ERR_UNSAFE_PORT/.test(msg)) return s.tunnelBlocked || !/TUNNEL/.test(msg) ? { why: "blocked" } : { why: "navigation" };
  if (/net::ERR_(?:CONNECTION|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED|EMPTY_RESPONSE|SSL|CERT)/.test(msg)) return { why: "navigation" };
  if (/Target crashed|Page crashed/i.test(msg)) return { why: "crashed" };
  if (name === "TimeoutError" || /Timeout \d+ms exceeded/.test(msg)) return { why: "timeout" };
  return { why: "failed" };
}

/** One step with the time it has. Every wait is bounded by `budget`; failures carry fixed reasons only. */
async function runStep(page: import("playwright-core").Page, step: BrowserStep, budget: number, secrets: Record<string, string>, status: () => number | null) {
  switch (step.action) {
    case "goto":
      await page.goto(step.url, { timeout: budget, waitUntil: "load" });
      return;
    case "click":
      await notFoundOnTimeout(page, step.selector, () => page.locator(step.selector).first().click({ timeout: budget }));
      return;
    case "fill": {
      const value = step.secretRef !== undefined ? secrets[step.secretRef] : step.value;
      if (value === undefined) throw new StepFailed("secret");
      await notFoundOnTimeout(page, step.selector, () => page.locator(step.selector).first().fill(value, { timeout: budget }));
      return;
    }
    case "press":
      await withTimeout(page.keyboard.press(step.key), budget);
      return;
    case "waitFor":
      if (step.selector !== undefined) await notFoundOnTimeout(page, step.selector, () => page.locator(step.selector!).first().waitFor({ state: "visible", timeout: budget }));
      else await page.getByText(step.text!, { exact: false }).first().waitFor({ state: "visible", timeout: budget });
      return;
    case "assertText": {
      const selector = step.selector ?? "body";
      const until = Date.now() + budget;
      for (;;) {
        const left = until - Date.now();
        const text = left > 0 ? await page.locator(selector).first().innerText({ timeout: Math.max(1, left) }).catch(() => null) : null;
        if (text !== null) {
          const ok = step.equals !== undefined ? text.trim() === step.equals.trim() : text.includes(step.contains!);
          if (ok) return;
        }
        if (Date.now() >= until) throw new StepFailed(text === null ? "notFound" : "textMismatch");
        await sleep(Math.min(250, Math.max(0, until - Date.now())));
      }
    }
    case "assertUrl": {
      const until = Date.now() + budget;
      for (;;) {
        if (urlMatches(step.pattern, page.url())) return;
        if (Date.now() >= until) throw new StepFailed("urlMismatch");
        await sleep(Math.min(250, Math.max(0, until - Date.now())));
      }
    }
    case "assertStatus": {
      const got = status();
      if (got === null) throw new StepFailed("noResponse");
      if (got !== step.code) throw new StepFailed("status", ` (${got}, expected ${step.code})`);
      return;
    }
    case "evaluate": {
      // Evaluated by the DevTools protocol in the page's main world (not subject to the page's CSP), as the body of an
      // async function. Only `true` passes; what the script returns or throws is never stored (it may hold page data).
      let result: unknown;
      try {
        result = await withTimeout(page.evaluate(`(async () => {\n"use strict";\n${step.script}\n})()`), budget);
      } catch (e) {
        throw new StepFailed((e as Error)?.name === "TimeoutError" ? "timeout" : "scriptError");
      }
      if (result !== true) throw new StepFailed("scriptFalse");
      return;
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`Timeout ${ms}ms exceeded`), { name: "TimeoutError" })), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** A locator action that timed out because nothing matched is "element not found", not a bare timeout. */
async function notFoundOnTimeout(page: import("playwright-core").Page, selector: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      const n = await withTimeout(page.locator(selector).count(), 1000).catch(() => -1);
      if (n === 0) throw new StepFailed("notFound");
    }
    throw e;
  }
}

/** A PNG of the viewport with secret-filled fields and password inputs masked, within MAX_SCREENSHOT_BYTES; else none. */
async function capture(page: import("playwright-core").Page, secretSelectors: string[]): Promise<string | undefined> {
  const mask = [page.locator("input[type=password]"), ...secretSelectors.map((s) => page.locator(s))];
  const shots: { clip?: { x: number; y: number; width: number; height: number } }[] = [{}, { clip: { x: 0, y: 0, width: 800, height: 450 } }, { clip: { x: 0, y: 0, width: 480, height: 270 } }];
  for (const opt of shots) {
    try {
      const png = await page.screenshot({ type: "png", timeout: 3000, animations: "disabled", caret: "hide", mask, maskColor: "#000000", ...opt });
      if (png.byteLength <= MAX_SCREENSHOT_BYTES) return png.toString("base64");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function probe(job: WorkerJob): Promise<{ ok: boolean }> {
  const proxy = await startEgressProxy({ allowPrivate: false });
  try {
    const l = await launch(job, proxy.port);
    await l.close();
    return { ok: true };
  } catch (e) {
    // stderr is read and dropped by the parent; useful when running the worker by hand
    process.stderr.write(`launch failed: ${e instanceof Error ? e.message : String(e)}
`);
    return { ok: false };
  } finally {
    await proxy.close();
  }
}

async function main() {
  let job: WorkerJob;
  try {
    job = JSON.parse(await readStdin()) as WorkerJob;
  } catch {
    process.stdout.write(RESULT_PREFIX + JSON.stringify({ ok: false, error: "Browser journey is invalid", steps: [], failedStep: null, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 }) + "\n");
    process.exit(0);
  }
  const secrets = Object.values(job.secrets ?? {});
  try {
    if (process.argv.includes("--probe")) emit(await probe(job), secrets);
    else emit(await run(job), secrets);
  } catch {
    emit({ ok: false, error: "Browser check failed", steps: [], failedStep: null, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 }, secrets);
  }
  // never linger: the parent deletes this process's directory as soon as it is gone
  process.exit(0);
}

// only as the entry point, never when a test imports this module for its helpers
const entry = process.argv[1] ?? "";
if (/browser-worker\.(?:mjs|ts|js)$/.test(entry.replace(/\\/g, "/"))) void main();

export { STEP_FAILURES };
