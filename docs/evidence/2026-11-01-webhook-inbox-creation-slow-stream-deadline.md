# Authenticated Webhook inbox creation: total stream-read deadline

**Date:** 2026-11-01 Asia/Riyadh. **Environment:** authorized Mac, synthetic streams, private Montral repository, no production data, external service, cloud deployment or paid resources.

## RED — availability regression

The existing inbox-creation POST body parser enforces a strict 4-KiB byte budget, handles forged shorter Content-Length, and never awaits stalled cancellation after an oversized upload. But a body that sends one byte then never closes falls below the byte budget: the next `reader.read()` can remain pending indefinitely while holding an authenticated API request. A deterministic synthetic stream put one byte into its queue and provided a never-resolving `cancel()`. On the original reader, a new 30-ms read-deadline test failed with **`still-stalled`** after a separate 160-ms watchdog.

## Fix and safety constraints

- A **single 10,000-ms wall-clock deadline** begins when inbox creation starts reading and covers all chunks and inactivity gaps. Incremental one-byte uploads cannot reset it. No external network request or retry is introduced.
- The deadline is raced against each pending `reader.read()`. A timeout raises a distinct local error, mapped to **HTTP 408** with the existing no-store, no-referrer, nosniff and noindex response headers.
- The cleanup clears the timer on every path, initiates stream cancellation without awaiting an uncooperative source, and releases the lock. It does not attempt to mint a receiver token or write a PostgreSQL inbox after a timeout.
- Previous manager-role access, project isolation, UTF-8 JSON validation, 4-KiB HTTP 413 and ordinary HTTP 201 on valid input are unchanged. Public Webhook receiver streaming (already independently deadline-bound) is unchanged.

## Local regression proof

**GREEN**: 16/16 focused Webhook unit tests pass on Node 24.22.1, including a synthetic fast direct timeout, a mounted HTTP **408** after the real 10-second production deadline, private response headers, never-settling cancellation, and **zero newly created inboxes**. The mounted test uses an incomplete JSON body to ensure it never accidentally becomes a valid create request. Previously covered 413 and normal capture paths also pass. API TypeScript typecheck passes.

## Qualification limits

Application-level read bounds do not prove hosted ingress protection, reverse-proxy socket/connection caps, real-world abuse throughput, and bearer-path access-log scrubbing. Host-configuration, external mail, payment and infrastructure readiness gates remain OPEN. No deployment authorized. Montral stays **PRIVATE**, commercial release **NO-GO**. Hosted CI must pass on the exact pushed revision, separately from local testing.

## Complete Mac qualification on supported runtime

With a new, isolated, disposable PostgreSQL database, the full local test inventory passed **1,005/1,005**: API **746/746** (97 test files); PostgreSQL **115/115** (10 files); Probe **20/20** (4 files); Web **124/124** (26 files, including built page tests). Monorepo TypeScript/Astro checks, Node API bundle, Edge Probe and Astro web production builds passed. All **638** pinned donor source files were verified and the active-branding guard passed.

This qualification verifies the locally merged tree (based on `19f2655`). A remote rebasing or later commit requires its own checks, and hosted CI on the final exact SHA is independent. Hosted reverse proxy, live hostile streaming load, cloud regions, payments, external SMTP, data recovery, legal and release gates remain OPEN.
