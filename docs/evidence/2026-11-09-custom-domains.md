# Verified custom domains for status pages

## Gap
`status_page.custom_domain` existed since the first migration, but nothing set
it, verified it or routed requests by it (GAP-MATRIX: "N (column only)").

## Design
- Scope: the self-hosted Node server (Docker). Cloudflare Workers has no
  Host-based router here, so `PUT /domain` and `POST /domain/verify` answer
  `400 custom_domain_unsupported` there (`isWorkers()`); `DELETE` still works.
- Schema (migration `0048_status_page_custom_domain`): `custom_domain_token`
  (plain; it is published in DNS, so it is not a secret) and
  `custom_domain_verified_at`. A partial unique index makes a *verified* domain
  exclusive (`status_page_custom_domain_verified_idx ... WHERE verified_at IS
  NOT NULL`).
- Management API (owner/admin, `requireManager`):
  `PUT /api/status-pages/:id/domain {domain}`, `POST .../domain/verify`,
  `DELETE .../domain`. `statusPageDomain` accepts only a lowercase FQDN
  (trimmed and lowercased first) of at least two LDH labels, at most 253
  characters, no scheme/port/path/userinfo/wildcard/IP literal/trailing dot,
  not `*.localhost`, and not the app's own host (`WEB_ORIGIN`,
  `BETTER_AUTH_URL`). Every `PUT`, even of the same name, issues a new token
  (`montral-verify=<40 hex>`) and clears `verified_at`.
- Verification resolves TXT `_montral-challenge.<domain>` with
  `node:dns/promises` (`Resolver`, 4 s timeout, 2 tries; imported lazily so the
  module stays Workers-safe; injectable via `setTxtResolver` for tests). A
  record matches only when its joined character strings equal the token
  exactly. The `UPDATE` is conditional on the domain and token that were
  checked, so a concurrent re-set cannot be verified by the old record; a
  unique violation (another page verified first) is `409`. 30 attempts per
  page per hour.
- Squatting: uniqueness covers verified domains only. A `PUT` is refused
  (`409 custom_domain_taken`) when another page has verified the name, but an
  unverified claim elsewhere does not block anyone: whoever proves DNS first
  gets the domain, and the other claim can never verify.
- Routing (`custom-domain-node.ts`, called first in `server.ts`):
  - The routing host is the `Host` header, or `X-Forwarded-Host` only when
    `scrubUntrustedForwarding` reports a trusted proxy peer (TRUST_PROXY +
    TRUST_PROXY_PEER_IPS). Port, case and trailing dot are dropped.
  - The app's own hosts, IP literals, `localhost` and single labels never hit
    the database (health checks and direct-IP access stay independent of it).
    Other hosts are looked up (`custom_domain = $1 AND verified_at IS NOT
    NULL`), hits and misses cached 60 s (bounded at 1000 entries) and cleared
    on any successful management write to status pages on this process. A
    lookup error answers `503` instead of falling back to the app.
  - `customDomainRoute` (pure) maps: `/` to `/status/<slug>` (query kept);
    `/rss.xml`, `/maintenance.ics`, `/badge.svg`, `/llms.txt` to the page's
    public API; `/api/public/status/<slug>[/...]` as is (no `%` escapes);
    `POST /api/public/status/_/unlock` for password pages; `/_astro/<file>`,
    `/favicon.svg`, `/apple-touch-icon.png` as static assets with no SSR
    fallback. Everything else is `404` (`private, no-store`): app, login,
    signup, private API, auth, webhook receivers, docs, `/status/*`, other
    slugs, share-link and subscription token endpoints, `/zh-Hans`. URLs are
    normalised by the WHATWG parser first and the request is rewritten to the
    returned URL, so what runs is what was checked; absolute-form targets are
    refused.
  - A members-only page is `404` on every path of its domain.
  - Credentials are cut down before any handler runs: only the page's own
    `montral_sa_<page id>` cookie survives; `Authorization` and `X-API-Key`
    are removed. `X-Forwarded-Host` is set to the verified name.
  - `x-montral-status-domain` is deleted from every incoming request and set
    only by the router for page renders; the SSR page honours it only when
    `MONTRAL_STATUS_DOMAINS=node` (set by `server.ts`), so a client cannot
    inject it and Workers ignores it.
- Page (`status/[slug].astro`): on a custom domain the canonical link and RSS
  `<link>` use `https://<verified domain>/` (http only when `WEB_ORIGIN` is
  http), feed and pager links use root paths, and hreflang alternates are
  omitted. Never derived from a raw Host. Security headers from
  `web-security-headers.ts` are applied (status paths stay frameable), and the
  Astro meta CSP is unchanged (no inline script changed).
- Feeds (RSS, iCal, llms.txt) name the verified domain as the page's home when
  the page is not members-only; badge/summary/share links keep the main origin.
- Password pages: the unlock `POST` previously accepted only the main origin
  or the request URL's origin. It now also accepts exactly
  `https://<domain>` (scheme per `WEB_ORIGIN`) when that domain is the
  *verified* domain of the page named in the body; other pages, unverified
  domains and look-alike origins get `403`. The access cookie is unchanged:
  `Path=/; HttpOnly; SameSite=Lax` (+`Secure` on https), no `Domain`, so it
  is host-only for the custom domain that set it.
- UI: "Custom domain" card in the status page editor (hostname, save/remove,
  TXT name and value with copy buttons, Verify with the result, the
  reverse-proxy/TLS requirement, and a warning for members-only pages).
- Docs: `docs/self-host#custom-domains` (Caddy example, nginx `Host`, trusted
  proxy rule, what the domain serves) in English and Chinese; three endpoints
  in `docs/api`.

## Evidence (local, Windows, 2026-11-09)
- `apps/api/src/custom-domain.test.ts`: 46 tests. Hostname validation (24
  refusals incl. ports, schemes, IPs, wildcards, unicode, over-length, the
  app's hosts), `routingHost` trust rules, the route map (the full 404 list
  incl. traversal and encoded variants, members-only, unlock only for
  password pages), cookie filtering, TXT verification with a stubbed
  resolver (exact match, chunked records, prefix/suffix/case refusals,
  missing vs failed lookup), lookup caching and fail-closed errors.
- `apps/api/src/custom-domain-node.test.ts`: 10 tests over a real Node HTTP
  server wired like `server.ts` (scrub, header removal, router): page, feeds,
  assets and own API routed; app/login/private API/webhooks 404 with no
  cookies set; session, Authorization and a forged internal header stripped;
  unverified domain not routed; own host/IP/localhost never looked up;
  untrusted `X-Forwarded-Host` ignored and trusted one honoured; members-only
  404; password unlock route; 503 when the lookup fails.
- `apps/api/src/custom-domain.e2e.test.ts` (PostgreSQL, 3 tests; runs in CI,
  skipped locally without `TEST_DATABASE_URL`): set/verify/re-set/clear,
  invalid hostnames, an unverified domain is not returned by the routing
  lookup, feeds name the domain; another workspace cannot claim a verified
  domain or touch the page, a squatter's unverified claim does not block the
  owner and loses the race; members-only not routed; unlock from the domain
  origin sets a host-only cookie, refused from foreign, look-alike,
  other-page and unverified origins.
- `tsc -p apps/api` clean; `@montral/web` typecheck 0 errors;
  `gen-migrations --check` in sync (49); `verify-active-branding.sh` pass;
  env-docs guard updated (`MONTRAL_STATUS_DOMAINS` is internal).
- Full API unit suite: all pass except the two workerd suites
  (`edge-cloudflare.workers`, `websocket.workers`), which time out locally
  because workerd's install script is skipped on this machine; they do not
  touch this change.

## Not done / limits
- Not tested end to end behind a real Caddy/nginx with TLS, and the e2e suite
  has not run (no local PostgreSQL).
- No Chinese (`/zh-Hans`) rendering on custom domains: the locale route
  re-fetches pages over loopback and would lose the domain.
- Several Node replicas: a change is immediate on the replica that handled it
  and reaches the others within the 60 s cache lifetime.
- No periodic re-verification: a domain stays verified until it is set again
  or removed, even if the TXT record is later deleted.

## Independent review
No host-header bypass was found. Fixed findings:
- **Takeover by DNS proof.** A verified domain used to stay claimed after DNS
  changed hands. Setting a domain no longer checks for a holder; proving the
  TXT record for one's own token releases the domain from any other page and
  verifies this one (a concurrent race answers 409; retrying settles it). Only
  the DNS owner can publish records, so only they can move a domain.
- **No app on foreign hostnames.** A hostname pointed at the instance that is
  neither the app's own nor a verified domain (before verification, or after
  the page or domain is removed) now gets 404 instead of Montral's sign-in.
  IP literals, `localhost` and single-label names still reach the app.
- **Real wiring.** `scripts/smoke-node.mjs` (CI) now drives the built server:
  a verified domain serves only its page (`/app`, `/login`, `/api/me`,
  `/api/auth/get-session` 404), an unverified hostname 404s, and the app's own
  address still serves `/app`.
