// Terraform provider acceptance qualification: starts the built self-hosted Node server against a disposable
// PostgreSQL database, signs up a synthetic user (whose personal workspace it owns), creates an API key through the
// API, then runs the provider's Go acceptance tests (TF_ACC=1) against that server. Synthetic data only; monitors check
// the server itself (ALLOW_PRIVATE_TARGETS=true), webhooks point back at it, nothing is delivered elsewhere.
//
// Usage: TEST_DATABASE_URL=postgres://.../montral_test_tf_ci node scripts/qualify-terraform.mjs [extra go test args]
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !/\/montral_test_[a-z0-9_]+(\?|$)/.test(connection)) {
  throw new Error("TEST_DATABASE_URL must point to a disposable montral_test_* PostgreSQL database");
}

const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close((error) => (error ? reject(error) : done(port)));
  });
});
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let serverLog = "";
const server = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
  env: {
    ...process.env,
    DATABASE_URL: connection,
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    WEB_ORIGIN: base,
    BETTER_AUTH_URL: base,
    WEB_DIST: resolve("apps/web/dist"),
    BETTER_AUTH_SECRET: "montral-terraform-qualification-only-never-production",
    CRON_SECRET: "montral-terraform-qualification-cron-only",
    ALLOW_PRIVATE_TARGETS: "true",
    MONTRAL_BILLING_ENABLED: "false",
    MONTRAL_METERING_ENABLED: "false",
    SMTP_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-12000); });
}
let serverExit = null;
server.once("exit", (code, signal) => { serverExit = { code, signal }; });

async function stopServer() {
  if (serverExit) return;
  server.kill("SIGTERM");
  await Promise.race([new Promise((done) => server.once("exit", done)), sleep(10_000)]);
  if (!serverExit) server.kill("SIGKILL");
}

let cookie = "";
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const set = res.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ");
  if (set) cookie = set;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text };
}

let exitCode = 1;
try {
  // readiness, as in scripts/smoke-node.mjs
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline && !serverExit) {
    try {
      const res = await fetch(base + "/health", { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await res.json()).ok === true) { healthy = true; break; }
    } catch {}
    await sleep(300);
  }
  if (!healthy) throw new Error(`Node server did not pass /health ${JSON.stringify(serverExit)}`);

  const email = `terraform-qa-${Date.now()}@example.test`;
  const signup = await api("POST", "/api/auth/sign-up/email", { email, name: "Synthetic Terraform QA", password: "synthetic terraform qualification" });
  if (signup.status !== 200) throw new Error(`sign-up failed: HTTP ${signup.status}`);
  const me = await api("GET", "/api/me");
  const organizationId = me.body?.organization?.id;
  if (me.status !== 200 || !organizationId) throw new Error(`no workspace for the synthetic user: HTTP ${me.status}`);
  const key = await api("POST", "/api/auth/api-key/create", { name: "terraform acceptance", metadata: { organizationId } });
  if (key.status !== 200 || typeof key.body?.key !== "string") throw new Error(`API key creation failed: HTTP ${key.status}`);
  // the key works on its own, without the session
  cookie = "";
  const check = await fetch(base + "/api/me", { headers: { authorization: `Bearer ${key.body.key}` } });
  if (check.status !== 200) throw new Error(`API key rejected: HTTP ${check.status}`);
  console.log(`TERRAFORM_QUALIFY: server ${base} ready, synthetic workspace and API key created`);

  const args = ["test", "./...", "-v", "-count=1", "-timeout", "60m", ...process.argv.slice(2)];
  const tests = spawn("go", args, {
    cwd: resolve("terraform-provider-montral"),
    env: { ...process.env, TF_ACC: "1", MONTRAL_ENDPOINT: base, MONTRAL_API_KEY: key.body.key, CHECKPOINT_DISABLE: "1" },
    stdio: "inherit",
  });
  exitCode = await new Promise((done) => tests.once("exit", (code) => done(code ?? 1)));
  if (exitCode !== 0) console.error("TERRAFORM_QUALIFY: acceptance tests failed");
  else console.log("TERRAFORM_QUALIFY_PASS: provider acceptance tests passed against the Node server and PostgreSQL");
} catch (error) {
  console.error(`TERRAFORM_QUALIFY: ${error.message}`);
  exitCode = 1;
} finally {
  await stopServer();
  if (exitCode !== 0) console.error("--- server log (tail) ---\n" + serverLog.replace(/montral_[A-Za-z0-9_-]{20,}/g, "montral_[REDACTED]"));
}
process.exit(exitCode);
