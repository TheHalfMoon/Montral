# Resource-bounded authenticated JSON body reads

**Date:** 2026-11-02 Asia/Riyadh. Private Montral source, authorized Mac, Node v24.22.1 and isolated local PostgreSQL. Synthetic credentials only. No paid services, Cloudflare deployment, third-party email or real merchant traffic.

## Defect (RED)

The authenticated API parsed JSON before applying a size budget on three small endpoints:
- `POST /api/workspaces`: valid name plus ~24 KiB ignored padding created an actual workspace, returning **201**, instead of refusing the unnecessary body.
- `PATCH /api/me/locale`: valid locale plus ~24 KiB ignored padding updated the user, returning **200**.
- `POST /api/monitors/:id/check`: ~24 KiB ignored padding was parsed before the monitor lookup (returned **404**), instead of rejecting early.

Three real mounted Hono/authenticated/PostgreSQL tests initially failed against the old code with actual HTTP statuses above. Unrestricted JSON parsing can exhaust worker memory; even small valid prefixes can be held open by slow senders.

Monitor import/preview already had a correct **4 MiB Hono bodyLimit** but its limit did not independently establish a total elapsed-time deadline while receiving a trickle of bytes. Existing import normalization, row count (1..500), credential redaction and duplicate protections must remain intact.

## Change (GREEN)

Added shared `limitedJsonBody(request, maxBytes, timeoutMs=10000)`:
- Consumes **the original ReadableStream once** (no `request.clone()` tee buffer). Checks `Content-Length` early when trustworthy but never relies on it: forged small values cannot bypass the byte-exact actual stream counter.
- Rejects oversized bodies **413** before JSON parsing or business mutations; **one 10-second wall-clock read deadline**, not a per-chunk reset, rejects nonterminating/slowing streams **408**.
- Does not await a peer-controlled `cancel()` promise on abort or over-budget termination. Does not log body content, user fields or credentials. Invalid/empty JSON retains the route's original validation fallback.
- Applies **1,024 bytes** to workspace creation, locale update and manual monitor spot-check region selection.
- Applies **4 MiB unchanged** to monitor import and import preview, replacing the Hono-only budget so slow streams also terminate; monitor import and privacy/identity/plan-capacity logic remains unchanged.

New tests include unit cases for forged/huge Content-Length, a nonsettling stream cancellation, a never-ending slow sender and normal/invalid small JSON; authenticated real PostgreSQL HTTP tests for all three oversized routes and a complete actual **10-second** import timeout returning **408** without import writes. Prior monitor import integration suite continues to qualify normalized export/import and permission/duplicate behavior.

## Qualification caveats

This is a local request-body resource hardening fix. It does not qualify external Cloudflare ingress rate limiting, edge distributed load, live regional egress, managed PostgreSQL recovery, external SMTP deliverability or merchant payments. **NO-GO commercial release** remains in force.

## Verified full supported-runtime local result

Authorized Mac, Node **v24.22.1**, pnpm 10, isolated PostgreSQL, API maxWorkers=2 and DB maxWorkers=1. Complete supported package suite **1,038/1,038 PASS**: API **779/779** across 99 files (including 9 new bounded JSON tests and the actual 10-second stalled import HTTP request), PostgreSQL **115/115** in 10 files, Probe **20/20** in 4 files, Web **124/124** in 26 files. Monorepo TypeScript/Astro typechecks **PASS** (one nonblocking Astro React FormEvent deprecation hint), Node API/Edge Probe/Astro Web production builds **PASS**, pinned donor source integrity **638/638 PASS**, active Montral branding scan **PASS**. Both hosted exact-SHA GitHub workflow results are tracked independently.
