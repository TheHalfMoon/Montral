# Legacy monthly report claim transition safety — 2026-10-31

**Repository:** PRIVATE `TheHalfMoon/Montral`, authorized macOS Mac, synthetic-only local PostgreSQL / email loopback. **Not a production scheduler migration.** No new deploy, hosted mail, live merchant, paid service or public release.

## Verified failure mode

Montral has two monthly-report pipelines: (1) the live **legacy** `sendMonthlyReports`, which claims `workspace_setting.last_report_month` for the month and sends a bulk report; (2) a **staged, not scheduled** recipient outbox that atomically captures owners and records each `prepared/attempted/accepted/uncertain/skipped` state. Previous staged work guarded claim release but not the **legacy claim predicate**. If an administrator or an older process reset `last_report_month` after a staged outbox was already created, the legacy scheduler could claim the same workspace-month as a new report. That is an unsafe path to duplicate provider attempts and quota charges.

## Database safety repair

`Repo.claimMonthlyReports(month, limit)` now requires a valid `YYYY-MM` report month and integer batch size 1–1000 (existing 500-item callers remain compatible); it only selects workspace settings with enabled reporting, a different month claim, **and no `monthly_report_recipient` row for that same `(workspace, month)`**. The database predicate applies regardless of each recipient's state or whether the workspace's `last_report_month` was mistakenly reset. Selection uses ordered `FOR UPDATE ... SKIP LOCKED` on the same `workspace_setting` row as staged atomic materialization. Both claimers serialize on that row, while the new outbox retains the previous ban on replaying a historic org-only claim without delivery evidence. This is defensive even if application processes of different versions overlap during a future transition.

**Preserved semantics:** Legacy workspaces without staged outbox rows still follow the existing report workflow; the new predicate does not convert or replay any past org-only claim. `sendMonthlyReports` still owns the normal production cron path, still consumes the existing bulk email allowance and still does not automatically retry an ambiguous SMTP outcome. The staged outbox remains disconnected from active scheduling.

## Emergency pause — opt-in only, no new sender

`MONTRAL_MONTHLY_REPORTS_PAUSED=true` suppresses **new legacy monthly-report work from scheduler ticks**, without stopping regular monitor checks, incident notifications, retries, escalations, maintenance reminders, or database maintenance. The default is `false` and is explicit in the environment typings, Docker Compose and both sample environment files. The option is forwarded from all three Node, Cloudflare Worker and authenticated-secret `/internal/run-checks` scheduler entry points. This option **does not launch the staged sender**. A pause applies at the beginning of future scheduler calls; it is not a synchronous cancellation of emails or calls already in flight, and mixed-version deployments require independent operational coordination. Do not describe a toggle as a fully atomic global migration.

## Test coverage

Three additional real PostgreSQL regressions validate: a staged workspace-month cannot be reclaimed by legacy even after intentionally resetting the month marker; ten concurrently running mixed old/new claimers never claim the same workspace; and invalid legacy month/batch input fails closed while a safe unsent legacy month can still be claimed exactly once. Two additional scheduler tests verify that pausing stops legacy claims while essential monitoring, incident housekeeping and maintenance still run, including queue fan-out. Existing scheduler, reports, environment-contract and staged crash-recovery suites remain in the full regression set.

## Production migration still **NO-GO**

An eventual transition must stop old scheduler instances before activating staged sends, confirm all processes have received the new guard, reconcile in-flight and ambiguous messages, explicitly choose which legacy claimed months remain omitted, and have independent provider-level evidence, immutable report-content policy and an operator-approved rollback. Restore/PITR/failover and hosted CI must be qualified. Switching the pause back off restarts legacy behavior, **not** the staged outbox, and must not be presented as a launch instruction. The default-off staged review UI and metering pathways remain unchanged. Do not deploy or publish based on this local code change alone.

## Qualification

The full local macOS test suite, production builds, real SIGKILL drill, SMTP loopback, Chromium E2E, per-table PostgreSQL SHA-256 restore and pinned donor hashes will be recorded once verified. GitHub Actions billing/spending-limit runner allocation is a separate external gate and cannot be inferred from local success.

## Final verified local qualification

- **946/946 package tests PASS**: 688 API, 114 real PostgreSQL, 20 Edge Probe and 124 Web. This includes all three new claim-collision tests, the two scheduler pause tests, existing 500-workspace legacy claim compatibility and the full existing monthly reports suite.
- Supported **Node v24.22.1 / pnpm 10.0.0 / local PostgreSQL 17.9**. Monorepo TypeScript PASS; production Node API, Node SSR Web and Edge Probe builds PASS. Real Node/PostgreSQL HTTP config, health, MCP and dashboard smoke PASS.
- Separate OS-level `MONTHLY_REAL_SIGKILL_DRILL_PASS` across five crash boundaries, including the staged/legacy claim safety and provider acceptance ambiguity. This is synthetic local evidence, not a real SMTP service. Synthetic loopback mail `SMTP_LOOPBACK_PASS` and headless real Chromium `BROWSER_E2E_PASS` for signup, monitor/incident/webhook, disabled billing and reset-link privacy.
- Local `RESTORE_DRILL_PASS`: **45 tables (36 populated), 118 synthetic organizations**, seven critical Montral SQL functions, and identical per-table row counts and normalized SHA-256 fingerprints after dump and restore. Not evidence of production PITR or failover.
- **43 embedded Drizzle migrations** unchanged and synchronized; **638 pinned donor source files** verified unchanged. No schema changes needed for this claim guard or the scheduler pause.
- Initial full DB suite revealed a pre-existing 500-item legacy claim caller; the new validation initially capped at 100. The legacy cap was adjusted to **1000** and regression-tested at 500, while the staged atomic materializer retains its 100-item limit. A subsequent run with the disposable database not yet migrated failed with `relation does not exist` before application tests; after bootstrapping its schema via the actual Node/PostgreSQL smoke, all 946 tests and system drills passed. These preliminary failures were test preparation/compatibility issues and **not** evidence of a clean first pass.

**Hosted CI and production remain NO-GO.** The code adds a defensive guard and an explicit pause, not a production rollout or approval to connect the staged sender to cron.
