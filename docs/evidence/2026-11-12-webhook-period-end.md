# Webhook quota reset at the reported meter period boundary (2026-11-12)

## Bug
An exhausted public webhook receiver returned `429` and `Retry-After` calculated from the first day of the next UTC calendar month, even if the edition reported a renewal-aligned webhook-events meter period ending on a different day. The response also lacked a machine-readable `resetsAt` to help senders understand when to retry.

## Change
- Only on the quota-refusal path, query the existing `Entitlements.meterBalance(workspace, "webhookEvents")` via `allowanceResetsAt`. Use its valid end instant for `Retry-After` (ceiling seconds, at least one) and JSON `resetsAt`.
- If the meter's balance cannot be read, has a stale end, or has an invalid end, use the legacy next UTC calendar-month boundary. The read is advisory only: it cannot turn a quota refusal into a success or into a 500.
- Change the error copy from "for the month" to "for this period" to avoid claiming a billing period that differs from the reported meter.
- Current hosted preview still allocates using calendar-month periods. This does NOT change when credits reset or migrate the ledger to renewal-aligned billing periods.

## Verification
- Focused Vitest checks a synthetic renewal-aligned meter period (November 15 instead of December 1) and exact Retry-After seconds; checks thrown/stale balance fallbacks, existing month-boundary behavior and fail-open/self-hosted behavior.
- PostgreSQL hosted-meter integration now validates the new `resetsAt` response field.
- TypeScript / CI exact-head qualification required before merge.

## Boundaries
No changes to prices, plan amounts, subscription billing, meters, payments, production deployment or database migrations. This avoids lying to senders when a valid period end is available.
