# Montral subscription cancellation and checkout race qualification

Date: **2026-10-30**, source starting at private commit `64a48cd99e73cbbe082565e70aaff4068c60217d`.

## Engineering security defects addressed

1. **Indefinite paid access after cancellation:** Previous `createMontralEntitlements` trusted provider status `cancelled` indefinitely if the provider's expiration event was not delivered. Signed Lemon Squeezy subscription payloads can include `ends_at`. The preview now stores this timestamp in PostgreSQL and treats a cancelled subscription as eligible only until its known **future** deadline. Missing, invalid or past deadlines downgrade to Free automatically at read time, without depending on a webhook or background scheduler. A test-mode subscription and configured test merchant are also required to grant Pro or Business privileges.
2. **Provider webhook before checkout intent persistence:** Previous `POST /api/billing/checkout` contacted the provider before saving Montral's server-issued nonce. A fast callback could arrive while the nonce did not yet exist and fail correlation. The code now saves the short-lived checkout intent **before** calling the provider, and removes it if the provider returns an error (unless a callback already consumed it).
3. **Migration from older preview:** The existing `montral_subscription` schema is extended using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ends_at`, and the obsolete seven-argument SQL billing event function is retired before installing the deadline-aware eight-argument version. The historical donors remain unchanged.
4. **Dashboard clarity:** A cancelled subscription with a future expiration shows the end timestamp; otherwise the dashboard explains that paid access has ended. The preview still cannot charge money and is disabled by default.
5. **Protocol consistency:** If the signed merchant callback includes an `X-Event-Name` header, its value must match the event name in the HMAC-protected body.

## Local test environment

Only authorized Mac Desktop Commander, private GitHub and disposable PostgreSQL 17.9 on **127.0.0.1:55443**, database `montral_test_20261030f`. No customer data, provider credentials, cloud deployment, public release or real paid transactions. The existing Mac PostgreSQL on 5432 was left untouched.

## Regression test coverage

`apps/api/src/montral-billing.e2e.test.ts` adds real PostgreSQL-backed checks that:
- create a signed synthetic active subscription, cancel it with a future `ends_at`, and verify Pro privileges remain only through that deadline;
- simulate the deadline passing **without a new provider event**, and verify paid privileges are revoked;
- fail closed when `ends_at` is missing or the row is not a test subscription, or the test merchant is disabled;
- intercept a fake test-checkout request and assert the checkout nonce already exists **before** simulated provider response;
- simulate provider failure and verify the orphaned checkout intent is discarded.

The parser also rejects malformed `ends_at` fields. Existing suite covers HMAC, replay idempotency, matching store and variants, unknown intent, stale events, concurrency, OAuth grants, real Chromium web UI and workerd Edge Probe.

Official protocol references: https://docs.lemonsqueezy.com/help/webhooks/event-types ; https://docs.lemonsqueezy.com/help/webhooks/webhook-requests ; https://docs.lemonsqueezy.com/api/checkouts/create-checkout .

## Verified local results

- PostgreSQL-backed billing regression: **11/11** focused tests passed, including two new end-to-end cases.
- Complete Montral API test suite: **551/551**, 73 files, with isolated PostgreSQL 17.
- Web test suite: **122/122**, 25 files (after the Node-target build).
- Probe test suite: **20/20**, 4 files. **Grand total: 693 tests passing.**
- TypeScript/Astro monorepo checks, production Node API, self-hosted Node web, Edge Worker bundles: **PASS**.
- Real Node+PostgreSQL smoke and Chromium signup/webhook-receiver/event viewer/disabled-billing journey: **PASS**.
- Immutable donor source verification: **638 files matched**.
- Backward-compatibility drill on a separate disposable `montral_test_upgrade_20261030f` database: cloned the synthetic baseline, removed the new `ends_at` field and added a deliberately obsolete seven-argument SQL billing function to simulate the earlier preview. The new migration and seven billing E2E tests passed; the restored schema has **one `ends_at` column and only the eight-argument function**. This proves the local preview upgrade path without touching the existing Mac PostgreSQL service.

The Mac currently runs Node v26.0.0, which is outside the repository's declared supported Node 26 minimum. Hosted CI is still blocked before runner allocation; these are local results, not a production certification.

## Boundaries remaining before commercial release

- **Only sandbox/test-mode billing exists; no real merchant is connected**. The provider's real test store, exact live webhook shape, cancellation trial/grace policies, renewal proration, refunds, portal, and accounting remain to be qualified independently.
- GitHub Actions is blocked before runner assignment; local tests are not hosted CI or a supported-Node-version certification.
- The marketing/operational launch, hosted backup/restore, cloud DNS/regions, outbound notifications, legal/privacy policies and chargeback recovery remain unresolved.
- This code must not be used to grant real paid entitlements until complete payment-provider and legal qualification.
