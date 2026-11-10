/**
 * The channel between the app and the browser-runner service (browser-runner.ts).
 *
 * The runner holds no database credentials and no app secrets; it only knows BROWSER_RUNNER_TOKEN, a dedicated shared
 * token (at least 32 characters) that both sides use for HMAC-SHA256:
 *
 *   request  header x-montral-runner: t=<unix ms>,n=<32 hex nonce>,s=<hex HMAC over "v1\n<method>\n<path>\n<t>\n<n>\n<sha256(body)>">
 *   response header x-montral-runner: s=<hex HMAC over "v1-response\n<n>\n<status>\n<sha256(body)>">
 *
 * The runner accepts a request only with a valid signature, a timestamp within MAX_SKEW_MS of its clock and a nonce it
 * has not seen in the last 2 * MAX_SKEW_MS (replay protection), with a body of at most MAX_REQUEST_BYTES. The app accepts
 * a response only with a valid signature bound to its own nonce, and reads at most MAX_RESPONSE_BYTES. The comparison is
 * constant time. A job carries one run's journey and the secrets that run needs, already decrypted, and nothing else.
 */
import type { WorkerJob } from "./browser-worker";
import type { WorkerRun } from "./browser-check";

export const RUNNER_HEADER = "x-montral-runner";
export const MAX_SKEW_MS = 60_000;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MIN_TOKEN_LENGTH = 32;
export const RUNNER_PORT = 8090;

export type RunRequest = { job: WorkerJob; hardTimeoutMs: number; maxRssMb: number; /** the job's secrets, sealed (sealSecrets) */ sealedSecrets?: string };
export type RunResponse = { run: WorkerRun } | { busy: true };
export type ProbeResponse = { ok: boolean };

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (body: string | Uint8Array) => hex(await crypto.subtle.digest("SHA-256", typeof body === "string" ? enc.encode(body) : Uint8Array.from(body)));

async function hmac(token: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

/** Constant-time comparison of two hex strings. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const requestText = (method: string, path: string, t: number, n: string, bodyHash: string) => `v1\n${method.toUpperCase()}\n${path}\n${t}\n${n}\n${bodyHash}`;
const responseText = (n: string, status: number, bodyHash: string) => `v1-response\n${n}\n${status}\n${bodyHash}`;

export async function signRequest(token: string, method: string, path: string, body: string, now = Date.now()): Promise<{ header: string; nonce: string }> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const s = await hmac(token, requestText(method, path, now, nonce, await sha256Hex(body)));
  return { header: `t=${now},n=${nonce},s=${s}`, nonce };
}

export const parseHeader = (h: string | null | undefined): Record<string, string> =>
  Object.fromEntries((h ?? "").split(",").map((p) => p.trim().split("=")).filter((kv) => kv.length === 2 && kv[0] && kv[1]).map(([k, v]) => [k, v]));

export type Verdict = { ok: true; nonce: string } | { ok: false; why: "missing" | "skew" | "signature" | "replay" };

/** Nonces seen recently; bounded (oldest dropped first), entries expire after 2 * MAX_SKEW_MS. */
export function nonceCache(max = 20_000) {
  const seen = new Map<string, number>();
  return {
    /** false when the nonce was already used */
    use(nonce: string, now = Date.now()): boolean {
      for (const [k, at] of seen) { if (now - at > 2 * MAX_SKEW_MS && seen.size > 0) seen.delete(k); else break; }
      if (seen.has(nonce)) return false;
      if (seen.size >= max) seen.delete(seen.keys().next().value!);
      seen.set(nonce, now);
      return true;
    },
    size: () => seen.size,
  };
}

export async function verifyRequest(token: string, method: string, path: string, body: string, header: string | null | undefined, nonces: ReturnType<typeof nonceCache>, now = Date.now()): Promise<Verdict> {
  const h = parseHeader(header);
  const t = Number(h.t);
  if (!h.t || !h.n || !h.s || !/^[0-9a-f]{32}$/.test(h.n) || !/^[0-9a-f]{64}$/.test(h.s) || !Number.isSafeInteger(t)) return { ok: false, why: "missing" };
  if (Math.abs(now - t) > MAX_SKEW_MS) return { ok: false, why: "skew" };
  const want = await hmac(token, requestText(method, path, t, h.n, await sha256Hex(body)));
  if (!sameHex(want, h.s)) return { ok: false, why: "signature" };
  // only a correctly signed request may use up a nonce
  if (!nonces.use(h.n, now)) return { ok: false, why: "replay" };
  return { ok: true, nonce: h.n };
}

/**
 * The secrets of a job travel encrypted (AES-256-GCM, key from HKDF-SHA-256 over the runner token with its own salt and
 * info), so they are not readable on the internal network even though the rest of the job is only signed. The other job
 * fields (journey, limits) are signed but in clear text; the jobs network is internal-only.
 */
const SEAL_INFO = enc.encode("montral:browser-runner:sealed-secrets:v1");
async function sealKey(token: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(token), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("montral-runner-seal"), info: SEAL_INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sealSecrets(token: string, secrets: Record<string, string>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SEAL_INFO }, await sealKey(token), enc.encode(JSON.stringify(secrets))));
  return `${b64(iv)}.${b64(ct)}`;
}

/** The secrets, or null when they cannot be opened (another token, tampered, not an object of strings). */
export async function openSecrets(token: string, sealed: unknown): Promise<Record<string, string> | null> {
  if (typeof sealed !== "string") return null;
  const m = /^([A-Za-z0-9+/=]{16})\.([A-Za-z0-9+/=]{24,})$/.exec(sealed);
  if (!m) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(m[1]), additionalData: SEAL_INFO }, await sealKey(token), unb64(m[2]));
    const v: unknown = JSON.parse(new TextDecoder().decode(pt));
    if (!v || typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string")) return null;
    return v as Record<string, string>;
  } catch {
    return null;
  }
}

export const signResponse = async (token: string, nonce: string, status: number, body: string) => `s=${await hmac(token, responseText(nonce, status, await sha256Hex(body)))}`;

export async function verifyResponse(token: string, nonce: string, status: number, body: string, header: string | null | undefined): Promise<boolean> {
  const s = parseHeader(header).s ?? "";
  return /^[0-9a-f]{64}$/.test(s) && sameHex(await hmac(token, responseText(nonce, status, await sha256Hex(body))), s);
}

/** Reads a response body up to `max` bytes; null when it is larger. */
async function boundedText(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { void reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

export class RunnerError extends Error {
  constructor(readonly why: "unreachable" | "rejected" | "unsigned" | "too_large" | "bad_response") { super(`browser runner ${why}`); }
}

/** One signed call to the runner. Throws RunnerError; never includes the job or the response in the error. */
export async function callRunner<T>(baseUrl: string, token: string, path: "/v1/run" | "/v1/probe", payload: unknown, timeoutMs: number): Promise<{ status: number; body: T }> {
  const body = JSON.stringify(payload);
  if (enc.encode(body).byteLength > MAX_REQUEST_BYTES) throw new RunnerError("too_large");
  const { header, nonce } = await signRequest(token, "POST", path, body);
  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), { method: "POST", body, headers: { "content-type": "application/json", [RUNNER_HEADER]: header }, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  } catch {
    throw new RunnerError("unreachable");
  }
  const text = await boundedText(res, MAX_RESPONSE_BYTES);
  if (text === null) throw new RunnerError("too_large");
  if (!(await verifyResponse(token, nonce, res.status, text, res.headers.get(RUNNER_HEADER)))) throw new RunnerError("unsigned");
  if (res.status === 401) throw new RunnerError("rejected");
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch {
    throw new RunnerError("bad_response");
  }
}
