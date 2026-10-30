import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must point to an isolated disposable PostgreSQL database");

const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    WEB_ORIGIN: base,
    BETTER_AUTH_URL: base,
    WEB_DIST: resolve("apps/web/dist"),
    BETTER_AUTH_SECRET: "montral-node-smoke-only-2026-never-production",
    CRON_SECRET: "montral-smoke-cron-only-2026-never-production",
    DISABLE_SIGNUP: "true",
    SMTP_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { log = (log + chunk).slice(-4000); });
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(3000) });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${path} responded ${response.status}: ${text.slice(0, 200)}`);
  return text;
}
try {
  let healthy = false;
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const payload = JSON.parse(await get("/health"));
      if (payload.ok === true) { healthy = true; break; }
    } catch {}
    await sleep(300);
  }
  if (!healthy) throw new Error("Node server did not pass /health. " + log);
  const config = JSON.parse(await get("/api/config"));
  if (config.edition !== "montral" || config.features?.webhooks !== true) {
    throw new Error("Montral runtime capabilities missing");
  }
  const mcp = JSON.parse(await get("/.well-known/mcp.json"));
  if (mcp.name !== "Montral" || !mcp.endpoints?.some((e) => e.url.endsWith("/api/mcp"))) {
    throw new Error("Montral OAuth MCP discovery missing");
  }
  const dashboard = await get("/app");
  if (!dashboard.includes("Montral")) throw new Error("Built Node web dashboard missing Montral");
  console.log("Montral Node+Postgres smoke PASS: health, config, MCP discovery, HTML dashboard");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    sleep(2500),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
