# Montral full-table row-count restore qualification — 2026-10-31

## Scope

Private Montral repository on the authorized Mac only. Real loopback PostgreSQL 17.9; Node v24.22.1 and pnpm 10.0.0; all data is explicitly synthetic. No customer data, hosted PostgreSQL, paid infrastructure, public app, external email or merchant was accessed.

## Hardening

`scripts/qualify-backup.mjs` originally checked only schema table count, organization count and presence of five named transactional functions. It now takes a deterministic table-by-table **row-count snapshot of all base tables** in the isolated source, confirms that the source counts did not change during the dump, restores the custom-format archive into a new scratch database, and compares all restored table row counts against the original values. A mismatch fails with table names only, not row content. A cleanup failure also fails the command rather than producing a passing qualification, while temporary dump files are removed even if database cleanup fails.

This is a **row-count integrity check**; it does not compare all cell values or guarantee correctness if rows are modified without changing table counts. It is not point-in-time recovery, cloud failover, or a production disaster recovery certification.

## Local test fixture and results

- Ran the built Montral Node API and web smoke against an isolated, newly created disposable PostgreSQL database; `Montral Node+Postgres smoke PASS`.
- Inserted 128 synthetic organizations, 128 projects, 128 heartbeat monitors, 128 status pages and 128 email-channel definitions, all using SQL generated for this one local drill. No outbound network monitoring or mail was performed.
- `RESTORE_DRILL_PASS`: **42 total tables, 6 nonempty, 128 organizations, every table row count matched, five business-critical PostgreSQL functions restored**. The temporary restored database and source fixture were dropped after the drill; no saved local backup archive remains.
- The stronger post-dump source-stability check was also included in a second successful test with the same 128/128/128/128/128 synthetic fixture.
- The full monorepo regression on supported **Node v24.22.1 / pnpm 10.0.0** passed: **574/574 API, 20/20 Probe and 122/122 web tests = 716/716**, plus `pnpm -r typecheck` PASS, built Node API and SSR web smoke PASS, and `python3 scripts/verify_sources.py` verified **638/638** pinned donor files.

## Remaining release gates

- Hosted GitHub Actions still fails before runner assignment; no hosted job executed this new drill.
- A hosted replica/restore/PITR exercise, data-byte fidelity verification, egress limits, realistic sustained data volume and backup retention are not yet qualified.
- Keep the repo private and do not deploy, release or activate real billing.
