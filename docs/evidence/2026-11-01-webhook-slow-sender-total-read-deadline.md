# Webhook streaming total-read deadline: slow sender cannot pin an API request

**2026-11-01 (Asia/Riyadh)** — PRIVATE Montral engineering qualification. Synthetic streams and an isolated Mac test database only. No real customer traffic, deployment, provider or paid service.

## Reproduction (RED)

The receiver already enforced an exact 32-KiB body cap and did not await stalled cancellation on oversize. However, if a sender uploaded a single byte (or kept a stream open with a low sustained byte rate), the next `reader.read()` could remain pending forever because only byte count, not elapsed time, was bounded.

A new regression stream enqueues one byte then never closes. Its cancellation callback also never settles. On the original implementation the test returned `still-stalled` after a 150-ms watchdog rather than the required timeout, reproducing the availability weakness without allocating a large body.

## Correction (GREEN)

- Enforce one 10,000-ms total deadline over the whole streamed body, including gaps between chunks. **This is not a new per-chunk timeout that attackers can reset by dripping bytes.**
- Race the pending body read with the deadline and clear its timer on all success, over-limit and error exits. Request cancellation is initiated without awaiting a non-cooperative stream, and pending read rejections are observed by the race.
- Return HTTP **408** with `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `X-Robots-Tag: noindex, nofollow` for a timed-out valid receiver path. Do **not** capture any event.
- Preserve existing behavior: authenticated receivers, token hashing, per-inbox quotas, exact 32-KiB cap (413), strict UTF-8/NUL handling (422), successful capture (202), invalid token (404) and bounded cancellation.

**Focused synthetic regression result:** 11/11 local webhook tests pass, including direct stalled-read and actual mounted-route 408 with no persisted event, and the prior stalled-cancellation 413 regressions. TypeScript typecheck passed.

## Qualification boundary

This is a bounded application-level defense. It is not evidence that external reverse proxies remove or scrub token URLs from logs, prevent socket exhaustion before app dispatch, or enforce cloud ingress timeouts. Those hosting/abuse/load gates remain OPEN. The repository stays private and release **NO-GO**.

A local package-wide test run on the supported Node 24.22.1 runtime and disposable PostgreSQL is tracked separately from hosted CI. Never treat hosted GitHub Actions (blocked before runner assignment) as successful.

## Supported-runtime integrated Mac qualification

The earlier `main` concurrently acquired the independent **4-KiB inbox-creation JSON budget** fix (`a26d14b`). This change was rebased on top rather than overwriting that feature. The combined code passed focused **19/19** webhook unit + real PostgreSQL E2E tests on Node **24.22.1**.

On a **fresh, named disposable** PostgreSQL test database, the merged source passed **1,003/1,003** tests:
- API **744/744** (97 test files), including the new slow-sender 408 and inbox-creation 413 cases
- PostgreSQL repository **115/115** (10 files, explicitly setting `DATABASE_URL`)
- Edge Probe **20/20** (4 files)
- Web **124/124** (26 files, built pages present)

All workspace TypeScript/Astro checks, the rebuilt Node API bundle, and previous same-wave Edge Probe/Web production builds passed. The donor manifest check verified **638 source files from three pinned snapshots**. The active Montral brand guard passed.

**Non-hidden intermediate caveat:** A rerun on an earlier repeatedly-used test database produced **743/744 API passes**, failing an existing OAuth project-scope fixture that saw an empty inbox list. The same OAuth test passed on a new disposable database, and the complete **744/744 API suite** passed on another new disposable database. This is consistent with test-database reuse/isolation interference but is **not** proof of a specific root cause. Neither a production OAuth fix nor unconditional multi-run stability is claimed; the reused-database anomaly remains qualification evidence.

Hosted GitHub Actions must be independently qualified at the final pushed commit. Provider email, Cloudflare ingress/proxy access logs, hosted disaster recovery, real load, and launch readiness remain **OPEN**. No new external credentials or paid services were used.
