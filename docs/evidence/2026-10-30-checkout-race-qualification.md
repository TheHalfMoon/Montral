# Montral — atomic test-checkout reservation and subscription identity qualification

Date: **2026-10-30**. Source base at beginning of wave: private `TheHalfMoon/Montral`, commit `7c450b804969e53742d185704dd79b870506fc97`. Work performed on authorized **Mac only**; all test data synthetic.

## Failure modes corrected

**Concurrent checkout duplicates.** The prior authenticated `POST /api/billing/checkout` checked active subscriptions and then inserted its checkout intent in separate database statements. Concurrent requests from the same workspace could all pass the preflight check, producing multiple test-mode provider checkout links.

A new `montral_reserve_billing_intent` PostgreSQL function obtains a transaction-level advisory lock keyed to the **workspace**, verifies there is no active subscription and no unconsumed unexpired checkout intent, and inserts exactly one intent in the same transaction. Different workspaces are not globally locked. A partial index accelerates the pending-intent lookup. The provider request remains strictly **test mode**, its API redirect policy is now `redirect: "error"`, and the original cleanup of failed provider calls remains.

**Legacy duplicate subscription creation.** Workspaces might already have two unconsumed intents saved by earlier previews. The signed `subscription_created` handler now acquires the *same workspace advisory lock* after resolving the original server-created intent; a different provider subscription cannot replace an already active one, and a matching provider ID or a genuinely expired previous subscription is required for the upsert. Badly matched events return `unmatched` before the event ledger or intent is consumed.

**Nothing enables real charges.** Billing remains behind `MONTRAL_BILLING_ENABLED=true` and `MONTRAL_BILLING_MODE=test`, and no production merchant integration is implemented or enabled.

## Reproducible test evidence

- `apps/api/src/montral-billing.e2e.test.ts` tests **eight simultaneous authenticated checkout requests** from one workspace with a fake payment provider response. One request succeeds with a test checkout; seven return HTTP 409; the provider is invoked exactly once and exactly one active intent is created.
- Repeated checkout requests are refused while an earlier test checkout is still valid; expired intents allow a new checkout.
- Active subscriptions block creation of a new checkout.
- Two historically saved pending intents are simulated; a second signed `subscription_created` event for a different provider is rejected without replacing an active subscription or consuming the second intent. Signed subsequent updates for the unknown provider are rejected.
- Fake payment responses and synthetic signed webhooks: **no external merchant contact or payment attempt**.

## Final qualification

| Verification | Outcome |
|---|---|
| Full API on isolated real PostgreSQL 17 | **560 / 560 passing, 74 files** |
| Web test suite, after Node-target web build | **122 / 122 passing, 25 files** |
| Probe suite | **20 / 20 passing, 4 files** |
| Total | **702 passing tests** |
| Monorepo TypeScript / Astro | PASS, zero diagnostic errors |
| Node API and web + optional Edge Probe build | PASS |
| Node + PostgreSQL health/config/MCP/web smoke | PASS |
| Real headless Chromium signup/webhook inspection/disabled-billing journey | PASS |
| Real disposable pg_dump/pg_restore | PASS — 42 tables, 122 synthetic organizations, **5** essential Montral SQL functions restored (including the new checkout reservation) |
| Original donor source integrity | PASS — 638 files matching three pinned source snapshots |

Test database `montral_test_20261030i` was isolated to Mac loopback `127.0.0.1:55446`; the owner's existing PostgreSQL on port 5432 was left untouched. Test checkouts used fake fetchers, not Lemon Squeezy's hosted store. The installed Mac Node is v26.0.0, outside the repo's declared supported minimum, so CI on the pinned Node version remains required.

## Release gates still outstanding

The private repository's GitHub Actions have not produced green runner-backed evidence. At the beginning of the wave the prior commit's jobs included queued/failed runs before runner allocation. No real Lemon Squeezy test merchant, real customer payment, production account lifecycle, hosted Cloudflare region, real SMTP verification, managed DB PITR, security/privacy/legal approval or public deployment occurred. **No live launch or charging is authorized.**

This local qualification closes the concurrent test-checkout and active provider-identity issues only; it does not qualify production commerce.
