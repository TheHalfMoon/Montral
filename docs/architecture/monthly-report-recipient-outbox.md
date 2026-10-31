# Monthly report recipient outbox — design contract (NOT implemented)

## Existing contract and remaining gap

`workspace_setting.last_report_month` atomically claims an entire workspace-month, and `sendMonthlyReports` makes one best-effort email attempt per eligible owner. Errors **before** any provider request can reopen the month; errors **after** a provider request are intentionally never automatically retried because acceptance is ambiguous. There is not yet a durable per-owner delivery record, crash recovery for a worker killed immediately after an org claim, or a recipient-level reconciliation API. Do not describe this feature as implemented or production-qualified.

The pre-send mail-render preflight in `apps/api/src/reports.ts` ensures that a corrupt component or contact cannot cause a halfway send or charge before all messages have been rendered. It is a narrow prerequisite, not an outbox substitute.

## Proposed PostgreSQL and safety rules

1. Add a dedicated outbox with a **unique `(organization_id, report_month, recipient_user_id)`** key; reference existing org/user rows for deletion rules, store the planned recipient email/locale and a minimal immutable report snapshot or content hash, `state` (`prepared`, `attempted`, `accepted`, `uncertain`, `skipped`), monotonic attempt marker and timestamps. Do not persist SMTP credentials, unsubscribe tokens or full provider exception strings. Confirm how to handle email changes after claim.
2. Enqueue the selected owner set atomically with the workspace claim, or add a bounded **pre-send lease** so a crashed worker before materialization can resume. Existing `last_report_month` values from previous releases must not be automatically assumed safe to resend. Migration from the old org-only claim must be explicit and idempotent.
3. Account for the email allowance **once per reserved recipient** using an idempotent metering key in the *same* transactional boundary as the grant or durable reservation. The current `spendEmails(org, count)` is not idempotent for process-crash replays; changing only the outbox table would risk duplicate charges.
4. Atomically move a *prepared* recipient to **attempted before calling SMTP**. On crash, do **not** automatically repeat an `attempted` or `uncertain` item. Mark `accepted` only on an unambiguous success. On timeout or provider failure with unknown acceptance, leave `uncertain` for **manual reconciliation** or a provider-defined idempotency facility. There is no generic exactly-once guarantee in SMTP.
5. Continue sending other recipients/workspaces independently. If entitlement service, policy or snapshot preparation fails before a recipient is marked attempted, release only the safe, unattempted work. Keep business rules (opt-in, disabled reports, first three UTC days, quotas) unchanged.
6. Add operator-visible aggregate counts (prepared/attempted/accepted/uncertain/skipped) without exposing recipient emails in logs. Add retention and tenant-authorization rules for any new status endpoint.

## Must-pass qualification before enabling the outbox

- PostgreSQL concurrent claiming and uniqueness (multiple workers); transaction rollback and migration replay on an *existing* database.
- Kill process after org claim but before enqueue; after enqueue but before quota reservation; after quota reservation but before provider call; after provider acceptance but before recorded success. Reconcile credits and ensure no duplicate external messages.
- Owner removed, email changed, report disabled, month rolled over during worker downtime, partial allowance, invalid grant and transient database outage; securely erase deleted workspace's outbox.
- Real local SMTP acceptance/delay/timeout with synthetic inbox, plus hosted CI, load tests, and external-provider reconciliation prior to release. Separate a live merchant quota metering test from local simulations.

**Release decision: NOT READY.** Do not use the design document to turn any product or release gate green. No paid service, real email delivery, public deployment or production billing is authorized by this document.
