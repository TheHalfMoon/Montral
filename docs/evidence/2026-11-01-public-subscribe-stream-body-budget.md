# Public status subscription — body-size and time-budget protection

**Date:** 2026-11-01 Asia/Riyadh. Authorized Mac, private Montral repository, synthetic stream and HTTP tests with no external SMTP, real subscriber data, provider activation or deployment.

## RED — valid JSON parsed before size refusal

The unauthenticated `POST /api/public/status/:slug/subscribe` route passed the HTTP request directly to Hono's `zValidator("json", ...)`, without any independent byte budget or upload duration. Even though the schema accepts one email and at most 200 monitor UUIDs, a client could send a much larger body or never close a partial JSON upload. A synthetic Hono fixture sent **24 KiB** of padding alongside a valid email with forged **Content-Length: 5**. The pre-fix response was **404** (the request was parsed then reached the nonexistent test page), rather than early **413**. This test proved oversized parsing; time-bound behavior was also absent from the previous parser.

## GREEN — bounded before side effects

- Add **12 KiB** of byte-exact request budget, enough for the maximum **200** UUIDs plus email, with a **single, non-resetting 10-second wall-clock read deadline**. Ignore incorrect/forged Content-Length as a source of trust.
- A cloned request stream is inspected before Hono's original JSON validator, preserving the same valid input for strict Zod schema, rate limits and subscription/mail logic.
- Oversize returns **HTTP 413**; timeout returns **HTTP 408**. Both occur *before* subscriber lookup, rate-limit spending, subscriber insertion, confirmation-token creation or any SMTP attempt.
- On refusal initiate cancellation without awaiting a never-resolving stream cancellation promise, release reader lock, and preserve prior private subscriber response headers via existing middleware: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Robots-Tag: noindex, nofollow`.
- Keep normal validation error semantics, existing per-page, per-IP and per-email shared quotas, non-enumerating confirmation mail and language behavior unchanged.

## Regression protocol

Synthetic RED 24 KiB gave 404, GREEN must give 413 with private response. A direct 30-ms injected deadline tests a one-chunk stalled upload and non-settling cancellation; mounted HTTP exercises the real 10-second clock and 408 response with no subscriber work. A separate fixture sends exactly **200 UUIDs** in valid JSON and expects normal route continuation (404 only because the status page is intentionally absent). Prior subscriber token and 1-KiB unsubscribe route cases remain in the same dedicated test file.

## Open gates

Host ingress/socket-abuse and proxy-level limits, external email verification, cross-browser and Cloudflare multi-region deployments remain OPEN. Private repository. No customer data, paid service, live billing or deployment. Commercial release **NO-GO**.

## Supported-runtime complete local qualification

Authorized Mac, Node **v24.22.1**, independently fresh disposable PostgreSQL database, API Vitest with 2 workers and DB Vitest with 1: **1,021/1,021** package tests passed — API **762/762** across 97 files, DB **115/115** across 10 files, Probe **20/20**, built Web **124/124**. All TypeScript/Astro checks, Node API build, Edge Probe bundle and Astro production build PASSED. **638/638** pinned donor source hash checks and active Montral branding scan PASSED. This does not qualify public cloud ingress, external SMTP, Cloudflare or live billing. Hosted exact-SHA GitHub CI is independently required.
