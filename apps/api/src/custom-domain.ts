import { ttlCache } from "./ttlcache";

/**
 * Custom domains for status pages (self-hosted Node only). A manager names a hostname; Montral hands out a TXT value
 * that must appear at `_montral-challenge.<domain>`; once DNS shows it the domain is verified, and the Node server
 * (server.ts) serves only that page, its feeds and its public API on that host. Montral never issues certificates:
 * the operator's reverse proxy terminates TLS and forwards the original Host.
 *
 * Everything here is runtime-neutral (no node: imports at module load) so the management routes can share it with
 * Workers, where setting a domain is refused instead.
 */

export const CHALLENGE_PREFIX = "_montral-challenge";
export const CUSTOM_DOMAIN_TTL_MS = 60_000;

/** The DNS name that must carry the verification TXT record. */
export const challengeName = (domain: string) => `${CHALLENGE_PREFIX}.${domain}`;

/** A fresh verification value: not a secret (it is published in DNS), only unguessable so a claim cannot be pre-seeded. */
export function newDomainToken(): string {
  return `montral-verify=${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Lowercase hostnames of the app itself (WEB_ORIGIN, BETTER_AUTH_URL): never claimable, never rerouted. */
export function appHosts(env: { WEB_ORIGIN?: string; BETTER_AUTH_URL?: string }): Set<string> {
  const out = new Set<string>();
  for (const v of [env.WEB_ORIGIN, env.BETTER_AUTH_URL]) {
    try { if (v) out.add(new URL(v).hostname.toLowerCase().replace(/\.$/, "")); } catch {}
  }
  return out;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates a status page domain: a lowercase fully qualified hostname of at least two labels, at most 253 characters,
 * with no scheme, port, path, userinfo, wildcard, IP literal or trailing dot, that is not one of the app's own hosts.
 * Input is trimmed and lowercased first; anything else is refused rather than repaired.
 */
export function statusPageDomain(value: unknown, ownHosts: Set<string> = new Set()): { domain: string } | { error: string } {
  if (typeof value !== "string") return { error: "Enter a hostname such as status.example.com" };
  const domain = value.trim().toLowerCase();
  if (!domain || domain.length > 253) return { error: "Enter a hostname of at most 253 characters" };
  if (/[^a-z0-9.-]/.test(domain)) return { error: "Use a bare hostname: no scheme, port, path, wildcard or spaces" };
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { error: "Enter a fully qualified hostname such as status.example.com" };
  // an all-numeric last label is an IPv4 literal (or a misspelling of one), never a public name
  if (/^\d+$/.test(labels[labels.length - 1])) return { error: "IP addresses cannot be used; enter a hostname" };
  if (labels[labels.length - 1] === "localhost") return { error: "That hostname cannot be used" };
  if (ownHosts.has(domain)) return { error: "That is this Montral instance's own address" };
  return { domain };
}

/** TXT lookup: each record is a list of character strings (as node:dns returns them). */
export type TxtResolver = (name: string) => Promise<string[][]>;

let txtResolver: TxtResolver | undefined;
/** Tests swap DNS out; undefined restores the system resolver. */
export function setTxtResolver(resolver: TxtResolver | undefined) {
  txtResolver = resolver;
}

/** The system resolver, bounded so a slow authoritative server cannot hold the request open. Node only. */
async function systemTxt(name: string): Promise<string[][]> {
  const dns = await import("node:dns/promises");
  const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
  return resolver.resolveTxt(name);
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: "missing" | "mismatch" | "lookup_failed" };

/**
 * Whether `_montral-challenge.<domain>` has a TXT record exactly equal to `token` (a record split into several
 * character strings is joined first, as DNS servers may chunk long values). No prefix, substring or case folding.
 */
export async function verifyDomainToken(domain: string, token: string, resolver: TxtResolver | undefined = txtResolver): Promise<VerifyOutcome> {
  let records: string[][];
  try {
    records = await (resolver ?? systemTxt)(challengeName(domain));
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, reason: code === "ENOTFOUND" || code === "ENODATA" ? "missing" : "lookup_failed" };
  }
  if (!records.length) return { ok: false, reason: "missing" };
  return records.some((chunks) => chunks.join("") === token) ? { ok: true } : { ok: false, reason: "mismatch" };
}

// ── routing ───────────────────────────────────────────────────────────────────

/** What the router needs to know about a verified domain's page. */
export type DomainSite = { id: string; slug: string; visibility: "public" | "members" | "password"; domain: string };

/**
 * The host this request was addressed to, for custom-domain routing. X-Forwarded-Host counts only when the socket
 * peer is a trusted proxy (node-proxy-peer.ts); from anyone else it is ignored and the Host header itself is used.
 * Returns the lowercase hostname without port or trailing dot, or null when it is missing or malformed.
 */
export function routingHost(headers: { host?: string; "x-forwarded-host"?: string | string[] }, trustedPeer: boolean): string | null {
  const forwarded = trustedPeer ? headers["x-forwarded-host"] : undefined;
  // a proxy chain may append: the first value is what the visitor asked for
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || headers.host?.trim();
  if (!raw || raw.length > 260) return null;
  const host = raw.toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+$/.test(host) ? host : null;
}

export type CustomDomainRoute =
  /** render the status page: hand `url` (a /status/<slug> path) to the web build */
  | { kind: "page"; url: string }
  /** answer from the API: hand `url` to Hono */
  | { kind: "api"; url: string }
  /** a static asset of the web build (no SSR fallback) */
  | { kind: "asset"; url: string }
  | { kind: "not_found" };

/** Root paths on a custom domain that stand for the page's public feeds. */
const FEEDS = new Set(["/rss.xml", "/maintenance.ics", "/badge.svg", "/llms.txt"]);
/** Static files the status page itself loads; the app's manifest, service worker and other pages stay off this host. */
const ASSETS = /^\/(?:_astro\/[A-Za-z0-9._-]+|favicon\.svg|apple-touch-icon\.png)$/;

/**
 * Where a request to a verified custom domain goes. Only the page, its feeds, its own public API and the assets the
 * page loads exist on that host; everything else (the app, sign-in, sign-up, private API, webhook receivers, docs,
 * other pages' public API) is a 404, so the host can never serve the authenticated app or set its cookies. A
 * members-only page is a 404 throughout: sessions live on the main origin, never here.
 *
 * Pure: the caller rewrites the request to the returned URL, so what runs is exactly what was checked.
 */
export function customDomainRoute(method: string | undefined, rawUrl: string | undefined, site: Pick<DomainSite, "slug" | "visibility">): CustomDomainRoute {
  if (site.visibility === "members") return { kind: "not_found" };
  let url: URL;
  try { url = new URL(rawUrl ?? "/", "http://custom.invalid"); } catch { return { kind: "not_found" }; }
  // a request target must be origin-form; an absolute or scheme-relative one could resolve to another path than it reads
  if (!(rawUrl ?? "/").startsWith("/") || (rawUrl ?? "").startsWith("//")) return { kind: "not_found" };
  const path = url.pathname;
  const search = url.search;
  const read = method === "GET" || method === "HEAD";
  const api = `/api/public/status/${site.slug}`;
  // English only: the /zh-Hans route of the web build re-fetches pages over loopback, which would lose the domain
  if (path === "/" && read) return { kind: "page", url: `/status/${site.slug}${search}` };
  if (FEEDS.has(path) && read) return { kind: "api", url: `${api}${path}${search}` };
  if (ASSETS.test(path) && read) return { kind: "asset", url: path + search };
  // the page's own fetches: the board, history, subscribe; percent-escapes have no business in these paths
  if ((path === api || path.startsWith(`${api}/`)) && !path.includes("%") && (read || method === "POST" || method === "OPTIONS")) {
    return { kind: "api", url: path + search };
  }
  // the password form posts here; the API checks the Origin against this page's verified domain
  if (path === "/api/public/status/_/unlock" && method === "POST" && site.visibility === "password") return { kind: "api", url: path };
  return { kind: "not_found" };
}

/** Keeps only the page's own access cookie (montral_sa_<id>): no session or other cookie is ever read on a custom domain. */
export function customDomainCookies(cookie: string | undefined, pageId: string): string | undefined {
  if (!cookie) return undefined;
  const name = `montral_sa_${pageId.replace(/-/g, "")}=`;
  const kept = cookie.split(/;\s*/).filter((c) => c.startsWith(name));
  return kept.length ? kept.join("; ") : undefined;
}

// ── domain → page lookup ──────────────────────────────────────────────────────

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

const domainCache = ttlCache<DomainSite | null>(CUSTOM_DOMAIN_TTL_MS, 1000);

/** Forget every cached domain (on this process): called after any status page change through the management API. */
export function purgeCustomDomains() {
  domainCache.clear();
}

/**
 * The verified page served on `host`, or null. Hits and misses are both cached for CUSTOM_DOMAIN_TTL_MS so random Host
 * values cannot turn into one query each; any management change clears the cache. Database errors are thrown, and
 * the caller fails closed (it must never fall back to serving the app on a host that might be a status domain).
 */
export async function lookupCustomDomain(query: Query, host: string): Promise<DomainSite | null> {
  const hit = domainCache.get(host);
  if (hit !== undefined) return hit;
  const rows = await query<{ id: string; slug: string; visibility: DomainSite["visibility"] }>(
    "SELECT id, slug, visibility FROM status_page WHERE custom_domain = $1 AND custom_domain_verified_at IS NOT NULL LIMIT 1",
    [host],
  );
  const site = rows[0] ? { ...rows[0], domain: host } : null;
  domainCache.set(host, site);
  return site;
}

/** Scheme for links to a custom domain: https, unless the instance itself runs on plain http (local testing). */
export const customDomainOrigin = (domain: string, webOrigin: string | undefined) =>
  `${/^http:/i.test(webOrigin ?? "") ? "http" : "https"}://${domain}`;
