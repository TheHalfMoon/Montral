#!/usr/bin/env node
// Offline, real-browser smoke. Uses a preinstalled headless Chromium and the
// project's existing ws dependency; does not contact hosted browsers or customers.
// Requires TEST_DATABASE_URL for a disposable local PostgreSQL database and
// MONTRAL_CHROMIUM pointing to an already installed Chromium executable.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import WebSocket from "../apps/api/node_modules/ws/index.js";

const connection = process.env.TEST_DATABASE_URL;
const executable = process.env.MONTRAL_CHROMIUM;
if (!connection || !executable) throw new Error("Set TEST_DATABASE_URL and MONTRAL_CHROMIUM");
const db = new URL(connection);
if (!["127.0.0.1", "localhost"].includes(db.hostname) || !/^\/montral_test_[a-zA-Z0-9_]+$/.test(db.pathname)) {
  throw new Error("Browser qualification refuses any non-local or non-disposable database");
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() => resolvePort(addr.port));
    });
  });
}
async function until(label, fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await pause(180);
  }
  throw new Error("Timed out waiting for " + label + (last ? " (" + last.message + ")" : ""));
}
const portHttp = await port();
const portCdp = await port();
const base = `http://127.0.0.1:${portHttp}`;
const chromeProfile = `/tmp/montral-browser-profile-${process.pid}`;
const api = spawn(process.execPath, [resolve("apps/api/dist/server.mjs")], {
  env: {
    ...process.env, DATABASE_URL: connection, PORT: String(portHttp),
    BIND_HOST: "127.0.0.1", BETTER_AUTH_URL: base, WEB_ORIGIN: base,
    WEB_DIST: resolve("apps/web/dist"),
    BETTER_AUTH_SECRET: "browser-e2e-secret-2026-10-30-only-never-live",
    CRON_SECRET: "browser-e2e-cron-secret-2026-10-30-only",
    MONTRAL_BILLING_ENABLED: "false", MONTRAL_METERING_ENABLED: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
for (const stream of [api.stdout, api.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", t => { serverLog = (serverLog + t).slice(-2500); });
}
let chrome;
let ws;
let browserCompleted = false;
try {
  await until("Node API /health", async () => {
    if (api.exitCode !== null) throw new Error(serverLog);
    const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).ok;
  }, 40000);
  chrome = spawn(executable, [
    "--headless", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-background-networking", "--disable-extensions", "--no-sandbox",
    `--remote-debugging-port=${portCdp}`, "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${chromeProfile}`,
    "about:blank",
  ], { stdio: "ignore" });
  const tab = await until("Chromium CDP", async () => {
    const response = await fetch(`http://127.0.0.1:${portCdp}/json/list`, { signal: AbortSignal.timeout(700) });
    return (await response.json()).find(t => t.type === "page" && t.webSocketDebuggerUrl);
  });
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((done, fail) => { ws.once("open", done); ws.once("error", fail); });
  let nextId = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (!msg.id || !pending.has(msg.id)) return;
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
  });
  async function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((ok, fail) => {
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function js(expression) {
    const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }
  async function page(path) {
    await cdp("Page.navigate", { url: base + path });
    await until("page " + path, () => js(`location.pathname === ${JSON.stringify(path)} && document.readyState === "complete"`));
  }
  async function fill(selector, value) {
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await cdp("Input.insertText", { text: value });
  }
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  // Check that a browser without auth cannot read private webhook/billing state.
  for (const path of ["/api/hooks/inboxes", "/api/billing"]) {
    const unauth = await fetch(base + path);
    if (unauth.status !== 401) throw new Error("Private path not denied: " + path + " " + unauth.status);
  }
  // Subscribe/unsubscribe confirmation URLs contain single-use bearer tokens.
  // Test privacy headers on real Node HTTP redirects and the interactive form,
  // without ever sending mail or altering a subscriber row.
  for (const [path, init, expectedStatus] of [
    ["/api/public/status/_/confirm?token=invalid-synthetic", {}, 302],
    ["/api/public/status/_/unsubscribe?token=invalid-synthetic", {}, 200],
    ["/api/public/status/_/unsubscribe?token=invalid-synthetic", { method: "POST", body: "List-Unsubscribe=One-Click" }, 200],
  ]) {
    const result = await fetch(base + path, { ...init, redirect: "manual" });
    if (result.status !== expectedStatus ||
        result.headers.get("cache-control") !== "private, no-store" ||
        result.headers.get("referrer-policy") !== "no-referrer" ||
        result.headers.get("x-content-type-options") !== "nosniff" ||
        result.headers.get("x-robots-tag") !== "noindex, nofollow" ||
        (result.headers.get("location") || "").includes("invalid-synthetic")) {
      throw new Error("Status bearer-token URL privacy check failed for " + path);
    }
  }
  await page("/signup");
  await until("hydrated signup form", () => js('!!document.querySelector("form.auth-fields input[type=email]")'));
  const signupSemantics = await js('document.querySelector("a.skip-link[href]")?.getAttribute("href") === "#main-content" && !!document.querySelector("main#main-content h1") && Array.from(document.querySelectorAll("form.auth-fields input")).every(el => el.labels && el.labels.length > 0)');
  if (!signupSemantics) throw new Error("Signup heading, main landmark or input labels inaccessible");
  const email = `montral-browser-${Date.now()}@example.test`;
  await fill('form.auth-fields input[autocomplete=name]', "Montral Browser QA");
  await fill('form.auth-fields input[type=email]', email);
  await fill('form.auth-fields input[type=password]', "correct horse battery staple");
  await js('document.querySelector("form.auth-fields button.auth-go").click()');
  await until("signed-in app dashboard", async () => {
    const pathname = await js("location.pathname");
    if (pathname === "/app") return true;
    const error = await js('document.querySelector(".auth-fields .err")?.textContent');
    if (error) throw new Error("Signup error: " + error);
    return false;
  }, 30000);
  // No SMTP provider is configured for this private browser preview. Signup
  // must not expose its verification bearer link (or recipient) in Node logs.
  await pause(120);
  if (serverLog.includes("Verify email:") || /verify-email\?token=/i.test(serverLog) || serverLog.includes(email)) {
    throw new Error("Browser signup leaked a verification credential or recipient in Node logs");
  }
  // A direct deep link to the unlisted, staged operator tool must never
  // expose review work in the default-off private preview. Real Chromium
  // renders the route, then the server's independent feature gate returns 404.
  await page("/app/mail-review");
  await until("disabled mail operator review page", () => js(
    'document.body.innerText.includes("Review tool unavailable") && !document.body.innerText.includes("Record decision once")'
  ));
  // HttpOnly session cookies are intentionally invisible to document.cookie.
  // Check the gate inside the actual authenticated browser origin instead of
  // constructing a separate anonymous Node fetch.
  const operatorGate = await js('fetch("/api/monthly-reconciliation/pending?month=2026-09", { credentials: "same-origin" }).then(r => r.status)');
  if (operatorGate !== 404) throw new Error("Monthly operator API unexpectedly enabled");
  if (await js('Array.from(document.querySelectorAll("nav.nl a[href]")).some(a => a.getAttribute("href") === "/app/mail-review")'))
    throw new Error("Staged mail review must remain unlinked from normal navigation");
  // Real-browser monitoring journey, using only a synthetic heartbeat. It
  // does not probe any external site, DNS resolver, or third-party service.
  await page("/app");
  const dashboardLandmarks = await js('document.querySelector("a.skip-link[href]")?.getAttribute("href") === "#main-content" && !!document.querySelector("nav.nl[aria-label]") && !!document.querySelector("main#main-content") && !!document.querySelector("nav.nl a[aria-current=page][data-nav=monitors]")');
  if (!dashboardLandmarks) throw new Error("Dashboard main/navigation landmarks or current-page state inaccessible");
  await until("monitor add action", () => js(
    'Array.from(document.querySelectorAll("button")).some(b => b.textContent.includes("Add your first monitor") || b.textContent.includes("New monitor"))'
  ));
  await js('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Add your first monitor") || b.textContent.includes("New monitor")).click()');
  await until("monitor creation dialog", () => js('!!document.querySelector("form.mform")'));
  await js('Array.from(document.querySelectorAll("form.mform .type-c")).find(b => b.textContent.includes("Heartbeat (cron)")).click()');
  await fill('form.mform input[required]', "Synthetic browser heartbeat");
  await js('Array.from(document.querySelectorAll("form.mform .mbtns button")).find(b => b.textContent.trim() === "Create monitor").click()');
  await until("created monitor rendered", () => js('document.body.innerText.includes("Synthetic browser heartbeat") && !document.querySelector("form.mform")'));
  const newMonitor = await js('fetch("/api/monitors", { credentials: "same-origin" }).then(r => r.json()).then(rows => rows.find(x => x.name === "Synthetic browser heartbeat"))');
  if (!newMonitor?.id || newMonitor.type !== "heartbeat") throw new Error("Browser-created heartbeat missing from authenticated API");
  await page("/app/monitors/" + newMonitor.id);
  await until("monitor detail view", () => js('document.querySelector("h1.ph-title")?.textContent?.includes("Synthetic browser heartbeat")'));
  await js('Array.from(document.querySelectorAll(".ph-actions button")).find(b => b.textContent.trim() === "Pause").click()');
  await until("monitor paused in browser", () => js('Array.from(document.querySelectorAll(".ph-actions button")).some(b => b.textContent.trim() === "Resume")'));
  await js('Array.from(document.querySelectorAll(".ph-actions button")).find(b => b.textContent.trim() === "Resume").click()');
  await until("monitor resumed in browser", () => js('Array.from(document.querySelectorAll(".ph-actions button")).some(b => b.textContent.trim() === "Pause")'));
  await page("/app/incidents");
  await until("incident page rendered", () => js('document.querySelector("h1")?.textContent?.includes("Incidents")'));
  if (!await js('!!document.querySelector("nav.nl a[data-nav=incidents][aria-current=page]")')) throw new Error("Incident navigation loses active-page semantics");
  // Qualify the actual manual incident lifecycle, including private team notes.
  // This test account has no configured channels or subscribers, and all
  // affected monitors/data are local synthetic records.
  await js('Array.from(document.querySelectorAll(".ph-actions button")).find(b => b.textContent.includes("Declare incident")).click()');
  await until("incident declaration dialog", () => js('!!document.querySelector(".modal form input[required]")'));
  await fill(".modal form input[required]", "Synthetic browser incident");
  await js('document.querySelector(".modal form textarea").value = "Synthetic incident created for local qualification"; document.querySelector(".modal form textarea").dispatchEvent(new Event("input", { bubbles: true }))');
  await js('Array.from(document.querySelectorAll(".modal form button")).find(b => b.textContent.trim() === "Declare incident").click()');
  await until("incident detail navigation", () => js('location.pathname.startsWith("/app/incidents/") && !!document.querySelector(".dh h1")'), 25000);
  const incidentId = await js('location.pathname.split("/").at(-1)');
  if (!/^[0-9a-f-]{36}$/i.test(incidentId)) throw new Error("Invalid incident id after browser declaration");
  const opened = await js(`fetch("/api/incidents/${incidentId}", { credentials: "same-origin" }).then(r => r.json())`);
  if (opened.title !== "Synthetic browser incident" || opened.status !== "investigating" || opened.auto) {
    throw new Error("Manual browser incident not persisted as investigating");
  }
  await js('Array.from(document.querySelectorAll(".dh-acts button")).find(b => b.textContent.trim() === "Acknowledge").click()');
  await until("incident acknowledged", () => js('!Array.from(document.querySelectorAll(".dh-acts button")).some(b => b.textContent.trim() === "Acknowledge")'));
  await until("incident acknowledgement persisted in API", () => js(`fetch("/api/incidents/${incidentId}", { credentials: "same-origin" }).then(r => r.json()).then(s => !!s.acknowledgedAt)`));
  // An internal update is never intended for outbound status-page subscribers.
  await js('Array.from(document.querySelectorAll("form.card.cc .seg i")).find(e => e.textContent.trim() === "identified").click()');
  await until("identified incident status selected", () => js('Array.from(document.querySelectorAll("form.card.cc .seg i")).some(e => e.textContent.trim() === "identified" && e.classList.contains("on"))'));
  await js('Array.from(document.querySelectorAll("form.card.cc .seg i")).find(e => e.textContent.trim() === "Internal note").click()');
  await until("internal note visibility selected", () => js('Array.from(document.querySelectorAll("form.card.cc .seg i")).some(e => e.textContent.trim() === "Internal note" && e.classList.contains("on"))'));
  await fill('form.card.cc textarea.in[required]', "Synthetic private investigation update");
  await until("internal incident draft text exact", () => js('document.querySelector("form.card.cc textarea.in[required]")?.value === "Synthetic private investigation update"'));
  await js('Array.from(document.querySelectorAll("form.card.cc button")).find(b => b.textContent.trim() === "Publish update").click()');
  await until("internal incident note in timeline", () => js('Array.from(document.querySelectorAll(".tl .ev")).some(e => e.textContent.includes("Synthetic private investigation update"))'));
  try {
    await until("internal incident state persisted in API", () => js(`fetch("/api/incidents/${incidentId}", { credentials: "same-origin" }).then(r => r.json()).then(s => s.status === "identified" && !!s.acknowledgedAt && Array.isArray(s.updates) && s.updates.some(u => u.visibility === "internal" && u.body === "Synthetic private investigation update"))`));
  } catch {
    // Only metadata from disposable synthetic content; never log incident
    // bodies, identities, credentials, targets or provider responses.
    let diagnostic = "unavailable";
    try {
      const state = await js(`fetch("/api/incidents/${incidentId}", { credentials: "same-origin" }).then(r => r.json()).then(s => ({ status: s.status, acknowledged: !!s.acknowledgedAt, updates: Array.isArray(s.updates) ? s.updates.slice(-3).map(u => ({ status: u.status, visibility: u.visibility, bodyExact: u.body === "Synthetic private investigation update", bodyLength: typeof u.body === "string" ? u.body.length : null })) : null }))`);
      diagnostic = JSON.stringify(state);
    } catch {}
    throw new Error("Internal incident persistence mismatch (synthetic metadata only): " + diagnostic);
  }
  const internalState = await js(`fetch("/api/incidents/${incidentId}", { credentials: "same-origin" }).then(r => r.json())`);
  if (internalState.status !== "identified" || !internalState.acknowledgedAt ||
      !internalState.updates.some(u => u.visibility === "internal" && u.body === "Synthetic private investigation update")) {
    throw new Error("Incident internal update or acknowledgement not persisted");
  }
  await js('Array.from(document.querySelectorAll(".dh-acts button")).find(b => b.textContent.trim() === "Resolve").click()');
  await until("incident resolved in browser", () => js('!!document.querySelector(".dh .pill.resolved")'));
  const closed = await js(`fetch("/api/incidents/${incidentId}", { credentials: "same-origin" }).then(r => r.json())`);
  if (closed.status !== "resolved" || !closed.resolvedAt ||
      !closed.updates.some(u => u.status === "resolved" && u.visibility === "public")) {
    throw new Error("Manual incident resolution was not persisted as a public update");
  }
  await page("/app/incidents");
  await until("resolved incident in list", () => js('document.body.innerText.includes("Synthetic browser incident")'));
  const resumed = await js(`fetch("/api/monitors/${newMonitor.id}", { credentials: "same-origin" }).then(r => r.json())`);
  if (resumed.paused) throw new Error("Monitor remained paused after browser resume");
  // No external outage was generated, and no alert provider was configured.

  await page("/app/hooks");
  await until("webhook inbox form", () => js(`!!document.querySelector('form input[maxlength="100"]')`));
  if (!await js('!!document.querySelector("nav.nl a[data-nav=hooks][aria-current=page]")')) throw new Error("Webhook navigation loses active-page semantics");
  await fill("form input[maxlength='100']", "Browser integration QA");
  await js('document.querySelector("form button.primary").click()');
  const secretPath = await until("new webhook inbox receiver URL", () => js('document.querySelector(".fresh code")?.textContent'));
  if (!secretPath.startsWith(base + "/api/hooks/receive/")) throw new Error("Malformed receiver URL");
  const submit = await fetch(secretPath, { method: "POST", headers: { "content-type": "application/json" }, body: '{"synthetic":"browser-e2e"}' });
  if (submit.status !== 202) throw new Error("Browser receiver returned " + submit.status);
  await js('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Refresh")?.click()');
  await until("captured webhook event rendered", () => js('!!document.querySelector("details summary")'));
  await js('document.querySelector("details").setAttribute("open", "")');
  await until("actual event payload in inspector", () => js('Array.from(document.querySelectorAll(".code2")).some(p => p.textContent.includes("browser-e2e"))'));
  // The receiver URL must not be accessible after leaving the in-memory creation view.
  await page("/app/hooks");
  await until("hook inbox list loaded", () => js('document.body.innerText.includes("Browser integration QA")'));
  const exposed = await js(`document.body.textContent.includes(${JSON.stringify(secretPath.split("/").at(-1))})`);
  if (exposed) throw new Error("Receiver token leaked after page reload");
  // Tests intentionally do not print, copy or save the secret receiver URL.
  await page("/app/billing");
  await until("billing page mounted", () => js('document.querySelector("h1")?.textContent?.includes("Billing")'));
  await until("billing is fail-closed", () => js('document.body.innerText.includes("Checkout is not configured")'));
  const buttonsDisabled = await js('Array.from(document.querySelectorAll("button")).filter(b => b.textContent.includes("Open test checkout")).every(b => b.disabled)');
  if (!buttonsDisabled) throw new Error("Billing checkout unexpectedly enabled");
  // The reset-link credential is short-lived and must not stay in history after hydration.
  await cdp("Page.navigate", { url: base + "/reset-password?token=syntheticbrowserresetcredential0123456789" });
  await until("reset link scrubbed from browser URL", () => js(
    'location.pathname === "/reset-password" && location.search === "" && !!document.querySelector("form.auth-fields input[type=password]")'
  ));
  const resetMeta = await js('document.querySelector("meta[name=referrer]")?.content');
  if (resetMeta !== "no-referrer") throw new Error("Reset page missing no-referrer metadata");
  await page("/reset-password");
  await until("missing reset link fails closed", () => js(
    'Array.from(document.querySelectorAll("a")).some(a => a.getAttribute("href") === "/forgot-password") && !document.querySelector("form.auth-fields")'
  ));
  console.log("BROWSER_E2E_PASS: real Chromium signup, synthetic monitor, incident, webhook, disabled billing, reset-link URL privacy; anonymous routes denied");
  browserCompleted = true;
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM");
  let shutdownFailed = false;
  // The browser fixture is a real Node process using an isolated PostgreSQL
  // database. A successful user journey must also demonstrate clean SIGTERM
  // shutdown: the old 800ms SIGKILL fallback never asserted the exit code.
  const apiAlive = api.exitCode === null && api.signalCode === null;
  if (apiAlive) {
    const exited = new Promise((resolveExit) => {
      api.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const sent = api.kill("SIGTERM");
    const exit = await Promise.race([
      exited,
      pause(browserCompleted ? 10500 : 800).then(() => null),
    ]);
    if (browserCompleted) {
      shutdownFailed = !sent || !exit || exit.code !== 0 || exit.signal !== null;
      if (!shutdownFailed) console.log("NODE_SIGTERM_PASS: self-hosted Node exited cleanly with disposable PostgreSQL");
    }
  } else if (browserCompleted) {
    shutdownFailed = true;
  }
  for (const child of [chrome, api]) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await pause(250);
  await rm(chromeProfile, { recursive: true, force: true });
  if (shutdownFailed) throw new Error("Node SIGTERM did not finish cleanly within the bounded shutdown deadline");
}
