# Public unsubscribe: total streaming read deadline

**Date:** 2026-11-01 Asia/Riyadh. Authorized Mac and private Montral repo; synthetic-only streams, no external SMTP, mail subscriber data or production provider calls.

## RED — 1 KiB cap does not bound elapsed time

Montral's public `POST /api/public/status/_/unsubscribe?token=...` accepts an empty HTML form or RFC 8058 `List-Unsubscribe=One-Click` body. A 1,024-byte streaming cap, bearer-token response privacy headers and nonblocking oversize cancellation already existed. However, an unauthenticated caller could send just one byte then leave the request stream open indefinitely. A new synthetic mounted Hono test reproduced the original behavior: a valid-token request held open beneath the size cap returned the test sentinel **999** instead of HTTP **408** after a 180-ms watchdog. No subscriber row was mutated, but an HTTP request could remain pending indefinitely.

## GREEN — one fixed 10-second total budget

`unsubscribeOneClick` now races every `reader.read()` against one non-resetting **10-second wall-clock timeout**, covers both idle and byte-drip senders, clears its timer, and initiates cancellation without awaiting a malicious never-settling cancel promise. On timeout, the public route sends HTTP **408**, before calling `removeSubscriber` or changing any subscription. It retains `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `X-Robots-Tag: noindex, nofollow`, without revealing the URL bearer token. The **1,024-byte** budget and HTTP **413** refusal are unchanged. Valid no-body HTML unsubscribe still redirects **303** and a valid one-click protocol body still returns **200**.

## Focused regression evidence

- **RED** mounted one-byte never-ending request did not return within its synthetic watchdog.
- **GREEN** direct helper with injected 30-ms deadline returns fixed typed timeout even if stream cancellation never settles.
- **GREEN** mounted route with the real 10-second deadline replies **408**, keeps privacy headers and performs no subscriber mutation even if cancellation never settles.
- All **7/7** focused token-privacy cases pass on supported Node v24.22.1.

## Open qualification

Real hosted ingress/socket abuse handling, proxy/access-log bearer token scrubbing, actual remote mail-client behaviors, external SMTP deliverability and cloud availability are unverified. This is a local synthetic security regression, not authorization to deploy. Production release remains **NO-GO**. Full local tests and hosted CI qualification are separately recorded.

## Supported-runtime complete local qualification

Node **v24.22.1** on the authorized Mac, fresh disposable local PostgreSQL, Vitest max 2 API workers and 1 DB worker: **1,017/1,017 tests passed** — API **758/758** across 97 files, PostgreSQL **115/115** across 10 files, Probe **20/20**, built Web **124/124**. All monorepo TypeScript/Astro typechecks and API Node, Probe Edge and Astro Web production builds PASSED. The **638/638** pinned donor hashes and active Montral branding guard PASSED. No actual SMTP provider, network exposure or deployment. Hosted exact-SHA CI is separately required.
