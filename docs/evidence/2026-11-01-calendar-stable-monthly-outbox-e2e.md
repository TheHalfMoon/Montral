# Calendar-stable staged monthly-outbox PostgreSQL tests

**Date:** 2026-11-01 (Asia/Riyadh). **Scope:** private Montral repository, macOS Node 24.22.1 and disposable loopback PostgreSQL 17.9; tests only, no scheduled mail activation and no external provider calls.

## Failure discovered during the full API qualification

The initial 2026-11-01 707-test API run had **695 passes and 12 failures** concentrated in `monthly-outbox-dispatcher.e2e.test.ts` and `monthly-outbox-batch-recovery.e2e.test.ts`. Both used a fixed synthetic report month `2026-09` and injected `now = 2026-10-01` into the staged dispatcher. However, the production metering claim deliberately uses **the actual current UTC accounting month**, which is November 2026, for its quota period, and the database claim checks consistency between accounting and reporting windows. The old October test fixture was therefore an impossible combination of dates after the calendar rollover. Independent tests passed; no production code regression was established.

## Test-only correction

The two synthetic E2E files now choose the **second UTC day of the current UTC month**, obtain the report month with the existing `previousMonth(when)` helper, and leave all real database and SMTP simulation logic unchanged. The reporting-window refusal test now uses the fourth day of the same dynamic month instead of a fixed 2026-10-04. This tests the same claim / exactly-once / crash-recovery / freeze / quotas and time-policy invariants across future month/year boundaries, without mocking PostgreSQL time or weakening production time guards.

The first explicit rerun *without* `TEST_DATABASE_URL` skipped all 21 database-backed tests and was not counted as passing. After supplying a freshly created `montral_test_*` loopback database, **23/23 focused tests passed**, comprising 15 dispatcher, six batch-recovery and two independent cookie-selector tests. The full suite was then rerun against a third fresh `montral_test_*` database: **707/707 API tests PASS**, including all staged monthly dispatcher and recovery scenarios, followed by **114/114 database**, **20/20 Edge Probe**, and **124/124 web tests PASS**. The first web run after a fresh clone skipped one built-page SEO test due to absent built assets; the final web run after production builds explicitly passed **124/124**, with no skipped test counted as a pass. TypeScript/Astro and three production builds PASS. Node/Postgres smoke, real Chromium browser, local SMTP, 46-table/8-synthetic-workspace SHA-256 backup/restore, five real OS SIGKILL crash boundaries and 638 original source hashes PASS. This is local macOS evidence, not hosted CI.

## Remaining constraints

These local deterministic fixtures do **not** qualify live SMTP provider acknowledgments, deployed scheduler clock skew, hosted failover, actual deletion/retention policies or publication. GitHub-hosted runners remain subject to the account's payments/spending limit; do not report hosted CI green based on these tests.
