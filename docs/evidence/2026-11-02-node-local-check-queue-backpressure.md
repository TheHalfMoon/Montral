# Bounded self-hosted Node monitor queue and atomic backpressure

**2026-11-02 Asia/Riyadh — Engineering branch.** No production rollout, no real monitors or external providers.

## Risk and approach

The self-hosted Node entry point previously scheduled a new timer for every local queue message and pushed ready messages into an unbounded in-memory array. During slow or stalled checks, repeated scheduler ticks could accumulate arbitrarily many timers and ready messages even though only four checks ran concurrently. The existing scheduler already has a safe recovery path: if `sendBatch()` rejects, it releases **that batch and every remaining unsent monitor lease** for the next tick. That recovery is correct only when the batch is accepted **all-or-nothing**.

Introduced `createLocalCheckQueue`:
- A finite **512-message** per-process capacity counts waiting, delayed and in-flight messages, not merely the number of active checks. Four checks may execute concurrently by default.
- Each batch is validated and capacity checked **before** any timer, ready-message push or reservation occurs. A rejected batch is never partially enqueued; the scheduler's existing `releaseClaims` path can safely release unsent claims and retry on later ticks.
- A completed or failed check frees its reservation; synchronous handler exceptions are also caught, and external diagnostics remain redacted. Slots are reserved while delay timers are pending.
- The Cloudflare Workers production queue and its semantics remain **untouched**. This is a resource safety guard for self-hosted Node only; it is **not a durable, multi-replica broker**.

The new regression suite covers running/ready saturation, delayed timer saturation, atomic invalid-batch rejection, capacity recovery after a throwing handler, and configuration validation. The full GitHub Actions pipeline provides types/build/PG/browser/SMTP/restore gates. Local Mac validation could not run in this session because Remote Desktop Commander reached its monthly usage limit; the GitHub connector remains connected and the branch is intentionally private until independent CI qualification.

## Release limits

The cap mitigates unbounded in-memory queue growth but does not prove crash-safe redelivery, multi-replica scheduling or managed queue guarantees. Existing no-cloud/no-paid/no-production authorization and **NO-GO commercial release** remain unchanged.
