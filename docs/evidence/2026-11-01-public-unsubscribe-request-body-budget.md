# Public unsubscribe: fail closed on oversized or endless request bodies

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private Montral, local Mac with synthetic unsubscribe tokens and in-process HTTP requests. No live email, external traffic, production deployment or paid account.

## Bug reproduced before changing production code

The public `POST /api/public/status/_/unsubscribe?token=...` handler unconditionally called `removeSubscriber()` before reading the request body with `c.req.text()`. A caller could send an arbitrarily large or unending body to that public bearer-token route. `text()` would buffer the full stream, which increases the memory consumed by each incoming request. The handler would also apply the unsubscribe mutation before noticing anything about its size.

Expanded `status-token-privacy.test.ts` with a synthetic valid token and a 2-KiB body that starts with the RFC 8058 one-click payload. **RED**: the route returned HTTP 200 instead of rejecting the excessive input, and had already acted on the token; production code had no input size limit.

## Narrow fix and test coverage

Added a byte-exact **1,024-byte** request body budget for the unsubscribe endpoint. It checks declared `Content-Length` where present and always checks the actual bytes as a stream, so chunked/incomplete transfer cannot bypass the budget. On overflow it cancels the reader without waiting for an upstream that might never terminate, returns HTTP **413**, and **does not call** `removeSubscriber`. Only after a valid bounded body is read is the token acted on. The normal HTML form still responds with HTTP 303, and a valid RFC 8058 `List-Unsubscribe=One-Click` payload still gets HTTP 200. Existing `private, no-store`, `no-referrer`, `nosniff`, `noindex` headers remain unchanged on success and rejection.

**GREEN**: all five status-token privacy tests pass, including 2-KiB body rejection with zero subscriber mutation and a never-ending synthetic `ReadableStream` that is cancelled after a bounded handful of 512-byte chunks. Normal valid/invalid token redirects and one-click protocols are unchanged. The new cap is explicitly for a tiny unsubscribe form body, not an upload or webhook endpoint.

## Release boundary

Full local Mac qualification on Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9**, separate disposable PostgreSQL databases: **988/988 package tests PASS** (API **730/730** over 95 files, DB **114/114**, Probe **20/20**, Web **124/124**). TypeScript/Astro checks and three production builds (Node API, Edge Probe, Node Web) PASS. Node/PostgreSQL health/config/MCP/dashboard smoke, headless Chromium account/monitor/incident/webhook/disabled billing/password-reset URL privacy, and loopback-only SMTP verification/channel/incident recovery/account reset all PASS. `pg_dump`/`pg_restore` verified **46 tables** (14 nonempty), nine synthetic organizations, all exact row counts and SHA-256 normalized content fingerprints and eight SQL functions. Five OS `SIGKILL` monthly-outbox boundaries PASS, with no duplicate delivery or quota debit. All **638 donor source snapshots** and active-code branding verified. Hosted GitHub Actions on the new exact commit is a separate gate, not implied by local results. This test proves request-body memory and mutation-order hardening only; real hosted abuse/load, traffic filtering, ingress timeouts, unsubscribe deliverability and legal/privacy reviews remain independently unqualified. Montral stays PRIVATE and **NO-GO** for public deployment.
