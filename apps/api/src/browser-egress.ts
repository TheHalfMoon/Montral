/**
 * Network egress for browser checks. Node only; runs inside the isolated worker process (browser-worker.ts).
 *
 * Chromium is started with this module's forward proxy as its only way out (`--proxy-server`, loopback not bypassed,
 * its own resolver mapped to NOTFOUND, non-proxied WebRTC UDP disabled), so every request the page makes (documents,
 * subresources, redirects, fetch / XHR, WebSockets, iframes, popups) reaches the network through `startEgressProxy`:
 *
 * - plain http:// requests arrive as absolute-URI requests, https:// and ws(s):// as CONNECT tunnels;
 * - each new destination is decided once per check by `decideEgress`: the name is resolved once, and every address it
 *   resolves to must be acceptable (private, CGNAT, documentation… refused unless BROWSER_CHECK_ALLOW_PRIVATE_TARGETS;
 *   loopback, link-local, cloud metadata, `localhost` names and the deny list (own and app addresses) always refused);
 * - the proxy then dials one of those validated IP literals itself, so the name cannot be re-resolved to another address
 *   between the decision and the connection (DNS rebinding), not even by a later request of the same check;
 * - TLS stays end to end (the browser verifies the certificate against the hostname as usual);
 * - bytes in both directions count against a per-connection and a per-check budget, and connections against a cap:
 *   past a limit the connection is cut and the check fails with a fixed message.
 *
 * Why a proxy rather than only `--host-resolver-rules` or Playwright's request routing: routing does not see WebSockets,
 * service-worker or some preflight traffic, and resolver rules would have to be known before the first request (a page
 * can name any host). A proxy sees every connection the network stack opens and decides with the address it then dials.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { addressBlocked, canonicalIp, hostBlocked, ipLiteral, linkLocalOrMetadata, loopbackAddress } from "./netguard";

export type EgressPolicy = {
  /**
   * BROWSER_CHECK_ALLOW_PRIVATE_TARGETS (its own opt-in, separate from ALLOW_PRIVATE_TARGETS): private and internal
   * addresses become reachable. Never loopback, link-local / metadata, or the addresses in `deny`.
   */
  allowPrivate: boolean;
  /** Addresses always refused: this server's own interfaces and, on a browser runner, the app that sent the job. */
  deny?: string[];
  /**
   * Exact "ip:port" pairs reachable even though private. Never set from configuration or the API: only the runner's
   * programmatic options (tests serve their synthetic site on 127.0.0.1 this way while every other private address stays
   * refused).
   */
  extraAllowed?: string[];
  /** Resolver (tests replace it); default `dns.lookup(host, { all: true })`. */
  resolve?: (host: string) => Promise<string[]>;
};

export type EgressDecision =
  | { allowed: true; host: string; port: number; addresses: string[] }
  | { allowed: false; reason: "host" | "address" | "port" | "unresolved" };

/** Largest data: URL a request may carry (routing layer); anything larger is refused. */
export const MAX_DATA_URL_LENGTH = 64 * 1024;

/**
 * Schemes a request may use, before any network decision: http(s), ws(s), small data: URLs, blob: and about:blank.
 * file:, chrome:, chrome-extension:, view-source:, ftp:, javascript: and every other about: page are refused.
 */
export function schemeAllowed(url: string): boolean {
  const lower = url.slice(0, 32).toLowerCase();
  if (lower.startsWith("data:")) return url.length <= MAX_DATA_URL_LENGTH;
  if (lower.startsWith("blob:")) return true;
  if (lower === "about:blank" || lower.startsWith("about:blank#") || lower.startsWith("about:blank?")) return true;
  return /^(?:https?|wss?):\/\//.test(lower);
}

/** Lower-case ASCII host without brackets or trailing dot; IDN becomes punycode; numeric IPv4 spellings become dotted. */
export async function normaliseEgressHost(host: string): Promise<string | null> {
  let h = host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!h || h.length > 253) return null;
  if (h.includes(":")) return ipLiteral(h) ? h : null;
  if (/^[0-9a-fx.]+$/.test(h)) {
    try { h = new URL(`http://${h}`).hostname; } catch { return null; }
    return h;
  }
  const { domainToASCII } = await import("node:url");
  const ascii = domainToASCII(h);
  if (!ascii || !/^[a-z0-9.-]+$/.test(ascii)) return null;
  return ascii;
}

const defaultResolve = async (host: string) => {
  const dns = await import("node:dns/promises");
  return (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);
};

/** Whether one address may be dialled on `port` under `policy`. */
export function addressAllowed(ip: string, port: number, policy: EgressPolicy): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (policy.extraAllowed?.includes(`${bare}:${port}`) || policy.extraAllowed?.includes(`[${bare}]:${port}`)) return true;
  // never, whatever the deployment allows: metadata / link-local, loopback, and this server's (or the app's) own addresses
  if (linkLocalOrMetadata(bare) || loopbackAddress(bare)) return false;
  const canon = canonicalIp(bare);
  if (canon && policy.deny?.some((d) => canonicalIp(d) === canon)) return false;
  return policy.allowPrivate || !addressBlocked(bare);
}

/** Every address of this machine's interfaces: the server's own addresses, refused as browser destinations. */
export async function ownAddresses(): Promise<string[]> {
  const os = await import("node:os");
  return Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address.split("%")[0]));
}

/**
 * The decision for one destination: the host is normalised, refused outright when it can only be local, otherwise
 * resolved once (an IP literal is its own address) and allowed only when every address is acceptable. The addresses
 * returned are the ones to dial, IPv4 first.
 */
export async function decideEgress(rawHost: string, port: number, policy: EgressPolicy): Promise<EgressDecision> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { allowed: false, reason: "port" };
  const host = await normaliseEgressHost(rawHost);
  if (!host) return { allowed: false, reason: "host" };
  // localhost names never go anywhere, whatever the deployment allows
  if (host === "localhost" || host.endsWith(".localhost")) return { allowed: false, reason: "host" };
  let addresses: string[];
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    addresses = [host];
  } else {
    if (!policy.allowPrivate && hostBlocked(host)) return { allowed: false, reason: "host" };
    try {
      addresses = await (policy.resolve ?? defaultResolve)(host);
    } catch {
      return { allowed: false, reason: "unresolved" };
    }
    if (!addresses.length) return { allowed: false, reason: "unresolved" };
  }
  if (!addresses.every((a) => ipLiteral(a.toLowerCase()) && addressAllowed(a, port, policy))) return { allowed: false, reason: "address" };
  return { allowed: true, host, port, addresses: [...addresses.filter((a) => !a.includes(":")), ...addresses.filter((a) => a.includes(":"))] };
}

// ---- proxy -----------------------------------------------------------------------------------------------------------

export type EgressLimits = {
  /** bytes per connection, both directions */
  maxConnectionBytes: number;
  /** bytes per check, all connections, both directions */
  maxTotalBytes: number;
  /** upstream connections per check */
  maxConnections: number;
  /** connect timeout per address */
  connectTimeoutMs: number;
};
export const DEFAULT_EGRESS_LIMITS: EgressLimits = { maxConnectionBytes: 10 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024, maxConnections: 256, connectTimeoutMs: 10_000 };

export type EgressEvent = { kind: "blocked" | "unreachable"; at: number; tunnel: boolean };
export type EgressProxy = {
  port: number;
  stats: { blocked: number; connections: number; bytes: number; limitHit: null | "transfer" | "connections"; events: EgressEvent[] };
  close(): Promise<void>;
};

/** Header the proxy puts on the responses it makes up itself, so the worker can tell a refusal from the site's own 403. */
export const EGRESS_HEADER = "x-montral-egress";

type Dial = (address: string, port: number) => Socket;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection", "proxy-authorization", "proxy-authenticate"]);

/** "host:port" / "[v6]:port" of a CONNECT request. */
export function connectTarget(authority: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):(\d{1,5})$/.exec(authority);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

export async function startEgressProxy(policy: EgressPolicy, limits: EgressLimits = DEFAULT_EGRESS_LIMITS, dial?: Dial): Promise<EgressProxy> {
  const http = await import("node:http");
  const net = await import("node:net");
  const connect: Dial = dial ?? ((address, port) => net.connect({ host: address, port }));
  const stats: EgressProxy["stats"] = { blocked: 0, connections: 0, bytes: 0, limitHit: null, events: [] };
  const sockets = new Set<Duplex>();
  // one decision per destination for the whole check: later requests reuse the addresses validated first
  const decisions = new Map<string, Promise<EgressDecision>>();
  const decide = (host: string, port: number) => {
    const key = `${host.toLowerCase()}\0${port}`;
    let d = decisions.get(key);
    if (!d) { d = decideEgress(host, port, policy); decisions.set(key, d); }
    return d;
  };
  const track = <T extends Duplex>(s: T) => { sockets.add(s); s.once("close", () => sockets.delete(s)); return s; };
  const event = (kind: EgressEvent["kind"], tunnel: boolean) => {
    if (kind === "blocked") stats.blocked++;
    if (stats.events.length < 500) stats.events.push({ kind, at: Date.now(), tunnel });
  };

  /** Counts bytes of one connection against both budgets; past either, everything of that connection is cut. */
  const meter = (onExceed: () => void) => {
    let own = 0;
    return (n: number) => {
      own += n;
      stats.bytes += n;
      if (own > limits.maxConnectionBytes || stats.bytes > limits.maxTotalBytes) {
        stats.limitHit ??= "transfer";
        onExceed();
        return false;
      }
      return true;
    };
  };

  /** Dial the validated addresses in turn; null when none answered. */
  const open = (addresses: string[], port: number) => new Promise<Socket | null>((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= addresses.length) return resolve(null);
      const s = track(connect(addresses[i++], port));
      const timer = setTimeout(() => s.destroy(), limits.connectTimeoutMs);
      s.once("connect", () => { clearTimeout(timer); s.removeAllListeners("error"); s.on("error", () => s.destroy()); resolve(s); });
      s.once("error", () => { clearTimeout(timer); s.destroy(); next(); });
    };
    next();
  });

  const admit = () => {
    if (stats.connections >= limits.maxConnections) {
      stats.limitHit ??= "connections";
      return false;
    }
    stats.connections++;
    return true;
  };

  /** Raw tunnel between the client socket and an upstream connection, metered both ways. */
  const splice = (client: Duplex, upstream: Socket, head?: Buffer) => {
    const kill = () => { client.destroy(); upstream.destroy(); };
    const count = meter(kill);
    if (head?.length && count(head.length)) upstream.write(head);
    upstream.on("data", (d: Buffer) => { if (count(d.length)) client.write(d); });
    client.on("data", (d: Buffer) => { if (count(d.length)) upstream.write(d); });
    upstream.on("end", () => client.end());
    client.on("end", () => upstream.end());
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("error", kill);
    upstream.on("error", kill);
  };

  const refuseSocket = (socket: Duplex, status: 403 | 502, tunnel: boolean) => {
    event(status === 403 ? "blocked" : "unreachable", tunnel);
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\n${EGRESS_HEADER}: ${status === 403 ? "blocked" : "unreachable"}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
  };

  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const refuse = (status: 403 | 502 | 400) => {
      if (status !== 400) event(status === 403 ? "blocked" : "unreachable", false);
      if (!res.headersSent) res.writeHead(status, { [EGRESS_HEADER]: status === 403 ? "blocked" : status === 502 ? "unreachable" : "bad-request", "content-length": "0", connection: "close" });
      res.end();
    };
    let u: URL;
    try { u = new URL(req.url ?? ""); } catch { return refuse(400); }
    if (u.protocol !== "http:") return refuse(403);
    const port = u.port ? Number(u.port) : 80;
    const d = await decide(u.hostname, port);
    if (!d.allowed) return refuse(d.reason === "unresolved" ? 502 : 403);
    if (!admit()) return refuse(403);
    const upstream = await open(d.addresses, port);
    if (!upstream) return refuse(502);
    // the request is forwarded as it came (origin-form path, the browser's own Host header), minus hop-by-hop headers,
    // over the connection just opened to the validated address
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k.startsWith("proxy-")) continue;
      headers[k] = v;
    }
    headers.connection = "close";
    const kill = () => { upstream.destroy(); res.destroy(); req.destroy(); };
    const count = meter(kill);
    if (!count(JSON.stringify(headers).length + (req.url?.length ?? 0))) return;
    const forward = http.request({ method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false, createConnection: () => upstream }); // no agent: createConnection is used only without one
    forward.on("error", () => { if (!res.headersSent) refuse(502); else res.destroy(); });
    req.on("data", (d: Buffer) => { if (count(d.length)) forward.write(d); });
    req.on("end", () => forward.end());
    forward.on("response", (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      out.connection = "close";
      res.writeHead(up.statusCode ?? 502, out);
      up.on("data", (d: Buffer) => { if (count(d.length)) res.write(d); });
      up.on("end", () => res.end());
      up.on("error", () => res.destroy());
    });
    res.on("close", () => upstream.destroy());
  };

  const server = http.createServer({ requestTimeout: 0, headersTimeout: 30_000 });
  server.on("request", (req, res) => { void onRequest(req, res).catch(() => res.destroy()); });
  server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    track(socket);
    socket.on("error", () => socket.destroy());
    void (async () => {
      const t = connectTarget(req.url ?? "");
      if (!t) return refuseSocket(socket, 403, true);
      const d = await decide(t.host, t.port);
      if (!d.allowed) return refuseSocket(socket, d.reason === "unresolved" ? 502 : 403, true);
      if (!admit()) return refuseSocket(socket, 403, true);
      const upstream = await open(d.addresses, t.port);
      if (!upstream) return refuseSocket(socket, 502, true);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      splice(socket, upstream, head);
    })().catch(() => socket.destroy());
  });
  // ws:// sent as an absolute-URI upgrade (some stacks do this instead of CONNECT): forwarded like a request
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    track(socket);
    socket.on("error", () => socket.destroy());
    void (async () => {
      let u: URL;
      try { u = new URL(req.url ?? ""); } catch { return refuseSocket(socket, 403, false); }
      if (u.protocol !== "http:" && u.protocol !== "ws:") return refuseSocket(socket, 403, false);
      const port = u.port ? Number(u.port) : 80;
      const d = await decide(u.hostname, port);
      if (!d.allowed) return refuseSocket(socket, d.reason === "unresolved" ? 502 : 403, false);
      if (!admit()) return refuseSocket(socket, 403, false);
      const upstream = await open(d.addresses, port);
      if (!upstream) return refuseSocket(socket, 502, false);
      const lines: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!req.rawHeaders[i].toLowerCase().startsWith("proxy-")) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      const reqHead = Buffer.from(`${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      splice(socket, upstream, Buffer.concat([reqHead, head]));
    })().catch(() => socket.destroy());
  });
  server.on("connection", (s: Socket) => { track(s); });
  server.on("clientError", (_e, s) => s.destroy());

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    stats,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
