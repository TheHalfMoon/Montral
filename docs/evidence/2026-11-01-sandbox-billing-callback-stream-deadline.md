# Sandbox billing callback — bounded read deadline and nonblocking cancellation

**Date:** 2026-11-01 (Asia/Riyadh). **Environment:** authorized Mac, supported Node 24.22.1, private Montral repository, synthetic payment events and disposable local PostgreSQL. No connected payment merchant, provider credentials, charge, publication or production activation.

## RED — reproducible pre-HMAC availability defects

The optional `POST /api/billing/lemon` path previously enforced a 64-KiB raw-body cap to guarantee byte-exact HMAC verification. However, `limitedBody` waited indefinitely on a sender that offered a small first chunk but never closed, and its `finally { await reader.cancel() }` waited indefinitely when an over-limit sender refused stream cancellation. Two isolated synthetic tests both returned **`still-stalled`** on the original implementation, demonstrating distinct low-rate and over-budget availability failures. The billing route is still **off by default** and remains test-mode only.

## Correction

- One total **10,000-ms wall-clock deadline** spans all chunks and inactivity; streaming small chunks cannot extend the deadline.
- Timeout returns fixed **HTTP 408** with no-store/no-referrer/nosniff headers, before HMAC verification, JSON decoding, entitlement mutation or billing-event insertion. Normal valid signed callbacks retain byte-exact HMAC, sandbox test-mode checks, original JSON/refusal semantics and SQL idempotency.
- On oversize or timeout, initiate cancellation without awaiting uncooperative remote streams, clear timer and release lock. On successful completion, return the same bytes with no cancellation wait. Existing strict **64 KiB** raw-body limit remains.
- The optional test timeout is used only by direct deterministic tests. Mounted endpoints always use the 10-second production bound. No external calls or billing activation introduced.

## Evidence

Direct RED→GREEN unit cases cover one-byte unread completion and a forged short Content-Length with an upload over 64 KiB whose cancellation never settles. Mounted signed and otherwise valid synthetic subscription-created event is streamed but never closed: after the 10-second window, response is **408** with privacy headers. A real PostgreSQL check confirms **zero** billing events for that test provider ID. Focused billing unit and PostgreSQL E2E suites **20/20** PASS. The merchant integration remains sandbox-only, disabled unless explicitly configured.

## Local full-suite qualification caveat (transparent)

An initial all-API test run with default worker parallelism on a new database **did not pass** under substantial unrelated Mac host load (reported load average near 46). Result: **92/97 files passed**, **743 passed / 4 failed / 4 skipped** tests plus one failing suite hook. The failures were timeouts in monthly-transition setup and in four other PostgreSQL-backed integration tests, with no failing billing-callback assertion. Host contention is a hypothesis, not a proven root cause; the failing run is not counted as qualification. Recheck on an **independently fresh** database with Vitest worker concurrency capped at 2 and longer default test/hook timeouts; report actual results separately. The hosted GitHub Actions pipeline on the eventual pushed SHA is an independent required gate.

## Subsequent source-unchanged verification on supported Node

- Fresh PostgreSQL database, Vitest API capped at **2 workers** and 60-second default test/hook timeouts: **97/97 API files, 751/751 tests PASS**. The previously timing-out unrelated API E2E tests passed. Source files were unchanged between failing and passing runs.
- The first PostgreSQL full-suite run at 2 workers on that DB showed **114/115 PASS**, with one unexpected observation-generation fence assertion in `coverage.test.ts` (expected generation 3 to be rejected). This is a correctness-sensitive transient that **must not be silently dismissed**. Running that entire file alone subsequently passed **15/15**, and rerunning the complete PostgreSQL suite with **one worker** on the same disposable DB passed **115/115**. Cross-file timing/isolation remains a candidate and needs independent investigation; no claim of root cause or unconditional concurrency qualification.
- Probe **20/20**, built Astro Web **124/124**, all monorepo TypeScript/Astro typechecks, API Node bundle, Edge Probe and Web builds passed.
- Donor-source integrity **638/638** and active Montral branding scan PASS.

**Supported local suite total in final resource-bounded qualification: 1,010/1,010 passing** (API 751 + DB 115 + Probe 20 + Web 124), with the two preceding non-green attempts explicitly disclosed above. Hosted CI at the exact pushed SHA is required to validate default runner concurrency independently.

## Open gates

Hosted CI on exact new SHA; live merchant test-store callbacks, documented refund/settlement plans, real payment switch authorization, reverse-proxy socket/load enforcement, hosted PostgreSQL resiliency, legal/privacy and external mail remain OPEN. No publication. Private repo, **commercial release NO-GO**.
