# Bounded database-protocol probe responses — local macOS qualification

**Date:** 2026-10-31 (Asia/Riyadh). **Repository:** PRIVATE `TheHalfMoon/Montral`. **Scope:** authorized macOS, synthetic localhost TCP responders; no production probes, deployment, public launch, customer data or paid services.

## Reproduced issue

The database-probe exchange helper in `apps/api/src/checker.ts` already had a request timeout, but it repeatedly concatenated the full network reply into a larger `Uint8Array` until the protocol-specific completion predicate was true. A misconfigured or adversarial Redis-compatible TCP endpoint that never sent a newline could keep sending bytes and grow that reply buffer until the timeout; repeated allocation/copying amplified the cost. The PostgreSQL/MySQL probes shared the same helper, although their valid handshakes are tiny.

A new localhost TCP regression deliberately writes a **96 KiB** unterminated response. Before the fix, the test was **RED**, reporting `Connection timed out` after approximately two seconds rather than a byte-budget rejection. No outside host was contacted.

## Correction

The shared exchange now imposes `MAX_PROTOCOL_REPLY_BYTES = 64 * 1024` on accumulated replies. Before each concatenation, it rejects a chunk exceeding the remaining budget with the **constant, non-secret** `Probe response exceeds byte budget` error. Existing `finally` cleanup closes the probe connection on rejection. This does not claim to cap OS or socket-level buffering before each read; it bounds the accumulated application buffer, preventing repeated unbounded concatenation. Standard PostgreSQL TLS availability bytes, MySQL version-10 handshakes, and Redis `+PONG`/`-NOAUTH` replies still succeed. An intentional client disconnect resets the synthetic attack server socket, which the test explicitly handles without concealing production errors.

## Release limits

This patch is a **local resilience improvement**, not a production readiness attestation. Hosted GitHub Actions remains blocked before runner start due to account payment/spending controls; real Cloudflare egress/region delivery, hosted failure injection, managed PITR, external SMTP/merchant integration, privacy, capacity and publication decisions remain open. No environment, billing, scheduler, migration, source-provenance or deployment settings changed.

## Final qualification

- **Red-to-green focused test:** a synthetic localhost server returned 96 KiB without a Redis line terminator. Before the fix, the probe waited 2 seconds and reported `Connection timed out` (expected byte-budget refusal: FAIL). After the fix, it stopped with `Probe response exceeds byte budget`. All **22/22** checker-focused tests pass, including legitimate TCP, PostgreSQL SSLRequest, MySQL v10 and Redis PONG/NOAUTH. The synthetic test server handles the expected `ECONNRESET` when the bounded client closes its socket; no production exception was suppressed.
- **Mac runtime:** Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9**. On a fresh isolated `montral_test_*` test database, complete package tests **963/963 PASS**: 705 API, 114 DB (explicit `DATABASE_URL`, not skipped), 20 Edge Probe, 124 Web. TypeScript/Astro checks PASS; production Node API, Node Web SSR and Edge Probe builds PASS.
- **Local smoke and resilience:** self-hosted Node/PostgreSQL health/config/MCP/dashboard smoke PASS; synthetic PostgreSQL `pg_dump` to `pg_restore` PASS with **46 tables**, all per-table counts and normalized SHA-256 content fingerprints equal, **8 synthetic organizations/projects/monitors** and **8 required SQL functions**. Real offline headless Chromium signup/monitor/incident/webhook/reset-token-privacy/disabled-billing journey PASS. Local loopback SMTP signup/alert/automatic down-recovery/account-recovery PASS; **5 actual OS SIGKILL** staged monthly-outbox boundaries PASS without duplicate mail or extra quota. **638 original donor source files** remain hash-identical.
- **Test configuration correction:** DB package's PostgreSQL tests require `DATABASE_URL`; an initial run with only `TEST_DATABASE_URL` skipped 108 database tests, which were NOT counted as passes. The full 114/114 DB run with `DATABASE_URL` set explicitly passed against a disposable migrated database. None of these local passes makes GitHub-hosted CI green.
- **Open external gates:** GitHub Actions runners previously failed before executing steps because account payments/spending limits require owner action; this is separately checked after push. Managed PITR, live Cloudflare probe regions/egress, genuine merchant and SMTP-provider qualification, load testing, security/privacy reviews and explicit release authorization are still **NO-GO**. No deployment was attempted.
