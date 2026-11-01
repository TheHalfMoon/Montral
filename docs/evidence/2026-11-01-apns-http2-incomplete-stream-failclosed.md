# APNs Node HTTP/2 fail-closed on prematurely closed or aborted streams

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** Montral private Node APNs client, entirely synthetic in-process HTTP/2 event emitters and local PostgreSQL qualification; no real Apple credentials or endpoint.

## Reproduced failure

After the preceding 64-KiB response-body hardening, the Node APNs HTTP/2 request still handled `response`, `data`, `end` and `error` but not the stream lifecycle events `close` or `aborted`. A remote stream could supply a status (including 410) and partial JSON, then close without `end`; the request would stay pending until its full ten-second timeout, unnecessarily delaying the notification path. An `aborted` event followed by `end` could also be mistaken for a completed response. Correct behavior is an immediate retryable transport failure; never return an incomplete HTTP 410 as grounds to delete the device token.

A new deterministic `apns-http2-lifecycle.test.ts` fixture injects a synthetic Node-style HTTP/2 stream with no sockets. **RED**: two of four cases failed because the promise did not reject on `close` or `aborted`. Existing byte-overflow and normal complete split-UTF8 cases passed. The tests require neither network access nor a real Apple device.

## Minimal correction

Extracted the existing Node per-stream send to `sendHttp2Request` (exported only for local deterministic protocol regression testing, no HTTP route or new privilege). The same `http2Transport` reuses it. A premature `close` now rejects with a constant `APNs stream closed before completion`; `aborted` rejects with a constant `APNs stream aborted`. The pre-existing `settled` guard ensures that a subsequent `end` or `error` cannot override that rejection, and the ordinary timeout is cleared when the request fails. Complete responses, UTF-8 decoding, 64-KiB response limit, APNs bearer JWT, host selection, channel behavior and device death decisions remain unchanged.

**GREEN:** all four local HTTP/2 event cases and all current APNs/response-limit cases, **27/27** total. The error text is fixed and does not include a device bearer token. Real APNs uptime, latency, connection-level/session replacement, and iOS push delivery are not qualified by these tests.

## Qualification

Full local Mac qualification (Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9**, fresh disposable real PostgreSQL databases): **980/980 package tests PASS** across API **722/722** (92 files), PostgreSQL DB **114/114** with explicit `DATABASE_URL`, Edge Probe **20/20**, and built Web **124/124**. All TypeScript/Astro checks and three production builds (Node API, Edge Probe and Node Web) PASS. The four new deterministic Node HTTP/2 protocol tests were included in the full API suite.

Extra local qualification PASS: live Node/PostgreSQL service smoke for health/config/MCP/dashboard; headless Chromium signup, monitor, incident, webhook, disabled billing and reset-link privacy; loopback-only production Node SMTP verification/channel/incident recovery/account reset; `pg_dump` / `pg_restore` for **46 tables** (14 nonempty), **nine synthetic organizations**, all exact row counts and normalized-content SHA-256 fingerprints and eight SQL functions; five real OS `SIGKILL` monthly outbox crash boundaries (no replay or double debit). Pinned **638 original donor files** and active brand scan verified. GitHub-hosted CI on the new exact commit must be checked separately; local green does not imply hosted green. No paid service, deployment, production traffic or device registration is authorized.
