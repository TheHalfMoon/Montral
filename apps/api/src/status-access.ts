import type { Database, StatusPage } from "@montral/repo";
import type { Context } from "hono";
import type { AppEnv } from "./env";
import { cookieValue } from "./middleware";

/**
 * Access to non-public status pages for people outside the workspace: a page password, or a revocable share link.
 * Either one ends in the same signed, HttpOnly cookie, bound to the page, its access version and an expiry; a share
 * link's cookie also names the link, which is rechecked on every request so revoking it takes effect at once.
 */

/** Workers' WebCrypto caps PBKDF2 at 100k iterations; Node accepts the same, so one value serves both runtimes. */
const PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_ACCESS_HOURS = 12;
export const SHARE_LINK_MAX_HOURS = 24 * 365;
export const SHARE_LINK_DEFAULT_HOURS = 24 * 7;
export const MAX_ACTIVE_SHARE_LINKS = 50;

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, key, 256));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPagePassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

/** A fixed hash to verify against when a page has no password, so a wrong slug costs the same time as a wrong password. */
const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

export async function verifyPagePassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, iter, salt, hash] = (stored ?? DUMMY_HASH).split("$");
  const iterations = Number(iter);
  if (scheme !== "pbkdf2-sha256" || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  let expected: Uint8Array;
  try { expected = fromB64(hash); } catch { return false; }
  const actual = await pbkdf2(password, fromB64(salt), iterations);
  return constantTimeEqual(actual, expected) && stored !== null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A share link's secret: 32 random bytes, hex. Only its SHA-256 is stored. */
export async function newShareToken(): Promise<{ token: string; hash: string }> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  return { token, hash: await sha256Hex(token) };
}

// ── signed access cookie ──────────────────────────────────────────────────────

type Grant = { p: string; v: number; l: string | null; e: number };

const cookieName = (pageId: string) => `montral_sa_${pageId.replace(/-/g, "")}`;

async function signingKey(secret: string): Promise<CryptoKey> {
  // a key of its own, derived from the deployment secret, so these cookies cannot be confused with session cookies
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`montral-status-access-v1:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The Set-Cookie header value that grants access to `page` until `expiresAt` (at most PASSWORD_ACCESS_HOURS from now). */
export async function accessCookie(env: AppEnv["Bindings"], page: StatusPage, linkId: string | null, expiresAt: Date): Promise<string> {
  const e = Math.floor(Math.min(expiresAt.getTime(), Date.now() + PASSWORD_ACCESS_HOURS * 3_600_000) / 1000);
  const payload = b64url(enc.encode(JSON.stringify({ p: page.id, v: page.accessVersion, l: linkId, e } satisfies Grant)));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env.BETTER_AUTH_SECRET), enc.encode(payload))));
  const secure = /^https:/i.test(env.WEB_ORIGIN ?? "") ? "; Secure" : "";
  const maxAge = Math.max(0, e - Math.floor(Date.now() / 1000));
  return `${cookieName(page.id)}=${payload}.${sig}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Whether the request carries a valid grant for `page`: signature, page, access version and expiry must match, a
 * password grant needs a page that is still password-protected, and a link grant needs its link unrevoked and unexpired.
 */
export async function hasAccessGrant(c: Context<AppEnv>, page: StatusPage): Promise<boolean> {
  if (page.visibility === "public") return true;
  const raw = cookieValue(c.req.header("cookie"), cookieName(page.id));
  if (!raw || raw.length > 600) return false;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return false;
  let grant: Grant;
  try {
    const valid = await crypto.subtle.verify("HMAC", await signingKey(c.env.BETTER_AUTH_SECRET), fromB64url(sig), enc.encode(payload));
    if (!valid) return false;
    grant = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Grant;
  } catch { return false; }
  if (grant.p !== page.id || grant.v !== page.accessVersion || !(grant.e * 1000 > Date.now())) return false;
  if (grant.l === null) return page.visibility === "password";
  if (typeof grant.l !== "string") return false;
  const db = c.get("database");
  const rows = await db.query<{ stale: boolean }>(
    "SELECT (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes') AS stale FROM status_page_share_link WHERE id = $1 AND status_page_id = $2 AND revoked_at IS NULL AND expires_at > now()",
    [grant.l, page.id],
  );
  if (rows.length !== 1) return false;
  // "last used" is informational: refresh it at most every few minutes, not on every request of a page view
  if (rows[0].stale) await db.query("UPDATE status_page_share_link SET last_used_at = now() WHERE id = $1", [grant.l]).catch(() => {});
  return true;
}

/** The link a share token belongs to, if it is still usable, with its page. */
export async function redeemShareToken(db: Database, token: string): Promise<{ linkId: string; slug: string; expiresAt: Date } | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const rows = await db.query<{ id: string; slug: string; expires_at: Date }>(
    `SELECT l.id, p.slug, l.expires_at FROM status_page_share_link l JOIN status_page p ON p.id = l.status_page_id
     WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now()`,
    [await sha256Hex(token)],
  );
  const row = rows[0];
  return row ? { linkId: row.id, slug: row.slug, expiresAt: new Date(row.expires_at) } : null;
}
