/**
 * Browser (synthetic multi-step) checks: the parent side. Node only (self-hosted server), off unless the operator turns
 * it on (BROWSER_CHECKS=enabled) and a Chromium can actually be started.
 *
 * Where Chromium runs: with BROWSER_RUNNER_URL (Docker, docker-compose.browser.yml) every run is sent over a signed
 * channel to the separate browser-runner service (browser-runner.ts), which has no app secrets and no database network;
 * without it, the worker runs in this process tree (plain Node; weaker, see /docs/self-host#browser-checks). The
 * supervision below runs wherever the worker does.
 *
 * Every check runs in its own short-lived child process (browser-worker.ts) with its own temporary directory, which is
 * deleted afterwards; that process starts its own Chromium with a fresh incognito context, so nothing (cookies, storage,
 * cache, service workers) carries over from one check, or one workspace, to the next.
 *
 * Limits, enforced from outside the child:
 * - at most MAX_BROWSER_CHECKS checks at once per server (default 2); a few more may wait briefly for a slot
 *   (MAX_WAITING, WAIT_MS), and one per workspace (PER_WORKSPACE_BROWSER_CHECKS); beyond that the check is deferred:
 *   inconclusive, recorded as a deferred run, alerted after BROWSER_DEFERRED_ALERT_AFTER in a row, never queued without bound;
 * - wall time: the journey's own timeout (<= 60 s) plus browser start-up and shutdown allowances, then the whole process
 *   tree is killed;
 * - memory and CPU (Linux): the resident set and CPU time of the whole process tree (worker, Chromium and its children)
 *   are sampled every SAMPLE_MS from /proc; past BROWSER_CHECK_MAX_RSS_MB or MAX_CPU_MS the tree is killed and the check
 *   fails with a fixed message. The renderer's V8 heap and the worker's own heap are capped as well.
 * - orphans (Linux): every process whose command line names the check's directory (Chromium's profile is inside it) is
 *   killed after the run, so a worker that crashed cannot leave a browser behind.
 * - the child gets no server secrets: its environment is PATH, its temp directory and the Playwright browser path only;
 *   the secrets of its own journey come over stdin.
 */
import type { CheckInput, CheckOutcome } from "./checker";
import { z } from "zod";
import { browserConfigSchema, MAX_SCREENSHOT_BYTES, maskSecrets, secretRefs, STEP_FAILURES, type BrowserRunReport } from "./browser-steps";
import { decryptForRun } from "./browser-secrets";
import { checkUserAgent, isWorkers } from "./netguard";
import { proberOnline } from "./selfcheck";
import { decideEgress, ownAddresses } from "./browser-egress";
import { callRunner, RunnerError, sealSecrets } from "./browser-runner-protocol";
import type { WorkerJob } from "./browser-worker";

export const BROWSER_WORKERS_UNSUPPORTED = "Browser checks need the self-hosted Node runtime";
export const BROWSER_DISABLED = "Browser checks are not enabled on this server";
export const BROWSER_UNAVAILABLE = "Browser unavailable on this server";
export const BROWSER_BUSY = "Browser check capacity is full on this server; check deferred";
export const BROWSER_TIME_LIMIT = "Browser check exceeded its time limit";
export const BROWSER_MEMORY_LIMIT = "Browser check exceeded its memory limit";
export const BROWSER_CPU_LIMIT = "Browser check exceeded its CPU limit";
export const BROWSER_INVALID = "Browser journey is invalid";
export const BROWSER_FAILED = "Browser check failed";
const RESULT_PREFIX = "MONTRAL-BROWSER-RESULT ";

export const DEFAULT_MAX_BROWSER_CHECKS = 2;
export const DEFAULT_MAX_RSS_MB = 1024;
/** CPU time of the whole tree per check: a page spinning one core is stopped after this, whatever its timeout. */
export const MAX_CPU_MS = 30_000;
export const MAX_WAITING = 4;
export const WAIT_MS = 15_000;
const SAMPLE_MS = 250;
const LAUNCH_ALLOWANCE_MS = 20_000;
const SHUTDOWN_ALLOWANCE_MS = 10_000;
const WORKER_HEAP_MB = 256;
const RENDERER_HEAP_MB = 256;
const MAX_STDOUT_BYTES = 1024 * 1024;

type Settings = {
  enabled: boolean; maxConcurrent: number; maxRssMb: number; executablePath?: string;
  /** Chromium's sandbox; it can be turned off only in development (NODE_ENV=development) */
  sandbox: boolean;
  /** BROWSER_CHECK_SANDBOX=off outside development: refused, so browser checks are unavailable */
  sandboxRefused: boolean;
  authSecret: string;
  /** BROWSER_CHECK_ALLOW_PRIVATE_TARGETS: its own opt-in; ALLOW_PRIVATE_TARGETS does not open private targets to browsers */
  allowPrivate: boolean;
  /** BROWSER_RUNNER_URL / BROWSER_RUNNER_TOKEN: run checks in the separate browser-runner service instead of in-process */
  runnerUrl?: string;
  runnerToken?: string;
};
let settings: Settings = { enabled: false, maxConcurrent: DEFAULT_MAX_BROWSER_CHECKS, maxRssMb: DEFAULT_MAX_RSS_MB, sandbox: true, sandboxRefused: false, authSecret: "", allowPrivate: false };

const intIn = (v: string | undefined, min: number, max: number, d: number) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export type BrowserEnv = {
  BROWSER_CHECKS?: string; MAX_BROWSER_CHECKS?: string; BROWSER_CHECK_MAX_RSS_MB?: string; BROWSER_EXECUTABLE_PATH?: string; BROWSER_CHECK_SANDBOX?: string;
  BETTER_AUTH_SECRET?: string; BROWSER_CHECK_ALLOW_PRIVATE_TARGETS?: string; BROWSER_RUNNER_URL?: string; BROWSER_RUNNER_TOKEN?: string;
};

/** Env values are constant per deployment; called at start-up (Node) and per request (like configureNetGuard). */
export function configureBrowserChecks(env: BrowserEnv) {
  // NODE_ENV is set by the image / process manager, not by operators: read by name so it is not taken for a setting
  const development = process.env["NODE_ENV"] === "development";
  const sandboxOff = env.BROWSER_CHECK_SANDBOX === "off";
  const next: Settings = {
    enabled: env.BROWSER_CHECKS === "enabled",
    maxConcurrent: intIn(env.MAX_BROWSER_CHECKS, 1, 16, DEFAULT_MAX_BROWSER_CHECKS),
    maxRssMb: intIn(env.BROWSER_CHECK_MAX_RSS_MB, 256, 8192, DEFAULT_MAX_RSS_MB),
    executablePath: env.BROWSER_EXECUTABLE_PATH?.trim() || undefined,
    sandbox: !(sandboxOff && development),
    sandboxRefused: sandboxOff && !development,
    authSecret: env.BETTER_AUTH_SECRET ?? "",
    allowPrivate: env.BROWSER_CHECK_ALLOW_PRIVATE_TARGETS === "true",
    runnerUrl: env.BROWSER_RUNNER_URL?.trim() || undefined,
    runnerToken: env.BROWSER_RUNNER_TOKEN?.trim() || undefined,
  };
  if (next.maxConcurrent !== settings.maxConcurrent) slots.resize(next.maxConcurrent);
  if (next.enabled !== settings.enabled || next.executablePath !== settings.executablePath || next.sandbox !== settings.sandbox || next.runnerUrl !== settings.runnerUrl) availability = undefined;
  settings = next;
}
export const browserChecksEnabled = () => settings.enabled;
export const browserSettings = (): Readonly<Settings> => settings;

/**
 * Test seam (never configuration): private ip:port pairs a test's synthetic site uses, for in-process runs started through
 * the API. The runner service drops it from every job it receives.
 */
let testExtraAllowed: string[] | undefined;
export function setBrowserTestAllowance(pairs: string[] | undefined) { testExtraAllowed = pairs; }

/** Browser monitors check at most this often: each run costs a whole browser for seconds. */
export const BROWSER_MIN_INTERVAL_SEC = 300;
/**
 * A monitor whose checks did not happen (deferred or runtime errors) this many runs in a row is marked unchecked and its
 * owners and admins are told, once per streak (scheduler.ts).
 */
export const BROWSER_UNCHECKED_AFTER = 3;

// ---- concurrency -----------------------------------------------------------------------------------------------------

export type Slots = { tryEnter(waitMs?: number): Promise<(() => void) | null>; inFlight(): number; waiting(): number; resize(max: number): void };

/** At most `max` holders; at most `maxWaiting` callers wait (each up to `waitMs`) for a slot, everyone else is refused at once. */
export function browserSlots(max = DEFAULT_MAX_BROWSER_CHECKS, maxWaiting = MAX_WAITING): Slots {
  let running = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      running--;
      const next = queue.shift();
      if (next) next();
    };
  };
  return {
    async tryEnter(waitMs = WAIT_MS) {
      if (running < max) { running++; return release(); }
      if (queue.length >= maxWaiting || waitMs <= 0) return null;
      return new Promise<(() => void) | null>((resolve) => {
        const grant = () => { clearTimeout(timer); running++; resolve(release()); };
        const timer = setTimeout(() => { const i = queue.indexOf(grant); if (i >= 0) queue.splice(i, 1); resolve(null); }, waitMs);
        queue.push(grant);
      });
    },
    inFlight: () => running,
    waiting: () => queue.length,
    resize(n: number) {
      max = n;
      while (running < max && queue.length) queue.shift()!();
    },
  };
}
export const slots = browserSlots();

/** Browser checks one workspace may run at once on this server, so one tenant cannot hold every slot. */
export const PER_WORKSPACE_BROWSER_CHECKS = 1;

/**
 * Per-workspace gates (created on demand, dropped when idle): a workspace's checks queue behind each other (bounded, like
 * the server gate) before they compete with other workspaces for a server slot.
 */
export function workspaceSlots(perWorkspace = PER_WORKSPACE_BROWSER_CHECKS, maxWaiting = MAX_WAITING) {
  const gates = new Map<string, Slots>();
  return {
    async tryEnter(workspace: string, waitMs = WAIT_MS): Promise<(() => void) | null> {
      let g = gates.get(workspace);
      if (!g) { g = browserSlots(perWorkspace, maxWaiting); gates.set(workspace, g); }
      const release = await g.tryEnter(waitMs);
      const gate = g;
      const drop = () => { if (gate.inFlight() === 0 && gate.waiting() === 0 && gates.get(workspace) === gate) gates.delete(workspace); };
      if (!release) { drop(); return null; }
      return () => { release(); drop(); };
    },
    size: () => gates.size,
  };
}
export const perWorkspace = workspaceSlots();

// ---- process supervision ---------------------------------------------------------------------------------------------

type ProcInfo = { pid: number; ppid: number; rssPages: number; cpuTicks: number };

/** Every process on this machine from /proc (Linux); empty elsewhere. */
async function procTable(): Promise<ProcInfo[]> {
  const fs = await import("node:fs");
  let names: string[];
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  const out: ProcInfo[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, "utf8");
      // fields after the command name, which is in parentheses and may contain spaces
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({ pid: Number(n), ppid: Number(f[1]), cpuTicks: Number(f[11]) + Number(f[12]), rssPages: Number(f[21]) });
    } catch { /* gone */ }
  }
  return out;
}

/** `root` and all its descendants. */
export function descendants(table: Pick<ProcInfo, "pid" | "ppid">[], root: number): number[] {
  const children = new Map<number, number[]>();
  for (const p of table) (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(p.pid);
  const seen = new Set<number>([root]);
  const stack = [root];
  while (stack.length) for (const c of children.get(stack.pop()!) ?? []) if (!seen.has(c)) { seen.add(c); stack.push(c); }
  return [...seen];
}

const PAGE_BYTES = 4096;
const TICK_MS = 10;

export type WorkerRun = { report: BrowserRunReport | null; killed: null | "time" | "memory" | "cpu"; peakRssMb: number | null; cpuMs: number | null; exitCode: number | null; /** the per-check directory (deleted by the time this returns) */ dir?: string; /** probe runs: did Chromium start */ probeOk?: boolean };

export type WorkerOptions = {
  /** worker entry (tests point at a pre-built bundle); default: browser-worker.mjs next to this module, else the .ts via tsx */
  worker?: { file: string; args: string[] };
  hardTimeoutMs: number;
  maxRssMb: number;
  maxCpuMs?: number;
  probe?: boolean;
};

/**
 * The worker to start: the bundle next to this module in production (dist/browser-worker.mjs beside server.mjs), else the
 * TypeScript source through tsx (development and tests; tsx resolved here, since the child runs in its own directory).
 */
export async function defaultWorker(): Promise<{ file: string; args: string[] }> {
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const fs = await import("node:fs");
  const bundled = fileURLToPath(new URL("./browser-worker.mjs", import.meta.url));
  if (fs.existsSync(bundled)) return { file: bundled, args: [] };
  const { createRequire } = await import("node:module");
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { file: fileURLToPath(new URL("./browser-worker.ts", import.meta.url)), args: ["--import", tsx] };
}

/** Where Playwright keeps its browsers when not told otherwise, for the default HOME (the child gets another HOME). */
async function browsersPath(): Promise<string | undefined> {
  const explicit = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (explicit) return explicit;
  const os = await import("node:os");
  const path = await import("node:path");
  if (process.platform === "win32") return process.env["LOCALAPPDATA"] ? path.join(process.env["LOCALAPPDATA"]!, "ms-playwright") : undefined;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  return path.join(process.env["XDG_CACHE_HOME"] || path.join(os.homedir(), ".cache"), "ms-playwright");
}

/** The child's whole environment: PATH, its own temp/home directory and the browser location. Never the server's secrets. */
export async function workerEnv(dir: string): Promise<Record<string, string>> {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? process.env["Path"] ?? "", HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir, LANG: "C.UTF-8" };
  const browsers = await browsersPath();
  if (browsers) env["PLAYWRIGHT_BROWSERS_PATH"] = browsers;
  // Windows (development only): Chromium needs SystemRoot; pointing LOCALAPPDATA / USERPROFILE elsewhere breaks its path lookup
  if (process.platform === "win32") for (const k of ["SystemRoot", "windir"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** Kill `pid` and everything below it (Chromium starts its own process group, so a group kill of the worker is not enough). */
async function killTree(pid: number) {
  if (process.platform === "win32") {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((r) => { const k = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); k.once("close", () => r()); k.once("error", () => r()); });
    return;
  }
  const pids = descendants(await procTable(), pid);
  for (const p of pids.reverse()) {
    try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    try { process.kill(-p, "SIGKILL"); } catch { /* not a group leader */ }
  }
}

/**
 * Processes that belong to one check even after their parent died: Chromium is started with a profile inside the check's
 * own directory (`--user-data-dir=<dir>/…`), so every browser process whose command line names that directory is the
 * check's, and so is everything below it. A worker that crashes leaves Chromium re-parented to init (outside the
 * worker's tree), which is why the tree alone is not enough. Linux only (/proc).
 */
export async function processesOf(dir: string): Promise<number[]> {
  if (process.platform !== "linux") return [];
  const fs = await import("node:fs");
  const table = await procTable();
  const marked: number[] = [];
  for (const p of table) {
    if (p.pid === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${p.pid}/cmdline`, "utf8").includes(dir)) marked.push(p.pid);
    } catch { /* gone */ }
  }
  return [...new Set(marked.flatMap((p) => descendants(table, p)))];
}

/** SIGKILL every process of a check (see processesOf), repeated until none is left (a dying parent may fork once more). */
export async function killCheckProcesses(dir: string) {
  for (let round = 0; round < 5; round++) {
    const left = await processesOf(dir);
    if (!left.length) return;
    for (const p of left) {
      try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Runs one job in a fresh worker process and supervises it: wall time, RSS and CPU of the whole tree. Returns the
 * worker's report (null when it was killed or produced none) and what was measured.
 */
export async function runBrowserWorker(job: WorkerJob, opts: WorkerOptions): Promise<WorkerRun> {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "montral-browser-"));
  const worker = opts.worker ?? (await defaultWorker());
  const args = [`--max-old-space-size=${WORKER_HEAP_MB}`, ...worker.args, worker.file, ...(opts.probe ? ["--probe"] : [])];
  let killed: WorkerRun["killed"] = null;
  let peakRss = 0;
  const cpu = new Map<number, number>();
  let sampled = false;
  try {
    const child = spawn(process.execPath, args, { cwd: dir, env: await workerEnv(dir), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    let out = "";
    let size = 0;
    child.stdout.on("data", (d: Buffer) => { if (size < MAX_STDOUT_BYTES) { out += d.toString("utf8"); size += d.length; } });
    // the worker's diagnostics may name page details: read and dropped, never logged
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(job));
    const exited = new Promise<number | null>((resolve) => { child.once("close", (code) => resolve(code)); child.once("error", () => resolve(null)); });
    const kill = (why: NonNullable<WorkerRun["killed"]>) => { if (!killed) { killed = why; void killTree(child.pid!); } };
    const timer = setTimeout(() => kill("time"), opts.hardTimeoutMs);
    const maxCpu = opts.maxCpuMs ?? MAX_CPU_MS;
    let sampling = false;
    const sampler = process.platform === "linux" ? setInterval(() => {
      if (sampling || !child.pid) return;
      sampling = true;
      void procTable().then((table) => {
        const tree = new Set(descendants(table, child.pid!));
        let rss = 0;
        for (const p of table) {
          if (!tree.has(p.pid)) continue;
          rss += p.rssPages * PAGE_BYTES;
          cpu.set(p.pid, Math.max(cpu.get(p.pid) ?? 0, p.cpuTicks));
        }
        sampled = true;
        peakRss = Math.max(peakRss, rss);
        const cpuMs = [...cpu.values()].reduce((a, b) => a + b, 0) * TICK_MS;
        if (rss > opts.maxRssMb * 1024 * 1024) kill("memory");
        else if (cpuMs > maxCpu) kill("cpu");
      }).finally(() => { sampling = false; });
    }, SAMPLE_MS) : undefined;
    const code = await exited;
    clearTimeout(timer);
    if (sampler) clearInterval(sampler);
    // the worker exits right after reporting; anything it left behind (a Chromium that did not close, or one orphaned by a
    // worker that crashed) goes now
    if (child.pid) await killTree(child.pid);
    await killCheckProcesses(dir);
    const line = out.split("\n").reverse().find((l) => l.startsWith(RESULT_PREFIX));
    // not trusted yet: browserCheck validates the report against reportSchema before using any of it
    let report: BrowserRunReport | null = null;
    let probeOk: boolean | undefined;
    if (line && !killed) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { parsed = null; }
      if (opts.probe) probeOk = (parsed as { ok?: unknown } | null)?.ok === true;
      else report = parsed as BrowserRunReport | null;
    }
    return {
      report,
      killed,
      peakRssMb: sampled ? Math.round(peakRss / 1024 / 1024) : null,
      cpuMs: sampled ? [...cpu.values()].reduce((a, b) => a + b, 0) * TICK_MS : null,
      exitCode: code,
      dir,
      ...(opts.probe ? { probeOk: probeOk === true } : {}),
    };
  } finally {
    await killCheckProcesses(dir).catch(() => {});
    // Chromium may still be writing its profile for a moment after the kill
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
}


// ---- availability and runtime health --------------------------------------------------------------------------------

let availability: { at: number; ok: boolean } | undefined;
let availabilityPending: Promise<boolean> | undefined;
const AVAILABLE_TTL_MS = 10 * 60_000;
const UNAVAILABLE_TTL_MS = 60_000;
const RUNNER_GRACE_MS = 15_000;

/** Fixed messages of runs that did not happen because the browser runtime failed (recorded as `error` runs). */
export const RUNNER_UNREACHABLE = "Browser runner unreachable";
export const RUNNER_REJECTED = "Browser runner refused the request (check BROWSER_RUNNER_TOKEN)";
export const RUNNER_UNSIGNED = "Browser runner answer was not signed with BROWSER_RUNNER_TOKEN";
export const RUNNER_MALFORMED = "Browser runner answer was malformed";
export const REPORT_MALFORMED = "Browser worker report was malformed";
export const RUNNER_NOT_CONFIGURED = "BROWSER_RUNNER_URL is set but BROWSER_RUNNER_TOKEN is not";
export const SANDBOX_REFUSED = "BROWSER_CHECK_SANDBOX=off is refused outside development";

/** What this server knows about its browser runtime, shown to every workspace member (no secrets, fixed texts). */
export type BrowserRuntimeHealth = {
  enabled: boolean;
  mode: "runner" | "in-process";
  /** null: not probed yet */
  available: boolean | null;
  checkedAt: string | null;
  /** the latest runtime failure, a fixed message */
  lastError: string | null;
  lastErrorAt: string | null;
};
let lastRuntimeError: { message: string; at: number } | null = null;
const runtimeFailed = (message: string) => { lastRuntimeError = { message, at: Date.now() }; };

export function browserRuntimeHealth(): BrowserRuntimeHealth {
  return {
    enabled: settings.enabled,
    mode: settings.runnerUrl ? "runner" : "in-process",
    available: settings.enabled ? (settings.sandboxRefused ? false : availability ? availability.ok : null) : false,
    checkedAt: availability ? new Date(availability.at).toISOString() : null,
    lastError: settings.sandboxRefused ? SANDBOX_REFUSED : lastRuntimeError?.message ?? null,
    lastErrorAt: lastRuntimeError ? new Date(lastRuntimeError.at).toISOString() : null,
  };
}

/**
 * Can browser checks run (enabled, sandbox not refused, and either the browser-runner answers its probe or, in-process,
 * this server can start Chromium)? Cached.
 */
export async function browserAvailable(worker?: WorkerOptions["worker"]): Promise<boolean> {
  if (!settings.enabled || isWorkers()) return false;
  if (settings.sandboxRefused) { refusedSandbox(); return false; }
  if (availability && Date.now() - availability.at < (availability.ok ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS)) return availability.ok;
  availabilityPending ??= (async () => {
    try {
      let ok: boolean;
      if (settings.runnerUrl) {
        if (!settings.runnerToken) { runnerMisconfigured(); ok = false; }
        else {
          const r = await callRunner<unknown>(settings.runnerUrl, settings.runnerToken, "/v1/probe", {}, LAUNCH_ALLOWANCE_MS + SHUTDOWN_ALLOWANCE_MS + RUNNER_GRACE_MS);
          // a busy runner is alive and has started Chromium before
          ok = r.status === 429 || (r.status === 200 && probeSchema.safeParse(r.body).data?.ok === true);
        }
      } else {
        const run = await runBrowserWorker({ config: null, secrets: {}, policy: { allowPrivate: false }, executablePath: settings.executablePath, sandbox: settings.sandbox }, { worker, hardTimeoutMs: LAUNCH_ALLOWANCE_MS + SHUTDOWN_ALLOWANCE_MS, maxRssMb: settings.maxRssMb, probe: true });
        ok = run.probeOk === true;
      }
      if (!ok) unavailable();
      availability = { at: Date.now(), ok };
      return ok;
    } catch (e) {
      unavailable(e instanceof RunnerError ? runnerMessage(e) : undefined);
      availability = { at: Date.now(), ok: false };
      return false;
    } finally {
      availabilityPending = undefined;
    }
  })();
  return availabilityPending;
}

const once = new Set<string>();
const logOnce = (key: string, line: string) => { if (!once.has(key)) { once.add(key); console.error(line); } };
const runnerMessage = (e: RunnerError) => (e.why === "unreachable" ? RUNNER_UNREACHABLE : e.why === "rejected" ? RUNNER_REJECTED : e.why === "unsigned" ? RUNNER_UNSIGNED : RUNNER_MALFORMED);
function unavailable(message = BROWSER_UNAVAILABLE): string {
  logOnce("unavailable", settings.runnerUrl
    ? "browser checks: the browser-runner did not answer correctly (unreachable, wrong BROWSER_RUNNER_TOKEN, or no Chromium there); browser monitors stay unchecked"
    : "browser checks: Chromium could not be started (playwright-core, the browser or its sandbox is missing); browser monitors stay unchecked, see /docs/self-host#browser-checks");
  runtimeFailed(message);
  return message;
}
const refusedSandbox = () => logOnce("sandbox", "browser checks: BROWSER_CHECK_SANDBOX=off is accepted only with NODE_ENV=development; browser checks are unavailable until it is removed");
const runnerMisconfigured = () => { logOnce("token", "browser checks: BROWSER_RUNNER_URL is set but BROWSER_RUNNER_TOKEN is not; browser checks are unavailable"); runtimeFailed(RUNNER_NOT_CONFIGURED); };
let disabledLogged = false;

// ---- reports: validated before use -----------------------------------------------------------------------------------

const ACTIONS = ["goto", "click", "fill", "press", "waitFor", "assertText", "assertUrl", "assertStatus"] as const;
/** Run-level messages a report may carry (everything else must be a step error built from STEP_FAILURES). */
const RUN_LEVEL_ERRORS = new Set<string>([BROWSER_INVALID, BROWSER_FAILED, "launch"]);
const STEP_ERROR = new RegExp(`^Step \\d{1,2} \\((?:${ACTIONS.join("|")})\\): (?:${Object.values(STEP_FAILURES).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?: \\(\\d{3}, expected \\d{3}\\))?$`);
/** Only fixed messages are ever stored: a worker or runner that sends anything else (page text, paths) is not trusted. */
export const knownReportError = (e: string) => RUN_LEVEL_ERRORS.has(e) || STEP_ERROR.test(e);

const count = (max: number) => z.number().int().min(0).max(max);
export const reportSchema = z.object({
  ok: z.boolean(),
  steps: z.array(z.object({ action: z.enum(ACTIONS), ms: count(600_000), ok: z.boolean() }).strip()).max(32),
  failedStep: count(31).nullable(),
  error: z.string().max(200).refine(knownReportError, "unknown error text").nullable(),
  statusCode: z.number().int().min(100).max(599).nullable(),
  durationMs: count(600_000),
  blockedRequests: count(10_000_000),
  popupsClosed: count(10_000),
  networkError: z.boolean().optional(),
  screenshot: z.string().max(Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
}).strip();
const probeSchema = z.object({ ok: z.boolean() }).strip();
export const workerRunSchema = z.object({
  report: reportSchema.nullable(),
  killed: z.enum(["time", "memory", "cpu"]).nullable(),
  peakRssMb: count(1_000_000).nullable(),
  cpuMs: count(100_000_000).nullable(),
  exitCode: z.number().int().nullable(),
}).strip();

// ---- the check -------------------------------------------------------------------------------------------------------

export type BrowserCheckInput = Pick<CheckInput, "target"> & { id?: string; organizationId?: string; browser?: unknown; browserSecrets?: Record<string, string> | null };

/** What a browser check adds to its outcome; the scheduler stores it as a run (steps, timings, optional screenshot). */
export type BrowserOutcome = BrowserRunReport & { screenshotPng?: Uint8Array; kind?: "run" | "deferred" | "error"; usedSecrets?: boolean };

export type BrowserDeps = {
  worker?: WorkerOptions["worker"];
  /** test seam: private ip:port pairs the synthetic test site uses (see EgressPolicy.extraAllowed) */
  extraAllowed?: string[];
  slots?: Slots;
  workspaces?: ReturnType<typeof workspaceSlots>;
  waitMs?: number;
  maxCpuMs?: number;
  maxRssMb?: number;
  /** test seam: abort the worker this long after Chromium started (crash handling) */
  testAbortAfterMs?: number;
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function screenshotBytes(b64: string | undefined): Uint8Array | undefined {
  if (!b64 || b64.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4) return undefined;
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES || !PNG.every((v, i) => bytes[i] === v)) return undefined;
  return bytes;
}

/**
 * A run that did not happen: capacity was full (deferred) or the browser runtime failed (error). Inconclusive (nothing
 * about the target is recorded), but the scheduler stores it as a visible run and counts it towards the "unchecked" state.
 */
const notRun = (kind: "deferred" | "error", error: string, usedSecrets = false): CheckOutcome & { browser: BrowserOutcome } => ({
  ok: false, inconclusive: true, error,
  browser: { ok: false, kind, usedSecrets, steps: [], failedStep: null, error, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0 },
});
const deferred = () => notRun("deferred", BROWSER_BUSY);
const runtimeError = (message: string) => notRun("error", message);

/**
 * One browser check. Up with the journey's duration as latency when every step passed; down with the failing step and a
 * fixed message otherwise. Runs that did not happen (deferred, runtime errors, disabled) are inconclusive but carry a run
 * of kind `deferred` / `error`, which the scheduler records and alerts on when they go on (see scheduler.ts).
 */
export async function browserCheck(m: BrowserCheckInput, deps: BrowserDeps = {}): Promise<CheckOutcome & { browser?: BrowserOutcome }> {
  if (isWorkers()) return runtimeError(BROWSER_WORKERS_UNSUPPORTED);
  if (!settings.enabled) {
    if (!disabledLogged) { disabledLogged = true; console.warn("browser checks: monitors of type browser exist but BROWSER_CHECKS is not enabled; they stay unchecked"); }
    return runtimeError(BROWSER_DISABLED);
  }
  const parsed = browserConfigSchema.safeParse(m.browser);
  if (!parsed.success) return { ok: false, error: BROWSER_INVALID };
  const config = parsed.data;
  const usedSecrets = secretRefs(config).length > 0;
  // fairness first: one check per workspace at a time, then a server slot
  const waitMs = deps.waitMs ?? WAIT_MS;
  const startedWaiting = Date.now();
  const releaseWorkspace = await (deps.workspaces ?? perWorkspace).tryEnter(m.organizationId ?? "", waitMs);
  if (!releaseWorkspace) {
    console.warn("browser checks: workspace already running a browser check, check deferred");
    return deferred();
  }
  const release = await (deps.slots ?? slots).tryEnter(Math.max(0, waitMs - (Date.now() - startedWaiting)));
  if (!release) {
    releaseWorkspace();
    console.warn("browser checks: all slots busy, check deferred");
    return deferred();
  }
  try {
    if (!deps.worker && !(await browserAvailable())) return runtimeError(settings.sandboxRefused ? SANDBOX_REFUSED : lastRuntimeError?.message ?? BROWSER_UNAVAILABLE);
    const secrets = await decryptForRun(settings.authSecret, m.organizationId ?? "", m.id ?? "", m.browserSecrets, secretRefs(config));
    const extraAllowed = deps.extraAllowed ?? testExtraAllowed;
    const job: WorkerJob = {
      config,
      secrets,
      policy: { allowPrivate: settings.allowPrivate, deny: await ownAddresses(), ...(extraAllowed ? { extraAllowed } : {}) },
      executablePath: settings.executablePath,
      sandbox: settings.sandbox,
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome ${checkUserAgent()}`,
      rendererHeapMb: RENDERER_HEAP_MB,
      launchTimeoutMs: LAUNCH_ALLOWANCE_MS,
      ...(deps.testAbortAfterMs ? { testAbortAfterMs: deps.testAbortAfterMs } : {}),
    };
    const hardTimeoutMs = LAUNCH_ALLOWANCE_MS + config.timeoutMs + SHUTDOWN_ALLOWANCE_MS;
    const maxRssMb = deps.maxRssMb ?? settings.maxRssMb;
    let raw: unknown;
    if (settings.runnerUrl && !deps.worker) {
      if (!settings.runnerToken) { runnerMisconfigured(); return runtimeError(RUNNER_NOT_CONFIGURED); }
      try {
        // the secrets travel encrypted with a key derived from the runner token; the rest of the job is only signed
        const { secrets: plain, ...rest } = job;
        const token = settings.runnerToken;
        const r = await callRunner<unknown>(settings.runnerUrl, token, "/v1/run", async (nonce: string) => ({ job: { ...rest, secrets: {} }, sealedSecrets: await sealSecrets(token, plain, nonce), hardTimeoutMs, maxRssMb }), hardTimeoutMs + RUNNER_GRACE_MS);
        if (r.status === 429) return deferred();
        const body = r.body as { run?: unknown } | null;
        if (r.status !== 200 || !body || typeof body !== "object" || !("run" in body)) {
          availability = undefined;
          return runtimeError(unavailable(RUNNER_MALFORMED));
        }
        raw = body.run;
      } catch (e) {
        if (e instanceof RunnerError) logOnce(`runner-${e.why}`, `browser checks: browser-runner call failed (${e.why})`);
        availability = undefined;
        return runtimeError(unavailable(e instanceof RunnerError ? runnerMessage(e) : RUNNER_UNREACHABLE));
      }
    } else {
      raw = await runBrowserWorker(job, { worker: deps.worker, hardTimeoutMs, maxRssMb, maxCpuMs: deps.maxCpuMs });
    }
    // whatever the worker or the runner sent is checked field by field before anything of it is used or stored
    const checked = workerRunSchema.safeParse(raw);
    if (!checked.success) {
      logOnce("malformed", "browser checks: a worker report did not match the expected shape; discarded");
      return runtimeError(unavailable(settings.runnerUrl && !deps.worker ? RUNNER_MALFORMED : REPORT_MALFORMED));
    }
    const run = checked.data;
    const measured = { peakRssMb: run.peakRssMb, cpuMs: run.cpuMs };
    if (run.killed) {
      const error = run.killed === "memory" ? BROWSER_MEMORY_LIMIT : run.killed === "cpu" ? BROWSER_CPU_LIMIT : BROWSER_TIME_LIMIT;
      return { ok: false, error, browser: { ok: false, kind: "run", usedSecrets, steps: [], failedStep: null, error, statusCode: null, durationMs: 0, blockedRequests: 0, popupsClosed: 0, ...measured } };
    }
    const r = run.report;
    // no report and not killed: the worker died on its own; "launch": Chromium did not start. Both are the server's problem.
    if (!r) { console.error("browser checks: worker ended without a report"); runtimeFailed(BROWSER_FAILED); return runtimeError(BROWSER_FAILED); }
    if (r.error === "launch") { availability = { at: Date.now(), ok: false }; return runtimeError(unavailable()); }
    // defence in depth: whatever came back is masked again before it can be stored
    const values = Object.values(secrets);
    const error = r.error ? maskSecrets(r.error, values) : undefined;
    const browser: BrowserOutcome = { ...r, kind: "run", usedSecrets, error: error ?? null, ...measured, screenshot: undefined, ...(r.screenshot ? { screenshotPng: screenshotBytes(r.screenshot) } : {}) };
    const out = { ok: r.ok, latencyMs: r.durationMs, ...(r.statusCode != null ? { statusCode: r.statusCode } : {}), ...(error ? { error } : {}), browser };
    // a navigation that failed at the network level from a machine that is itself offline says nothing about the target
    if (!r.ok && r.networkError && !(await proberOnline())) return { ...out, inconclusive: true, browser: { ...browser, kind: "error" } };
    return out;
  } finally {
    release();
    releaseWorkspace();
  }
}

/** Why a browser monitor cannot be created on this deployment (400), or null: Workers, not enabled, or no usable Chromium. */
export async function browserCreationProblem(): Promise<{ error: string; code: string } | null> {
  if (isWorkers()) return { error: `${BROWSER_WORKERS_UNSUPPORTED}; this deployment runs on Cloudflare Workers`, code: "browser_checks_unsupported" };
  if (!settings.enabled) return { error: `${BROWSER_DISABLED}: set BROWSER_CHECKS=enabled on a server with Chromium (see /docs/self-host#browser-checks)`, code: "browser_checks_disabled" };
  if (!(await browserAvailable())) return { error: `${BROWSER_UNAVAILABLE}: Chromium could not be started (see /docs/self-host#browser-checks)`, code: "browser_unavailable" };
  return null;
}

/** Test seam: forget the cached availability probe. */
export function resetBrowserAvailability() { availability = undefined; }

/**
 * Why a journey URL is refused at creation, judged by the same egress decision the proxy makes at run time: loopback,
 * this server's own addresses, link-local, metadata and localhost names always; private addresses unless
 * BROWSER_CHECK_ALLOW_PRIVATE_TARGETS. A name that does not resolve now is accepted (the check reports it).
 */
export async function browserUrlProblem(url: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(url); } catch { return "Use an absolute http:// or https:// URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http:// and https:// URLs can be monitored.";
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const d = await decideEgress(u.hostname, port, { allowPrivate: settings.allowPrivate, deny: await ownAddresses(), ...(testExtraAllowed ? { extraAllowed: testExtraAllowed } : {}) });
  if (d.allowed || d.reason === "unresolved") return null;
  return settings.allowPrivate
    ? "Target is a loopback, link-local, cloud metadata or localhost address, or this server's own address, which browser checks never reach."
    : "Target is a private or internal address. Set BROWSER_CHECK_ALLOW_PRIVATE_TARGETS=true to let browser checks reach internal services.";
}
