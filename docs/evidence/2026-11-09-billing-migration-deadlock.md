# Montral: billing migration / checkout deadlock (40P01)

**Date:** 2026-11-09. **Branch:** `engineering/montral-billing-lock-order`, based on `origin/main` at `80c84c4`. Synthetic data only. Billing enablement is unchanged: it is still off by default and test-mode only (`billingReady` requires `MONTRAL_BILLING_ENABLED=true` and `MONTRAL_BILLING_MODE=test`).

## Symptom

CI run https://github.com/TheHalfMoon/Montral/actions/runs/42445399140: `apps/api/src/montral-billing.e2e.test.ts`, "allows only one pending checkout across concurrent requests and database connections". It expected `[201, 409 x7]` and got `201`, six `409`s and one `500`.

## Root cause (checked against the source)

- About 14 e2e files call `migrateMontralSchema` in `beforeAll` against the same database while other files are already sending traffic. `migrateEdition` (`packages/db-pg/src/index.ts`) runs all edition DDL in **one transaction** behind the `montral:edition:migrate` advisory lock. That lock only serializes migrators against each other, not against requests.
- `migrateMontralBilling` (`apps/api/src/montral-billing.ts`) ran these statements unconditionally on every startup:
  1. `ALTER TABLE montral_billing_intent ADD COLUMN IF NOT EXISTS consumed_at`. This takes **ACCESS EXCLUSIVE** even when the column already exists, because PostgreSQL picks the lock level before it checks the column.
  2. `CREATE INDEX IF NOT EXISTS montral_billing_intent_pending`. This takes **SHARE** on the table before it checks the index.
  3. Later, `ALTER TABLE montral_subscription ADD COLUMN IF NOT EXISTS ends_at`, which takes **ACCESS EXCLUSIVE**.
  All of these locks are held until the edition transaction commits.
- `montral_reserve_billing_intent` reads `montral_subscription` (ACCESS SHARE) first, then `montral_billing_intent` (ACCESS SHARE, then ROW EXCLUSIVE for the INSERT).
- The two sides take the tables in opposite orders. The migration holds `billing_intent` and waits for `subscription`, while the checkout holds `subscription` and waits for `billing_intent`. PostgreSQL resolves the cycle with `40P01 deadlock_detected`. The checkout route had no handler for it, so `onError` returned 500. A production replica that restarts and re-runs migrations while checkouts are in flight is exposed in the same way.
- Related: `migrateMontralHooks` ran three unconditional `CREATE INDEX IF NOT EXISTS` statements. Each takes SHARE on `montral_hook_inbox` / `montral_hook_event` and blocks webhook captures until the edition transaction commits. This blocks traffic but does not create a lock cycle.

## Fix

- `apps/api/src/schema-catalog.ts` adds `relationExists` and `columnExists`. They use `to_regclass` (resolved through search_path like the unqualified DDL, and takes no relation lock) and `pg_attribute`.
- `migrateMontralBilling` reads the catalog first. It runs `ADD COLUMN` or `CREATE INDEX` only when the column or index is actually missing, so **an up-to-date schema takes no table-locking DDL**. When existing tables genuinely need DDL (an upgrade), it first runs `LOCK TABLE montral_subscription, montral_billing_intent IN ACCESS EXCLUSIVE MODE`, listing only the tables that need DDL. That is the checkout function's order. Fresh installs follow the same statements as before: `CREATE TABLE` with all columns, then the index.
- `migrateMontralHooks`: each `CREATE INDEX IF NOT EXISTS` now runs only when the index is missing.
- `apps/api/src/app.ts`: `onError` is now the exported `handleApiError`. PostgreSQL `40P01` and `40001` return **503** with `Retry-After: 1`, `Cache-Control: no-store` and the fixed body `{"error":"Temporarily unavailable, please retry"}`. The log line contains only the `errorClass` SQLSTATE and never the driver message. All other errors keep the existing generic 500.

## Tests

- `apps/api/src/montral-billing-lock-order.e2e.test.ts` (PostgreSQL; skipped without `TEST_DATABASE_URL`):
  1. Re-runs the full edition migration inside `migrateEdition` on an up-to-date schema, then queries `pg_locks` for that backend before commit. It asserts **no** Share / ShareRowExclusive / Exclusive / AccessExclusive lock on any edition table. Expected RED on old code: AccessExclusive on `montral_billing_intent` and `montral_subscription`, plus Share on the intent and hook tables.
  2. Two-connection interleaving. Connection A runs `BEGIN` and reads `montral_subscription` (the function's first lock). Connection B re-runs the edition migration. The test polls `pg_locks` (bounded at 15 s, relation locks only) until B finishes or blocks, then A calls `montral_reserve_billing_intent` and commits. It asserts that B never blocked, that the reservation succeeded and that the migration completed. Expected RED on old code: B blocks on `montral_subscription` while holding `montral_billing_intent`, A's call closes the cycle, and either A or B fails with 40P01.
  3. On a disposable database (same guards as `schema-migrate.e2e.test.ts`), a fresh install has every billing and hook column and index. The test then drops `montral_subscription.ends_at` and `montral_billing_intent_pending` to simulate a genuine upgrade on both tables and runs the same interleaving. It asserts that the migration **does** block (on `montral_subscription`, before taking `montral_billing_intent`), that the reservation still succeeds, that the migration then finishes, and that the schema is complete again.
- `apps/api/src/error-class.test.ts`: `handleApiError` maps 40P01 and 40001 to 503 + Retry-After with a fixed body and a log that contains only the SQLSTATE. 23505, 40P02, lowercase `40p01` and TypeError stay 500 without Retry-After. HTTPException passes through unchanged.

## What is and is not proven

- **Proven locally (Windows, no Docker):** `pnpm -r typecheck` passes. `npx vitest run` passes for `error-class.test.ts`, `montral-billing.test.ts`, `montral-hooks.test.ts` and `montral-edition.test.ts`: 34 passed. The new e2e file is skipped locally.
- **Not proven locally:** the e2e tests above have **not** run against PostgreSQL yet. They need GitHub CI (`TEST_DATABASE_URL`). The RED results described for old code come from reading the code and PostgreSQL's documented lock levels. They were not observed on this machine.
- **Residual risk (upgrade window only):** `montral_apply_billing_event` (`subscription_created`) locks `montral_billing_intent` (FOR UPDATE) before `montral_subscription`, which is the opposite of checkout. No single migration lock order matches both functions, so a genuine one-time upgrade can still deadlock with a concurrent webhook. Steady-state restarts take no billing table locks, so they cannot. If the upgrade case happens, the request now gets a retryable 503 and the provider retries the signed event, which is deduplicated by digest.
- The existing flaky CI assertion should stop failing once the no-op migration no longer locks tables. Confirm this in CI on this branch.
