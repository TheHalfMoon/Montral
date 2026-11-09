import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWK, type JWTPayload } from "jose";
import { BlockedTarget, guardedFetch, readCapped } from "./netguard";

/**
 * The OpenID Connect relying party: discovery, the authorization request (code flow with PKCE S256, state and nonce),
 * the token request and id_token validation. Signatures are checked by `jose` against the provider's JWKS; nothing
 * here parses or verifies JWT cryptography by hand.
 *
 * Every request to the identity provider (discovery, JWKS, token endpoint) is a server-side fetch to an address an
 * owner typed in, so it goes through the SSRF guard: public addresses only, connections pinned to the validated
 * addresses, no redirects, a deadline and a byte cap on the response. SSO_ALLOW_PRIVATE_IDP=true allows an identity
 * provider on a private network (and plain http) for self-hosters; ALLOW_PRIVATE_TARGETS (monitors) does not.
 *
 * Runtime-neutral: works on Node and Workers.
 */

/** Asymmetric signature algorithms accepted for id_tokens. Never `none`, never HMAC (a public key is not a secret). */
export const ID_TOKEN_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;
const KTY_OF: Record<string, string> = { RS: "RSA", PS: "RSA", ES: "EC", Ed: "OKP" };

export type SsoOptions = {
  allowPrivate: boolean;
  /** deadline of one request to the identity provider, headers and body together */
  timeoutMs: number;
  /** largest discovery document, JWKS or token response accepted */
  maxBytes: number;
  /** how long discovery documents and key sets are reused */
  cacheMs: number;
  /** an unknown key id refetches the JWKS (key rotation), at most once per this interval per provider */
  jwksCooldownMs: number;
  /** clock skew tolerated on exp, nbf and iat */
  clockSkewSec: number;
  /** an id_token issued longer ago than this is refused, whatever its exp */
  maxIdTokenAgeSec: number;
};
const DEFAULTS: SsoOptions = { allowPrivate: false, timeoutMs: 8000, maxBytes: 64 * 1024, cacheMs: 10 * 60_000, jwksCooldownMs: 30_000, clockSkewSec: 60, maxIdTokenAgeSec: 600 };
let options: SsoOptions = { ...DEFAULTS };

/** Env values are constant per deployment, so module-level configuration is safe (as in netguard.ts). */
export function configureSso(env: { SSO_ALLOW_PRIVATE_IDP?: string }) {
  options.allowPrivate = env.SSO_ALLOW_PRIVATE_IDP === "true";
}
/** Tests only: tighter deadlines, a shorter cooldown. `null` restores the defaults and clears the caches. */
export function setSsoOptionsForTests(o: Partial<SsoOptions> | null) {
  options = o ? { ...options, ...o } : { ...DEFAULTS };
  discoveryCache.clear();
  jwksCache.clear();
}
export const ssoPrivateAllowed = () => options.allowPrivate;

export type SsoErrorCode =
  | "invalid_issuer" | "blocked_target" | "idp_unreachable" | "timeout" | "response_too_large" | "invalid_response"
  | "discovery_failed" | "token_exchange_failed" | "invalid_id_token";

/** A failure with a fixed, non-secret message: safe to show the owner and to log. Never carries tokens or secrets. */
export class SsoError extends Error {
  constructor(readonly code: SsoErrorCode, message: string) {
    super(message);
    this.name = "SsoError";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** 32 random bytes, base64url: state, nonce, PKCE verifier and browser binding. */
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const sha256b64url = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
/** Constant-time comparison of two strings (lengths may differ). */
export function sameString(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** An identity provider URL Montral may contact or send a browser to: https (http only with the private opt-in), no credentials or fragment. */
export function idpUrl(raw: unknown, what: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new SsoError("invalid_issuer", `${what} is not a valid URL`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && options.allowPrivate)) throw new SsoError("invalid_issuer", `${what} must use https://`);
  if (u.username || u.password) throw new SsoError("invalid_issuer", `${what} must not contain credentials`);
  if (u.hash) throw new SsoError("invalid_issuer", `${what} must not contain a fragment`);
  return u;
}

/** The issuer as the owner typed it (trimmed), once it is a usable identifier: compared byte for byte with the provider's. */
export function normalizeIssuer(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length < 8 || s.length > 500) throw new SsoError("invalid_issuer", "Issuer URL must be 8 to 500 characters");
  const u = idpUrl(s, "Issuer URL");
  if (u.search) throw new SsoError("invalid_issuer", "Issuer URL must not contain a query");
  return s;
}

/** GET or POST to the identity provider: SSRF-guarded, no redirects, bounded in time and size; returns the JSON object. */
async function idpJson(url: string, what: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  idpUrl(url, what);
  const signal = AbortSignal.timeout(options.timeoutMs);
  const req: RequestInit = { method: init.method ?? "GET", headers: { accept: "application/json", ...init.headers }, body: init.body, signal };
  let res: Response;
  try {
    res = options.allowPrivate ? await fetch(url, { ...req, redirect: "manual" }) : (await guardedFetch(url, req, { follow: false, publicOnly: true })).res;
  } catch (e) {
    if (e instanceof BlockedTarget) throw new SsoError("blocked_target", `${what}: private or internal addresses are refused. Set SSO_ALLOW_PRIVATE_IDP=true for an identity provider on your own network.`);
    if (signal.aborted) throw new SsoError("timeout", `${what} did not answer in time`);
    throw new SsoError("idp_unreachable", `${what} could not be reached`);
  }
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel().catch(() => {});
    throw new SsoError("invalid_response", `${what} answered with a redirect; enter the final URL`);
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    void res.body?.cancel().catch(() => {});
    throw new SsoError("response_too_large", `${what} answered with more than ${options.maxBytes} bytes`);
  }
  let text: string;
  try {
    text = await readCapped(res, options.maxBytes + 1, signal);
  } catch {
    throw new SsoError(signal.aborted ? "timeout" : "idp_unreachable", signal.aborted ? `${what} did not answer in time` : `${what} could not be read`);
  }
  if (enc.encode(text).length > options.maxBytes) throw new SsoError("response_too_large", `${what} answered with more than ${options.maxBytes} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SsoError("invalid_response", `${what} did not answer with JSON`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SsoError("invalid_response", `${what} did not answer with a JSON object`);
  return { status: res.status, body: body as Record<string, unknown> };
}

// ── discovery ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Discovery = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint: string | null;
  /** id_token algorithms both sides accept */
  algorithms: string[];
  tokenAuth: "client_secret_basic" | "client_secret_post";
};

const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const jwksCache = new Map<string, { at: number; value: JSONWebKeySet }>();
const CACHE_LIMIT = 200;
const remember = <T,>(cache: Map<string, { at: number; value: T }>, key: string, value: T) => {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { at: Date.now(), value });
};

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

/** Reads and checks `<issuer>/.well-known/openid-configuration` (OpenID Connect Discovery 1.0). */
export async function discover(issuerRaw: string, { fresh = false }: { fresh?: boolean } = {}): Promise<Discovery> {
  const issuer = normalizeIssuer(issuerRaw);
  const hit = discoveryCache.get(issuer);
  if (!fresh && hit && Date.now() - hit.at < options.cacheMs) return hit.value;
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const { status, body: d } = await idpJson(url, "Discovery document");
  if (status !== 200) throw new SsoError("discovery_failed", `Discovery document answered HTTP ${status}`);
  // §4.3: the issuer in the document must be exactly the one configured, or tokens could claim any issuer
  if (d.issuer !== issuer) throw new SsoError("discovery_failed", typeof d.issuer === "string" && d.issuer.replace(/\/+$/, "") === issuer.replace(/\/+$/, "") ? `Issuer must be entered exactly as the provider names it: ${d.issuer.slice(0, 200)}` : "The discovery document names a different issuer");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof d[k] !== "string") throw new SsoError("discovery_failed", `The discovery document has no ${k}`);
    idpUrl(d[k], k);
  }
  const responseTypes = strings(d.response_types_supported);
  if (responseTypes && !responseTypes.some((t) => t.split(" ").includes("code"))) throw new SsoError("discovery_failed", "The provider does not support the authorization code flow");
  const pkce = strings(d.code_challenge_methods_supported);
  if (pkce && !pkce.includes("S256")) throw new SsoError("discovery_failed", "The provider does not support PKCE with S256");
  // the spec's default is RS256 when the provider lists nothing
  const offered = strings(d.id_token_signing_alg_values_supported) ?? ["RS256"];
  const algorithms = ID_TOKEN_ALGS.filter((a) => offered.includes(a));
  if (!algorithms.length) throw new SsoError("discovery_failed", "The provider signs id_tokens with no algorithm Montral accepts (asymmetric only: RS, PS, ES or EdDSA)");
  const auth = strings(d.token_endpoint_auth_methods_supported);
  const tokenAuth = !auth || auth.includes("client_secret_basic") ? "client_secret_basic" : auth.includes("client_secret_post") ? "client_secret_post" : null;
  if (!tokenAuth) throw new SsoError("discovery_failed", "The provider supports neither client_secret_basic nor client_secret_post");
  let endSessionEndpoint: string | null = null;
  if (typeof d.end_session_endpoint === "string") {
    try { endSessionEndpoint = idpUrl(d.end_session_endpoint, "end_session_endpoint").toString(); } catch { /* optional: ignored when unusable */ }
  }
  const value: Discovery = {
    issuer,
    authorizationEndpoint: d.authorization_endpoint as string,
    tokenEndpoint: d.token_endpoint as string,
    jwksUri: d.jwks_uri as string,
    endSessionEndpoint,
    algorithms,
    tokenAuth,
  };
  remember(discoveryCache, issuer, value);
  return value;
}

// ── keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];

/** Public signing keys only: RSA, EC and OKP, `use` absent or "sig", no private or symmetric key material. */
export function publicSigningKeys(raw: unknown): JSONWebKeySet {
  const keys = Array.isArray((raw as { keys?: unknown } | null)?.keys) ? ((raw as { keys: unknown[] }).keys) : [];
  const out: JWK[] = [];
  for (const k of keys.slice(0, 50)) {
    if (!k || typeof k !== "object") continue;
    const jwk = k as JWK;
    if (!["RSA", "EC", "OKP"].includes(String(jwk.kty))) continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (PRIVATE_MEMBERS.some((m) => m in jwk)) continue;
    out.push(jwk);
  }
  return { keys: out };
}

async function keySet(jwksUri: string, refresh: boolean): Promise<JSONWebKeySet> {
  const hit = jwksCache.get(jwksUri);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (refresh ? age < options.jwksCooldownMs : age < options.cacheMs)) return hit.value;
  const { status, body } = await idpJson(jwksUri, "JWKS");
  if (status !== 200) throw new SsoError("invalid_id_token", `JWKS answered HTTP ${status}`);
  const value = publicSigningKeys(body);
  remember(jwksCache, jwksUri, value);
  return value;
}

const hasKeyFor = (set: JSONWebKeySet, alg: string, kid: string | undefined) =>
  set.keys.some((k) => k.kty === KTY_OF[alg.slice(0, 2)] && (kid === undefined || k.kid === kid) && (k.alg === undefined || k.alg === alg));

// ── tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The URL the browser is sent to: authorization code flow with PKCE (S256), state and nonce. */
export function authorizationUrl(d: Discovery, p: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string; loginHint?: string | null }): string {
  const u = new URL(d.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.loginHint) u.searchParams.set("login_hint", p.loginHint);
  return u.toString();
}

/** application/x-www-form-urlencoded, as RFC 6749 §2.3.1 asks for the client id and secret in HTTP Basic. */
const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

/** Exchanges the authorization code (with the PKCE verifier) for tokens; returns the id_token. Tokens are not stored. */
export async function exchangeCode(d: Discovery, p: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string }): Promise<string> {
  const form = new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (d.tokenAuth === "client_secret_basic") headers.authorization = `Basic ${btoa(`${formEncode(p.clientId)}:${formEncode(p.clientSecret)}`)}`;
  else {
    form.set("client_id", p.clientId);
    form.set("client_secret", p.clientSecret);
  }
  const { status, body } = await idpJson(d.tokenEndpoint, "Token endpoint", { method: "POST", headers, body: form.toString() });
  if (status !== 200) {
    // only a short OAuth error code is repeated; descriptions are free text from the provider
    const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? ` (${body.error})` : "";
    throw new SsoError("token_exchange_failed", `Token endpoint answered HTTP ${status}${code}`);
  }
  if (typeof body.id_token !== "string") throw new SsoError("token_exchange_failed", "Token endpoint returned no id_token");
  return body.id_token;
}

export type VerifiedIdentity = { issuer: string; subject: string; email: string | null; emailVerified: boolean; name: string | null };

/**
 * Validates an id_token (OpenID Connect Core §3.1.3.7): signature by a key from the provider's JWKS (refetched once on
 * an unknown key id, for rotation) with an allow-listed asymmetric algorithm; iss, aud, azp, exp, nbf and iat (with a
 * small skew, and no older than maxIdTokenAgeSec); and the nonce of this sign-in.
 */
export async function verifyIdToken(token: string, p: { discovery: Discovery; clientId: string; nonce: string; now?: Date }): Promise<VerifiedIdentity> {
  const bad = (why: string) => new SsoError("invalid_id_token", `The id_token was refused: ${why}`);
  if (typeof token !== "string" || token.length > 16_384) throw bad("malformed");
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token) as { alg?: string; kid?: string };
  } catch {
    throw bad("malformed");
  }
  const alg = header.alg;
  if (!alg || !p.discovery.algorithms.includes(alg)) throw bad("signature algorithm not allowed");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  let keys = await keySet(p.discovery.jwksUri, false);
  if (!hasKeyFor(keys, alg, kid)) keys = await keySet(p.discovery.jwksUri, true);
  if (!hasKeyFor(keys, alg, kid)) throw bad("unknown signing key");
  const now = p.now ?? new Date();
  let payload: JWTPayload | undefined;
  // a key set may hold several keys that fit (no kid in the header): each is tried on its own, never more than ten
  const candidates = keys.keys.filter((k) => hasKeyFor({ keys: [k] }, alg, kid)).slice(0, 10);
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      ({ payload } = await jwtVerify(token, createLocalJWKSet({ keys: [candidate] }), {
        issuer: p.discovery.issuer,
        audience: p.clientId,
        algorithms: p.discovery.algorithms,
        clockTolerance: options.clockSkewSec,
        maxTokenAge: options.maxIdTokenAgeSec,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        currentDate: now,
      }));
      break;
    } catch (e) {
      failure = e;
    }
  }
  if (!payload) {
    const e = failure;
    const code = (e as { code?: string }).code;
    const reasons: Record<string, string> = {
      ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "bad signature",
      ERR_JWT_EXPIRED: "expired",
      ERR_JWT_CLAIM_VALIDATION_FAILED: "claim check failed",
      ERR_JWKS_NO_MATCHING_KEY: "unknown signing key",
      ERR_JOSE_ALG_NOT_ALLOWED: "signature algorithm not allowed",
    };
    const claim = (e as { claim?: string }).claim;
    throw bad(code && reasons[code] ? `${reasons[code]}${claim && /^[a-z_]{1,20}$/.test(claim) ? ` (${claim})` : ""}` : "invalid");
  }
  const nowSec = Math.floor(now.getTime() / 1000);
  // jose bounds the age; a token "issued" in the future is refused here too
  if (typeof payload.iat !== "number" || payload.iat > nowSec + options.clockSkewSec) throw bad("issued in the future (iat)");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud.length > 1 && payload.azp === undefined) throw bad("several audiences and no authorized party (azp)");
  if (payload.azp !== undefined && payload.azp !== p.clientId) throw bad("issued to another client (azp)");
  if (typeof payload.nonce !== "string" || !sameString(payload.nonce, p.nonce)) throw bad("nonce does not match this sign-in");
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) throw bad("missing subject");
  const rawEmail = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const email = rawEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 100) : null;
  return { issuer: p.discovery.issuer, subject: payload.sub, email, emailVerified: payload.email_verified === true, name };
}

/** The lowercase domain of an email address. */
export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
