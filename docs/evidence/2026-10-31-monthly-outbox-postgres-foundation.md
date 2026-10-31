# Durable monthly recipient outbox — PostgreSQL foundation qualification

**Date:** 2026-10-31 Asia/Riyadh. **Repository:** PRIVATE `TheHalfMoon/Montral`. **Scope:** actual, staged PostgreSQL schema and repo state machine only. **NOT connected to live report SMTP or quota consumption.** No deployment, paid service or real recipients.

## Database implementation

A new generated, append-only Drizzle migration `0041_same_millenium_guard` creates `monthly_report_recipient` with foreign keys to organization and recipient user (cascade on deletion), composite primary key `(organization_id, report_month, recipient_user_id)`, strict `YYYY-MM` validation, state integrity checks, and an index for workspace/month/state queries. It stores only recipient email snapshot and locale plus lifecycle timestamps, **no SMTP tokens, provider errors, private check payloads or full message bodies**.

`Repo` and its Postgres implementation now expose **staged-only** methods:

- `reserveMonthlyReportRecipients` checks an opted-in workspace with a matching already-claimed report month under a row lock, validates owner membership, atomically reserves an immutable owner snapshot, and returns **new insertions only**. Competing reservations cannot create duplicate recipient records or append new recipients after the first snapshot.
- `attemptMonthlyReportRecipient` uses an atomic compare-and-set from `prepared` to `attempted`; it refuses revoked ownership, report opt-out, changed owner email since the snapshot, a different report month, and repeated attempts.
- `finishMonthlyReportRecipient` permits only a single `attempted` -> `accepted` or `uncertain` transition. There is no `uncertain`/`accepted` -> `prepared` replay; deliberately no automatic retry of an ambiguous SMTP acceptance.
- `monthlyReportRecipientCounts` aggregates per-workspace and month **without exposing recipient addresses**.

The existing `sendMonthlyReports` runtime path remains unchanged. This prevents deploying the new table as if it were a working outbox without idempotent quota reservations and a crash-reconciliation mechanism. Migration is additive and does not mutate legacy `last_report_month` claims. Historic claims are **not** assumed safe to resend.

## Adversarial PostgreSQL test coverage

Eight new real Postgres state-machine tests exercise unclaimed/disabled/invalid and non-owner reservations; eight competing reserve transactions (one owner snapshot); twelve concurrent attempt CAS operations (only one wins); `uncertain` is terminal and cannot be overwritten to `accepted`; scoped counts; ownership removal and report opt-out; user-email changes; stale month/DB check constraints; and cascade deletion of entire workspace's outbox. A **ninth** integration regression creates a separate database at the previous 0040 schema, seeds a previously-claimed monthly report, upgrades concurrently from three clients to 0041, verifies the legacy claim remains untouched (not eligible for resend), and proves repeated migration is idempotent.

Tests run against disposable local PostgreSQL 17.9 under Node v24.22.1 and pnpm 10.0.0. Drizzle generated SQL, snapshot/journal, and `migrations.generated.ts` are committed together; `node scripts/gen-migrations.mjs --check` passes. Source file donor SHA-256 baseline **638/638** intact.

- Full local package tests after running the required Node + PostgreSQL schema bootstrap: **95 PostgreSQL + 650 API + 20 Edge Probe + 122 Web = 887/887 PASS**. A preliminary run without migrating the disposable database failed on missing pre-existing tables; re-running with the correct bootstrap eliminated those setup failures. Do not interpret the premature run as a product test result.
- `pnpm -r typecheck`: PASS. Production Node API, Node web SSR and Edge Probe builds: PASS; `scripts/smoke-node.mjs`: PASS.
- Real headless Chromium E2E: **BROWSER_E2E_PASS** covering synthetic signup, monitors/incidents, webhooks, disabled billing and password-reset privacy.
- Node SMTP with loopback synthetic inbox: **SMTP_LOOPBACK_PASS** for verification/channel tests, scheduler down/recovery and account recovery. No external SMTP.
- `pg_dump` / `pg_restore` with normalized per-table SHA-256 and row-count comparison: **RESTORE_DRILL_PASS: 43 tables (36 nonempty), 110 synthetic organizations, five transactional functions**. This is stronger than an empty-database smoke drill but does not prove managed cloud PITR, realistic scale, or hosted failover. All temporary test databases were disposable.

Hosted CI/production qualification cannot be inferred from local passing checks.

## Outstanding enabling gates

The database foundation alone cannot guarantee idempotent email-metering spend or exactly-once SMTP sends. Implement an idempotent per-recipient quota-reservation key, a durable phase-aware scheduler that never blindly resends ambiguous provider attempts, operator-only reconciliation of uncertain results, and crash-injection tests for every failure boundary before enabling the outbox in `sendMonthlyReports`. The existing mail path must continue to use its conservative one-attempt/one-month behavior. Do not change billing/service flags, deploy, publish or send external mail on the basis of this migration.

Hosted GitHub Actions is blocked before runner allocation by account billing/spend-limit state; real Cloudflare, managed database PITR/failover/load, external SMTP and merchant sandbox, security/privacy/accessibility/legal and final release authorization remain open.
