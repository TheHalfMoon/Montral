# APNs streamed response memory budget — Workers and Node HTTP/2

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private Montral, synthetic APNs responses, supported Mac Node runtime, disposable PostgreSQL for requalification; no Apple credentials, real devices, external APNs network calls, paid services or deployment.

## Reproduced availability/memory risk

`apps/api/src/apns.ts` used unlimited `Response.text()` for APNs replies on Cloudflare Workers and accumulated every Node HTTP/2 `data` event in an unbounded `Buffer[]` before `Buffer.concat`. APNs error bodies are ordinarily small JSON, but an upstream that unexpectedly sends an oversized or endless body could consume memory indefinitely until resource exhaustion. Both streams used a 10-second request timeout, but that is not a **byte budget**; the rate of bytes received before timeout is unbounded. A prior per-device error-log redaction fix does not prevent this availability issue.

RED evidence: a mocked Workers `fetch` returning a synthetic HTTP 410 stream that produced 40-KiB chunks without terminating caused the existing unlimited `.text()` implementation to consume memory until the test worker exited unexpectedly with **SIGKILL**. That observed test failure is not claimed as an Apple/production outage. Repeating this unbounded pre-fix fixture is unsafe, so only the bounded corrected implementation was rerun.

## Production fix and behavioral contract

Introduced one byte-exact `APNS_RESPONSE_MAX_BYTES = 64 * 1024` ceiling and a shared bounded response collector for both platform paths. The Worker fetch transport now reads a `ReadableStream` incrementally, stops on byte overflow, cancels the provider reader, and throws a constant safe error rather than silently truncating a JSON provider response. The Node HTTP/2 transport no longer retains unlimited `data` chunks; it rejects and closes the request on the first over-budget chunk, clears its timeout, and guards end/error callbacks against double settlement. It also decodes UTF-8 correctly across chunk boundaries. A reply with a too-large HTTP 410 status is **not** returned as an ordinary dead-device notice; the sender treats the transport failure as retryable and does not remove a token based on that malformed provider body.

The provider host allowlist, APNs authorization JWT, recipient tokens, scheduler, retries, subscriptions and outage/notification rules were not changed. The fixed budget is intentionally larger than ordinary APNs JSON errors and applies equally on Workers and Node.

## Regressions

`apns-response-limit.test.ts` directly validates that synthetic unbounded Worker 410 responses reject and cancel within a small number of reads, normal UTF-8 JSON error/status is preserved, and the shared collector respects an exact 65,536-byte limit with split multi-byte Unicode. Focused `apns-response-limit.test.ts` plus existing APNs suite **23/23 PASS** after the fix. The `fetchTransport` export exists only for deterministic testing; it is not an HTTP API.

Full macOS Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9** independent disposable-database package qualification: **976/976 PASS** (API **718/718** across 91 files, DB **114/114** with real `DATABASE_URL`, Edge Probe **20/20**, Web **124/124** after build). All TypeScript/Astro checks and three production Node API/Edge Probe/Node Web builds PASS.

Separate local Node/PostgreSQL smoke PASS; real headless Chromium signup, monitor, incident, webhook, disabled billing and reset-link privacy PASS; loopback-only SMTP verification, channel test, automatic incident down/recovery and account recovery PASS. `pg_dump`/`pg_restore` verified **46 tables** (14 nonempty), **nine synthetic organizations**, every table row count and normalized-content SHA-256 fingerprint, and eight SQL functions. Five macOS OS `SIGKILL` staged monthly-outbox crash/recovery boundaries PASS with no recipient resend or double quota debit. **638/638 pinned donor snapshots** and active-branding check PASS. Hosted GitHub Actions on the exact new commit is tracked separately and must not be inferred from local success.

**Out of scope / still OPEN:** actual Apple production transport availability, hosted load/capacity, Cloudflare regional egress, full real-provider failures, security review, privacy and release authorization. No live APNs service was contacted.
