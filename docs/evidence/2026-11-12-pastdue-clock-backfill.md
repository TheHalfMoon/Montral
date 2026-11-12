# Legacy billing grace clock backfill (2026-11-12)

## Problem
The preview edition introduced `past_due_since` for the first failed payment, but older subscriptions could already be `past_due` when the column was first added, or retain NULL after that upgrade. They then fall back to the default plan immediately instead of using an existing saved failure clock; the Billing UI has no grace end.

## Implementation
- On edition migration, after ensuring payment columns exist, update only `test_mode=true` subscriptions in the active/on_trial/past_due states with `past_due_since IS NULL` and a persisting past-due condition.
- A `past_due` status uses its saved `provider_updated_at`. If an invoice failure has a separate saved `payment_updated_at`, use the earlier of those clocks, avoiding an artificially later grace start. An active/on-trial subscription whose last payment failed uses its saved `payment_updated_at` only.
- Never use `NOW()` or migration time as the backfill clock. A failed invoice without any saved timestamp and without a `past_due` status remains NULL: the existing fail-closed behavior is preserved.
- Exclude refunded payments, a `past_due` status superseded by a newer paid invoice, and all `test_mode=false` subscriptions. Never overwrite a previously set `past_due_since`.
- The update is idempotent and conditional. Every restart may invoke the migrator without extending an expired grace window. No new table/column/DDL or provider calls.

## Verification
- Disposable PostgreSQL upgrade test creates a legacy `past_due` row with no payment columns before upgrading, and asserts backfill uses the old `provider_updated_at` exactly.
- Already-upgraded schema tests cover: active+failed with timestamp, active+failed without timestamp, paid-after-status, older saved failed invoice clock, non-test subscription, and an existing past_due_since that must never change.
- Rerun the migrator and check idempotency; existing migration lock-order/deadlock regression must remain green.
- Require exact-head PostgreSQL 17/18, macOS and load qualification before merging.

## Boundaries
This is sandbox billing only. It does not enable live billing, change prices, graceDays, payment-provider integration, reconciliation, commercial entitlements or release status. The separate provider-clock comparability concern remains unresolved: for existing missing clocks the backfill deliberately does not guess.
