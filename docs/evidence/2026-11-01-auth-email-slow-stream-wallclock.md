# Public email-auth body: low-rate streaming availability guard

**Date:** 2026-11-01, Asia/Riyadh. PRIVATE synthetic-only Montral work on authorized Mac, Node 24.22.1, local disposable PostgreSQL. No paid or deployed infrastructure and no customer credentials.

## RED — existing size gate could wait indefinitely

`limitedAuthBody()` protects five email-auth endpoint bodies with a strict **16-KiB byte limit**, even against a forged short `Content-Length`, and maintains an untouched clone for Better Auth after successful parsing. It previously awaited `reader.read()` without a wall-clock bound. A one-byte upload that never closed was smaller than 16 KiB but kept an authentication request pending forever, independently of its per-IP/email quota. A dedicated synthetic `ReadableStream` with never-settling `cancel()` returned `still-stalled` after a 160-ms watchdog, rather than timing out (RED).

## Correction (local only)

- Impose **one 10-second total body-read deadline** on the clone; sending slow intermittent chunks cannot reset it. Strict 16-KiB byte cap and per-IP/email quotas are unchanged.
- On deadline, refuse with **HTTP 408** before the auth provider runs. Return a fixed error category and `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- Clear the deadline timer on all paths. On timeout or oversize only, request cancellation of both clone and original without waiting for a remote source that ignores cancellation. On success, preserve the original request body for downstream Better Auth.
- Do not introduce retries, new credentials or cloud dependencies.

## Regressions and qualification

A direct synthetic stream with a 30-ms injectable deadline now rejects and initiates cancellation (GREEN). A separate **real PostgreSQL/Hono** request into public `/api/auth/sign-in/email` remains below 16 KiB, never closes, and deterministically returns HTTP 408 with the privacy headers and fixed non-credential error. The synthetic cancellation promise never resolves, yet the response completes.

**Focused 10/10** tests pass across the auth body-budget and hardening E2E suites; API TypeScript typecheck passes. Existing normal signup/login, quota and 413 tests remain intact. This does not prove a production reverse-proxy body/sockets timeout, distributed load fairness, mail delivery, OAuth network correctness or hosted recovery. Hosted CI on exact pushed SHA remains a separate release gate. Commercial launch remains **NO-GO**.

## Supported-runtime full local qualification

After creating an independent clean `montral_test_*` PostgreSQL database, the entire test matrix passed **1,007/1,007** tests: API **748/748** across 97 files, PostgreSQL **115/115** across 10 files, Probe **20/20** across 4 files, and Web **124/124** across 26 files. All monorepo TypeScript/Astro checks and production API Node, Edge Probe, and Astro web builds passed. All **638** pinned donor source-file hashes and the Montral-only active-branding scan passed.

These are **local synthetic/PostgreSQL qualifications**, not external production load, payment-provider, SMTP, Cloudflare rollout, hosted disaster recovery, or legal review. The previously pushed `9eb1608` app CI was still in progress while this new correction was being qualified; new hosted CI must be verified for its own exact final SHA.
