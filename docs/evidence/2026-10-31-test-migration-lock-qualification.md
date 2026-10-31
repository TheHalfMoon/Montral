# Shared PostgreSQL migration concurrency qualification — 2026-10-31

## Observed failure

A fresh, synthetic Mac PostgreSQL 17 test database running the full parallel API suite initially reported `PostgresError: tuple concurrently updated` during `src/montral-billing.e2e.test.ts` setup. The initial run had 561 passing tests, 13 skipped, and one failing test file. The failure was in catalog/schema setup, not a failed assertion about billing state.

## Minimal repair

Two E2E files (`montral-billing.e2e.test.ts` and `montral-hooks.e2e.test.ts`) each invoked core migration, then called the Montral edition migration directly outside the edition's advisory transaction lock. They now use the existing `migrateMontralSchema(db, montralEdition)` entry point. The production migration implementation and all test assertions remain unchanged. The global setup still initializes the shared disposable schema first.

## Independent fresh-database verification

The full suite was rerun on a *different*, freshly created local database named `montral_test_gate_*`, using the production-adjacent PostgreSQL implementation and normal Vitest file parallelism:

- API: **78/78 files; 574/574 tests PASS**, in 21.19 s.
- Edge probe: **4/4 files; 20/20 tests PASS**.
- Web: **25/25 files; 122/122 tests PASS**.
- Updated headless Chromium signup, heartbeat monitoring, manual incident, webhook and disabled billing journey: `BROWSER_E2E_PASS`.
- Immutable donor source manifest: **638/638 files verified**.
- Disposable test database removed by shell exit trap.

The local Node runtime was **v24.15.0**, below the declared-supported `^24.22.1`. The concurrent-migration regression is locally green but does **not** qualify the supported-runtime or hosted-CI release gate. GitHub Actions remains unexecuted because the organization/account runner job fails before any step starts.
