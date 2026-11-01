# Monitored outbound HTTP response cap — do not await hostile cancellation

**Date:** 2026-11-01 Asia/Riyadh. Authorized Mac, private Montral GitHub repository, zero-cost and synthetic-only streams. No external network or production monitoring.

## RED — 8-byte cap still allowed an unbounded wait

The shared `readCapped(res, max)` function in the SSRF-guarded networking module is used by HTTP checks, probe capability reading, DNS-over-HTTPS and alert provider result parsing. It already stops buffering at the byte cap but the cap-exit branch did `await reader.cancel()`. A legal web-stream source may return a Promise from `cancel()` that never settles. A deterministic synthetic `ReadableStream` delivered 11 ASCII bytes with an 8-byte cap, then returned a never-settling cancel promise. **RED:** the reader failed to return even the first eight bytes and a separate 180-ms watchdog yielded `still-stalled`.

## Correction and regressions

- Keep the existing byte-exact cap, UTF-8 streaming TextDecoder and first-`max` bytes result.
- On cap or unexpected read error, **initiate cancellation but do not await** its fulfillment. Release the reader lock; a remote stream cannot delay a completed bounded read via its cancel hook.
- On normal complete body, preserve the full decoded content; return empty for nonpositive cap or absent body.
- Synthetic RED→GREEN regression now yields **`abcdefgh`** at an 8-byte cap even when cancellation never settles, and a separate small normal response remains `OK`. Entire dedicated networking security test file **16/16** PASS, API TypeScript typecheck PASS.

## Full fresh-database Mac qualification

On supported Node **24.22.1**, with an independently fresh disposable PostgreSQL database and resource-bounded Vitest workers (API 2, DB 1), all **1,012/1,012** tests passed: API **753/753** across 97 files, PostgreSQL **115/115** across 10 files, Probe **20/20**, built Web **124/124**. All monorepo TypeScript/Astro checks and Node API, Edge Probe and Web build targets passed; **638/638** donor source hashes and active-branding guard passed. This is synthetic local verification, not hosted provider or real internet load. The previously pushed billing `d81f27f` hosted CI is separately tracked, and final exact-SHA hosted checks must be checked before claiming hosted qualification.

## Scope / release blockers

This fixes a post-cap cancellation hang, not every possible network source that refuses to yield the next chunk. Existing fetch deadline/SSRF protections remain separate and should still be validated at real proxy/cloud ingress. No external DNS/Cloudflare/SMTP/provider load, browser claims or production deployment are made. Hosted CI must pass exact resulting SHA. Montral stays private, **NO-GO**.
