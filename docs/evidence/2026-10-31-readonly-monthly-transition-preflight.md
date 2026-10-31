# Read-only staged monthly report transition preflight — 2026-10-31

**Scope:** PRIVATE `TheHalfMoon/Montral`, authorized Mac, local PostgreSQL and synthetic test data only. **This is a staging inspection tool; it is NOT an activation, production migration, scheduler, SMTP sender, or external-provider verification.**

## Motivation and boundary

The legacy monthly sender and new durable recipient outbox can coexist in the schema, but past `last_report_month` claims without recipient rows do **not** prove what an SMTP provider accepted. Before a migration it must be possible to count those ambiguous states without granting a new attempt or exposing who received reports. This audit adds a read-only snapshot, not a shortcut around incident reconciliation or release gates.

New `inspectMonthlyTransition(db, YYYY-MM)` runs one PostgreSQL `REPEATABLE READ READ ONLY` transaction and a single parameterized aggregate SELECT. It does not invoke `migrate()`, reserve quota, claim a workspace, alter any state or call SMTP. A missing table, insufficient permissions, invalid month or broken transaction-read-only contract **throws**, rather than interpreting the dataset as clean. The output is aggregate counts, a stable SHA-256 digest of *only* the month and counts, and human-readable findings without user, workspace or email identifiers. This fingerprint is a report comparison aid **not cryptographic integrity evidence for raw database rows**, approval, or a signed audit.

Reported categories include eligible as-yet-unclaimed opted-in workspaces (not a send authorization), historical org-only claims with no recipient evidence, outbox workspace totals, mismatched or missing workspace settings, prepared recipients after opt-out, recent and aged `attempted` records, unreconciled `uncertain` records, reviewed but unresolved provider outcomes, owner-attested acceptance, skipped rows and attempted/terminal rows that lack a monthly idempotent email reservation. A single report snapshot cannot prove actual delivery; report fields `outcome: NO_GO`, `readOnly: true` and `authorizesSending: false` never change to GO—even if every count is zero.

`pnpm --filter @montral/api inspect:monthly-transition 2026-09` is the explicit local command. It requires `TEST_DATABASE_URL` resolving to **localhost / 127.0.0.1 with a `montral_test_*` database name**. It refuses all remote/production databases without connecting, does not print connection strings, and returns only JSON counts to stdout. Run it only against a pre-migrated disposable, synthetic-only local database; do not enable it via an HTTP endpoint, UI, cron, CI with live secrets or scheduler. This local-only CLI intentionally cannot inspect or authorize a production database.

## Synthetic PostgreSQL tests

A freshly created disposable database is migrated with the existing core + Montral edition migration path. Separate synthetic workspace/owner fixtures represent: a historical legacy-only claim, prepared outbox, aged attempted outbox without quota evidence, an uncertain outbox with unresolved owner-attested audit and mismatched workspace claim, plus an opted-in unclaimed workspace. Tests verify bounded period validation before SQL, precise categories, stable report digest, no raw addresses/identifiers/evidence, repeatability and unchanged row counts. Other tests simulate opt-out and deleting the setting row *outside* the audit: the next report must detect those changes rather than hide or replay recipients. Missing schema via restricted connection `search_path` fails closed. No provider is called and no external mail sent.

## Explicit remaining gates

**NO-GO for production.** Do not infer exactly-once email delivery from idempotent quotas, the local process-kill drill, or this aggregate report. A real staged-to-live transition still requires stopping every legacy scheduler replica, resolving prior attempts with independent external-provider evidence, handling historical claimed months without replay, provider acceptance/SMTP timeout fault injection, live tenant privacy and retention review, operator approval, managed database PITR, hosted CI, and an audited rollback plan. The new preflight has no mutation or release capability and is not proof that those gates are resolved.

## Verified evidence

Full local tests, TypeScript/builds, local CLI output, real process-kill, Chromium, SMTP loopback, restore and donor hash verification will be appended only after a complete run. GitHub hosted CI may be blocked before runner assignment by the account's billing/spend limit, independently of local passing tests.

## Final verified Mac qualification

- **950/950 tests PASS**: 692 API (including four new real PostgreSQL preflight tests), 114 PostgreSQL, 20 Probe and 124 Web. Monorepo TypeScript PASS; Node API / Node Web SSR / Edge Probe builds PASS.
- Explicit `pnpm --silent --filter @montral/api inspect:monthly-transition 2026-09` on a migrated, synthetic, disposable localhost database emitted valid JSON with `outcome=NO_GO`, `readOnly=true`, and `authorizesSending=false`. A remote URL containing a synthetic credential and a malformed string containing a synthetic credential were both rejected **without attempting a remote connection or emitting either credential**.
- `MONTHLY_REAL_SIGKILL_DRILL_PASS` for five locally fault-injected crash boundaries. `SMTP_LOOPBACK_PASS` and headless `BROWSER_E2E_PASS` on fully synthetic local endpoints. No external-provider or paid-service use.
- `RESTORE_DRILL_PASS`: **45 PostgreSQL tables (36 populated), 118 synthetic organizations**, seven required transactional SQL functions, identical per-table row counts and normalized SHA-256 fingerprints after dump and restore; **43 embedded migrations** in sync; **638 pinned donor source hashes** unchanged.
- The first test fixture used an invalid timestamp parameter inference and then passed a JavaScript Date into a raw SQL parameter requiring a string. Both were corrected in synthetic test code. The first full CLI parser mistook pnpm's execution header for JSON; the explicit `--silent` command verified the actual JSON output, and the complete 950-test suite and external local qualification then passed. The failures are reported here rather than being hidden.

**NO-GO remains:** none of the local passes establish production sender safety, external provider acceptance, managed PostgreSQL failover, hosted CI or a release authorization.
