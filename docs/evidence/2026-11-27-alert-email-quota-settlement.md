# Incident alert email quota settlement

## Finding

In the claimed incident alert path, a metered email quota debit happened before the final live workspace suspension read. A suspension committed between claim and provider I/O caused a terminal `skipped` delivery without a provider request, while the debit remained in the aggregate email meter. This was a confirmed correctness defect for deliveries whose quota was successfully reserved before that suspension check.

## Change

Metered incident alert emails now use the existing PostgreSQL idempotent email reservation primitive with a per-delivery key. When the final suspension check skips delivery, PostgreSQL verifies the matching granted reservation, records one refund receipt, decrements the same monthly usage row, and changes the delivery to terminal `skipped` in one transaction. A repeated refund is a no-op. If settlement cannot be committed, the delivery stays recoverable rather than becoming terminal. A legacy aggregate debit with no per-delivery reservation is deliberately not refunded because its ownership cannot be proven safely.

Only a confirmed pre-provider suspension skip uses this settlement path. Provider errors, timeouts, and other ambiguous external outcomes do not refund quota. A metering outage retains incident-email fail-open behavior without falling back to a second unkeyed debit. The Community edition remains unmetered.

## Verification

- Disposable PostgreSQL 16: email reservation is rolled back with an aborted transaction; concurrent settlement attempts produce exactly one refund, usage reaches zero, one receipt is stored, and delivery status becomes `skipped`.
- API tests: `alerts.test.ts` and `monthly-email-quota-reservation.e2e.test.ts`, 85/85 passing against the disposable database. Existing suspension regression asserts no provider call for a suspended claimed delivery.
- API TypeScript check passed; `git diff --check` passed.

This evidence qualifies the code paths exercised above. It is not security clearance, release approval, billing activation, or permission to deploy.
