import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { request } from "node:http";
import postgres from "../packages/db-pg/node_modules/postgres/src/index.js";

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
  // Custom-domain routing through the real server wiring (server.ts), not a copy of it: a verified domain serves only
  // its page; an unverified hostname gets 404 instead of the app; the app's own address still serves the app.
  const viaHost = (path, host) => new Promise((resolveReq, rejectReq) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolveReq({ status: res.statusCode, body }));
    });
    req.on("error", rejectReq);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.end();
  });
  const db = postgres(process.env.TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  const domainSuffix = Math.random().toString(36).slice(2, 10);
  const verifiedDomain = `status-${domainSuffix}.smoke.example`;
  try {
    const org = "smoke-domain-" + domainSuffix;
    await db`insert into organization (id, name, slug, created_at) values (${org}, 'Smoke domain', ${org}, now())`;
    const [project] = await db`insert into project (organization_id, name) values (${org}, 'Smoke') returning id`;
    await db`insert into status_page (organization_id, project_id, slug, title, custom_domain, custom_domain_token, custom_domain_verified_at)
      values (${org}, ${project.id}, ${"smoke-" + domainSuffix}, 'Smoke custom domain page', ${verifiedDomain}, 'synthetic', now())`;
  } finally {
    await db.end({ timeout: 2 });
  }
  const onDomain = await viaHost("/", verifiedDomain);
  if (onDomain.status !== 200 || !onDomain.body.includes("Smoke custom domain page")) throw new Error(`verified domain did not serve its page: ${onDomain.status}`);
  for (const path of ["/app", "/login", "/api/me", "/api/auth/get-session"]) {
    const res = await viaHost(path, verifiedDomain);
    if (res.status !== 404) throw new Error(`custom domain served ${path} with ${res.status}`);
  }
  for (const path of ["/", "/app", "/login"]) {
    const res = await viaHost(path, `unverified-${domainSuffix}.smoke.example`);
    if (res.status !== 404) throw new Error(`unverified hostname served ${path} with ${res.status}`);
  }
  const ownApp = await viaHost("/app", `127.0.0.1:${port}`);
  if (ownApp.status !== 200) throw new Error(`the app's own address stopped serving /app: ${ownApp.status}`);
  console.log("CUSTOM_DOMAIN_SMOKE_PASS: verified domain serves only its page; unverified hostnames 404; own address serves the app");
  console.log("Montral Node+Postgres smoke PASS: health, config, MCP discovery, HTML dashboard");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    sleep(2500),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
