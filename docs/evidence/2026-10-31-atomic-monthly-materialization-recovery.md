# Atomic monthly report materialization and safe recovery — 2026-10-31

**Scope:** PRIVATE `TheHalfMoon/Montral`, authorized Mac, synthetic-only database + local email transport. **Staged internal worker only; NOT used by the live cron, HTTP routes or legacy monthly sender.** No deployment, publishing, paid services or external email.

## Prior crash gap

The legacy `claimMonthlyReports` writes `workspace_setting.last_report_month` before generating or delivering any mail. A process death between that update and recording its owners leaves an **org-only claim with no durable recipient evidence**. Automatically re-issuing such a claim is unsafe because older versions may already have attempted SMTP. The initial staged outbox could reserve owners only *after* this legacy claim, leaving the same crash window.

## New staged recovery contract

- New `Repo.claimMonthlyReportsWithRecipients(month, limit)` selects newly eligible, opted-in workspace settings with PostgreSQL row locks and `SKIP LOCKED`, and **atomically updates the month claim and inserts the immutable, currently authorized owner-address snapshots** in a single transaction. No provider sends, quota charges or outside effects occur inside that transaction. A failure before commit rolls back both the claim and all recipient rows; a process death after commit leaves `prepared` recipients recoverable. Input limits are validated and capped at 100.
- Existing org-only claims for that month are never inferred to be safe to resend. Workspaces with any previous recipient state for that month are never re-materialized, even if `last_report_month` was cleared erroneously. Workspaces with no eligible owners, broken email addresses or disabled reporting are not newly claimed.
- `Repo.recoverPreparedMonthlyReportWorkspaces(month, limit)` returns **workspace IDs only**, for still-opted-in workspaces that have both the matching committed month claim and at least one actual `prepared` recipient row. It excludes legacy claims, disabled workspaces, and orgs whose every recipient has already been attempted or decided. No personal emails appear in this result.
- The old `releaseMonthlyReportClaim` now refuses to clear a claim if any recipient was already snapshotted for the month. It still permits safe legacy release of a claim without recipient records.
- New **staged-only** `runStagedMonthlyOutboxBatch` orchestrates atomic materialization, recovery discovery and the already-tested at-most-one-attempt recipient dispatcher. A new process instance can recover committed `prepared` records. If fresh materialization fails, existing prepared records can still be discovered; a failed per-workspace send is isolated. It refuses to start if the required metered atomic-claim method or email provider is missing or outside the first three UTC days.
- The active `sendMonthlyReports` function and its existing monthly cron schedule remain **unchanged**. No new schema migration was needed: current `0041` recipient rows and existing workspace setting suffice.

## Fault-injection and concurrency tests

Seven new isolated real-PostgreSQL repository tests verify: atomic claim+owner materialization; eight competing materializers without duplicate rows; an org-only legacy month claim cannot be recovered; old claim release cannot reset snapshotted/attempted rows; an injected SQL trigger failure rolls the entire claim and batch back (then a later attempt succeeds); malformed owner/opt-out behavior; and bounded recovery that only returns still-prepared work.

Six additional isolated PostgreSQL + synthetic-mail E2E tests exercise: first atomic materialization + provider attempts and no repeat on the next tick; a new database connection recovering an already-committed outbox after a simulated process interruption; safety exclusion of a legacy org-only claim; database trigger failure before commit and successful next-tick recovery, with no credentials logged; five concurrent staged workers sending each owner once and charging quota once; and fail-closed behavior with absent mail transport or opt-out. The dedicated test databases are destroyed after each run, and do not reference production organizations.

**Important limitation:** SQL transaction abort and new-connection restart tests model the crash boundaries. They do not constitute a real OS process-kill or external provider acceptance test. At-most-once SMTP can sacrifice delivery if the worker dies after the durable attempt claim but before calling SMTP; an ambiguous accepted-but-unacknowledged send still needs operator-only reconciliation. Existing legacy months and their past sent messages are intentionally not replayed.

## Further release gates

This does **not** capture a stable full monthly report-content snapshot, guarantee that every old org-only claim can be recovered, implement a production scheduler migration/rollout plan, or provide protected operator tooling for reviewing `attempted`/`uncertain` mail. Hosted CI, cloud DNS/egress, live email-provider behavior, managed PostgreSQL PITR/failover/load, real merchant sandbox, security/accessibility/privacy/legal checks and explicit release authorization remain open. No deployment or release approved.

## Qualification results

Results from the full package suite, builds, loopback SMTP, offline Chromium, PostgreSQL backup/restore and donor source-integrity gates are appended after execution; do not substitute staged tests for hosted or production evidence.

## Verified full local qualification

- **925/925 passing**: 681 API, 102 PostgreSQL, 20 Edge Probe, 122 Web; includes all thirteen new atomic-materialization and staged-batch recovery cases.
- Supported Node v24.22.1 / pnpm 10.0.0; production Node API, SSR Web, Edge Probe builds and live Node/PostgreSQL HTTP health/config/MCP/dashboard smoke PASS.
- Real offline headless Chromium browser E2E PASS for synthetic signup, monitors, incidents, webhooks, disabled billing and reset-link privacy.
- `SMTP_LOOPBACK_PASS`: synthetic verification/channel/incident down-recovery/account recovery through local-only mail. No external SMTP used.
- `RESTORE_DRILL_PASS`: 44 PostgreSQL tables (36 populated), 110 synthetic organizations, seven business SQL functions, identical row counts and normalized SHA-256 per-table data fingerprints after dump/restore. This does not prove cloud PITR, live failover or production scale.
- 638 pinned donor-source file hashes verified unchanged; 42 embedded Drizzle migrations in sync. No schema migration was added in this stage.

These are local Mac qualification results only. Hosted GitHub Actions and live-provider release gates remain outstanding.
