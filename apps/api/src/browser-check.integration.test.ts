/**
 * Real Chromium against a synthetic site this test serves on 127.0.0.1: journeys, the egress policy (redirects,
 * iframes, fetch / XHR / WebSocket / img to private addresses, file://, popups), runaway pages (infinite loop, memory
 * bomb, huge page, slow page), the concurrency cap and isolation between checks.
 *
 * Runs wherever a Chromium is available (BROWSER_EXECUTABLE_PATH, or the browser of the pinned playwright-core) and is
 * skipped otherwise. With BROWSER_CHECK_TESTS=required (the dedicated CI job) a missing Chromium is a failure.
 *
 * Every private address except the synthetic site's own port stays refused (`extraAllowed` is the runner's test seam);
 * a second "canary" server on another loopback port must never see a request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { BROWSER_BUSY, browserAvailable, browserCheck, browserSlots, configureBrowserChecks, defaultWorker, processesOf, resetBrowserAvailability, runBrowserWorker, workspaceSlots } from "./browser-check";
import { createRunnerServer } from "./browser-runner";
import { encryptSecret } from "./browser-secrets";
import { MAX_SCREENSHOT_BYTES } from "./browser-steps";

const required = process.env.BROWSER_CHECK_TESTS === "required";
const pw = await import("playwright-core").catch(() => null);
const explicit = process.env.BROWSER_EXECUTABLE_PATH;
const exe = explicit || pw?.chromium.executablePath() || "";
const haveChromium = !!pw && !!exe && existsSync(exe);
const AUTH = "browser-integration-test-secret-0123456789";
const ORG = "org-browser-it";
const PASSWORD = "s3cret-Pa55-for-test";
const MON = "5b0e0e0e-1111-4222-8333-944444444444";

describe("browser checks need Chromium", () => {
  it.runIf(required)("Chromium is installed (BROWSER_CHECK_TESTS=required)", () => {
    expect(haveChromium, `no Chromium at ${exe || "(unknown)"}`).toBe(true);
  });
});

type Site = { server: Server; port: number; hits: string[] };

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Site> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
  server.on("upgrade", (req, socket: Socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

const html = (res: ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
};

describe.skipIf(!haveChromium)("browser checks in real Chromium", () => {
  let site: Site;
  let canary: Site;
  let base: string;
  let udp: UdpSocket;
  let udpPort = 0;
  const udpHits: number[] = [];
  // canaries on this machine's non-loopback address too (a real interface, not 127.0.0.1): UDP and TCP
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  let lanUdp: UdpSocket | undefined;
  let lanTcp: NetServer | undefined;
  let lanUdpPort = 0;
  let lanTcpPort = 0;
  const lanHits: string[] = [];
  let worker: { file: string; args: string[] };
  const deps = () => ({ worker, extraAllowed: [`127.0.0.1:${site.port}`] });
  const monitor = async (steps: unknown[], extra: Record<string, unknown> = {}) => ({
    target: base,
    id: MON,
    organizationId: ORG,
    browser: { steps, timeoutMs: 30_000, screenshot: "never", ...extra },
    browserSecrets: { pw: await encryptSecret(AUTH, ORG, MON, "pw", PASSWORD) },
  });

  beforeAll(async () => {
    canary = await listen((_req, res) => html(res, "canary"));
    // a UDP canary: STUN / TURN / ICE / QUIC (WebTransport) packets that left the browser would land here
    udp = createSocket("udp4");
    udp.on("message", (m) => udpHits.push(m.length));
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
    udpPort = udp.address().port;
    if (lan) {
      lanUdp = createSocket("udp4");
      lanUdp.on("message", (m) => lanHits.push(`udp ${m.length}`));
      await new Promise<void>((r) => lanUdp!.bind(0, lan, () => r()));
      lanUdpPort = lanUdp.address().port;
      lanTcp = createNetServer((sock) => { lanHits.push("tcp"); sock.destroy(); });
      await new Promise<void>((r) => lanTcp!.listen(0, lan, () => r()));
      lanTcpPort = (lanTcp.address() as AddressInfo).port;
    }
    site = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const c = `http://127.0.0.1:${canary.port}`;
      switch (url.pathname) {
        case "/login":
          if (req.method === "POST") {
            let body = "";
            req.on("data", (d) => { body += d; });
            req.on("end", () => {
              const f = new URLSearchParams(body);
              if (f.get("user") === "alice" && f.get("pass") === PASSWORD) { res.writeHead(302, { location: "/dashboard", "set-cookie": "session=ok; Path=/; HttpOnly" }); res.end(); }
              else html(res, `<p id="error">Wrong password</p>`, 401);
            });
            return;
          }
          return html(res, `<form method="post" action="/login"><input id="user" name="user"><input id="pass" name="pass" type="text"><button id="submit" type="submit">Sign in</button></form>`);
        case "/dashboard":
          return (req.headers.cookie ?? "").includes("session=ok") ? html(res, `<h1 id="greeting">Welcome alice</h1>`) : html(res, "denied", 401);
        case "/slow":
          setTimeout(() => html(res, "<p>slow</p>"), 8000);
          return;
        case "/hold":
          setTimeout(() => html(res, `<p id="held">held</p>`), 3000);
          return;
        case "/huge": {
          res.writeHead(200, { "content-type": "text/html" });
          const chunk = Buffer.alloc(64 * 1024, 120);
          let sent = 0;
          const pump = () => {
            while (sent < 40 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) return void res.once("drain", pump); }
            res.end();
          };
          res.on("error", () => {});
          return pump();
        }
        case "/redirect-metadata":
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
          return res.end();
        case "/redirect-canary":
          res.writeHead(302, { location: `${c}/redirected` });
          return res.end();
        case "/exfil":
          return html(res, `<p id="done">pending</p>
            <iframe src="${c}/iframe"></iframe>
            <iframe src="http://10.255.255.1/iframe"></iframe>
            <img src="${c}/img.png"><img src="http://[::1]:${canary.port}/v6.png"><img src="http://2130706433:${canary.port}/decimal.png"><img src="http://0x7f000001:${canary.port}/hex.png">
            <script>
              const tries = [
                fetch("${c}/fetch").catch(() => 0),
                fetch("http://169.254.169.254/latest/meta-data/").catch(() => 0),
                new Promise((r) => { const x = new XMLHttpRequest(); x.open("GET", "${c}/xhr"); x.onloadend = r; x.send(); }),
                new Promise((r) => { try { const w = new WebSocket("ws://127.0.0.1:${canary.port}/ws"); w.onerror = r; w.onclose = r; setTimeout(r, 3000); } catch { r(); } }),
                new Promise((r) => { try { const w = new WebSocket("wss://127.0.0.1:${canary.port}/wss"); w.onerror = r; w.onclose = r; setTimeout(r, 3000); } catch { r(); } }),
                navigator.sendBeacon ? Promise.resolve(navigator.sendBeacon("${c}/beacon", "x")) : 0,
              ];
              Promise.all(tries).then(() => { document.getElementById("done").textContent = "done"; });
            </script>`);
        case "/file":
          return html(res, `<p id="status">pending</p><iframe src="file:///etc/passwd"></iframe><iframe src="chrome://version"></iframe>
            <script>
              fetch("file:///etc/passwd").then((r) => r.text()).then((t) => { document.getElementById("status").textContent = t.includes("root:") ? "leaked" : "empty"; })
                .catch(() => { document.getElementById("status").textContent = "no-access"; });
            </script>`);
        case "/webrtc":
          return html(res, `<p id="done">pending</p><script>
            const finish = () => { document.getElementById("done").textContent = "done"; };
            (async () => {
              try {
                const pc = new RTCPeerConnection({ iceServers: [
                  { urls: "stun:127.0.0.1:${udpPort}" },
                  { urls: "turn:127.0.0.1:${udpPort}?transport=udp", username: "u", credential: "p" },
                  { urls: "turn:127.0.0.1:${canary.port}?transport=tcp", username: "u", credential: "p" },
                  { urls: "stun:10.255.255.1:3478" },
                  ...(${JSON.stringify(!!lan)} ? [{ urls: "stun:${lan}:${lanUdpPort}" }, { urls: "turn:${lan}:${lanTcpPort}?transport=tcp", username: "u", credential: "p" }] : []),
                ] });
                pc.createDataChannel("x");
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await pc.setRemoteDescription({ type: "answer", sdp: offer.sdp.replace("a=setup:actpass", "a=setup:active") });
                for (const c of [
                  "candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host",
                  "candidate:2 1 tcp 1518280447 127.0.0.1 ${canary.port} typ host tcptype passive",
                  "candidate:3 1 udp 2122260223 10.255.255.1 ${udpPort} typ host",
                  ...(${JSON.stringify(!!lan)} ? ["candidate:4 1 udp 2122260223 ${lan} ${lanUdpPort} typ host", "candidate:5 1 tcp 1518280447 ${lan} ${lanTcpPort} typ host tcptype passive"] : []),
                ]) await pc.addIceCandidate({ candidate: c, sdpMid: "0", sdpMLineIndex: 0 }).catch(() => {});
              } catch {}
              try {
                const wt = new WebTransport("https://127.0.0.1:${udpPort}/wt");
                if (${JSON.stringify(!!lan)}) { const wt2 = new WebTransport("https://${lan}:${lanUdpPort}/wt"); wt2.ready.catch(() => {}); }
                await Promise.race([wt.ready.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
              } catch {}
              setTimeout(finish, 4000);
            })();
          </script>`);
        case "/popup":
          return html(res, `<p id="ok">ok</p><script>window.open("${c}/popup"); window.open("/dashboard");</script>`);
        case "/loop":
          return html(res, `<p id="x">start</p><script>setTimeout(() => { for (;;) {} }, 50);</script>`);
        case "/bomb":
          return html(res, `<p id="x">bomb</p><script>const keep = []; setInterval(() => { for (let i = 0; i < 200000; i++) keep.push({ i, s: "x".repeat(64) + i }); }, 5);</script>`);
        case "/set-cookie":
          return html(res, `<p id="state">set</p><script>localStorage.setItem("tenant", "A"); document.cookie = "js=A; path=/";</script>`, 200, { "set-cookie": "tenant=A; Path=/; Max-Age=3600" });
        case "/show-cookie":
          return html(res, `<p id="cookie">${(req.headers.cookie ?? "").replace(/[<>&]/g, "") || "none"}</p><p id="storage"></p><script>document.getElementById("storage").textContent = localStorage.getItem("tenant") ?? "empty";</script>`);
        default:
          return html(res, `<p id="home">home</p>`);
      }
    });
    base = `http://127.0.0.1:${site.port}`;
    // BROWSER_WORKER_BUNDLE: the esbuild bundle that ships (pnpm build:browser-worker); default: the source through tsx
    worker = process.env.BROWSER_WORKER_BUNDLE ? { file: process.env.BROWSER_WORKER_BUNDLE, args: [] } : await defaultWorker();
    configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH, BROWSER_EXECUTABLE_PATH: explicit, MAX_BROWSER_CHECKS: "4" });
  });
  afterAll(async () => {
    udp?.close();
    lanUdp?.close();
    lanTcp?.close();
    configureBrowserChecks({});
    await Promise.all([site, canary].map((s) => s && new Promise((r) => s.server.close(r))));
  });

  it("the availability probe starts and stops Chromium", async () => {
    resetBrowserAvailability();
    expect(await browserAvailable(worker)).toBe(true);
  }, 60_000);

  it("runs a login journey with a stored secret and records step timings", async () => {
    const out = await browserCheck(await monitor([
      { action: "goto", url: `${base}/login` },
      { action: "fill", selector: "#user", value: "alice" },
      { action: "fill", selector: "#pass", secretRef: "pw" },
      { action: "click", selector: "#submit" },
      { action: "waitFor", text: "Welcome" },
      { action: "assertUrl", pattern: "/dashboard" },
      { action: "assertText", selector: "#greeting", contains: "alice" },
      { action: "assertStatus", code: 200 },
    ]), deps());
    expect(out).toMatchObject({ ok: true, statusCode: 200 });
    expect(out.browser?.steps.map((s) => s.ok)).toEqual(Array(8).fill(true));
    expect(out.browser?.steps.every((s) => s.ms >= 0)).toBe(true);
    expect(out.browser?.blockedRequests).toBe(0);
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    if (process.platform === "linux") expect(out.browser?.peakRssMb).toBeGreaterThan(0);
    console.info(`login journey: ${out.latencyMs} ms, peak RSS ${out.browser?.peakRssMb ?? "n/a"} MiB, CPU ${out.browser?.cpuMs ?? "n/a"} ms`);
  }, 60_000);

  it("fails at the right step with a fixed message and a masked, bounded screenshot", async () => {
    const out = await browserCheck(await monitor([
      { action: "goto", url: `${base}/login` },
      { action: "fill", selector: "#user", value: "mallory" },
      { action: "fill", selector: "#pass", secretRef: "pw" },
      { action: "click", selector: "#submit" },
      { action: "assertText", selector: "#greeting", contains: "alice", timeoutMs: 1500 },
    ], { screenshot: "on_failure" }), deps());
    expect(out.ok).toBe(false);
    expect(out.error).toBe("Step 5 (assertText): element not found");
    expect(out.browser?.failedStep).toBe(4);
    const png = out.browser?.screenshotPng;
    expect(png && png.byteLength).toBeGreaterThan(100);
    expect(png!.byteLength).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES);
    expect(JSON.stringify({ ...out, browser: { ...out.browser, screenshotPng: undefined } })).not.toContain(PASSWORD);
  }, 60_000);

  it("a script step passes only on true; false, a throw and a hang fail with fixed messages that hold nothing from the page", async () => {
    const pass = await browserCheck(await monitor([
      { action: "goto", url: `${base}/login` },
      { action: "evaluate", script: "await new Promise((r) => setTimeout(r, 50)); return document.querySelector('#user') !== null && location.pathname === '/login';" },
    ]), deps());
    expect(pass).toMatchObject({ ok: true });
    for (const [script, error] of [
      ["return 'yes';", "Step 2 (evaluate): script did not return true"],
      ["return document.title.length;", "Step 2 (evaluate): script did not return true"],
      ["throw new Error('page secret ' + document.cookie + document.title);", "Step 2 (evaluate): script threw an error"],
      ["await new Promise(() => {}); return true;", "Step 2 (evaluate): timed out"],
    ] as const) {
      const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/login` }, { action: "evaluate", script, timeoutMs: 1500 }]), deps());
      expect(out, script).toMatchObject({ ok: false, error });
      expect(JSON.stringify(out)).not.toContain("page secret");
    }
    // a script cannot reach a private address either: its requests go through the same egress policy
    const hitsBefore = canary.hits.length;
    const probe = await browserCheck(await monitor([
      { action: "goto", url: `${base}/login` },
      { action: "evaluate", script: `for (const u of ['http://127.0.0.1:${canary.port}/from-script', 'http://169.254.169.254/latest/meta-data/']) { try { await fetch(u, { mode: 'no-cors' }); } catch {} } return true;`, timeoutMs: 8000 },
    ]), deps());
    expect(probe, probe.error).toMatchObject({ ok: true });
    expect(probe.browser!.blockedRequests).toBeGreaterThanOrEqual(1);
    expect(canary.hits.length).toBe(hitsBefore);
  }, 90_000);

  it("a missing secret fails the fill step without running it", async () => {
    const out = await browserCheck({ ...(await monitor([{ action: "goto", url: `${base}/login` }, { action: "fill", selector: "#pass", secretRef: "pw" }])), browserSecrets: {} }, deps());
    expect(out).toMatchObject({ ok: false, error: "Step 2 (fill): secret is not set" });
  }, 60_000);

  it("times out a slow page at the step's own timeout", async () => {
    const started = Date.now();
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/slow`, timeoutMs: 2000 }]), deps());
    expect(out).toMatchObject({ ok: false, error: "Step 1 (goto): timed out" });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("cuts a huge page at the transfer limit", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/huge`, timeoutMs: 20_000 }]), deps());
    expect(out).toMatchObject({ ok: false, error: "Step 1 (goto): page exceeded the transfer limit" });
  }, 60_000);

  it("refuses a redirect to the metadata address", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/redirect-metadata` }]), deps());
    expect(out).toMatchObject({ ok: false, error: "Step 1 (goto): blocked by the network policy" });
    expect(out.browser?.blockedRequests).toBeGreaterThan(0);
  }, 60_000);

  it("refuses a redirect to another private address", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/redirect-canary` }]), deps());
    expect(out).toMatchObject({ ok: false, error: "Step 1 (goto): blocked by the network policy" });
    expect(canary.hits).toEqual([]);
  }, 60_000);

  it("blocks iframes, fetch, XHR, WebSocket, beacons and images to private addresses in every spelling", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/exfil` }, { action: "waitFor", text: "done", timeoutMs: 15_000 }]), deps());
    expect(out.ok, out.error).toBe(true);
    expect(out.browser!.blockedRequests).toBeGreaterThanOrEqual(5);
    expect(canary.hits).toEqual([]);
  }, 60_000);

  it("cannot read file:// or open chrome:// pages", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/file` }, { action: "assertText", selector: "#status", equals: "no-access" }]), deps());
    expect(out.ok, out.error).toBe(true);
  }, 60_000);

  it("closes popup windows, and their requests are policed too", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/popup` }, { action: "assertText", selector: "#ok", equals: "ok" }]), deps());
    expect(out.ok, out.error).toBe(true);
    expect(out.browser!.popupsClosed).toBeGreaterThanOrEqual(1);
    expect(canary.hits).toEqual([]);
  }, 60_000);

  it("stops a page stuck in an infinite loop within its limits", async () => {
    const started = Date.now();
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/loop` }, { action: "click", selector: "#never", timeoutMs: 3000 }], { timeoutMs: 10_000 }), deps());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^(Step 2 \(click\): (timed out|element not found|failed)|Browser check exceeded its (time|CPU) limit)$/);
    // journey 10 s + launch and shutdown allowances
    expect(Date.now() - started).toBeLessThan(45_000);
  }, 60_000);

  it("stops a memory bomb within its limits", async () => {
    const started = Date.now();
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/bomb` }, { action: "waitFor", selector: "#never", timeoutMs: 25_000 }], { timeoutMs: 30_000 }), { ...deps(), maxRssMb: 700 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^(Step 2 \(waitFor\): (page crashed|timed out|failed|element not found)|Browser check exceeded its (memory|time|CPU) limit)$/);
    expect(Date.now() - started).toBeLessThan(65_000);
    console.info(`memory bomb: ${out.error}; peak RSS ${out.browser?.peakRssMb ?? "n/a"} MiB, CPU ${out.browser?.cpuMs ?? "n/a"} ms, ${Date.now() - started} ms`);
  }, 90_000);

  it("runs at most the configured number of checks at once; the rest are deferred, never queued", async () => {
    const cap = browserSlots(2, 0);
    const m = await monitor([{ action: "goto", url: `${base}/hold` }, { action: "assertText", selector: "#held", equals: "held" }]);
    // three workspaces (one check each), so only the server cap is in play; the per-workspace gate has its own tests
    const outs = await Promise.all([0, 1, 2].map((i) => browserCheck({ ...m, organizationId: `org-cap-${i}` }, { ...deps(), slots: cap, workspaces: workspaceSlots(1, 0) })));
    expect(outs.filter((o) => o.ok)).toHaveLength(2);
    expect(outs.filter((o) => o.inconclusive && o.error === BROWSER_BUSY)).toHaveLength(1);
    expect(cap.inFlight()).toBe(0);
  }, 90_000);

  it("shares nothing between checks: cookies and storage set by one are absent in the next", async () => {
    const a = await browserCheck(await monitor([{ action: "goto", url: `${base}/set-cookie` }, { action: "assertText", selector: "#state", equals: "set" }]), deps());
    expect(a.ok, a.error).toBe(true);
    const b = await browserCheck(await monitor([{ action: "goto", url: `${base}/show-cookie` }, { action: "assertText", selector: "#cookie", equals: "none" }, { action: "assertText", selector: "#storage", equals: "empty" }]), deps());
    expect(b.ok, b.error).toBe(true);
  }, 60_000);

  it("WebRTC (STUN/TURN over UDP and TCP, ICE host candidates to IP literals) and WebTransport never leave the box", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/webrtc` }, { action: "waitFor", text: "done", timeoutMs: 15_000 }]), deps());
    expect(out.ok, out.error).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(udpHits).toEqual([]);
    expect(lanHits).toEqual([]);
    if (process.env.CI) expect(lan, "no non-loopback IPv4 address for the canaries").toBeDefined();
    expect(canary.hits).toEqual([]);
  }, 60_000);

  it.runIf(process.platform === "linux")("a worker that crashes mid-check leaves no Chromium behind", async () => {
    // watch the machine for Chromium processes of this check while it runs
    const seen = new Set<string>();
    let watching = true;
    const watcher = (async () => {
      const fs = await import("node:fs");
      while (watching) {
        for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
          try {
            const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
            const m = /--user-data-dir=([^\0]*montral-browser-[^/\0]+)/.exec(cmd);
            if (m) seen.add(m[1]);
          } catch { /* gone */ }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const run = await runBrowserWorker({
      config: { steps: [{ action: "goto", url: `${base}/slow`, timeoutMs: 20_000 }], timeoutMs: 30_000, screenshot: "never" },
      secrets: {}, policy: { allowPrivate: false, extraAllowed: [`127.0.0.1:${site.port}`] }, executablePath: explicit, sandbox: true, testAbortAfterMs: 1500,
    }, { worker, hardTimeoutMs: 60_000, maxRssMb: 2048 });
    watching = false;
    await watcher;
    // the worker really crashed (no report) while its Chromium was running…
    expect(run.report).toBeNull();
    expect([...seen].some((d) => d.startsWith(run.dir!))).toBe(true);
    // …and nothing of that check is left
    expect(await processesOf(run.dir!)).toEqual([]);
  }, 90_000);

  it("through the browser-runner: signed jobs run there, and the runner drops the test allowance (loopback refused)", async () => {
    const token = "integration-runner-token-0123456789abcdef";
    const runner = await createRunnerServer({ token, slots: browserSlots(2, 0), worker, executablePath: explicit, maxRssMb: 2048 });
    await new Promise<void>((r) => runner.listen(0, "127.0.0.1", () => r()));
    const runnerUrl = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
    try {
      configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH, BROWSER_RUNNER_URL: runnerUrl, BROWSER_RUNNER_TOKEN: token });
      resetBrowserAvailability();
      expect(await browserAvailable()).toBe(true);
      // the app passes its test allowance for the loopback site; the runner removes it, so the site is refused
      const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/` }]), { extraAllowed: [`127.0.0.1:${site.port}`] });
      expect(out).toMatchObject({ ok: false, error: "Step 1 (goto): blocked by the network policy" });
      // a wrong token is refused by the runner and the app reports the check as unavailable (inconclusive)
      configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH, BROWSER_RUNNER_URL: runnerUrl, BROWSER_RUNNER_TOKEN: "wrong-token-wrong-token-wrong-token-0000" });
      resetBrowserAvailability();
      expect(await browserCheck(await monitor([{ action: "goto", url: `${base}/` }]))).toMatchObject({ ok: false, inconclusive: true });
    } finally {
      configureBrowserChecks({ BROWSER_CHECKS: "enabled", BETTER_AUTH_SECRET: AUTH, BROWSER_EXECUTABLE_PATH: explicit, MAX_BROWSER_CHECKS: "4" });
      resetBrowserAvailability();
      await new Promise((r) => runner.close(r));
    }
  }, 120_000);

  it("a public-only policy refuses the synthetic site itself (no test seam, loopback)", async () => {
    const out = await browserCheck(await monitor([{ action: "goto", url: `${base}/` }]), { worker });
    expect(out).toMatchObject({ ok: false, error: "Step 1 (goto): blocked by the network policy" });
  }, 60_000);
});
