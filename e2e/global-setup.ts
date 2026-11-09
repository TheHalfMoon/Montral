// Starts the built self-hosted Node server (apps/api build:node + DEPLOY_TARGET=node web build) against a disposable
// local PostgreSQL database, mirroring scripts/qualify-browser.mjs, and returns the teardown that stops it. The base
// URL is handed to the test workers through MONTRAL_E2E_BASE_URL (workers inherit this process's environment).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only a local database whose name marks it disposable (montral_test_*) may be used; anything else is refused. */
export function disposableDatabase(connection: string | undefined): string {
  if (!connection) throw new Error("Set TEST_DATABASE_URL to a disposable local PostgreSQL database (montral_test_*)");
  const db = new URL(connection);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(db.hostname) || !/^\/montral_test_[a-zA-Z0-9_]+$/.test(db.pathname)) {
    throw new Error("Cross-browser qualification refuses any non-local or non-disposable (montral_test_*) database");
  }
  return connection;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() => (addr && typeof addr === "object" ? done(addr.port) : fail(new Error("no port"))));
    });
  });
}

export default async function globalSetup() {
  const connection = disposableDatabase(process.env.TEST_DATABASE_URL);
  const server = resolve(ROOT, "apps/api/dist/server.mjs");
  const webDist = resolve(ROOT, "apps/web/dist");
  if (!existsSync(server) || !existsSync(resolve(webDist, "server"))) {
    throw new Error("Build first: pnpm --filter @montral/api build:node && DEPLOY_TARGET=node pnpm --filter @montral/web build");
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const api: ChildProcess = spawn(process.execPath, [server], {
    env: {
      ...process.env, DATABASE_URL: connection, PORT: String(port),
      BIND_HOST: "127.0.0.1", BETTER_AUTH_URL: base, WEB_ORIGIN: base,
      WEB_DIST: webDist,
      // synthetic, test-only secrets; never used by any deployment
      BETTER_AUTH_SECRET: "xbrowser-e2e-secret-2026-11-09-only-never-live",
      CRON_SECRET: "xbrowser-e2e-cron-secret-2026-11-09-only",
      MONTRAL_BILLING_ENABLED: "false", MONTRAL_METERING_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [api.stdout!, api.stderr!]) {
    stream.setEncoding("utf8");
    stream.on("data", (t: string) => { log = (log + t).slice(-4000); });
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (api.exitCode !== null) throw new Error("Node server exited during start-up:\n" + log);
    try {
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json() as { ok?: boolean }).ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { api.kill("SIGKILL"); throw new Error("Node server /health timed out:\n" + log); }
    await pause(200);
  }
  process.env.MONTRAL_E2E_BASE_URL = base;

  return async () => {
    if (api.exitCode !== null || api.signalCode !== null) {
      throw new Error("Node server died during the browser run:\n" + log);
    }
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      api.once("exit", (code, signal) => done({ code, signal })));
    api.kill("SIGTERM");
    const exit = await Promise.race([exited, pause(15_000).then(() => null)]);
    if (!exit) {
      api.kill("SIGKILL");
      throw new Error("Node server did not stop within 15 s of SIGTERM");
    }
    if (exit.code !== 0) throw new Error(`Node server exited ${exit.code ?? exit.signal} on SIGTERM:\n${log}`);
  };
}
