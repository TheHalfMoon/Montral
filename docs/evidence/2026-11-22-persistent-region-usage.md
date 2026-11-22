# Persistent per-region usage accounting (2026-11-22)

## Scope

This is a working engineering change for TASK-LEDGER row 55, based on the existing #93 region-credit refund path and #192 idempotent refund records. It extends accounting; it does not enable live billing, alter Community's unmetered behavior, deploy probes, or rewrite past customer balances. Community publication remains HOLD and Cloud/BYOC remain NO-GO.

## Behavior

- A metered scheduled check reserves one durable row per plan-allowed region. The operation and monthly aggregate credit debit commit together in PostgreSQL.
- Scheduled operation keys use the persisted monitor run generation. Repeating the same reservation is idempotent; reusing a key with different monitor or region inputs is rejected.
- Settlement records each returned regional result as completed, including a completed negative result. Planned regions without a result are marked unavailable and refunded once in the same database transaction that adjusts monthly aggregate usage.
- Repeated identical settlement is idempotent. A different settlement for the same operation is rejected. If the aggregate usage row or per-region reservation evidence is missing, settlement fails and the reservation remains unverified.
- A reservation still open after five minutes appears as unverified in the current UTC-month `/api/usage` summary. It stays charged until a result can be established; the system does not guess whether an outbound attempt happened before a process crash.
- Manual metered region checks use the same persistent reservation and settlement records. Browser checks retain their existing separate credit and browser-seconds handling.
- The usage summary reports planned, completed, failed-result, unavailable, recent-reserved, unverified, charged, and refunded counts by region. It contains no probe URLs or credentials.

## Historical boundary

The historical ledger retains aggregate monthly usage and refund settlement amounts, but not the region result set needed to establish which region completed or whether a reservation was left unverified. No backfill or retroactive customer adjustment is performed. This change starts region-level evidence when deployed.

## Verification

- `apps/api/src/scheduler.test.ts`: 61/61 passed, including durable run-generation keys, fail-closed behavior without a generation, and preserved Community behavior.
- `apps/api/src/montral-metering.e2e.test.ts`: 15/15 passed on a disposable local PostgreSQL 18.7 database. Coverage includes concurrent duplicate reservation, idempotent settlement, partial-result refund, mismatched-key rejection, missing aggregate usage evidence, quota denial, and serialization against ordinary credit spending.
- API TypeScript typecheck: passed.
- `git diff --check`: passed.

These are local branch checks. They are not hosted exact-head CI or release qualification. No independent external probe, production billing, deployment, or security clearance is claimed.
