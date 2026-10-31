# Montral — secret-bearing webhook response privacy qualification

**Date:** 2026-10-31. **Repository:** PRIVATE `TheHalfMoon/Montral`. Base commit `62ae32cb7d13b37094347b782c736135c3edd97b`. Performed on authorized Mac, with an isolated local PostgreSQL 17 database and synthetic webhook events.

## Risk closed

A Montral webhook receiver URL embeds a 256-bit bearer token in the request path. Some webhook platforms and administrators use URLs in browser consoles, debugging tools and intermediary caches. Prior to this change, authenticated inbox endpoints sent `Cache-Control: private, no-store` and `nosniff`, while the public receiver had cache instructions only for successful receipts. Error paths (invalid tokens, body limit, malformed UTF-8 and throttling) did **not** uniformly advertise a no-store/referrer policy. One-time inbox creation and successful receipts also explicitly overwrote their middleware cache policy with `no-store`.

The new shared privacy middleware covers both manager-only inbox routes and public receive routes, before route-specific handlers. All normal and refusal responses now explicitly return:

| Header | Value | Purpose |
|---|---|---|
| `Cache-Control` | `private, no-store` | Do not retain secret paths or event bodies in response caches |
| `Referrer-Policy` | `no-referrer` | Restrict browser-initiated referrer propagation |
| `X-Content-Type-Options` | `nosniff` | Avoid MIME-type confusion for responses |
| `X-Robots-Tag` | `noindex, nofollow` | Tell cooperating indexers not to index secret receiver paths |

Route-specific overrides were removed; the same policy now applies to 201 creation, 202 receiver success, 200 authenticated event reads, and 404 / 413 / 422 / 429 refusals.

This is a **defense-in-depth response-header improvement**, not protection against a reverse proxy or access logger that already records incoming URL paths; infrastructure must redact bearer URLs and avoid collecting bodies, and end users still must treat the one-time receiver URL as a password.

## Automated verification

- New unit and real PostgreSQL E2E assertions prove the same four headers on 201, 202, 404, 413, 422, 429 paths.
- Existing manager access, per-project isolation, SHA-256 receiver-token verification, request-size/UTF-8 limit, event cap, concurrent deletion and expiration behavior stay intact.
- Focused hook unit/PostgreSQL suites **12/12 PASS**.
- Full API **569/569** tests (77 files), Web **122/122** (25 files after Node-target build) and Probe **20/20** (4 files): **711 total passing tests**.
- Monorepo TypeScript/Astro checks passed; Node API, Node web and optional Edge Probe builds all passed.
- Real Node+PostgreSQL smoke passed (health, config, MCP discovery and HTML dashboard).
- Real Chromium browser smoke passed: signup, synthetic heartbeat monitor, manual incident lifecycle, webhook receiver/event inspector and disabled billing.
- Production Node SMTP over loopback passed: synthetic channel email plus cron-created down and recovery alerts, without external email.
- Disposable `pg_dump` / `pg_restore` passed: **42 tables, 127 synthetic organizations and 5 transactional SQL functions** recovered.
- All **638 pinned donor files** matched original SHA-256 manifests.
- PostgreSQL used only temporary `127.0.0.1:55455/montral_test_20261031r`; the Mac's existing PostgreSQL instance at 5432 was untouched.

## Boundaries

No external provider, third-party webhook system, Cloudflare deployment, real merchant or customer data was used. Hosted proxy access-log scrubbing, CDN behavior, source at-rest encryption/key rotation, privacy policy, prolonged load and real CI (GitHub-hosted jobs failing before runner provisioning) still require separate qualification. Node v26.0.0 on this Mac is outside the declared supported Node v26.12.1+ range; local success is not hosted supported-Node approval.

The repository remains PRIVATE and is not cleared for commercial launch.
