# Suspended public status pages: bypass server-side caches (2026-11-12)

## Gap
The public-status middleware resolves `statusPageBySlug` on every request. That lookup already excludes suspended workspaces. For an open/public page, however, middleware previously returned immediately to the route. The `/incidents` and root board routes may serve warm `sharedCache` entries without repeating the lookup, returning old incidents and uptime even after the workspace is hidden by an operator.

## Narrow correction
- For pages still present and public, keep the original 30-second board/history caching and response headers.
- For an unresolved slug (unknown, removed or suspended workspace), set `statusResponsePrivate` before entering route handlers, so board/history `sharedCache.cached(...,{bypass:true})` never returns local or edge-cached data.
- After route completion, force `Cache-Control: private, no-store` for unresolved slugs. Standard JSON feeds return their ordinary 404; the public badge keeps its existing neutral SVG "unknown" behavior without caching.
- No extra database query or provider integration. The existing slug lookup is used, and suspension remains a per-request database filter.

## Tests
- Pure in-memory HTTP regression in `status-access.test.ts` checks that missing/suspended summary and incident routes return 404 with `private, no-store`, and that the badge remains neutral `unknown` but also no-store.
- Hosted PostgreSQL 17/18, WebKit/Chromium/Firefox, macOS, load and security checks must qualify the exact head before merge.

## Scope
A response delivered to an **external CDN or browser before suspension** may still be used until its existing HTTP cache max-age expires; no supported global purge mechanism is configured. This change prevents further responses from **Montral's own** memory or Cloudflare shared data cache after the suspended/missing slug has been checked. Previously dispatched monitor checks remain separately tracked.

No change to prices, plans, payments, providers, schema, production deployment or release status.
