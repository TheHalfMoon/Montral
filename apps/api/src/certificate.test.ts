import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WORKERS_UNSUPPORTED, certificateCheck, certificateIncidentTitle, certificateProblem, certificateTargetProblem, certificateVerdict } from "./certificate";
import { runCheck, type CheckInput } from "./checker";
import { configureNetGuard, targetProblem } from "./netguard";

const NOW = Date.parse("2026-11-09T00:00:00Z");
const DAY = 864e5;
const at = (ms: number) => new Date(ms).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) (\S+) GMT$/, "$2 $1 $4 $3 GMT"); // getPeerCertificate's format

describe("certificate verdict", () => {
  it("passes a certificate with more than the warning window left", () => {
    expect(certificateVerdict("example.com", { valid_from: at(NOW - 30 * DAY), valid_to: at(NOW + 31 * DAY), issuer: { CN: "R11" } }, 30, NOW)).toEqual({ ok: true });
  });

  it("fails inside the warning window with the days left, the date and the issuer", () => {
    expect(certificateVerdict("example.com", { valid_to: at(NOW + 9 * DAY), issuer: { CN: "R11", O: "Let's Encrypt" } }, 30, NOW))
      .toEqual({ ok: false, error: "Certificate for example.com expires in 9 days (2026-11-18, issued by R11)" });
    expect(certificateVerdict("example.com", { valid_to: at(NOW + DAY / 2), issuer: { O: "Example CA" } }, 30, NOW).error).toBe("Certificate for example.com expires in 1 day (2026-11-09, issued by Example CA)");
    // the window is inclusive and configurable
    expect(certificateVerdict("example.com", { valid_to: at(NOW + 9 * DAY) }, 9, NOW).ok).toBe(false);
    expect(certificateVerdict("example.com", { valid_to: at(NOW + 9 * DAY) }, 8, NOW).ok).toBe(true);
  });

  it("fails an expired, not yet valid or undated certificate even when verification let it through", () => {
    expect(certificateVerdict("example.com", { valid_to: at(NOW - DAY) }, 30, NOW)).toEqual({ ok: false, error: "Certificate for example.com has expired (2026-11-08)" });
    expect(certificateVerdict("example.com", { valid_from: at(NOW + DAY), valid_to: at(NOW + 90 * DAY) }, 30, NOW)).toEqual({ ok: false, error: "Certificate for example.com is not valid yet" });
    expect(certificateVerdict("example.com", { valid_to: "garbage" }, 30, NOW)).toEqual({ ok: false, error: "Certificate for example.com has no readable expiry date" });
  });

  it("keeps a peer-supplied issuer name printable and short", () => {
    const error = certificateVerdict("example.com", { valid_to: at(NOW + 2 * DAY), issuer: { CN: ["Evil\u0000\u001b[31mCA" + "x".repeat(200), "second"] } }, 30, NOW).error!;
    expect(error).toMatch(/issued by Evil\[31mCAx+\)$/);
    expect(error).not.toMatch(/[^\x20-\x7e]/);
    expect(error.length).toBeLessThan(140);
    expect(certificateVerdict("example.com", { valid_to: at(NOW + 2 * DAY), issuer: {} }, 30, NOW).error).toMatch(/issued by an unnamed issuer\)$/);
  });

  it("maps TLS failures to fixed messages and leaves network failures to the caller", () => {
    const err = (code: string) => Object.assign(new Error(`peer text that must not be stored (${code})`), { code });
    expect(certificateProblem("example.com", err("CERT_HAS_EXPIRED"))).toBe("Certificate for example.com has expired");
    expect(certificateProblem("example.com", err("CERT_NOT_YET_VALID"))).toBe("Certificate for example.com is not valid yet");
    expect(certificateProblem("example.com", err("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe("Certificate for example.com is self-signed and not trusted");
    expect(certificateProblem("example.com", err("SELF_SIGNED_CERT_IN_CHAIN"))).toBe("Certificate for example.com chains to an untrusted self-signed root");
    expect(certificateProblem("example.com", err("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toMatch(/^Certificate for example.com cannot be verified/);
    expect(certificateProblem("example.com", err("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe("Certificate for example.com does not match the hostname");
    expect(certificateProblem("example.com", err("CERT_SOMETHING_NEW"))).toBe("Certificate for example.com failed verification (CERT_SOMETHING_NEW)");
    expect(certificateProblem("example.com", err("ERR_SSL_WRONG_VERSION_NUMBER"))).toBe("TLS handshake with example.com failed");
    expect(certificateProblem("example.com", err("EPROTO"))).toBe("TLS handshake with example.com failed");
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"]) expect(certificateProblem("example.com", err(code))).toBeNull();
    expect(certificateProblem("example.com", new Error("Connection timed out"))).toBeNull();
  });

  it("names incidents after what the failure was", () => {
    expect(certificateIncidentTitle("Site", "Certificate for example.com expires in 9 days (2026-11-18, issued by R11)")).toBe("Site: certificate expires soon");
    expect(certificateIncidentTitle("Site", "Certificate for example.com expires in 1 day (2026-11-10, issued by R11)")).toBe("Site: certificate expires soon");
    expect(certificateIncidentTitle("Site", "Certificate for example.com has expired (2026-11-08)")).toBe("Site: certificate invalid");
    expect(certificateIncidentTitle("Site", "Certificate for example.com does not match the hostname")).toBe("Site: certificate invalid");
    expect(certificateIncidentTitle("Site", "ECONNREFUSED")).toBe("Site: certificate invalid");
    expect(certificateIncidentTitle("Site", undefined)).toBe("Site: certificate invalid");
  });
});

const check = (target: string, over: Partial<CheckInput> = {}): CheckInput => ({ type: "certificate", target, method: "GET", expectedStatus: 200, timeoutMs: 3000, ...over });

describe("certificate targets", () => {
  afterEach(() => { configureNetGuard({}); vi.unstubAllGlobals(); });

  it("takes host or host:port and refuses anything else", async () => {
    expect(certificateTargetProblem("example.com")).toBeNull();
    expect(certificateTargetProblem("example.com:8443")).toBeNull();
    expect(certificateTargetProblem("[2606:4700::1111]:443")).toBeNull();
    for (const bad of ["https://example.com/path", "example.com:0", "example.com:70000", "example.com:http", ""]) {
      expect(certificateTargetProblem(bad)).toBe("Target must be host or host:port");
      expect(await targetProblem("certificate", bad)).toBe("Target must be host or host:port");
    }
    expect(await targetProblem("certificate", "1.1.1.1")).toBeNull();
    expect(await targetProblem("certificate", "1.1.1.1:853")).toBeNull();
  });

  it("refuses private targets unless ALLOW_PRIVATE_TARGETS, like tcp", async () => {
    for (const target of ["127.0.0.1", "localhost:8443", "10.0.0.1:443", "169.254.169.254", "[::1]:443", "db.internal"]) {
      expect(await targetProblem("certificate", target)).toMatch(/private or internal/);
      expect(await targetProblem("tcp", /:\d+$/.test(target) ? target : `${target}:443`)).toMatch(/private or internal/);
    }
    // the check itself refuses before dialling: no connection to the private address is attempted
    const r = await runCheck(check("127.0.0.1:1"));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/private or internal/) });
    expect(r.inconclusive).toBeUndefined();
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    expect(await targetProblem("certificate", "127.0.0.1")).toBeNull();
  });

  it("is inconclusive on Cloudflare Workers, which have no node:tls", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    expect(await runCheck(check("example.com"))).toEqual({ ok: false, inconclusive: true, error: WORKERS_UNSUPPORTED });
    expect(WORKERS_UNSUPPORTED).toBe("Certificate checks need the self-hosted Node runtime");
  });
});

// ---- real handshakes ---------------------------------------------------------------------------------------------------
// Certificates are generated per run with the openssl CLI (the repository never commits keys or certificates: *.pem and
// *.key are ignored). `openssl ca` sets explicit validity dates on every OpenSSL version, unlike `x509 -not_after`.

type Pki = { ca: string; key: string; leaf(name: string, san: string, from: Date, to: Date): string; selfSigned(): string };

function makePki(): Pki {
  const dir = mkdtempSync(join(tmpdir(), "montral-cert-"));
  const p = (f: string) => join(dir, f).replace(/\\/g, "/");
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl("req", "-x509", ...ec, "-subj", "/CN=Montral Test CA", "-days", "2", "-keyout", p("ca.key"), "-out", p("ca.pem"));
  openssl("req", "-new", ...ec, "-subj", "/CN=localhost", "-keyout", p("leaf.key"), "-out", p("leaf.csr"));
  writeFileSync(p("index.txt"), "");
  writeFileSync(p("serial"), "1000\n");
  writeFileSync(p("ca.cnf"), `[ca]\ndefault_ca = test\n[test]\ndatabase = ${p("index.txt")}\nnew_certs_dir = ${p("")}\nserial = ${p("serial")}\ndefault_md = sha256\npolicy = any\nunique_subject = no\n[any]\ncommonName = supplied\n`);
  const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  let n = 0;
  return {
    ca: readFileSync(p("ca.pem"), "utf8"),
    key: readFileSync(p("leaf.key"), "utf8"),
    leaf(name, san, from, to) {
      writeFileSync(p(`${name}.cnf`), `subjectAltName = ${san}\nbasicConstraints = CA:FALSE\n`);
      openssl("ca", "-batch", "-notext", "-config", p("ca.cnf"), "-cert", p("ca.pem"), "-keyfile", p("ca.key"), "-in", p("leaf.csr"), "-out", p(`${name}-${n}.pem`), "-startdate", stamp(from), "-enddate", stamp(to), "-extfile", p(`${name}.cnf`));
      return readFileSync(p(`${name}-${n++}.pem`), "utf8");
    },
    selfSigned() {
      openssl("req", "-x509", "-key", p("leaf.key"), "-subj", "/CN=localhost", "-addext", "subjectAltName = DNS:localhost", "-days", "2", "-out", p("self.pem"));
      return readFileSync(p("self.pem"), "utf8");
    },
  };
}

describe("certificate checks over TLS", () => {
  let pki: Pki | null = null;
  const servers: TcpServer[] = [];
  const sockets = new Set<Socket>();
  /** Listens on loopback; every accepted socket is destroyed after the suite, so closing cannot wait on a held one. */
  const listen = async (server: TcpServer) => {
    server.on("connection", (s: Socket) => { sockets.add(s); s.on("error", () => {}); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return (server.address() as AddressInfo).port;
  };
  const serve = (cert: string) => {
    const server = createTlsServer({ key: pki!.key, cert, ALPNProtocols: ["http/1.1"] }, (socket) => socket.end());
    // a client that refuses the certificate aborts the handshake: that is not a server error worth failing on
    server.on("tlsClientError", () => {});
    return listen(server);
  };
  const days = (n: number) => new Date(Date.now() + n * DAY);

  beforeAll(() => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    try { pki = makePki(); } catch { pki = null; }
  });
  afterAll(async () => {
    configureNetGuard({});
    for (const s of sockets) s.destroy();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  it("passes a trusted certificate for the host with time to spare", async (ctx) => {
    if (!pki) ctx.skip();
    const port = await serve(pki!.leaf("valid", "DNS:localhost", days(-1), days(400)));
    const r = await certificateCheck(check(`localhost:${port}`), Date.now(), [pki!.ca]);
    expect(r).toMatchObject({ ok: true, latencyMs: expect.any(Number) });
    expect(r.error).toBeUndefined();
  });

  it("fails a trusted certificate inside the warning window, naming the days, date and issuer", async (ctx) => {
    if (!pki) ctx.skip();
    const to = days(10);
    const port = await serve(pki!.leaf("soon", "DNS:localhost", days(-1), to));
    const r = await certificateCheck(check(`localhost:${port}`, { domainExpiryWarnDays: 30 }), Date.now(), [pki!.ca]);
    expect(r).toMatchObject({ ok: false, error: `Certificate for localhost expires in 10 days (${to.toISOString().slice(0, 10)}, issued by Montral Test CA)` });
    expect((await certificateCheck(check(`localhost:${port}`, { domainExpiryWarnDays: 9 }), Date.now(), [pki!.ca])).ok).toBe(true);
  });

  it("fails an expired certificate", async (ctx) => {
    if (!pki) ctx.skip();
    const port = await serve(pki!.leaf("expired", "DNS:localhost", days(-60), days(-30)));
    expect(await certificateCheck(check(`localhost:${port}`), Date.now(), [pki!.ca])).toMatchObject({ ok: false, error: "Certificate for localhost has expired" });
  });

  it("fails a certificate that is not valid yet", async (ctx) => {
    if (!pki) ctx.skip();
    const port = await serve(pki!.leaf("future", "DNS:localhost", days(30), days(400)));
    expect(await certificateCheck(check(`localhost:${port}`), Date.now(), [pki!.ca])).toMatchObject({ ok: false, error: "Certificate for localhost is not valid yet" });
  });

  it("fails a certificate for another hostname", async (ctx) => {
    if (!pki) ctx.skip();
    const port = await serve(pki!.leaf("other", "DNS:other.example", days(-1), days(400)));
    expect(await certificateCheck(check(`localhost:${port}`), Date.now(), [pki!.ca])).toMatchObject({ ok: false, error: "Certificate for localhost does not match the hostname" });
  });

  it("checks an IP literal target against the certificate's IP address, without SNI", async (ctx) => {
    if (!pki) ctx.skip();
    const port = await serve(pki!.leaf("ip", "IP:127.0.0.1", days(-1), days(400)));
    expect(await certificateCheck(check(`127.0.0.1:${port}`), Date.now(), [pki!.ca])).toMatchObject({ ok: true });
  });

  it("fails self-signed and untrusted chains against the runtime's own roots", async (ctx) => {
    if (!pki) ctx.skip();
    const self = await serve(pki!.selfSigned());
    expect(await runCheck(check(`localhost:${self}`))).toMatchObject({ ok: false, error: "Certificate for localhost is self-signed and not trusted" });
    // signed by a CA nobody trusts, and the server sends no chain
    const untrusted = await serve(pki!.leaf("untrusted", "DNS:localhost", days(-1), days(400)));
    const r = await runCheck(check(`localhost:${untrusted}`));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^Certificate for localhost cannot be verified/) });
    expect(r.inconclusive).toBeUndefined();
  });

  it("reports a port that does not speak TLS as a failed handshake", async () => {
    const port = await listen(createTcpServer((s) => s.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")));
    const r = await runCheck(check(`localhost:${port}`));
    expect(r).toMatchObject({ ok: false, error: "TLS handshake with localhost failed" });
  });

  it("leaves a refused connection to the network-failure logic: a failure, not a certificate verdict", async () => {
    const r = await runCheck(check("127.0.0.1:1", { timeoutMs: 2000 }));
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/^Certificate|^TLS handshake/);
    // a private target says nothing about the prober's own connectivity
    expect(r.inconclusive).toBeUndefined();
  });

  it("times out a server that never finishes the handshake", async () => {
    const port = await listen(createTcpServer(() => {}));
    const started = Date.now();
    const r = await runCheck(check(`127.0.0.1:${port}`, { timeoutMs: 1000 }));
    expect(r).toMatchObject({ ok: false, error: "Connection timed out" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
