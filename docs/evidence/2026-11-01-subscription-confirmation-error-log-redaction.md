# Public status-page subscription: redact raw provider exceptions from server logs

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private Montral, real PostgreSQL and synthetic in-process SMTP transport only; no production mail, private customer information, paid account or deployment.

## RED — verified log leak

The public `POST /api/public/status/:slug/subscribe` endpoint catches required confirmation-email delivery errors and deliberately returns the same `{ ok: true }` response regardless of recipient state (to prevent enumeration). However, its catch callback logged the **entire untrusted provider error object**. Email-provider and webhook exceptions may include internal credentials, a recipient's private address or a token-bearing verification URL.

An expanded real-PostgreSQL subscriber-privacy E2E test creates a synthetic workspace and status page, injects a synthetic mail transport that rejects with a unique private marker, then captures `console.error`. **RED**: the server log contained the exact private marker. The route still replied 200 and preserved a pending subscriber row. The test also asserts no subscriber email address appears in the log, and keeps the existing owner-only management contact reads, role demotion, other-workspace and unauthenticated refusals.

## Minimal correction

The catch handler now logs only a **fixed, non-sensitive diagnostic**, `subscription email failed; provider diagnostics suppressed`. It never passes through the provider exception object, confirmation email body, recipient or bearer token. Failure does not mark the email confirmed or create a misleading sent ledger; the original non-enumerating HTTP 200 behavior and pending confirmation state remain unchanged. No retry, quota, security policy or storage setting was relaxed. Pending confirmation can be requested again within existing per-address and per-page limits.

**GREEN**: focused subscriber-privacy E2E PASS on real disposable PostgreSQL with synthetic throwing transport. Original privacy and authorization checks in that test remain green.

## Qualification and exclusions

macOS with supported Node **24.22.1**, pnpm **10.0.0** and PostgreSQL **17.9** passed **969/969 package tests** on fresh disposable PostgreSQL: **711 API**, **114 DB** (explicit `DATABASE_URL`), **20 Probe**, **124 Web after production web build**. All TypeScript/Astro checks and three production builds (Node API, Edge Probe, Node Web) PASS.

During the first full API run **all 711 test cases passed** but **two asynchronous `afterAll` hooks timed out at 10 seconds**, so that first run was correctly **FAILED**, not counted as green. The affected retention and monthly-outbox files plus the modified subscriber-privacy file were rerun on an independent fresh database (**14/14 tests PASS**), and the full 88-file API suite was rerun on another fresh database (**711/711 PASS with zero hook failures**). No production or synthetic deletion guard was relaxed; first-run hook contention remains an intermittent local test-stability observation, not a claim of proven root cause.

Additional Mac runtime qualification PASS: Node/PostgreSQL health/config/MCP/dashboard smoke, headless Chromium signup/monitor/incident/webhook/disabled billing/password-reset URL privacy, and production Node SMTP protocol against a local sink (signup verification, channel test, automatic incident down/recovery and account recovery). `pg_dump`/`pg_restore` verified all **46 PostgreSQL tables**, counts and SHA-256 normalized content digests (14 nonempty, nine synthetic workspaces and eight required SQL functions). Five real OS `SIGKILL` monthly-outbox crash boundaries PASS without SMTP replay or double quota debit; **638 pinned donor source files** and active-source branding checks PASS.

The last parent commit `26ba37e` had green **hosted** app and source-integrity GitHub Actions; the **new exact revision** still requires its own hosted CI success. Local results do not imply hosted success. This local server-log hardening is **not** an external SMTP deliverability test, does not inspect production reverse-proxy or SaaS provider access logs, and does not approve any live subscription email activation or production release.
