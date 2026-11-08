/**
 * TLS certificate checks: the certificate a server presents for `host` (or `host:port`, default 443) must verify against
 * the runtime's trusted roots, cover the hostname and stay valid for longer than the expiry warning window
 * (`domainExpiryWarnDays`, shared with domain monitors).
 *
 * Node only. The connection goes to the addresses the guard validated (`dialEach`), with the hostname sent as SNI and
 * used for the identity check, so a name cannot be re-resolved to an internal address between check and dial. Cloudflare
 * Workers have no `node:tls` and no way to read a peer certificate: there the check is inconclusive (nothing recorded),
 * and the API refuses to create such monitors.
 *
 * Failures the server is responsible for (expired, not yet valid, untrusted chain, wrong name, failed handshake) are
 * verdicts with fixed messages: the raw OpenSSL text is never stored. Network failures (refused, unreachable, timed out)
 * are thrown, so the caller can tell a target fault from a prober fault as for every other type.
 */

import type { CheckInput, CheckOutcome } from "./checker";
import { dialEach, isWorkers, strictHostPort } from "./netguard";

export const CERTIFICATE_PORT = 443;
export const WORKERS_UNSUPPORTED = "Certificate checks need the self-hosted Node runtime";

/** What the server-side problem is, by Node / OpenSSL error code; each completes "Certificate for <host> …". */
const PROBLEMS: Record<string, string> = {
  CERT_HAS_EXPIRED: "has expired",
  CERT_NOT_YET_VALID: "is not valid yet",
  DEPTH_ZERO_SELF_SIGNED_CERT: "is self-signed and not trusted",
  SELF_SIGNED_CERT_IN_CHAIN: "chains to an untrusted self-signed root",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "cannot be verified: the chain is incomplete or its issuer is not trusted",
  UNABLE_TO_GET_ISSUER_CERT: "cannot be verified: the issuer certificate is missing",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "cannot be verified: the issuer is not trusted or an intermediate is missing",
  CERT_UNTRUSTED: "is not trusted",
  CERT_REVOKED: "has been revoked",
  CERT_SIGNATURE_FAILURE: "has an invalid signature",
  CERT_CHAIN_TOO_LONG: "has a chain that is too long",
  INVALID_CA: "chains through an invalid CA certificate",
  INVALID_PURPOSE: "is not valid for TLS server authentication",
  ERR_TLS_CERT_ALTNAME_INVALID: "does not match the hostname",
};

/**
 * The fixed message for a TLS-level failure, or null when `e` is not one (a network failure the caller judges instead).
 * Unknown verification codes are named by their code only (an OpenSSL constant, never peer-supplied text).
 */
export function certificateProblem(host: string, e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return null;
  if (PROBLEMS[code]) return `Certificate for ${host} ${PROBLEMS[code]}`;
  if (/^(?:CERT_|UNABLE_TO_|ERR_TLS_CERT_)[A-Z_]+$/.test(code)) return `Certificate for ${host} failed verification (${code})`;
  if (code === "EPROTO" || /^ERR_SSL_[A-Z0-9_]+$/.test(code)) return `TLS handshake with ${host} failed`;
  return null;
}

/** The parts of `getPeerCertificate()` the verdict uses. */
export type PeerCertificate = { valid_from?: string; valid_to?: string; issuer?: Record<string, string | string[] | undefined> };

/** A printable, bounded issuer name (CN, else O): it comes from the peer and ends up in stored check results. */
function issuerName(cert: PeerCertificate): string {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const name = (pick(cert.issuer?.CN) ?? pick(cert.issuer?.O) ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 64);
  return name || "an unnamed issuer";
}

/**
 * The verdict for a certificate that passed verification: ok while more than `warnDays` days are left. Validity dates are
 * re-read here as well, so a clock or library that let an out-of-date certificate through still fails.
 */
export function certificateVerdict(host: string, cert: PeerCertificate, warnDays = 30, now = Date.now()): Pick<CheckOutcome, "ok" | "error"> {
  const to = Date.parse(cert.valid_to ?? ""), from = Date.parse(cert.valid_from ?? "");
  if (!Number.isFinite(to)) return { ok: false, error: `Certificate for ${host} has no readable expiry date` };
  if (Number.isFinite(from) && from > now) return { ok: false, error: `Certificate for ${host} ${PROBLEMS.CERT_NOT_YET_VALID}` };
  const date = new Date(to).toISOString().slice(0, 10);
  if (to <= now) return { ok: false, error: `Certificate for ${host} has expired (${date})` };
  const days = Math.ceil((to - now) / 864e5);
  if (days <= warnDays) return { ok: false, error: `Certificate for ${host} expires in ${days} day${days === 1 ? "" : "s"} (${date}, issued by ${issuerName(cert)})` };
  return { ok: true };
}

/** Why a certificate target is malformed, or null. */
export function certificateTargetProblem(target: string): string | null {
  return strictHostPort(target, CERTIFICATE_PORT) ? null : "Target must be host or host:port";
}

/** Whether `host` is an IP literal: SNI must not carry one (RFC 6066), so the identity check uses the address itself. */
const ipLiteral = (host: string) => host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

type Handshake = { cert: PeerCertificate } | { failure: unknown };

/**
 * `ca` replaces the trusted roots; tests use it to trust their own CA. Monitors never set it: runCheck passes none.
 */
export async function certificateCheck(m: Pick<CheckInput, "target" | "timeoutMs" | "domainExpiryWarnDays">, started = Date.now(), ca?: string[]): Promise<CheckOutcome> {
  if (isWorkers()) return { ok: false, inconclusive: true, error: WORKERS_UNSUPPORTED };
  const hp = strictHostPort(m.target, CERTIFICATE_PORT);
  if (!hp) return { ok: false, error: "Target must be host or host:port" };
  const { hostname, port } = hp;
  const tls = await import("node:tls");
  const until = Date.now() + m.timeoutMs;
  // One address's handshake. A TLS-level failure resolves (the server answered: that is the verdict); a network failure
  // rejects, so the next validated address is tried and the caller can judge whose fault it was.
  const once = (address: string, signal: AbortSignal) => new Promise<Handshake>((resolve, reject) => {
    const s = tls.connect({ host: address, port, servername: ipLiteral(hostname) ? undefined : hostname, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"], ...(ca ? { ca } : {}) }, () => {
      const cert = s.getPeerCertificate();
      s.destroy();
      resolve({ cert: { valid_from: cert.valid_from, valid_to: cert.valid_to, issuer: cert.issuer as PeerCertificate["issuer"] } });
    });
    s.once("error", (e) => { s.destroy(); if (certificateProblem(hostname, e)) resolve({ failure: e }); else reject(e); });
    // the address's slice of the time is over: stop the handshake instead of leaving the socket to linger
    signal.addEventListener("abort", () => { s.destroy(); reject(new Error("Connection timed out")); }, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("Connection timed out")), m.timeoutMs); });
  let result: Handshake;
  try {
    result = await Promise.race([dialEach(hostname, once, until), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if ("failure" in result) return { ok: false, latencyMs, error: certificateProblem(hostname, result.failure)! };
  return { ...certificateVerdict(hostname, result.cert, m.domainExpiryWarnDays), latencyMs };
}

/** What an incident about a failing certificate monitor is called, from the check's error: an expiring certificate, a
 * rejected certificate or handshake, or a server that could not be reached at all (which says nothing about the cert). */
export function certificateIncidentTitle(name: string, reason: string | undefined): string {
  if (reason && / expires in \d+ days? \(/.test(reason)) return `${name}: certificate expires soon`;
  if (reason && /^(?:Certificate for |TLS handshake with )/.test(reason)) return `${name}: certificate invalid`;
  return `${name}: unreachable`;
}
