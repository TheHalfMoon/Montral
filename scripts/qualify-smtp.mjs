#!/usr/bin/env node
/**
 * Live Node SMTP qualification, but with a strict LOCAL sink. Uses the actual
 * production Node app's Nodemailer SMTP transport, the auth API, and the
 * notification channel's test-send route. No external email or network calls.
 */
import { createServer as createTcp } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";

const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error("TEST_DATABASE_URL is required");
const db = new URL(connection);
if (!["127.0.0.1", "localhost"].includes(db.hostname) || !/^\/(?:montral_ci|montral_test_[a-zA-Z0-9_]+)$/.test(db.pathname)) {
  throw new Error("Refusing SMTP qualification on a nonlocal or nondisposable PostgreSQL database");
}
// The full API suite leaves hundreds of synthetic monitors in the shared
// CI database. Use a new database so the scheduled queue only contains this
// drill's own heartbeat and cannot be starved by unrelated test fixtures.
const scratchName = "montral_test_smtp_" + process.pid;
const target = new URL(connection);
target.pathname = "/" + scratchName;
execFileSync("psql", [connection, "-X", "-q", "-v", "ON_ERROR_STOP=1",
  "-c", `CREATE DATABASE "${scratchName}"`], { timeout: 5000 });
const isolatedConnection = target.href;
const slotOf = id => {
  let h = 0;
  for (const char of id) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h % 6;
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
const freePort = async () => new Promise((done, fail) => {
  const server = createTcp();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => { const selected = server.address().port; server.close(() => done(selected)); });
});
const httpPort = await freePort();
const smtpMessages = [];
let connections = 0;
const smtp = createTcp(socket => {
  connections++;
  socket.setEncoding("utf8");
  let pending = "";
  let dataMode = false;
  let dataLines = [];
  let recipient = "";
  socket.write("220 localhost Montral synthetic SMTP sink\r\n");
  socket.on("data", chunk => {
    pending += chunk;
    if (pending.length > 150_000) { socket.destroy(); return; }
    for (;;) {
      const end = pending.indexOf("\r\n");
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (dataMode) {
        if (line === ".") {
          smtpMessages.push({ to: recipient, raw: dataLines.join("\n") });
          dataLines = [];
          dataMode = false;
          socket.write("250 2.0.0 Synthetic message accepted\r\n");
        } else {
          dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        }
        continue;
      }
      const cmd = line.slice(0, line.indexOf(" ") < 0 ? undefined : line.indexOf(" ")).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") socket.write("250-localhost\r\n250-8BITMIME\r\n250 PIPELINING\r\n");
      else if (cmd === "MAIL") { recipient = ""; socket.write("250 2.1.0 sender accepted\r\n"); }
      else if (cmd === "RCPT") {
        if (!/^RCPT TO:\s*<[^<>\s]+@example\.test>$/i.test(line)) {
          socket.write("550 5.7.1 Only synthetic example.test recipients accepted\r\n");
        } else {
          recipient = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">")).toLowerCase();
          socket.write("250 2.1.5 recipient accepted\r\n");
        }
      } else if (cmd === "DATA") { if (!recipient) socket.write("503 5.5.1 recipient required\r\n"); else { dataMode = true; socket.write("354 end with dot on line\r\n"); } }
      else if (cmd === "RSET" || cmd === "NOOP") socket.write("250 OK\r\n");
      else if (cmd === "QUIT") { socket.end("221 Bye\r\n"); }
      else { socket.write("502 5.5.1 unsupported synthetic SMTP command\r\n"); }
    }
  });
});
await new Promise((done, fail) => { smtp.once("error", fail); smtp.listen(0, "127.0.0.1", done); });
const smtpPort = smtp.address().port;
const base = "http://127.0.0.1:" + httpPort;
const app = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
  cwd: process.cwd(), env: {
    ...process.env, DATABASE_URL: isolatedConnection,
    PORT: String(httpPort), BIND_HOST: "127.0.0.1",
    WEB_ORIGIN: base, BETTER_AUTH_URL: base, WEB_DIST: resolve("apps/web/dist"),
    BETTER_AUTH_SECRET: "local-smtp-qualification-secret-2026-nonproduction",
    CRON_SECRET: "local-smtp-cron-secret-2026-nonproduction",
    SMTP_URL: "", RESEND_API_KEY: "",
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "false",
    SMTP_USER: "", SMTP_PASS: "",
    EMAIL_FROM: "alerts@example.test",
    MONTRAL_BILLING_ENABLED: "false", MONTRAL_METERING_ENABLED: "false",
  }, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
for (const stream of [app.stdout, app.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", part => { log = (log + part).slice(-4000); });
}
let cookie = "";
const send = async (method, path, body) => {
  const response = await fetch(base + path, {
    method, headers: {
      ...(cookie ? { cookie } : {}), origin: base, "content-type": "application/json",
    }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const setCookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  if (setCookie) cookie = setCookie;
  return { status: response.status, body: await response.json().catch(() => null) };
};
try {
  let ready = false;
  for (let n = 0; n < 160; n++) {
    if (app.exitCode !== null) throw new Error("Node app exited: " + log);
    try {
      const r = await fetch(base + "/health", { signal: AbortSignal.timeout(650) });
      if (r.ok && (await r.json()).ok) { ready = true; break; }
    } catch {}
    await sleep(200);
  }
  if (!ready) throw new Error("Node app not healthy: " + log);
  if (!log.includes("smtp: connection verified")) {
    for (let n = 0; n < 50 && !log.includes("smtp: connection verified"); n++) await sleep(100);
  }
  if (!log.includes("smtp: connection verified")) throw new Error("SMTP verify handshake did not succeed: " + log);
  const address = "smtp-qa-" + Date.now() + "@example.test";
  const signup = await send("POST", "/api/auth/sign-up/email", {
    email: address, name: "Synthetic SMTP QA", password: "correct horse battery",
  });
  if (signup.status !== 200) throw new Error("Signup failed HTTP " + signup.status + ": " + JSON.stringify(signup.body));
  const channel = await send("POST", "/api/channels", {
    name: "Local fake SMTP destination", type: "email",
    config: { to: "synthetic-recipient@example.test" },
  });
  if (channel.status !== 201 || !channel.body?.id) {
    throw new Error("Create SMTP channel failed HTTP " + channel.status + ": " + JSON.stringify(channel.body));
  }
  const result = await send("POST", "/api/channels/" + channel.body.id + "/test");
  if (result.status !== 200 || result.body?.ok !== true) {
    throw new Error("SMTP notification test failed HTTP " + result.status + ": " + JSON.stringify(result.body) + " " + log);
  }
  const delivered = smtpMessages.filter(m => m.to === "synthetic-recipient@example.test");
  if (delivered.length !== 1 || !delivered[0].raw.includes("Test alert from Montral")) {
    throw new Error("SMTP sink did not receive exactly one correct synthetic alert: " + JSON.stringify(smtpMessages.map(m => m.to)));
  }
  const confirmation = await send("GET", "/api/channels");
  if (confirmation.status !== 200) throw new Error("Authenticated channel listing failed");
  if (connections < 2) throw new Error("No distinct SMTP verify + delivery connection observed");

  // Also exercise the actual Node cron + queue + PostgreSQL monitor state,
  // automatic incident creation, SMTP dispatch, heartbeat and recovery.
  // Do not dial any monitored external service: only this synthetic heartbeat
  // and a local SQL clock advance are used.
  // Node's built-in queue delays each stable hash slot by 8 seconds. Select
  // slot 0 to keep this smoke deterministic and fast even on hosted runners.
  let monitor;
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = await send("POST", "/api/monitors", {
      name: "Synthetic SMTP cron",
      type: "heartbeat", intervalSec: 60, failureThreshold: 1,
      recoveryThreshold: 1, channelIds: [channel.body.id],
    });
    if (candidate.status !== 201 || !/^[0-9a-f-]{36}$/i.test(candidate.body?.id)) {
      throw new Error("Could not create synthetic heartbeat: " + JSON.stringify(candidate));
    }
    if (!monitor || slotOf(candidate.body.id) < slotOf(monitor.body.id)) monitor = candidate;
    if (slotOf(monitor.body.id) === 0) break;
  }
  const id = monitor.body.id;
  const heartbeatToken = monitor.body.heartbeatToken;
  execFileSync("psql", [isolatedConnection, "-X", "-q", "-v", "ON_ERROR_STOP=1",
    "-c", `UPDATE monitor SET next_check_at=now() - interval '3 seconds' WHERE id='${id}'`],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  const queued = await fetch(base + "/internal/run-checks", {
    method: "POST", headers: { "x-cron-secret": "local-smtp-cron-secret-2026-nonproduction" },
    signal: AbortSignal.timeout(5000),
  });
  const queuedBody = await queued.json();
  if (queued.status !== 200 || queuedBody.checked < 1) {
    throw new Error("Cron did not claim synthetic monitor: " + JSON.stringify(queuedBody));
  }
  const monitorState = async () => (await send("GET", "/api/monitors/" + id)).body;
  let downDelivered = false;
  for (let n = 0; n < 250; n++) {
    const state = await monitorState();
    const down = smtpMessages.filter(m => m.to === "synthetic-recipient@example.test" &&
      m.raw.includes("Synthetic SMTP cron") && /is down/i.test(m.raw));
    if (state.status === "down" && down.length === 1) { downDelivered = true; break; }
    await sleep(240);
  }
  if (!downDelivered) {
    const state = await monitorState();
    throw new Error("Synthetic Cron did not send down alert through SMTP: " +
      JSON.stringify({ status: state?.status, messages: smtpMessages.map(m => m.to), log }));
  }
  const pulse = await send("POST", "/api/heartbeat/" + heartbeatToken);
  if (pulse.status !== 200 || pulse.body?.ok !== true) throw new Error("Synthetic heartbeat recovery HTTP failure");
  let recovered = false;
  for (let n = 0; n < 55; n++) {
    const state = await monitorState();
    const up = smtpMessages.filter(m => m.to === "synthetic-recipient@example.test" &&
      m.raw.includes("Synthetic SMTP cron") && /has recovered/i.test(m.raw));
    if (state.status === "up" && up.length === 1) { recovered = true; break; }
    await sleep(150);
  }
  if (!recovered) throw new Error("Synthetic heartbeat recovered without SMTP recovery alert: " + log);
  const incidents = await send("GET", "/api/incidents");
  if (incidents.status !== 200 ||
      incidents.body.filter(i => i.monitorId === id && i.auto === true && i.status === "resolved").length !== 1) {
    throw new Error("Automatic SMTP qualification did not resolve exactly one incident");
  }
  const recovery = await send("POST", "/api/auth/request-password-reset", {
    email: address, redirectTo: base + "/reset-password",
  });
  if (recovery.status !== 200) throw new Error("Local SMTP recovery request failed");
  const resetMessages = smtpMessages.filter(m => m.to === address && m.raw.includes("Reset your Montral password"));
  if (resetMessages.length !== 1) throw new Error("Local SMTP recovery mail not delivered exactly once");
  console.log("SMTP_LOOPBACK_PASS: production Node SMTP verification, channel test, cron incident down/recovery and account recovery link delivery over loopback only");
} finally {
  app.kill("SIGTERM");
  await Promise.race([new Promise(done => app.once("exit", done)), sleep(2500)]);
  if (app.exitCode === null) app.kill("SIGKILL");
  await new Promise(done => smtp.close(done));
  execFileSync("psql", [connection, "-X", "-q", "-v", "ON_ERROR_STOP=1",
    "-c", `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`],
    { timeout: 8000 });
}
