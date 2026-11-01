# Remote regional probe responses: bounded memory and private error diagnostics

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private Montral API regional probe client, synthetic fetch responses and local PostgreSQL qualification only. No actual deployed probe, customer target, paid service or external DNS/egress changed.

## Two problems reproduced before correction

1. `runInRegion` in `apps/api/src/probes.ts` called `res.json()` on an HTTP 200 probe reply, buffering the entire external provider body without a response-size bound. A 32-KiB fake response containing an otherwise valid failure JSON was counted as a *real monitored-target failure*, despite the excessive body. An unbounded source could exhaust worker memory, and could falsely affect monitor state.
2. Its catch handler returned `Probe unreachable: ${err.message}` verbatim. Fetch/client errors can include URL, headers, or authentication details, and regional `unreachable` summaries are logged by `measure`. A synthetic rejected fetch with an `Authorization` marker surfaced that marker in the returned result.

**RED**: two of the three initial targeted tests failed, demonstrating both behaviors on the original implementation. Existing small UTF-8 outcome test succeeded.

## Fix

A new `readProbeReply` incrementally reads remote successful probe bodies, with a strict **16 KiB byte limit**. The reader cancels without waiting for a potentially endless upstream when the budget is exceeded. Invalid UTF-8 or JSON is never accepted as a measured result. Oversized responses become `unreachable: Probe response exceeded 16 KiB limit` (not a target failure); failed fetches return a fixed `Probe unreachable` message, while recognized request timeouts continue returning `Probe did not answer in time`. No original error object/message, authorization header or token is forwarded to regional summaries.

The established signed request format, capability preflight, timeout, region configuration, aggregation/voting, and local fallback remain unchanged. `GET`/`HEAD` probe capability checking remains bound by its existing 4 KiB budget, and target failure outcomes inside a valid small provider response preserve their existing behavior.

**GREEN:** the four direct regression cases (32-KiB finite response, injected private fetch error, never-ending 8-KiB chunks with confirmed stream cancellation and few reads, small valid Unicode metrics) plus previous request-region unit tests **30/30 PASS**. The endless stream was tested only after the bounded fix was in place.

## Qualification and release limitations

Mac local qualification on Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9**, separate disposable databases: **986/986 package tests PASS** (API **728/728** across 95 files, DB **114/114**, Probe **20/20**, Web **124/124**). TypeScript/Astro and three production builds (Node API, Edge Probe, Node Web) PASS. Runtime Node/PostgreSQL health/config/MCP/dashboard smoke PASS; real headless Chromium signup, monitor, incident, webhook, disabled billing, reset-link privacy and unauthenticated protections PASS. Loopback-only SMTP verification, channel test, automatic incident down/recovery and account recovery PASS. PostgreSQL dump/restore verified all **46 tables** (14 nonempty), **nine synthetic organizations**, all row counts and SHA-256 normalized content fingerprints and eight SQL functions. Five real OS `SIGKILL` monthly-outbox crash/recovery boundaries PASS with no duplicated recipient delivery or quota. **638 pinned donor source snapshots** and active-brand scan verified unchanged. GitHub-hosted CI on the exact new revision must still be independently checked; local PASS is not hosted qualification. No real multi-region deployment, representative network loss/load, Cloudflare ingress/DNS, Apple APNs or commercial provider has been verified here. The project's hosted production and security/legal gates remain **OPEN** and release stays **NO-GO**.
