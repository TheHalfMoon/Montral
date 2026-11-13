# PostgreSQL billing lock-order test isolation (proposed)

**Status:** Proposed, pending exact-head hosted PostgreSQL 17/18 and macOS ARM64 qualification. No production migration, database schema, billing provider or runtime code changed.

## Trigger

PR #118 exact head `2e2c32b` failed its macOS ARM64 API suite in GitHub Actions run [43383241612](https://github.com/TheHalfMoon/Montral/actions/runs/43383241612): `montral-billing-lock-order.e2e.test.ts`, test `a no-op edition re-migration takes no table lock that blocks checkouts or captures`, reported PostgreSQL **`tuple concurrently updated`**. The same PR's browser/failover/load/Docker checks passed; its own probe tests passed locally. This is an E2E schema/DB catalog failure, not evidence of a probe signing regression. The mechanism was not fully observed from the error trace; concurrent schema updates on a shared test DB are a plausible cause, not a verified diagnosis.

## Change and safety

The billing lock-order test file now creates a uniquely named, disposable **local** `montral_test_lockorder_<uuid>` PostgreSQL database for its own setup and its no-op migration/checkout contention tests, instead of replacing stored functions in the shared `montral_ci` database alongside other parallel E2E files. The test still creates separate concurrent `checkout` and `migrator` database connections and asserts that a genuine legacy upgrade blocks in checkout lock order while a no-op re-migration does **not** block. No synchronization sleeps, exemptions, skipped assertions or weakened timeouts have been introduced.

The test checks that the configured parent database is `montral_ci` or `montral_test_*` on localhost/127.0.0.1 before issuing `CREATE DATABASE`, and closes and `DROP DATABASE ... WITH (FORCE)` the unique test DB after its suite, even if a test fails. The existing fresh-upgrade nested database is also created and dropped by its own test.

## Required evidence

- Local `@montral/api` typecheck and syntax/test discovery: pending.
- Hosted PR exact-head API PostgreSQL 17/18 and macOS ARM64 full suites must pass; failures must be inspected, not suppressed or treated as flaky by assumption.
- Once qualified, coordinate PR #118's base/requalification; do not merge code on a red exact head.

Release gating is unchanged: no tag/release/deployment/provider changes, and Community/Cloud/BYOC external requirements remain open.
