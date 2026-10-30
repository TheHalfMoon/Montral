# Montral — billing, metering and scoped MCP qualification

Date: **2026-10-30**. Repository: **PRIVATE** `TheHalfMoon/Montral`. Source checkout at the start of this wave: `bcca45da781c2706a0d8cce0ea83df3967b2a06b`. All work was performed on the authorized Mac only; Windows was not used.

## Test environment

- Temporary PostgreSQL 17.9 at `127.0.0.1:55440`, isolated cluster `/tmp/montral-pg-20261030c` and a synthetic-only database `montral_test_20261030c`. The user's existing 5432 Postgres server was not modified.
- pnpm dependencies installed only inside `/tmp/montral-dev-20261030c`; build artifacts and this database are disposable after remote GitHub verification.
- No production deployment, no connected merchant, no real payment/test checkout with an external vendor, and no new paid subscriptions, provider API keys, domains, or public artifacts.

## Local reproducible evidence

| Test/build | Verified outcome |
|---|---|
| Donor snapshot SHA-256 integrity | **638 unchanged files, PASS** |
| TypeScript/Astro monorepo | All packages PASS |
| API suites with real PostgreSQL | **544 passing, 0 skipped, 72 files** |
| Web suites | **122 passing, 0 skipped, 25 files** (1 prior skipped test verified by a subsequent complete run) |
| Probe suites | **20 passing, 0 skipped, 4 files** |
| Node API production bundle | PASS |
| Node-target Astro production build | PASS |
| Optional Cloudflare probe bundle | PASS, no real Cloudflare deployment |
| Node + PostgreSQL API and app live smoke | PASS: health, config, MCP discovery and HTML dashboard |

**Total: 686 passing tests, 0 skipped in the final respective suite runs.** Tests include legacy core behavior and the newly added synthetic commerce and scope cases.

## New Montral security coverage

`apps/api/src/oauth-scope.e2e.test.ts` uses real OAuth PKCE, scope grants, project-scoped API keys and actual Montral webhook/MCP paths. Checked: restricted project Alpha cannot read Beta events, read-only OAuth cannot create inboxes, write grants can create, API-key metadata cannot expand project or workspace scope, and new MCP tools respect these grants.

## Commercial integration: PRIVATE TEST MODE ONLY

`apps/api/src/montral-billing.ts` provides an off-by-default Lemon Squeezy adapter:
- Requires `MONTRAL_BILLING_ENABLED=true`, `MONTRAL_BILLING_MODE=test`, sandbox key, HMAC webhook secret, store ID and Pro/Business variant IDs.
- Provider checkout request explicitly sets `test_mode=true`, **also verifies the response's `test_mode=true`** and rejects untrusted checkout URL hosts.
- Server-issued checkout intent nonce maps the correct organization and variant, is valid for 30 minutes and single-use. Subscription events require HMAC-SHA256 signature, correct store, true `test_mode` and allowed subscription state.
- Transactional PostgreSQL event application, replay digest deduplication, stale-event protection, and duplicate active-subscription purchase refusal.
- Unit tests inject a fake fetcher: **no real provider network calls or charges occurred**. E2E uses synthetic signed provider events against PostgreSQL.
- Browser route `/app/billing` shows state and only offers test checkout when the fake/test merchant is fully configured.

`apps/api/src/montral-metering.ts` adds **separately opt-in** `MONTRAL_METERING_ENABLED=true` atomic monthly credit+email usage accounting and preview plan limits, reusing the existing monitor entitlement interface. Concurrent PostgreSQL requests verified the hard spending cap. Plans are experimental; dates use calendar UTC, not real provider renewal alignment. No production pricing is fixed.

## Identity and provenance

Active packages, UI, documentation and runtime product references use Montral. False upstream GitHub container image links, unpublished skill-package installation commands and unverified MCP Registry listing claims were removed. Historical donor licenses, copyright and source provenance remain unchanged under `vendor/`. The repo stays private.

## Still NOT production-qualified

GitHub Actions continues to fail before runner assignment with no steps executed on main at prior checks; this is not a green CI. Real merchant test-store checkout and webhook redelivery, production provider settlement, cancellation/refund reconciliation, cost/credit load tests, browser E2E, provider portal, backup/restore, real Cloudflare egress/region tests, live email deliverability, and business/legal readiness remain incomplete. **No public launch and no charging customers.**

See `docs/BILLING-SANDBOX.md` and `docs/RELEASE-GATES.md`.
