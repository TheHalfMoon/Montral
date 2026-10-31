# Confidential frozen monthly report content — synthetic retention rehearsal

**Date:** 2026-10-31 (Asia/Riyadh). **Scope:** PRIVATE `TheHalfMoon/Montral`, authorized macOS, locally isolated synthetic PostgreSQL databases only. **NOT an approved production retention schedule, automated cleanup or permission to delete live reports.**

## Risk and conservative design

Drizzle `0043` makes once-frozen monthly report content immutable to preserve the identity of each email's workspace name and monitor statistics across recipient deliveries and process restarts. Those data are sensitive and survive as long as the workspace exists, even after a month is closed. Workspace deletion already cascades to the report. The code did not otherwise provide a bounded way to assess potential data minimization, and blindly purging unfinished/ambiguous mail could destroy the context needed for reconciliation.

New internal helper `inspectFrozenContentRetention(db, retentionDays, now)` is a **read-only repeatable-read PostgreSQL snapshot** that returns only aggregate counts, a SHA-256 of month-independent report counts/cutoff (not a raw-row integrity proof), `NO_GO`, `readOnly=true` and `permitsProductionPurge=false`. Categories: total content snapshots; old, fully closed recipient groups potentially eligible; recent snapshots; old content without any matching recipient records; and old content with **any** `prepared`, `attempted` or `uncertain` recipient. No user IDs, emails, workspace names, monitor statistics, SMTP provider identifiers or raw report bodies are returned. Empty or missing schema cannot authorize production deletion.

A separate **disposable-only** rehearsal method `purgeFrozenContentInDisposableTestDb(db, retentionDays, now, batchSize)` has no scheduler, server route, worker import or production hook. It requires an explicit integer `retentionDays` in the **180–3650** range (example for test only, **not a selected real retention policy**) and bounded batch size 1–100. Inside its own transaction it checks `current_database()` matches `montral_test_*` **and** that PostgreSQL reports the server's real loopback interface, rejecting non-test or remote databases even when the CLI is bypassed. Row selection is ordered and locked with `FOR UPDATE SKIP LOCKED`; the delete re-checks age and recipient status. Only `monthly_report_content` rows older than the chosen cutoff with at least one matching recipient and **all** recipients in terminal `accepted` or `skipped` states may be removed. It never deletes any recipient metadata, provider review, quota, usage reservation, email log or billing record. Missing recipient snapshots, pending attempts, all uncertain outcomes, and recent reports are held even if their owner has reviewed them; no automatic retry or quota refund follows.

The explicit CLI `pnpm --silent --filter @montral/api rehearse:monthly-content-retention 180` uses `TEST_DATABASE_URL` and refuses any URL that is not loopback and a `montral_test_*` database before connecting. Its default mode is **read-only**. Only the extra **`--execute-disposable`** argument runs the limited synthetic-delete rehearsal; it is unavailable on production databases. Errors redact connection URLs and return NO-GO. This CLI is for a dedicated synthetic database, never customer data or cloud snapshots.

## Real PostgreSQL regression evidence

A fresh isolated and migrated local test database covers seven synthetic workspace-months: an old accepted row, old skipped row, recent accepted row, old prepared row, old attempted row, old uncertain row, and an orphan report with no recipients. Tests assert 2/7 old completed candidates, 1 recent, 1 orphan, and 3 unresolved rows; no private values escape the summary; the reporting transaction itself is read-only; two bounded one-item rehearsal passes remove only the accepted and skipped report content; recipient rows remain unchanged. A later independently updated attempted state can only be selected after it becomes terminal. Eight concurrent deletion workers cannot remove a report more than once. Invalid retention days, invalid batch sizes and calls against a non-`montral_test_*` database fail closed.

## Additional disposable-fixture proof (follow-up hardening)

The initial local purge guard enforced `montral_test_*` database identity and a real PostgreSQL loopback server address. That was necessary but not sufficient: a local restored database could carry actual data while accidentally retaining a test-like name. The rehearsal now also requires an **explicit, separate synthetic-fixture proof** stored inside the disposable database: `public.montral_retention_rehearsal_fixture` must have a row whose `database_name` equals `current_database()` and whose `purpose` equals `synthetic-monthly-content-retention-v1`. The table is provisioned **only in the test's disposable fixture setup**; it is never created by product migrations, runtime, HTTP endpoints or the CLI. A missing table, missing marker, or wrong database name refuses deletion.

To exercise the stand-alone CLI in a manually created **synthetic-only** database, the operator must independently create and populate that fixture marker after verifying the database contains no customer data. Simply pointing the CLI at a matching database name no longer makes the destructive experiment runnable. The default command remains read-only and `NO_GO`. Even with a marker, this is not permission to delete production or restored customer data, and the rehearsal has no automatic schedule.

## Remaining release and policy gates

- There is **no approved customer-data retention duration**, no automatic production purge, no data-processing/privacy assessment and no audited deletion approval. The 180-day minimum only bounds the local experiment.
- Uncertain SMTP events require independent provider evidence, historical migration review, and a deliberate policy deciding if/when their confidential payload may be erased. Purging report content must never erase the separate delivery/outbox evidence needed to prevent duplicate sends.
- Managed PostgreSQL/PITR restoration, external provider acceptance, hosted CI availability and production scheduler switch are still unqualified. **Montral remains NO-GO for release** and no hosted services/paid functionality are enabled by this change.

## Final qualification results

Full package tests, production builds, real SIGKILL, SMTP loopback, Chromium, migration/source integrity and PostgreSQL backup/restore results will be recorded only after the final complete local run passes.

## Final local qualification — verified macOS

- **959/959 package tests PASS** under supported Node **v24.22.1**, pnpm 10.0.0 and local PostgreSQL 17.9: **701 API**, **114 PostgreSQL**, **20 Edge Probe**, **124 Web**. The four newly added real PostgreSQL retention regressions passed, including direct bypass of the CLI, concurrent workers and protected ambiguous states.
- Monorepo TypeScript PASS; all production-target Node API, Node Web SSR and Edge Probe builds PASS; Node/PostgreSQL health/config/MCP/dashboard smoke PASS.
- Explicit `rehearse:monthly-content-retention 180` CLI dry run on a disposable, migrated `montral_test_*` database returned `readOnly=true`, `outcome=NO_GO` and `permitsProductionPurge=false`. The CLI refused a synthetic remote URL containing a test credential **without contacting it or exposing the credential**. A direct programmatic deletion attempt on a non-disposable local database was also denied by the database identity guard.
- `MONTHLY_REAL_SIGKILL_DRILL_PASS`: five actual OS worker-crash boundaries and no repeat SMTP/extra quota. `SMTP_LOOPBACK_PASS`: Node synthetic verification/alert/down-recovery/account recovery delivery through local loopback only. `BROWSER_E2E_PASS`: real Chromium signup, monitor, incident, webhook, disabled billing and reset URL privacy.
- `RESTORE_DRILL_PASS`: **46 PostgreSQL tables (36 populated), 118 synthetic organizations**, identical per-table row counts and normalized SHA-256 content fingerprints after dump/restore, including eight required functions. All **44 embedded Drizzle migrations** synchronized; all **638 pinned donor source files** verified unchanged.
- Preliminary iteration: PostgreSQL `inet_server_addr()::text` includes a `/32` network suffix; the rehearsal safety guard now uses the explicit PostgreSQL `host(inet_server_addr())` to compare the actual loopback address. Following that repair, the guard and all 959 package tests and local system drills passed. No client data was accessed or changed.

**Production NO-GO remains:** the chosen retention duration is experimental, no live purge or automated schedule is enabled, and privacy policy/provider/hosted CI/managed recovery gates are still open.

## Follow-up verification — explicit fixture marker

- Updated code based on private main `cfbbe728dbec8b09b93170a77325a6988639eb34`; only the staged retention helper/test and repository documentation changed. No migration or deployed service was modified.
- Five focused PostgreSQL retention tests PASS, including rejecting a missing marker table, missing marker row, and a marker bound to a different disposable database. Intentional test fixture creation uses only its disposable `montral_test_*` database.
- Supported **Node v24.22.1** / **pnpm 10.0.0** / **PostgreSQL 17.9** on Mac: **960/960 package tests PASS** (702 API, 114 DB, 20 Edge Probe, 124 Web); all workspace TypeScript checks PASS; three production-target builds PASS.
- **638/638 immutable donor source files verified**. Node + PostgreSQL health/config/MCP/web dashboard smoke PASS. Real offline Chromium browser journeys PASS. Local loopback SMTP verification, alerts and account-recovery delivery PASS, with no external email or customers.
- Disposable PostgreSQL `pg_dump`/`pg_restore` qualification PASS: **46 tables**, all per-table SHA-256 fingerprints and row counts identical; **8 synthetic organizations**, 8 sample projects, 8 heartbeat monitors and **8 required functions** survived. This does not prove managed PITR or hosted disaster recovery.
- A separate **real OS SIGKILL** qualification PASSED at five synthetic outbox crash boundaries: precommit rollback, postcommit recovery, pre-SMTP no replay, post-acceptance no replay and legacy-claim no resurrection. This did not send real provider mail.
- The special localhost-only fixture marker is **not** installed by migrations or by the CLI. This remains a deliberately isolated destructive rehearsal, not production permission. Hosted GitHub Actions, retention duration approval, cloud SMTP/Cloudflare/payment-provider validation and production release are still **NO-GO**.
