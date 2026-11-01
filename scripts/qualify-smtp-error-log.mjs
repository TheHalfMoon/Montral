#!/usr/bin/env node
/**
 * Synthetic-only runtime SMTP diagnostic privacy control.
 * Starts real Node API against a newly-created, local test DB and a localhost
 * SMTP sink that deliberately rejects the handshake with a private marker.
 * Never opens any external socket; never uses customer data or SMTP credentials.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer as createTcp } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";

const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error("TEST_DATABASE_URL is required");
const parsed = new URL(source);
if (!["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/(?:montral_ci|montral_test_[a-zA-Z0-9_]+)$/.test(parsed.pathname)) {
  throw new Error("Refusing SMTP log drill outside local isolated test databases");
}
const dbName = `montral_test_smtp_log_${process.pid}`;
const testDb = new URL(source);
testDb.pathname = "/" + dbName;
const marker = "smtp-private-diagnostic-fixture-never-log";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createTcp();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(() => resolvePort(port));
  });
});
let app;
let sink;
let dbCreated = false;
let output = "";
try {
  execFileSync("psql", [source, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${dbName}"`], { timeout: 5000, stdio: "pipe" });
  dbCreated = true;
  sink = createTcp(socket => { socket.end(`554 5.7.1 ${marker}\r\n`); });
  await new Promise((done, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", done); });
  const smtpPort = sink.address().port;
  const httpPort = await freePort();
  const base = `http://127.0.0.1:${httpPort}`;
  app = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: testDb.href, PORT: String(httpPort), BIND_HOST: "127.0.0.1",
      WEB_ORIGIN: base, BETTER_AUTH_URL: base, WEB_DIST: resolve("apps/web/dist"),
      BETTER_AUTH_SECRET: "local-smtp-log-privacy-test-secret-only",
      CRON_SECRET: "local-smtp-log-privacy-test-cron-only",
      SMTP_URL: "", RESEND_API_KEY: "", SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtpPort), SMTP_SECURE: "false", SMTP_USER: "", SMTP_PASS: "",
      EMAIL_FROM: "alerts@example.test", MONTRAL_BILLING_ENABLED: "false",
      MONTRAL_METERING_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [app.stdout, app.stderr]) {
    stream.on("data", bytes => {
      // No log contents are printed to stdout by this script, even on failure.
      output = (output + bytes.toString("utf8")).slice(-65536);
    });
  }
  let verified = false;
  for (let i = 0; i < 250; i++) {
    if (output.includes("smtp: connection verification failed")) { verified = true; break; }
    if (app.exitCode !== null) break;
    await sleep(50);
  }
  if (!verified) throw new Error("Expected Node server's generic SMTP verification warning not observed");
  if (output.includes(marker)) throw new Error("Private synthetic provider diagnostic was logged");
  console.log("SMTP_ERROR_LOG_PRIVACY_PASS: real Node SMTP verification failure suppressed the synthetic provider marker");
} finally {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([once(app, "exit").catch(() => {}), sleep(4000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  if (sink) await new Promise(done => sink.close(done));
  if (dbCreated) execFileSync("psql", [source, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`], { timeout: 10000, stdio: "pipe" });
}
