# Local concurrent authentication quotas across independent API instances

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** Montral private repository; macOS, a disposable PostgreSQL 17 database, synthetic nonexistent users, two separately instantiated Hono API applications. **Zero external requests and no real account traffic.** This is a bounded qualification slice, **not** a production-load certification or launch approval.

## What was not previously covered

The API's login/signup/recovery abuse controls are backed by atomic `rate_limit` upserts in PostgreSQL, but existing `withinLimit` repository tests primarily counted sequential requests. Previous `clientIp` tests checked IPv6 canonicalization separately. Neither proved that two API instances sharing the same PostgreSQL database would enforce the **exact** aggregate per-address and per-account budgets under simultaneous calls, or that one email's quota remains isolated from another.

## New deterministic regression evidence

- `packages/db-pg/src/repo.test.ts`: run 40 requests with a maximum of eight concurrent workers against the real PostgreSQL `withinLimit` function, cap 7/60 s. Exactly **7 allowed, 33 denied** and a single durable rate-limit row with `count=40`. This qualifies the atomic database counter with contention rather than just sequential calls.
- `apps/api/src/auth-quota-concurrency.e2e.test.ts`: issue 24 POST login attempts at concurrency six, alternating between **two distinct API app instances** and two equivalent IPv6 spellings (`2001:db8::...` vs full zero-padded upper-case notation), with case-varied synthetic email. Exactly **15 requests reach Better Auth and 9 receive HTTP 429**, with no 500s. The two PostgreSQL keys (canonical IP and normalized email) each record **24** attempts. Neither client-provided prepended X-Forwarded-For text nor IPv6 formatting partitions quota.
- Same test: 36 requests (18 per independently generated synthetic email) at concurrency six across the two API instances, with distinct trusted-IP buckets. **15 admitted and 3 rate-limited independently for each email**, both `auth:mail` counters exactly 18, without errors or cross-account quota sharing.

All tests have finite work counts, limited concurrency, no busy loops, no service attack, and a 30-second assertion deadline. The scenarios use a synthetic trusted-proxy configuration only; production reverse-proxy trust topology remains a separate ingress security gate.

## Repeatability finding and correction

The first concurrency test initially used a **fixed synthetic IP address**. Its first run passed, but a second execution against the **same database within the rate-limit window** yielded more 429s due to a valid persistent IP counter. That was a test-isolation issue, **not a product defect**. Updated both tests to use unique synthetic IPv6 peers on each run. Both scenarios then passed **three consecutive reruns against the same PostgreSQL database**, demonstrating repeatability and preserving actual quota persistence semantics.

Mac local qualification on Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9**, separate disposable databases: **996/996 package tests PASS** (API **737/737** across 97 files, PostgreSQL DB **115/115**, Edge Probe **20/20**, Web **124/124**), all TypeScript/Astro checks and all three production builds (Node API, Edge Probe, Node Web) PASS. Node/PostgreSQL health/config/MCP/dashboard smoke PASS; headless Chromium signup, synthetic monitor/incident/webhook, disabled billing and reset URL privacy PASS; loopback SMTP verification/channel/incident down/recovery/account recovery PASS. PostgreSQL `pg_dump`/`pg_restore` verified **46 tables** (14 nonempty), **nine synthetic organizations**, all row counts and normalized-content SHA-256 fingerprints and eight required SQL functions. All five macOS OS `SIGKILL` monthly-outbox crash boundaries PASS without duplicate email or quota debit. The 638 pinned donor snapshots and active-brand scan are verified separately. Hosted GitHub Actions is independently checked on the exact pushed SHA, not inferred from local tests.

No production rate-limiting logic, quota thresholds, authentication routes, migrations, deployment configuration or repository vendor snapshots were modified. This wave adds reproducible regression coverage and evidence only.

## Remaining release blockers

This run does not measure HTTP requests per second, percentile latency, sustained traffic, pool saturation, many API processes/regions, queue contention, managed PostgreSQL failover/PITR, malicious traffic from untrusted network ingress, CDN rate limiting, or real provider mail/commerce. The existing **hosted load and external ingress review remain OPEN**. Montral stays PRIVATE and release **NO-GO**.
