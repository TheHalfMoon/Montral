import type { Repo } from "@montral/repo";
import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env";

const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const proxied = (env: Pick<Bindings, "TRUST_PROXY"> | undefined) => ["true", "1"].includes(String(env?.TRUST_PROXY ?? "").trim().toLowerCase());

/** Canonical validated IP for shared quota keys. Never let different textual
 * IPv6 spellings divide one network peer into multiple rate-limit buckets.
 * Ambiguous IPv4 leading-zero octets are refused, not interpreted as octal.
 * Works on Node and Workers without importing a platform-specific net API. */
function canonicalIp(raw: string | null | undefined): string | null {
  const ip = raw?.trim();
  if (!ip || ip.length > 64) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".");
    return parts.every((p) => /^(?:0|[1-9]\d*)$/.test(p) && Number(p) <= 255)
      ? parts.map(Number).join(".") : null;
  }
  if (!ip.includes(":") || !/^[0-9a-f:.]+$/i.test(ip)) return null;
  try {
    // The URL parser fully validates and compresses IPv6. A normalized
    // bracketed hostname can be used as an unambiguous string quota key.
    return new URL("http://[" + ip + "]/").hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * The caller's canonical address, or null when it cannot be told. Cloudflare
 * controls `cf-connecting-ip` at the edge. Node must never trust that header.
 * Node accepts only the final XFF value from one trusted proxy configured to
 * append the actual socket peer; production must also block direct ingress.
 */
export function clientIp(c: Context, env?: Pick<Bindings, "TRUST_PROXY">): string | null {
  return clientIpFromHeaders((name) => c.req.header(name), env ?? (c.env as Bindings | undefined));
}

/** clientIp for code that has the request headers but no Hono context (Better Auth hooks); same trust rules. */
export function clientIpFromHeaders(header: (name: string) => string | null | undefined, env: Pick<Bindings, "TRUST_PROXY"> | undefined): string | null {
  if (onWorkers) return canonicalIp(header("cf-connecting-ip"));
  if (!proxied(env)) return null;
  // A client can prepend spoofed XFF entries; the trusted final hop is the
  // only entry used as the quota identity.
  const forwarded = header("x-forwarded-for")?.split(",");
  return canonicalIp(forwarded?.at(-1));
}

/** Counts one attempt under `key`; false once more than `limit` happened within `windowSec`. */
export const allow = (repo: Repo, key: string, limit: number, windowSec: number) => repo.withinLimit(key, limit, windowSec);

/** Constant-time string comparison (shared secrets). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type { AppEnv };
