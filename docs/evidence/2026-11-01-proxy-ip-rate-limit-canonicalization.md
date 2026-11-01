# Canonical IP identities for shared auth rate limiting

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private Montral Node/Cloudflare request rate-limit address extraction and synthetic regression cases. No new provider, proxy, DNS change or paid/deployed service.

## Issue reproduced before fix

The `clientIp` helper already ignored untrusted Node `cf-connecting-ip`, and when `TRUST_PROXY=true` it selected only the **last** `X-Forwarded-For` entry. However, it returned the text spelling of an accepted IP verbatim. Two forms of the *same IPv6 address* (`2001:db8::1` and `2001:0DB8:0:0:0:0:0:1`) therefore led to different persistent `auth:ip:` quota keys if a trusted ingress forwarded different spellings. Ambiguous decimal-looking IPv4 peers with zero-prefixed octets (e.g. `001.002.003.004`) were also accepted verbatim despite URL parsers interpreting such notation differently. Synthetic `vitest` **RED**: 2 of 8 focused tests failed (noncanonical IPv6 output and acceptance of ambiguous IPv4).

## Corrected behavior

`clientIp` now passes the trusted final proxy peer through a single `canonicalIp` helper. Strict dotted-decimal IPv4 permits decimal `0` or a nonzero leading digit, refuses octets beyond 255 and ambiguous zero prefixes, and returns canonical decimal text. IPv6 must be valid hexadecimal/colon notation with no zone identifiers, brackets or arbitrary text; the WHATWG URL parser validates and compresses it to lower-case canonical representation. Values longer than 64 characters, invalid addresses or unavailable IPs return `null`, retaining the existing conservative **shared unknown-IP quota** plus per-account/email guards. On Cloudflare the same validation applies to the platform-provided `cf-connecting-ip`; on Node, that header stays untrusted unless actually running on Workers.

The correction does not change the limits, credentials, session/membership checks, source IP trust model, `TRUST_PROXY` default, CORS, or the production network topology. **It does not establish that an external reverse proxy correctly appends the real socket peer, or that the backend is inaccessible directly.** Those must still be qualified on an authorized production-like ingress, and the external reverse-proxy gate remains OPEN.

## Verification

- RED: 2/8 focused synthetic tests failed on old code.
- GREEN: 8/8 `secrets.test.ts` including canonicalization, invalid IPv4, last-hop spoof handling and legacy secret comparisons.
- Full Mac supported Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9** package qualification **969/969 PASS**: **711 API**, **114 DB** with `DATABASE_URL` explicitly set to a fresh test DB, **20 Probe**, **124 Web** after built assets. All TypeScript/Astro checks and production Node API, Edge Probe and Node Web builds PASS.
- Actual localhost Node/PostgreSQL health/config/MCP/dashboard smoke PASS; real headless Chromium signup, monitor, incident, webhook, disabled billing and reset-link privacy PASS; localhost SMTP verification, channel test, incident down/recovery and account recovery PASS.
- Full **46-table PostgreSQL dump/restore** SHA-256 and exact row counts PASS (14 nonempty tables, nine synthetic workspaces and eight required DB functions). Five OS `SIGKILL` outbox crash boundaries PASS (rollback, committed snapshot recovery, pre/post-attempt no replay, old claim refusal).
- No hosted success inferred from local passes; check GitHub Actions on the new exact revision separately.
- Pinned donor sources remain unchanged, source-brand leakage checks retained.
