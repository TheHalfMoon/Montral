import type { IncomingMessage, ServerResponse } from "node:http";
import { customDomainCookies, customDomainRoute, routingHost, statusPageDomain, type DomainSite } from "./custom-domain";
import { applyWebSecurityHeaders } from "./web-security-headers";

/**
 * Set by the router on requests it hands to the web build for a custom domain, and removed from every incoming
 * request first, so its presence means "this router verified the host" and a client can never supply it.
 */
export const STATUS_DOMAIN_HEADER = "x-montral-status-domain";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export type CustomDomainRouter = {
  /** whether the socket peer is a trusted proxy (scrubUntrustedForwarding's answer for this request) */
  trustedPeer: boolean;
  /** the app's own hostnames: never looked up, always served as the app */
  ownHosts: Set<string>;
  lookup: (host: string) => Promise<DomainSite | null>;
  api: Handler;
  page: Handler;
  /** static files only: must answer 404 itself instead of falling through to SSR */
  asset: Handler;
};

function notFound(res: ServerResponse, status = 404) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(status === 404 ? "Not found" : "Unavailable");
}

/**
 * The host to look up for this request, or null when it can only be the app: no usable host, one of the app's own
 * hosts, or something that could never be a status page domain (an IP literal, localhost, a single label). Keeping
 * those off the database means health checks and direct-IP access never depend on it.
 */
export function candidateHost(req: Pick<IncomingMessage, "headers">, trustedPeer: boolean, ownHosts: Set<string>): string | null {
  const host = routingHost(req.headers, trustedPeer);
  if (!host || ownHosts.has(host)) return null;
  return "domain" in statusPageDomain(host) ? host : null;
}

/**
 * Serves a request addressed to a verified custom domain, and answers 404 for any other hostname that is not the app's
 * own; resolves false only for the app's own hosts, IP literals, localhost and single-label names (the caller then
 * serves the app as usual). The request is rewritten in place to the route customDomainRoute chose: its URL, and
 * credentials cut down to the page's own access cookie (no session, Authorization or API key reaches the app from a
 * custom domain). A lookup failure answers 503 rather than falling back to the app on a host that may be a status domain.
 */
export async function routeCustomDomain(req: IncomingMessage, res: ServerResponse, router: CustomDomainRouter): Promise<boolean> {
  delete req.headers[STATUS_DOMAIN_HEADER];
  const host = candidateHost(req, router.trustedPeer, router.ownHosts);
  if (!host) return false;
  let site: DomainSite | null;
  try {
    site = await router.lookup(host);
  } catch {
    console.error("custom domain lookup unavailable");
    notFound(res, 503);
    return true;
  }
  // A hostname that is neither the app's own nor a verified status domain (one pointed here before verification, or
  // after its page or domain was removed) gets a 404, never the app: Montral's sign-in must not appear under someone
  // else's name. IP literals, localhost and single-label names never get here (candidateHost), so local access works.
  if (!site) {
    notFound(res);
    return true;
  }
  const route = customDomainRoute(req.method, req.url, site);
  if (route.kind === "not_found") {
    notFound(res);
    return true;
  }
  req.url = route.url;
  const cookie = customDomainCookies(req.headers.cookie, site.id);
  if (cookie) req.headers.cookie = cookie;
  else delete req.headers.cookie;
  delete req.headers.authorization;
  delete req.headers["x-api-key"];
  // what the SSR page forwards to the API as "the host the visitor asked for": the verified name, not a raw header
  req.headers["x-forwarded-host"] = site.domain;
  if (route.kind === "api") {
    router.api(req, res);
    return true;
  }
  applyWebSecurityHeaders(route.url, res);
  if (route.kind === "asset") {
    router.asset(req, res);
  } else {
    req.headers[STATUS_DOMAIN_HEADER] = site.domain;
    router.page(req, res);
  }
  return true;
}
