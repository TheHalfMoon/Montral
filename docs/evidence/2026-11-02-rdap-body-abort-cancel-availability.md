# RDAP response stream deadline and nonblocking cancellation

**Date:** 2026-11-02 Asia/Riyadh. Authorized Mac, Node 24.22.1, private Montral repository, synthetic RDAP registry streams only; no external registry calls, deployment, paid providers or customer data.

## Fault discovered (RED)

Montral's domain-expiry RDAP check had an HTTPS/public-only/SSRF-filtered `guardedFetch` that accepted an `AbortSignal.timeout(input.timeoutMs)`, and a **1 MiB** byte cap on RDAP JSON. But it awaited `reader.cancel()` in the body read's `finally` even if a remote stream's cancellation never settled; it also awaited the error response's `res.body.cancel()` on HTTP 429, and the reader did not independently race its `reader.read()` against the abort signal. The monitored domain check could stall indefinitely even after a stream exceeded the size cap or the intended request deadline elapsed.

Three direct synthetic tests initially **failed** against the original source, each returning the `still-stalled` watchdog:
- A registry error **HTTP 429** with a stream whose cancellation never resolves.
- A **1 MiB + 1 byte** RDAP response with a never-settling cancellation.
- A **one-byte** response that never reaches EOF, with a **35 ms** network-check timeout. The injected fetch mock deliberately ignores the signal; a compliant bounded reader must still terminate.

## Change (GREEN)

- A rejected/non-OK RDAP registry response now initiates best-effort cancellation **without awaiting** it and returns the existing HTTP status classification (including 429).
- The response reader races each pending read against the **same AbortSignal** already passed to the guarded fetch. A signal abort produces a fixed `RDAP response read timed out` diagnostic and exits; slow byte drip cannot reset the deadline.
- A rejected size cap, read error or abort initiates nonblocking cancellation and releases the reader lock, without holding the domain scheduler on a sender-controlled promise. Normal EOF avoids unnecessary cancellation.
- Preserve **1 MiB** memory cap, strict public HTTPS no-redirect policy, SSRF checks, registry bootstrap and expiration parsing, short negative cache, positive cache and inconclusive offline state. This change is confined to response consumption and cancellation.

**Focused RED 3 failures → GREEN 16/16 RDAP tests pass.** Existing tests still validate registry suffix selection, date selection, cache logic, 429 handling, SSRF guard options, unknown state on invalid data, and real PostgreSQL separate from these synthetic unit tests.

## Remaining qualification

Hosted domain-registry behavior, real DNS/egress and multi-region Cloudflare, provider rate limits, production alert correctness, real scheduler availability and infrastructure abuse/load remain unqualified. Private code-only change; **commercial release remains NO-GO**. Full local regression and exact-SHA GitHub-hosted CI results are recorded separately once observed.

## Complete supported-runtime local qualification

On an independently fresh disposable PostgreSQL database with authorized Mac Node **24.22.1**, resource-bounded test workers (API 2, DB 1): **1,024/1,024 package tests PASS**, API **765/765** across 97 files, PostgreSQL **115/115** across 10 files, Probe **20/20** across 4 files and built Web **124/124** across 26 files. Monorepo TypeScript and Astro typechecks, Node API production build, Cloudflare Edge Probe bundle, Astro Web build, **638** donor file provenance hashes and active Montral brand scan **all PASS**. Hosted exact-commit Actions app/source checks are separate.
