/**
 * The browser-runner service: runs browser checks for the app in its own container (docker-compose.browser.yml), so
 * that Chromium never shares a process, a user or a container with the API server and its secrets.
 *
 * - Holds no database URL, no BETTER_AUTH_SECRET and no other app secret: only BROWSER_RUNNER_TOKEN (HMAC, see
 *   browser-runner-protocol.ts) and its own limits. It sits on an internal network with the app and on an egress
 *   network to the internet, never on the database's network.
 * - Accepts only signed, fresh, never-seen requests with bounded bodies; signs every response.
 * - Runs each job exactly as the app would in-process: a fresh worker process (browser-worker.ts) with its own egress
 *   proxy and Chromium, supervised for time, memory and CPU. Its own MAX_BROWSER_CHECKS bounds concurrency; when full it
 *   answers busy (the app records the check as deferred).
 * - Never trusts the job's network policy to be narrower than its own: test allowances are dropped, and the app's
 *   address (the request's peer) plus the runner's own addresses are always refused as destinations. Chromium's
 *   sandbox is always on here.
 *
 * Endpoints: POST /v1/run, POST /v1/probe (both signed), GET /health (unauthenticated, says only "ok").
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { browserSlots, configureBrowserChecks, browserSettings, runBrowserWorker, type Slots, type WorkerOptions, type WorkerRun } from "./browser-check";
import { ownAddresses } from "./browser-egress";
import { MAX_REQUEST_BYTES, MIN_TOKEN_LENGTH, nonceCache, openSecrets, RUNNER_HEADER, RUNNER_PORT, signResponse, verifyRequest, type RunRequest } from "./browser-runner-protocol";
import type { WorkerJob } from "./browser-worker";

export type RunnerOptions = {
  token: string;
  slots: Slots;
  /** runs one job (default: runBrowserWorker); tests replace it */
  run?: (job: WorkerJob, opts: WorkerOptions) => Promise<WorkerRun>;
  worker?: WorkerOptions["worker"];
  executablePath?: string;
  maxRssMb: number;
  /** upper bound for a job's own hard timeout (journey 60 s + launch and shutdown allowances) */
  maxHardTimeoutMs?: number;
};

const LIMIT_HARD_TIMEOUT_MS = 95_000;

async function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function createRunnerServer(o: RunnerOptions) {
  if (o.token.length < MIN_TOKEN_LENGTH) throw new Error(`BROWSER_RUNNER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  const http = await import("node:http");
  const nonces = nonceCache();
  const own = await ownAddresses();
  const run = o.run ?? runBrowserWorker;

  const reply = async (res: ServerResponse, status: number, payload: unknown, nonce?: string) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
    if (nonce) headers[RUNNER_HEADER] = await signResponse(o.token, nonce, status, body);
    res.writeHead(status, headers);
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") return reply(res, 200, { ok: true });
    if (req.method !== "POST" || (path !== "/v1/run" && path !== "/v1/probe")) return reply(res, 404, { error: "not found" });
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > MAX_REQUEST_BYTES) return reply(res, 413, { error: "too large" });
    const body = await readBody(req, MAX_REQUEST_BYTES);
    if (body === null) return reply(res, 413, { error: "too large" });
    const verdict = await verifyRequest(o.token, "POST", path, body, req.headers[RUNNER_HEADER] as string | undefined, nonces);
    // the same unsigned answer whatever the reason: an unauthenticated caller learns nothing
    if (!verdict.ok) return reply(res, 401, { error: "unauthorized" });
    const nonce = verdict.nonce;
    let payload: RunRequest;
    try { payload = JSON.parse(body) as RunRequest; } catch { return reply(res, 400, { error: "bad request" }, nonce); }

    const release = await o.slots.tryEnter(0);
    if (!release) return reply(res, 429, { busy: true }, nonce);
    try {
      if (path === "/v1/probe") {
        const r = await run({ config: null, secrets: {}, policy: { allowPrivate: false }, executablePath: o.executablePath, sandbox: true }, { worker: o.worker, hardTimeoutMs: 30_000, maxRssMb: o.maxRssMb, probe: true });
        return reply(res, 200, { ok: r.probeOk === true }, nonce);
      }
      const job = payload.job;
      if (!job || typeof job !== "object") return reply(res, 400, { error: "bad request" }, nonce);
      const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const { testAbortAfterMs: _testOnly, ...jobFields } = job;
      // secrets arrive sealed with a key derived from the token (see browser-runner-protocol.ts); none in clear text
      const secrets = payload.sealedSecrets === undefined ? {} : await openSecrets(o.token, payload.sealedSecrets);
      if (secrets === null) return reply(res, 400, { error: "bad request" }, nonce);
      const safeJob: WorkerJob = {
        ...jobFields,
        secrets,
        executablePath: o.executablePath,
        sandbox: true,
        // the runner's policy can only be stricter than the app's: no test allowances, never the app or the runner itself
        policy: { allowPrivate: job.policy?.allowPrivate === true, deny: [...new Set([...(job.policy?.deny ?? []), ...own, ...(peer ? [peer] : [])])] },
      };
      const hardTimeoutMs = Math.min(Math.max(1000, Number(payload.hardTimeoutMs) || 0), o.maxHardTimeoutMs ?? LIMIT_HARD_TIMEOUT_MS);
      const maxRssMb = Math.min(Math.max(256, Number(payload.maxRssMb) || o.maxRssMb), o.maxRssMb);
      const result = await run(safeJob, { worker: o.worker, hardTimeoutMs, maxRssMb });
      const { dir: _dir, probeOk: _probe, ...plain } = result;
      return reply(res, 200, { run: plain }, nonce);
    } finally {
      release();
    }
  };

  const server = http.createServer({ requestTimeout: 120_000, headersTimeout: 10_000 }, (req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); });
  });
  server.on("clientError", (_e, s) => s.destroy());
  return server;
}

async function main() {
  const env = process.env as Record<string, string | undefined>;
  const token = env["BROWSER_RUNNER_TOKEN"] ?? "";
  // the runner reads only its own settings; app secrets are not given to its container and would be ignored here
  configureBrowserChecks({ BROWSER_CHECKS: "enabled", MAX_BROWSER_CHECKS: env["MAX_BROWSER_CHECKS"], BROWSER_CHECK_MAX_RSS_MB: env["BROWSER_CHECK_MAX_RSS_MB"], BROWSER_EXECUTABLE_PATH: env["BROWSER_EXECUTABLE_PATH"] });
  for (const k of ["DATABASE_URL", "BETTER_AUTH_SECRET"]) if (env[k]) console.warn(`browser-runner: ${k} is set in this container but never used; remove it`);
  const s = browserSettings();
  const server = await createRunnerServer({ token, slots: browserSlots(s.maxConcurrent, 0), executablePath: s.executablePath, maxRssMb: s.maxRssMb });
  server.listen(RUNNER_PORT, "0.0.0.0", () => console.log(`browser-runner listening on :${RUNNER_PORT}, ${s.maxConcurrent} concurrent checks`));
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
if (/browser-runner\.(?:mjs|ts|js)$/.test(entry)) {
  main().catch((e) => {
    console.error(`browser-runner: ${e instanceof Error ? e.message : "failed to start"}`);
    process.exit(1);
  });
}
