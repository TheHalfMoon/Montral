# Montral commercial billing — private test-mode qualification

**Status (2026-10-30): Test-mode adapter implemented and unit/PostgreSQL E2E verified locally. No production commerce enabled.**

This is a Montral-owned integration; it is NOT part of the historical OpenUptime donor's hosted/proprietary edition.

## Components

- `apps/api/src/montral-billing.ts`: fail-closed Lemon Squeezy test-mode checkout integration, HMAC-SHA256 webhook verifier, transactional subscription event ledger and server-issued checkout-intent binding.
- `apps/api/src/montral-billing.test.ts`: test-mode gating, exact raw-body signature checking, store/variant checks and provider request validation with a **fake fetcher (zero network)**.
- `apps/api/src/montral-billing.e2e.test.ts`: real PostgreSQL authentication, synthetic intent, fake signed provider events, idempotency, stale event protection and expiration/cancellation state.
- `apps/web/src/components/Billing.tsx`: authenticated dashboard billing screen, disabled unless merchant test configuration is complete.
- `apps/api/src/montral-metering.ts`: optional Montral-native plan caps and atomic PostgreSQL usage credit ledger. All metering remains disabled unless `MONTRAL_METERING_ENABLED=true`. The billing provider's test-mode state does not automatically enable metering.

## Security contract

1. **Disabled by default**. Requires every explicit variable: `MONTRAL_BILLING_ENABLED=true`, `MONTRAL_BILLING_MODE=test`, `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_PRO`, `LEMONSQUEEZY_VARIANT_BUSINESS`.
2. **No live checkouts**: Requests always set `test_mode: true`; the provider response must also confirm `test_mode: true`. Any other response fails closed, including production checkout URLs.
3. **No payment-link trust**: Never grant entitlements because a browser visited a success URL. Subscription creation requires an HMAC-signed, test-mode merchant event, the correct store and variant, and a single-use, unexpired checkout intent that Montral created on behalf of the authenticated workspace manager.
4. **No PII stored**: Billing event table stores only the payload digest, provider subscription ID and event type. Subscription table holds workspace, plan, status and provider update time. No credit cards, addresses or raw provider payloads are stored.
5. **Cancellation safety**: Signed test-mode subscription updates persist `ends_at`; a missing or expired cancellation deadline cannot grant perpetual Pro/Business access. Before contacting the provider to create a checkout, Montral persists the correlating intent; failed provider requests delete unused intents.
6. **Idempotency**: Signature is verified before parsing, payload digest prevents exact redelivery, and a PostgreSQL function links/deduplicates/updates state in one transaction. Earlier events cannot overwrite newer subscription status.
7. **No extra subscriptions**: A workspace with a non-expired subscription is denied a second new checkout. Plan changes need a separate provider-portal integration, not a second subscription purchase.
8. **Small ingestion**: POST callback is limited to a 64-KiB raw body. Unknown/unsigned events are rejected. No live provider keys were used during implementation.

## Proposed private-preview plan guardrails

These are engineering quota candidates, **not confirmed merchant prices, product offers or a public pricing promise**. All monitoring is unmetered unless the operator explicitly sets `MONTRAL_METERING_ENABLED=true`. When enabled, each check/notification consumes atomic credits in PostgreSQL. Billing and metering are separate opt-ins.

| Plan | Active monitors | Minimum interval | Regions/check | Monthly outbound-check credits | Monthly emails |
|---|---:|---:|---:|---:|---:|
| Free | 1 | 600 sec | 1 | 4,500 | 20 |
| Pro | 5 | 300 sec | 2 | 50,000 | 200 |
| Business | 20 | 60 sec | 3 | 250,000 | 1,000 |

Each monitor can run only while credits remain; a workspace running **all** Business monitors every minute will exhaust its 250,000 credits before the month ends. These are intentionally hard budgets to avoid unexpected hosting costs. Usage periods start at 00:00 UTC on the first of each calendar month in this preview; renewal-aligned accounting and proration remain future work.

When both test-mode billing and metering are configured, only an explicitly `test_mode=true` subscription with `active` or `on_trial` status can grant the preview tier without a deadline. A `cancelled` subscription receives preview access **only while the provider-supplied `ends_at` timestamp is in the future**. A missing or expired `ends_at` revokes paid access immediately, even if the `subscription_expired` callback never arrives. Expired, unpaid, paused and past-due status also falls back to Free. Actual merchant reconciliation, real refunds and provider renewal-aligned billing periods remain future work.

## API surface

| Method | Route | Auth | Preview behavior |
|---|---|---|---|
| GET | `/api/billing` | Workspace manager | Reads plan and state; never exposes secrets |
| POST | `/api/billing/checkout` | Workspace manager | Fails 503 unless test merchant fully configured; returns only provider-confirmed test URL |
| POST | `/api/billing/lemon` | Lemon Squeezy signed webhook | Fails 404 unless fully configured; validates exact signature, store, test mode, intent, variants, status |

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

## Outstanding blockers before charging customers

- **Metering is implemented but disabled by default**; real production quota/usage/load/price certification, provider renewal-aligned windows, fraud/chargeback reconciliation, subscription lifecycle and operational monitoring are still missing. Never present a sandbox status as a production-paid entitlement.
- No live-mode provider adapter, live merchant approval, country-appropriate settlement verification, subscription portal integration or refunds/reconciliation.
- No payment-provider test store account/keys have been connected or used. Verify signed callback shape, live event order, subscription status transitions and delayed webhook retries in the real provider sandbox before enabling production.
- No full customer checkout E2E with actual payment-provider test transaction.
- No public infrastructure, backups/restore drill, commercial/legal review, or successful GitHub hosted CI. **Do not publish or charge**.

Local cancellation/intent race and old-schema upgrade evidence: [2026-10-30 lifecycle qualification](evidence/2026-10-30-billing-lifecycle-qualification.md).

## Local sandbox metadata retention

The private Montral maintenance tick removes **checkout-intent correlation records only after they have been expired for more than seven days**. Both Node and Worker invoke this maintenance independently from monitor-scheduler success, and failures in webhook cleanup do not suppress intent cleanup (or vice versa). The **subscription table and signed billing event ledger are not automatically deleted**, because their contents are necessary for replay prevention and may have future legal/audit retention requirements. This is an implementation default for the disabled-by-default sandbox preview, **not** an approved legal or accounting retention policy. See [local maintenance qualification](evidence/2026-10-30-maintenance-isolation-qualification.md).
