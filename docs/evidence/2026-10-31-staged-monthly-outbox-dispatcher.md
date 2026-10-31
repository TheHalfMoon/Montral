# Staged monthly report recipient dispatcher — 2026-10-31

**Repository:** PRIVATE `TheHalfMoon/Montral`. **Scope:** an internal, unconnected dispatcher used in synthetic local PostgreSQL/SMTP-loopback testing. Not enabled on a production scheduler, HTTP route, queue or background worker. No external SMTP, merchant activity, deployment, publishing, or paid service.

## Implementation and trust boundaries

A new staged `dispatchPreparedMonthlyOutbox` in `apps/api/src/monthly-outbox-dispatcher.ts` consumes an **existing reserved, `prepared` recipient snapshot** through a newly added workspace/month-scoped `Repo.preparedMonthlyReportRecipients`, implemented in `packages/db-pg`. The email target comes from that immutable PostgreSQL snapshot, **not** caller-supplied mail addresses. The PostgreSQL `montral_claim_monthly_report_send` function independently rechecks current owner membership, unchanged email, enabled monthly-report preference, matching workspace-month and canonical quota period under a lock immediately before authorizing the first attempt.

The staged dispatcher:

- Runs only for the first three UTC days, only when an actual email provider is configured and the **optional metered `claimMonthlyOutboxAttempt` method is present**. It never falls back to the unmetered edition or the non-idempotent legacy `spendEmails` method. It is **not called by the active monthly sender**.
- Reuses the **same HTML/text template renderer** as legacy monthly reports, extracted as `renderMonthlyReportMessage` from `apps/api/src/reports.ts` (no changes to the legacy report's quota or delivery semantics). Preparation failures are isolated per recipient before any quota grant.
- Only an atomic `attempted` result permits one call to `sendEmail(..., required=true)`. Replayed, ineligible, uncertain and quota-denied results are not sent. An explicit SMTP success attempts `attempted -> accepted`; an error/timeout—even after the provider may have accepted—attempts `attempted -> uncertain`. If result persistence itself fails, the durable `attempted` state prevents automatic resend. Errors logged here are fixed, nonsecret categories and do not include recipient emails, SMTP credentials or report content.
- Continues processing remaining recipients after one mail or database failure. Each result summarizes attempted, accepted, uncertain and denied counts without personal data. This is **at-most-one provider attempt**, not exactly-once receipt; a crash after claim but before the SMTP call can lose a message safely instead of risking duplication.

## Local E2E coverage

Ten new real-PostgreSQL tests using a memory-only synthetic mail transport test: first successful message to each owner followed by idempotent rerun; simulated SMTP acceptance followed by exception and healthy peer progression; post-acceptance result-write failure with `attempted` left un-replayed; malformed recipient data isolated before quota; missing provider guard; disabled report guard; a committed claim followed by simulated worker crash before SMTP, which never replays; report-window/unmetered fail-closed guards, three concurrent dispatchers claiming the same recipients once, and a failed recipient-query guard. The legacy `reports.test.ts` suite also passes, verifying behavior parity after extraction of the shared renderer. Neither the mock transport nor local SMTP loopback is a hosted-provider qualification.

## Still unimplemented

Full production integration requires **transactional recipient creation before any worker sends**, a pre-send crash-recovery mechanism for an org claimed but without outbox records, a persistent immutable report-content snapshot or a documented policy for regenerated report data, operator authentication/status views, uncertain-result review and manual reconciliation, hosted multiworker crash injection, and external SMTP delivery/protocol validation. Activating this staged dispatcher alone must not be called a production release or exactly-once delivery guarantee. Keep the current conservative monthly sender unchanged until these issues are resolved and explicit deployment authorization exists.

## Mac verification

Final package test counts, builds, Chromium E2E, local SMTP, PostgreSQL SHA-256 restore and source integrity are recorded below after completion. The local machine uses supported Node v24.22.1 and pnpm 10.0.0. Hosted GitHub Actions remain blocked by the GitHub account's payment/spending-limit state; they cannot be marked green from local checks.

## Final local qualification

- 912 of 912 tests passed: 675 API, 95 database, 20 probe, 122 web.
- TypeScript and all three builds passed.
- Browser, loopback SMTP and database restore drills passed.
- Restore covered 44 tables and 110 synthetic organizations with matching data fingerprints.
- 638 source hashes and 42 migrations checked.
- Hosted CI and production delivery remain unqualified.
