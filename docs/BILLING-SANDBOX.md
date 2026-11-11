# Montral commercial billing — private test-mode qualification

**Status (2026-11-11): Test-mode adapter with catalog-driven plans and the subscription lifecycle (payment-failure grace, refunds, plan changes). Unit tests run locally; the PostgreSQL E2E tests run in CI. No production commerce enabled.**

This is a Montral-owned integration; it is NOT part of the historical OpenUptime donor's hosted/proprietary edition.

## Components

- `apps/api/src/montral-billing.ts`: fail-closed Lemon Squeezy test-mode checkout integration, HMAC-SHA256 webhook verifier, transactional subscription event ledger and server-issued checkout-intent binding.
- `apps/api/src/montral-billing.test.ts`: test-mode gating, exact raw-body signature checking, store/variant checks and provider request validation with a **fake fetcher (zero network)**.
- `apps/api/src/montral-billing.e2e.test.ts`: real PostgreSQL authentication, synthetic intent, fake signed provider events, idempotency, stale event protection and expiration/cancellation state.
- `apps/web/src/components/Billing.tsx`: authenticated dashboard billing screen listing the plans `GET /api/billing/plans` exposes; checkout disabled unless merchant test configuration is complete.
- `apps/api/src/montral-metering.ts`: optional Montral-native plan caps and atomic PostgreSQL usage credit ledger. All metering remains disabled unless `MONTRAL_METERING_ENABLED=true`. The billing provider's test-mode state does not automatically enable metering.

## Security contract

1. **Disabled by default**. Requires every explicit variable: `MONTRAL_BILLING_ENABLED=true`, `MONTRAL_BILLING_MODE=test`, `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`, and plans: an operator plan catalog whose plans list `providerVariants` ([PLAN-CATALOG.md](PLAN-CATALOG.md)) or, as a fallback for a catalog without variants, `LEMONSQUEEZY_VARIANT_PRO` and `LEMONSQUEEZY_VARIANT_BUSINESS` (mapped to the plan ids `pro`/`business`).
2. **No live checkouts**: Requests always set `test_mode: true`; the provider response must also confirm `test_mode: true`. Any other response fails closed, including production checkout URLs.
3. **No payment-link trust**: Never grant entitlements because a browser visited a success URL. Subscription creation requires an HMAC-signed, test-mode merchant event, the correct store and variant, and a single-use, unexpired checkout intent that Montral created on behalf of the authenticated workspace manager.
4. **No PII stored**: Billing event table stores only the payload digest, provider subscription ID and event type. Subscription table holds workspace, plan, status and provider update time. No credit cards, addresses or raw provider payloads are stored.
5. **Cancellation safety**: Signed test-mode subscription updates persist `ends_at`; a missing or expired cancellation deadline cannot grant perpetual Pro/Business access. Before contacting the provider to create a checkout, Montral persists the correlating intent; failed provider requests delete unused intents. A new per-workspace transaction advisory lock ensures **only one unexpired, unconsumed test checkout intent at once** across concurrent requests. Legacy duplicate intents cannot replace an active subscription from a different provider.
6. **Idempotency / equal-timestamp safety**: Signature is verified before parsing, payload digest prevents exact redelivery, and a PostgreSQL function links/deduplicates/updates state in one transaction. Earlier events cannot overwrite newer subscription status. **Different signed provider events may share the same `updated_at`**; a tie now permits only more restrictive subscription states or a shorter cancellation deadline, never a paid-access restoration. Less-restrictive equal-timestamp callbacks return `stale`, while their event digest is still retained. After the old subscription expires, a *new* provider checkout may establish its own independent timestamp stream. See [equal-timestamp regression](evidence/2026-10-31-billing-equal-timestamp-ordering-qualification.md).
7. **No extra subscriptions**: A workspace with a non-expired subscription is denied a second new checkout. Plan changes arrive as signed `subscription_updated` events naming another catalog variant (see [Subscription lifecycle](#subscription-lifecycle)); Montral has no provider-portal integration to start one.
8. **Byte-exact signed ingestion**: POST callbacks are bounded to a 64-KiB raw byte stream. HMAC-SHA256 and billing digest/replay ledger use the **original HTTP bytes**, not replacement-decoded UTF-8 text. JSON is decoded only after HMAC verification, with strict UTF-8 (`fatal: true`); malformed bytes return 400, changed bytes with an old signature return 401. Unknown/unsigned merchant events are rejected. No live provider keys were used during implementation. See [2026-10-31 raw-byte qualification](evidence/2026-10-31-billing-raw-byte-hmac-qualification.md).

## Proposed private-preview plan guardrails

These are engineering quota candidates, **not confirmed merchant prices, product offers or a public pricing promise**. All monitoring is unmetered unless the operator explicitly sets `MONTRAL_METERING_ENABLED=true`. When enabled, each check/notification consumes atomic credits in PostgreSQL. Billing and metering are separate opt-ins.

| Plan | Active monitors | Minimum interval | Regions/check | Monthly outbound-check credits | Monthly emails | Monthly webhook events | Monthly browser seconds |
|---|---:|---:|---:|---:|---:|---:|---:|
| Free | 1 | 600 sec | 1 | 4,500 | 20 | 500 | 1,800 |
| Pro | 5 | 300 sec | 2 | 50,000 | 200 | 5,000 | 18,000 |
| Business | 20 | 60 sec | 3 | 250,000 | 1,000 | 25,000 | 72,000 |

Webhook events count requests the inbox receiver captures; browser seconds count browser-check runtime (each check reserves its journey timeout and gets the unused seconds back). The Free values are also what an operator catalog plan gets when it omits either meter (`METER_DEFAULTS`; never unlimited). See [PLAN-CATALOG.md](PLAN-CATALOG.md#schema-version-1) for when each is charged and what an exhausted or unreachable ledger does.

Each monitor can run only while credits remain; a workspace running **all** Business monitors every minute will exhaust its 250,000 credits before the month ends. These are intentionally hard budgets to avoid unexpected hosting costs. Usage periods start at 00:00 UTC on the first of each calendar month in this preview; renewal-aligned accounting and proration remain future work.

When both test-mode billing and metering are configured, only an explicitly `test_mode=true` subscription with `active` or `on_trial` status can grant its plan without a deadline. A `cancelled` subscription keeps its plan **only while the provider-supplied `ends_at` timestamp is in the future**. A missing or expired `ends_at` revokes paid access immediately, even if the `subscription_expired` callback never arrives. Expired, unpaid and paused status, and a refunded payment, fall back to the catalog's default plan at once; past due keeps the plan only for the grace period (see [Subscription lifecycle](#subscription-lifecycle)). Real merchant reconciliation, real refunds and provider renewal-aligned billing periods remain future work.

## Subscription lifecycle

All of this is **sandbox only**: events must be HMAC-signed, `test_mode: true` and from the configured store. Event names and payload fields were checked against Lemon Squeezy's public documentation ([event types](https://docs.lemonsqueezy.com/help/webhooks/event-types), [subscription object](https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object), [subscription invoice object](https://docs.lemonsqueezy.com/api/subscription-invoices/the-subscription-invoice-object)) on 2026-11-11, not against a real sandbox store.

| Event | Payload (`data.type`) | Effect |
|---|---|---|
| `subscription_created` | `subscriptions` | Links the subscription to the workspace through the server-issued checkout intent; the plan is the intent's catalog plan |
| `subscription_updated`, `_cancelled`, `_resumed`, `_paused`, `_unpaused`, `_expired` | `subscriptions` | Status, `ends_at` and, when `variant_id` names another catalog plan, the plan (upgrade or downgrade). A variant the catalog does not map (for example one removed from it) still applies status, `ends_at` and ordering; only the plan change is refused (plan and variant kept) |
| `subscription_payment_failed` | `subscription-invoices` | Payment state `failed`; the first failure starts the past-due grace period |
| `subscription_payment_success`, `subscription_payment_recovered` | `subscription-invoices` (invoice `status` must be `paid`) | Payment state `paid`; ends a past-due spell |
| `subscription_payment_refunded` | `subscription-invoices` (invoice `status` `refunded` or `partial_refund`) | Payment state `refunded`: entitlements fall back at once |

Invoice events carry `subscription_id` but **no variant**, so they never change the plan. They are matched by `subscription_id` to a subscription Montral already linked; otherwise 409.

**Ordering.** Two monotonic clocks, both the provider's. Subscription events are ordered by the subscription's `updated_at`, as before: an older event is `stale`; an equal timestamp admits only a stricter status or a shorter cancellation deadline, and never changes the plan. Payment events are ordered by the invoice's `updated_at`; an equal timestamp admits only a stricter outcome (paid, then failed, then refunded). `expired` is terminal: no later event revives that provider subscription, and a new checkout creates a new one. Exact redelivery (the same bytes) is `duplicate`.

**Lost payment events.** A subscription event reporting `active` or `on_trial` on an update strictly newer than both the subscription clock and the last failed invoice ends that failure (payment state cleared), and so does a reconciliation snapshot. A lost `subscription_payment_success` therefore cannot keep a paying customer on the default plan once the provider reports the subscription active again.

**Grace policy.** A subscription is past due when its status is `past_due` or its latest payment failed. It keeps its plan for `MONTRAL_BILLING_GRACE_DAYS` days (default 7, bounded to 0–30; a non-integer value means 7), counted from the **first** failed payment of the spell (`past_due_since`; a `past_due` status without a failed-payment event starts it at that update). After that it falls back to the default plan (fail closed) until a payment succeeds. A successful payment newer than the subscription's last status update ends past due at once, even before the provider's `subscription_updated` arrives. A refund (`subscription_payment_refunded`) or `expired` falls back immediately; after a refund, a later successful payment of the same subscription restores the plan.

**Audit.** Every billing event whose workspace is known writes one workspace audit event (actor type `system`, label "Billing provider", target the provider subscription id): `billing.event_applied` (state changed), `billing.event_ignored` (`reason` `stale` or `duplicate`; state unchanged) or `billing.event_unmatched` (a creation whose checkout intent does not match). An event applied with an unmapped variant is `billing.event_applied` with `reason` `unmapped_variant_plan_kept`. A redelivered digest is audited once (`duplicate_audited_at` on the event ledger); further identical redeliveries are answered `duplicate` without another row. Events that are not consumed (unmatched creations) can be audited once per provider retry. Values hold only `status`, `plan` and the event `type`: no amounts and no customer data. Events for unknown subscriptions or checkouts have no workspace and are not audited. Recording is best effort, like every audit event: the billing change has already committed.

**Catalog drift.** At start-up the Node server warns (counts and plan ids only) when live subscriptions name plan ids the catalog no longer defines, which then get the default plan, or variants it no longer lists, whose plan is kept and whose plan changes are refused.

**Known behaviours (by design in this preview).**
- A refund (`subscription_payment_refunded`, including `partial_refund`) falls back to the default plan at once. A later, newer successful payment of the same subscription restores the plan.
- A payment event that arrives before Montral linked its subscription (`subscription_created`) answers 409 and is not recorded; the provider's retry applies it once the subscription exists.

**Reconciliation hook.** `reconcileSubscription(db, env, snapshot)` applies a provider subscription snapshot (`status`, `variantId`, `updatedAt`, `endsAt`) through the same monotonic path (event name `subscription_reconciled`, digest of the snapshot), so an operator job can repair a lost webhook later. It only updates subscriptions Montral already linked, never creates one, and makes no network call. No job calls it yet.

## Rolling upgrade and rollback

Replicas of the previous release may keep running, and restarting, while this release migrates. This release therefore never drops, replaces or redefines a database function the previous release uses. `montral_reserve_billing_intent` and the eight-argument `montral_apply_billing_event` stay exactly as that release defines them, and a restarting old replica re-creates only its own versions. New code calls only `montral_reserve_billing_intent_v2` and `montral_billing_apply`. Against the new schema, old replicas are merely less capable: they sell only `pro`/`business`, ignore payment state and refuse variant changes. They never conflict. The fixed plan CHECK on `montral_billing_intent` is found by its definition, not its name, and dropped, which old replicas, inserting only `pro`/`business`, cannot notice. Likewise the usage ledger's original two-kind CHECK on `montral_usage.kind` is found by its definition and replaced by `montral_usage_kind_v2` (adding `webhook_events` and `browser_seconds`). `montral_spend_usage` is redefined in place to accept the new kinds; a previous-release replica that restarts during the rollout re-creates its two-kind version, and until a new replica restarts, webhook-event and browser-second charges fail. Metered deployments fail closed then: webhooks answer 503 and browser checks do not run. Nothing is over-granted. Finish the rollout promptly. The old functions are removed in a later release, once no replica of the previous release can run.

## API surface

| Method | Route | Auth | Preview behavior |
|---|---|---|---|
| GET | `/api/billing` | Workspace manager | Reads plan and state (`entitledPlan`, `paymentState`, `graceEndsAt`); never exposes secrets |
| GET | `/api/billing/plans` | Workspace manager | Catalog plans: `id`, `name`, `checkoutAvailable`. No price fields unless `MONTRAL_BILLING_SHOW_PRICES=true` and the plan has price metadata |
| POST | `/api/billing/checkout` | Workspace manager | Fails 503 unless test merchant fully configured; accepts any catalog plan with a provider variant (never the default plan), else 400; returns only provider-confirmed test URL |
| POST | `/api/billing/lemon` | Lemon Squeezy signed webhook | Fails 404 unless fully configured, 503 while the plan catalog is invalid; validates exact signature, store, test mode, intent, variant-to-plan mapping, status |

Test mode is supported; production billing intentionally has no activation path.

## Developer test path

```sh
# Run only with disposable local PostgreSQL and entirely synthetic merchant values
TEST_DATABASE_URL='<isolated PostgreSQL URL>' pnpm --filter @montral/api exec vitest run \
  src/montral-billing.test.ts src/montral-billing.e2e.test.ts
```

No merchant connection, test order or checkout with Lemon Squeezy's real test store was made. Local tests use fully synthetic signed callbacks and fake network responses.

## Provider protocol references

- HMAC-SHA256 signatures: https://docs.lemonsqueezy.com/help/webhooks/signing-requests
- Provider event names: https://docs.lemonsqueezy.com/help/webhooks/event-types
- Checkout creation with custom data: https://docs.lemonsqueezy.com/api/checkouts/create-checkout
- Custom data arrives in signed provider webhook: https://docs.lemonsqueezy.com/help/checkout/passing-custom-data
- Test-mode simulated events: https://docs.lemonsqueezy.com/help/webhooks/simulate-webhook-events
- Subscription object (statuses, `variant_id`, `ends_at`): https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object
- Subscription invoice object (payment events: `subscription_id`, `status`, `updated_at`): https://docs.lemonsqueezy.com/api/subscription-invoices/the-subscription-invoice-object

## Outstanding blockers before charging customers

- **Metering is implemented but disabled by default**; real production quota/usage/load/price certification, provider renewal-aligned windows, chargeback handling, a scheduled reconciliation job and operational monitoring are still missing. Never present a sandbox status as a production-paid entitlement.
- The lifecycle is verified only with synthetic signed events. Not verifiable without a real sandbox store: the invoice `status` values actually sent with each payment event; whether invoice and subscription `updated_at` values are comparable; whether `subscription_payment_*` can arrive before `subscription_created` (then 409 until the provider retries); how a plan change is reported (the documentation does not say that a variant change updates `variant_id` in `subscription_updated`); and chargebacks: Lemon Squeezy documents no chargeback or dispute webhook event, so a dispute is not handled.
- No live-mode provider adapter, live merchant approval, country-appropriate settlement verification, subscription portal integration or refunds/reconciliation.
- No payment-provider test store account/keys have been connected or used. Verify signed callback shape, live event order, subscription status transitions and delayed webhook retries in the real provider sandbox before enabling production.
- No full customer checkout E2E with actual payment-provider test transaction.
- No public infrastructure, backups/restore drill, commercial/legal review, or successful GitHub hosted CI. **Do not publish or charge**.

Local cancellation/intent race and old-schema upgrade evidence: [2026-10-30 lifecycle qualification](evidence/2026-10-30-billing-lifecycle-qualification.md).

## Local sandbox metadata retention

The private Montral maintenance tick removes **checkout-intent correlation records only after they have been expired for more than seven days**. Both Node and Worker invoke this maintenance independently from monitor-scheduler success, and failures in webhook cleanup do not suppress intent cleanup (or vice versa). The **subscription table and signed billing event ledger are not automatically deleted**, because their contents are necessary for replay prevention and may have future legal/audit retention requirements. This is an implementation default for the disabled-by-default sandbox preview, **not** an approved legal or accounting retention policy. See [local maintenance qualification](evidence/2026-10-30-maintenance-isolation-qualification.md).

Private test checkout concurrency and provider identity evidence: [2026-10-30 qualification](evidence/2026-10-30-checkout-race-qualification.md).

Signed callback equal-timestamp replay/downgrade and old-provider replacement evidence: [2026-10-31 qualification](evidence/2026-10-31-billing-equal-timestamp-ordering-qualification.md). This deterministic local rule requires verification against the real provider's timestamp precision and webhook semantics before any merchant activation.

Local signed callback byte-accuracy, malformed UTF-8 and replay-digest evidence: [2026-10-31 qualification](evidence/2026-10-31-billing-raw-byte-hmac-qualification.md). Authentic merchant sandbox and public release remain unqualified.
