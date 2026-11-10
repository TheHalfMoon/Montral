import { createServer, request, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressAllowed, connectTarget, decideEgress, EGRESS_HEADER, normaliseEgressHost, ownAddresses, schemeAllowed, startEgressProxy, type EgressPolicy } from "./browser-egress";
import { canonicalIp, linkLocalOrMetadata, loopbackAddress } from "./netguard";

const fixed = (map: Record<string, string[]>): EgressPolicy["resolve"] => async (h) => {
  if (!(h in map)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return map[h];
};
const PUBLIC = { allowPrivate: false, resolve: fixed({ "example.com": ["93.184.215.14"], "v6.example": ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"] }) };

describe("schemes", () => {
  it("allows ordinary web requests, small data: and blob: URLs and about:blank only", () => {
    for (const u of ["http://example.com/", "https://example.com/x", "ws://example.com/s", "wss://example.com/s", "data:text/plain,hi", "blob:https://example.com/uuid", "about:blank"]) expect(schemeAllowed(u), u).toBe(true);
    for (const u of ["file:///etc/passwd", "FILE:///C:/Windows/win.ini", "chrome://version", "chrome-extension://abc/x", "view-source:http://example.com", "ftp://example.com/", "javascript:alert(1)", "about:config", "about:version", "filesystem:http://x/y", `data:text/html,${"x".repeat(70_000)}`]) expect(schemeAllowed(u), u).toBe(false);
  });
});

describe("egress decisions", () => {
  it("refuses loopback, private, CGNAT, link-local and metadata literals in every spelling", async () => {
    for (const host of ["127.0.0.1", "127.1", "2130706433", "0x7f000001", "0x7f.0.0.1", "017700000001", "10.0.0.1", "172.16.5.4", "192.168.1.1", "100.64.0.1", "169.254.169.254", "0.0.0.0",
      "::1", "[::1]", "::ffff:127.0.0.1", "[::ffff:7f00:1]", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "fe80::1", "fc00::1", "fd00:ec2::254", "100.100.100.200"]) {
      expect(await decideEgress(host, 80, PUBLIC), host).toMatchObject({ allowed: false });
    }
  });

  it("refuses localhost and internal names before resolving them", async () => {
    let lookups = 0;
    const policy = { allowPrivate: false, resolve: async () => { lookups++; return ["93.184.215.14"]; } };
    for (const host of ["localhost", "LOCALHOST.", "app.localhost", "db.internal", "printer.local", "router.lan", "postgres", "metadata.google.internal"]) {
      expect(await decideEgress(host, 80, policy), host).toMatchObject({ allowed: false, reason: "host" });
    }
    expect(lookups).toBe(0);
  });

  it("allows public names and literals, and returns the addresses to dial", async () => {
    expect(await decideEgress("example.com", 443, PUBLIC)).toEqual({ allowed: true, host: "example.com", port: 443, addresses: ["93.184.215.14"] });
    expect(await decideEgress("93.184.215.14", 8443, PUBLIC)).toMatchObject({ allowed: true, addresses: ["93.184.215.14"] });
    expect(await decideEgress("[2606:4700:4700::1111]", 443, PUBLIC)).toMatchObject({ allowed: true, addresses: ["2606:4700:4700::1111"] });
  });

  it("refuses a name when any address it resolves to is private (mixed answers)", async () => {
    const policy = { allowPrivate: false, resolve: fixed({ "mixed.example": ["93.184.215.14", "10.1.2.3"], "meta.example": ["169.254.169.254"], "mapped.example": ["::ffff:10.0.0.1"] }) };
    for (const h of ["mixed.example", "meta.example", "mapped.example"]) expect(await decideEgress(h, 80, policy), h).toMatchObject({ allowed: false, reason: "address" });
  });

  it("converts IDN hostnames to punycode before resolving", async () => {
    const seen: string[] = [];
    const policy = { allowPrivate: false, resolve: async (h: string) => { seen.push(h); return ["93.184.215.14"]; } };
    expect(await normaliseEgressHost("BÜCHER.example")).toBe("xn--bcher-kva.example");
    expect(await decideEgress("bücher.example", 443, policy)).toMatchObject({ allowed: true, host: "xn--bcher-kva.example" });
    expect(seen).toEqual(["xn--bcher-kva.example"]);
    // an IDN that resolves privately is refused like any other name
    expect(await decideEgress("bücher.example", 443, { allowPrivate: false, resolve: async () => ["127.0.0.1"] })).toMatchObject({ allowed: false });
  });

  it("refuses unparseable hosts, port 0 and names that do not resolve", async () => {
    expect(await decideEgress("exa mple.com", 80, PUBLIC)).toMatchObject({ allowed: false, reason: "host" });
    expect(await decideEgress("example.com", 0, PUBLIC)).toMatchObject({ allowed: false, reason: "port" });
    expect(await decideEgress("example.com", 70000, PUBLIC)).toMatchObject({ allowed: false, reason: "port" });
    expect(await decideEgress("nowhere.example", 80, PUBLIC)).toMatchObject({ allowed: false, reason: "unresolved" });
    expect(await decideEgress("empty.example", 80, { allowPrivate: false, resolve: async () => [] })).toMatchObject({ allowed: false, reason: "unresolved" });
  });

  it("with the private opt-in, private addresses pass but loopback, link-local, metadata and localhost names never do", async () => {
    const policy = { allowPrivate: true, resolve: fixed({ "db.internal": ["10.0.0.5"], "imds.example": ["169.254.169.254"], "loop.example": ["127.0.0.1"], "loop6.example": ["::1"] }) };
    expect(await decideEgress("10.0.0.5", 5432, policy)).toMatchObject({ allowed: true });
    expect(await decideEgress("db.internal", 80, policy)).toMatchObject({ allowed: true, addresses: ["10.0.0.5"] });
    for (const h of ["127.0.0.1", "127.9.9.9", "2130706433", "0x7f000001", "::1", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "loop.example", "loop6.example",
      "169.254.169.254", "imds.example", "fd00:ec2::254", "::ffff:169.254.169.254", "fe80::1", "100.100.100.200", "localhost", "0.0.0.0"]) {
      expect(await decideEgress(h, 8080, policy), h).toMatchObject({ allowed: false });
    }
  });

  it("always refuses this server's own addresses and the app's (the deny list), in any spelling, even with the private opt-in", async () => {
    const policy = { allowPrivate: true, deny: ["172.18.0.2", "fd12::5"], resolve: fixed({ "app.internal": ["172.18.0.2"], "other.internal": ["172.18.0.3"] }) };
    for (const h of ["172.18.0.2", "::ffff:172.18.0.2", "[::ffff:ac12:2]", "app.internal", "fd12:0:0:0:0:0:0:5", "[fd12::5]"]) expect(await decideEgress(h, 8080, policy), h).toMatchObject({ allowed: false });
    expect(await decideEgress("other.internal", 8080, policy)).toMatchObject({ allowed: true });
    const own = await ownAddresses();
    expect(own).toContain("127.0.0.1");
    for (const a of own) expect(addressAllowed(a, 80, { allowPrivate: true, deny: own }), a).toBe(false);
  });

  it("ALLOW_PRIVATE_TARGETS alone does not open private targets to browser checks (separate opt-in)", async () => {
    expect(await decideEgress("10.0.0.5", 80, { allowPrivate: false })).toMatchObject({ allowed: false });
  });

  it("the test seam allows exactly one ip:port, nothing else on that host", () => {
    const policy = { allowPrivate: false, extraAllowed: ["127.0.0.1:4000"] };
    expect(addressAllowed("127.0.0.1", 4000, policy)).toBe(true);
    expect(addressAllowed("127.0.0.1", 4001, policy)).toBe(false);
    expect(addressAllowed("10.0.0.1", 4000, policy)).toBe(false);
  });

  it("decides with one lookup: a name whose DNS changes between lookups is pinned to what was validated", async () => {
    // first answer public, every later one private (DNS rebinding)
    let n = 0;
    const policy = { allowPrivate: false, resolve: async () => (n++ === 0 ? ["93.184.215.14"] : ["127.0.0.1"]) };
    const d = await decideEgress("rebind.example", 80, policy);
    expect(d).toEqual({ allowed: true, host: "rebind.example", port: 80, addresses: ["93.184.215.14"] });
    expect(n).toBe(1);
    // and a decision taken while it points privately is a refusal
    expect(await decideEgress("rebind.example", 80, policy)).toMatchObject({ allowed: false });
  });

  it("link-local / metadata classification covers the IPv6 spellings", () => {
    for (const ip of ["169.254.0.1", "169.254.169.254", "0.0.0.0", "100.100.100.200", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::169.254.169.254", "2002:a9fe:a9fe::", "fe80::1", "febf::1", "fd00:ec2::254"]) expect(linkLocalOrMetadata(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "10.0.0.1", "127.0.0.1", "::1", "fd00:ec2::253", "2606:4700::1111"]) expect(linkLocalOrMetadata(ip), ip).toBe(false);
  });

  it("canonicalises and classifies loopback in every spelling", () => {
    expect(canonicalIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalIp("[::ffff:7f00:1]")).toBe("127.0.0.1");
    expect(canonicalIp("64:ff9b::10.0.0.1")).toBe("10.0.0.1");
    expect(canonicalIp("2001:DB8::1")).toBe("2001:db8:0:0:0:0:0:1");
    expect(canonicalIp("example.com")).toBeNull();
    for (const ip of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1", "not-an-ip"]) expect(loopbackAddress(ip), ip).toBe(true);
    for (const ip of ["10.0.0.1", "::", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(loopbackAddress(ip), ip).toBe(false);
  });

  it("parses CONNECT authorities", () => {
    expect(connectTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(connectTarget("[::1]:8443")).toEqual({ host: "[::1]", port: 8443 });
    for (const bad of ["example.com", "example.com:", ":443", "a b:443", "[::1:443", "example.com:443/x"]) expect(connectTarget(bad), bad).toBeNull();
  });
});

describe("egress proxy", () => {
  let site: Server;
  let canary: Server;
  let sitePort = 0;
  let canaryPort = 0;
  const canaryHits: string[] = [];
  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === "/big") { res.writeHead(200, { "content-type": "text/plain" }); res.end(Buffer.alloc(300_000, 97)); return; }
      if (req.url === "/redirect") { res.writeHead(302, { location: `http://127.0.0.1:${canaryPort}/x` }); res.end(); return; }
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => { res.writeHead(200, { "content-type": "text/plain", "set-cookie": "a=1" }); res.end(`hello ${req.method} ${req.headers.host} ${body}`); });
    });
    canary = createServer((req, res) => { canaryHits.push(req.url ?? ""); res.end("canary"); });
    await Promise.all([site, canary].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))));
    sitePort = (site.address() as AddressInfo).port;
    canaryPort = (canary.address() as AddressInfo).port;
  });
  afterAll(async () => { await Promise.all([site, canary].map((s) => new Promise((r) => s.close(r)))); });

  const viaProxy = (proxyPort: number, url: string, method = "GET", body?: string) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method, path: url, headers: { host: new URL(url).host, "proxy-connection": "keep-alive" } }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const tunnel = (proxyPort: number, authority: string) => new Promise<string>((resolve) => {
    const s = netConnect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`));
    let got = "";
    s.on("data", (d) => { got += d; if (got.includes("\r\n\r\n")) { s.destroy(); resolve(got.split("\r\n")[0]); } });
    s.on("error", () => resolve(got.split("\r\n")[0] ?? ""));
    s.on("close", () => resolve(got.split("\r\n")[0] ?? ""));
  });

  it("forwards allowed plain HTTP requests (method, Host, body, headers) and meters them", async () => {
    const proxy = await startEgressProxy({ allowPrivate: false, extraAllowed: [`127.0.0.1:${sitePort}`] });
    try {
      const r = await viaProxy(proxy.port, `http://127.0.0.1:${sitePort}/form`, "POST", "x=1");
      expect(r.status).toBe(200);
      expect(r.body).toBe(`hello POST 127.0.0.1:${sitePort} x=1`);
      expect(r.headers["set-cookie"]).toEqual(["a=1"]);
      expect(proxy.stats.connections).toBe(1);
      expect(proxy.stats.bytes).toBeGreaterThan(0);
      expect(proxy.stats.blocked).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it("refuses private destinations with a marked 403 and never connects to them (HTTP, CONNECT, upgrade)", async () => {
    const proxy = await startEgressProxy({ allowPrivate: false, extraAllowed: [`127.0.0.1:${sitePort}`] });
    try {
      const r = await viaProxy(proxy.port, `http://127.0.0.1:${canaryPort}/direct`);
      expect(r.status).toBe(403);
      expect(r.headers[EGRESS_HEADER]).toBe("blocked");
      expect(await tunnel(proxy.port, `127.0.0.1:${canaryPort}`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await tunnel(proxy.port, `169.254.169.254:80`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await tunnel(proxy.port, `[::ffff:127.0.0.1]:${canaryPort}`)).toMatch(/^HTTP\/1\.1 403/);
      expect(await tunnel(proxy.port, `localhost:${canaryPort}`)).toMatch(/^HTTP\/1\.1 403/);
      expect((await viaProxy(proxy.port, `http://2130706433:${canaryPort}/decimal`)).status).toBe(403);
      expect((await viaProxy(proxy.port, `ftp://127.0.0.1:${sitePort}/x`)).status).toBe(403);
      expect(canaryHits).toEqual([]);
      expect(proxy.stats.blocked).toBeGreaterThanOrEqual(7);
    } finally {
      await proxy.close();
    }
  });

  it("a redirect to a private address is passed to the browser, and the follow-up request is refused", async () => {
    const proxy = await startEgressProxy({ allowPrivate: false, extraAllowed: [`127.0.0.1:${sitePort}`] });
    try {
      const r = await viaProxy(proxy.port, `http://127.0.0.1:${sitePort}/redirect`);
      expect(r.status).toBe(302);
      expect((await viaProxy(proxy.port, String(r.headers.location))).status).toBe(403);
      expect(canaryHits).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("tunnels allowed CONNECT requests to the validated address", async () => {
    const dialled: string[] = [];
    const proxy = await startEgressProxy({ allowPrivate: false, extraAllowed: [`127.0.0.1:${sitePort}`], resolve: fixed({ "site.example": ["127.0.0.1"] }) }, undefined, (address, port) => { dialled.push(`${address}:${port}`); return netConnect(port, address); });
    try {
      expect(await tunnel(proxy.port, `127.0.0.1:${sitePort}`)).toBe("HTTP/1.1 200 Connection Established");
      expect(dialled).toEqual([`127.0.0.1:${sitePort}`]);
    } finally {
      await proxy.close();
    }
  });

  it("pins every connection of a check to the first validated answer, even when DNS changes (rebinding)", async () => {
    let lookups = 0;
    const dialled: string[] = [];
    // validated public first; afterwards the name would point at loopback
    const resolve = async () => (lookups++ === 0 ? ["93.184.215.14"] : ["127.0.0.1"]);
    const proxy = await startEgressProxy({ allowPrivate: false, resolve }, { maxConnectionBytes: 1e6, maxTotalBytes: 1e6, maxConnections: 10, connectTimeoutMs: 200 },
      // records where the proxy dials, and connects to the local site instead of the internet
      (address, port) => { dialled.push(`${address}:${port}`); return netConnect(sitePort, "127.0.0.1"); });
    try {
      await tunnel(proxy.port, "rebind.example:443");
      await tunnel(proxy.port, "rebind.example:443");
      await viaProxy(proxy.port, "http://rebind.example:443/");
      expect(lookups).toBe(1);
      expect(dialled.every((d) => d === "93.184.215.14:443")).toBe(true);
      expect(dialled.length).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  it("cuts a response past the per-connection limit and reports the transfer limit", async () => {
    const proxy = await startEgressProxy({ allowPrivate: false, extraAllowed: [`127.0.0.1:${sitePort}`] }, { maxConnectionBytes: 100_000, maxTotalBytes: 1e9, maxConnections: 10, connectTimeoutMs: 1000 });
    try {
      const r = await viaProxy(proxy.port, `http://127.0.0.1:${sitePort}/big`).catch(() => ({ status: 0, body: "", headers: {} }));
      expect(r.body.length).toBeLessThan(300_000);
      expect(proxy.stats.limitHit).toBe("transfer");
    } finally {
      await proxy.close();
    }
  });

  it("caps connections per check", async () => {
    const proxy = await startEgressProxy({ allowPrivate: false, extraAllowed: [`127.0.0.1:${sitePort}`] }, { maxConnectionBytes: 1e6, maxTotalBytes: 1e9, maxConnections: 2, connectTimeoutMs: 1000 });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await viaProxy(proxy.port, `http://127.0.0.1:${sitePort}/n${i}`)).status);
      expect(statuses).toEqual([200, 200, 403, 403]);
      expect(proxy.stats.limitHit).toBe("connections");
    } finally {
      await proxy.close();
    }
  });
});
