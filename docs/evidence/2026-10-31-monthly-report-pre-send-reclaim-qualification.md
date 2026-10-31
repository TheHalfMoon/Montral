# Montral monthly digest pre-send reclaim — 2026-10-31

## Scope

Private Montral repository on authorized Mac only; supported Node v24.22.1 / pnpm 10.0.0 and disposable local PostgreSQL 17.9; exclusively synthetic test recipients. No external SMTP, cloud service, production users, live payments or public deployment.

## Failure mode repaired

The previous monthly email metering hardening correctly refused to send when a quota ledger failed or returned an invalid grant, but `claimMonthlyReports` had already set `workspace_setting.last_report_month` to that month. The report was therefore permanently treated as delivered even though *zero* messages were attempted.

## New contract

- `Repo.releaseMonthlyReportClaim(orgId, month)` is a guarded PostgreSQL compare-and-set update that resets the claim only when its organization, current month and enabled monthly-report preference all match. It cannot roll back the claim for a different month or a disabled preference.
- The monthly-report dispatcher invokes the release when it cannot prepare source data or obtain a valid quota decision, **before attempting any email**. The next eligible periodic report tick can claim that month again. Quota errors and release errors use generic diagnostics that exclude backend exceptions and private database details.
- Once any email may have been attempted, the entire claim stays consumed. In particular, an ambiguous mail-provider error or partial successful delivery never triggers a replay: this prevents accidental duplicate delivery of an already accepted message. An actual *zero* allowance is not a transient quota-backend failure and does not trigger endless retries.
- A prepared report with no owners/components still consumes the monthly claim (nothing is due). The default self-hosted unmetered implementation and emergency incident notifications are unchanged.
- The background scheduler already calls monthly reporting at its existing 5-minute cadence within the first three UTC days of a month. Temporary failures can retry during that window without a schema migration. Continuous upstream failure could cause repeated attempts and logs; retry throttling and a durable per-recipient outbox are separate production qualifications.

## Tests

- Thirteen focused synthetic monthly-report tests passed, including quota rejection/invalid values, partial sends, default unmetered, failure isolation between two organizations, generic log hygiene, preparation failure and explicit refusal to replay ambiguous provider results.
- One focused **real PostgreSQL** test passed: competing claims acquire a monthly report once, wrong-month releases do not clear it, correct-month pre-send release permits exactly one new claim, a later month stays isolated, and disabling the preference prevents release.
- Exact supported toolchain Node v24.22.1 / pnpm 10.0.0, fresh disposable PostgreSQL: **86/86 db-pg tests, 587/587 API tests, 20/20 Probe tests and 122/122 Web tests, total 815/815 PASS**. Node/API and SSR web builds, Edge probe build, Node+PostgreSQL HTTP smoke, and monorepo TypeScript checks PASS. **638/638** immutable donor files verify by hash. Temporary test databases were automatically dropped.

## Remaining limitations

This patch improves retry of failures that happen before *any* attempted mail. It does **not** guarantee exactly-once delivery if a process crashes after claiming but before invoking the release, nor does it requeue ambiguous delivery errors or handle per-recipient idempotent sends. Those require a durable transactional outbox and delivery ledger, plus hosted failover drills. Hosted GitHub Actions jobs currently fail before any runner executes a step; local results do not make hosted CI green. Cloudflare live regions, external email deliverability, merchant test-store callbacks, operational abuse/backup/PITR and launch authorization remain open.
