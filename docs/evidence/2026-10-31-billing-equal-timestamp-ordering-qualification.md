# Montral — deterministic ordering for equal-timestamp signed billing events

Date: **2026-10-31**, Asia/Riyadh. **Baseline**: private `TheHalfMoon/Montral`, commit `09709943c0767802278c197d31d1a9c5c35e6f5a`. All testing on authorized Mac and **disposable PostgreSQL**, with synthetic HMAC-signed provider events; no merchant account, test-store connection, real payment, production API credentials or external notification.

## Confirmed defect

The original PostgreSQL `montral_apply_billing_event` function compared subscription timestamps with `<=` for both updates and subscription creations. Two *different valid signed events* can share an identical `updated_at` provider timestamp; the billing event digest only rejects exact payload replays. A cancellation and a second `active` update with the **same timestamp**, received in that order, could therefore restore paid access by making the latter event the final database write. An `expired` subscription could likewise be reset by a second `subscription_created` event for the same provider and timestamp.

This was demonstrated by a **failing red regression test on the unmodified SQL**: an earlier cancellation persisted, but the equal-timestamp active update was still reported `applied`, rather than being discarded.

## Fix

The PostgreSQL SQL function now uses **strictly newer** timestamps as the ordinary chronological update rule. When signed events tie on `provider_updated_at`, it allows only a **more restrictive** state, ranked from `on_trial/active` through paused, past_due, unpaid, cancelled to expired. It also permits a **shorter** cancellation `ends_at` deadline (or an explicit missing deadline) at the same timestamp, never an extension. A less restrictive equal-timestamp update returns `stale` and leaves status/paid entitlement unchanged. Its signed event digest is still stored to preserve one-time replay accounting.

For a `subscription_created` event, a genuinely **different provider** can replace a fully expired provider, regardless of the old provider's separate timestamp stream. A creation using the **same** provider is not allowed to overwrite a later cancelled or expired state on an equal timestamp. Old providers cannot subsequently mutate newly linked subscriptions.

The zero-payments default, test-mode merchant checks, signed webhook verification, server-issued checkout intents and subscription deadlines are unchanged. The stored billing ledger still excludes raw event payload/credit card data.

## Real PostgreSQL regression

The added `montral-billing.e2e.test.ts` scenario performs signed API callbacks and checks persisted subscription state plus entitlements:

1. Active subscription created with a verified, unexpired checkout intent.
2. Signed cancellation with the same provider timestamp is accepted.
3. Contradictory signed active event with the *identical timestamp* returns `stale`; cancellation and its deadline remain intact.
4. Equal-timestamp cancellation with a **shorter** `ends_at` succeeds and shortens paid preview time.
5. Equal-timestamp expired state takes precedence and drops entitlement to the Free plan.
6. A new server-issued intent attempting to recreate the **same provider** with the same timestamp is `stale`, with no renewed paid entitlement.
7. A genuine **new provider** after expiry can use an earlier timestamp from its own clock stream, create a new subscription and obtain its rightful test-mode preview entitlement; the old provider can no longer mutate it.

**Before fix: RED**, proving the active replay was applied incorrectly. **After fix: GREEN**: 16 focused billing tests passed, including the new regression.

## Verification and outstanding gates

The full local requalification **PASSED** on the exact CI-declared **Node v24.22.1 and pnpm 10.0.0**:
- API **573/573** across 78 test files, Web **122/122** across 25 files, Probe **20/20** across four files: **715 passing tests**, no skipped tests.
- All monorepo TypeScript/Astro checks, production Node API, Node-target Web and optional Edge Probe bundles built successfully.
- Real Node/PostgreSQL smoke (health, configuration, MCP discovery, rendered HTML), real headless Chromium (synthetic signup, monitor, manual incident, webhook inspector and billing-disabled), real loopback SMTP (cron-triggered down/recovery notifications) all passed, without contacting hosted services.
- Local PostgreSQL `pg_dump`/`pg_restore` succeeded for **42 tables, 146 synthetic organizations and five transactional functions** in a separate temporary restored database.
- Verified all **638 files** across the three immutable upstream snapshots against their recorded SHA-256 manifests.
- Database: disposable PostgreSQL 17 on **127.0.0.1:55457**; existing Mac PostgreSQL on **5432** remained untouched. No temporary credentials or receiver tokens were committed.

This is a defensive local timestamp ordering rule for a **simulated Lemon Squeezy test merchant**, not verified against the live provider's timestamp precision or webhook semantics. Legitimate provider events sharing a timestamp may be conservatively discarded when they would **increase** access; production merchant reconciliation and renewal synchronization still require real test-store integration. GitHub-hosted CI is currently blocked before runner provisioning. Montral remains PRIVATE, UNPUBLISHED and not approved for customer billing.
