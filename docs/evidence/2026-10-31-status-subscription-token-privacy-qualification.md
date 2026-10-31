# Montral — status subscriber token privacy on supported Node 24

**Date:** 2026-10-31 (Asia/Riyadh). **Repo:** PRIVATE `TheHalfMoon/Montral`, source base `5ae661e9805ab53b3dda23f08d9e3574aa758318`. Authorized Mac only; no deployment, production payment, real email or customer data.

## Gap addressed

A status-page subscription confirmation URL (`/api/public/status/_/confirm?token=...`) and unsubscribe URL (`/api/public/status/_/unsubscribe?token=...`) carry bearer tokens in their query strings. Previously a redirect or public HTML unsubscribe page did not consistently specify `Referrer-Policy: no-referrer` or `Cache-Control: private, no-store`. Browser navigation after a GET confirmation redirect could send the full original URL to another same-origin resource as a `Referer`, and caches could retain sensitive responses. The prior standalone unsubscribe form had `no-store` and `noindex`, but no referrer policy, and its POST redirect did not apply consistent privacy controls.

## Implementation

A route-scoped `subscriptionTokenPrivacy` middleware now covers all HTTP methods for `/_/confirm`, `/_/unsubscribe`, and the subscription POST `/:slug/subscribe` within `publicStatus`. It sets all of the following before handlers so they survive redirects and refusals:

| Header | Exact value |
|---|---|
| `Cache-Control` | `private, no-store` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Robots-Tag` | `noindex, nofollow` |

The legacy unsubscribe HTML handler's narrower header override is removed. Both the browser form and RFC 8058 one-click POST protocol keep their behavior. The response `Location` never echoes the query token.

## Evidence

- New `apps/api/src/status-token-privacy.test.ts`: 3 tests asserting valid/invalid confirmation GET redirects (302), unsubscribe HTML (200), normal POST (303), one-click RFC 8058 POST (200), and subscription refusal (404) are private/non-referrable and don't echo the secret in `Location`.
- Focused status tests on the real local PostgreSQL test database: **32/32 PASS**, three files.
- `scripts/qualify-browser.mjs` now validates the same headers and no token in `Location` against a running **built Node server**, including token-confirmation, unsubscribe form and one-click unsubscribe routes, without sending mail or modifying subscriber records.
- **Crucially, this qualification runs on a supported Node binary: `v24.22.1`, the exact Node version declared by GitHub Actions.** It was installed in an ephemeral `/tmp/montral-node24-...` prefix; the user's existing Mac Node v26.0.0 remains unchanged. The temporary binary and entire disposable workspace will be deleted after GitHub push and checksum/clean-tree verification.
- All package TypeScript/Astro typechecks PASS. API **572/572** (78 files), Web **122/122** (25 files), Probe **20/20** (4 files) = **714 passing tests** on supported Node 24.22.1, and crucially the exact CI package manager **pnpm 10.0.0**. Node API / Node web / Edge Probe build PASS.
- Exact-CI local toolchain runtime verification: Node+PostgreSQL HTTP smoke PASS; real headless Chromium signup/monitor/manual-incident/webhook/billing-disabled journey plus subscriber token redirect headers PASS; actual Node SMTP-to-loopback synthetic failure and recovery alert delivery PASS; isolated pg_dump / pg_restore PASS for **42 tables, 218 synthetic organizations and 5 transactional Montral SQL functions**.
- All **638 pinned donor files** match their original SHA-256 manifest. The temporary PostgreSQL 17 database was **127.0.0.1:55456/montral_test_20261031s**; the owner's PostgreSQL on port 5432 was not used or changed.

## What this does not prove

These response headers mitigate browser caching and referrer propagation. They **cannot** remove a URL query token from upstream reverse proxy/edge/access logs, browser history, extensions or endpoints where an operator copies it. Hosting must configure access-log redaction and secure transport; this local run does not qualify external Cloudflare routing or a managed PostgreSQL cluster. External SMTP, merchant sandbox, supported-Node *hosted* CI (GitHub Actions previously failed before allocating a runner), legal review and commercial launch remain separate open gates. Montral must stay PRIVATE and UNPUBLISHED.
