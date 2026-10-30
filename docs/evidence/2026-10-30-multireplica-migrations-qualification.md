# Montral — multi-replica PostgreSQL migration serialization qualification

**Date:** 2026-10-30. **Source base:** private `TheHalfMoon/Montral`, commit `51aee5bf5752ef4d0f087de3c0307478d125aee3`. Work performed only on authorized Mac, on disposable synthetic data.

## Risk closed in source

The core Drizzle migration path already used an advisory lock and a single PostgreSQL transaction. However, Montral's edition-specific schema initialization (webhook inboxes, sandbox subscription tables, usage metering and SQL functions) occurred **outside that transaction**, after the core Drizzle lock was released. Independent API instances on an initially empty database could concurrently attempt `CREATE TABLE IF NOT EXISTS` on the same table and fail with PostgreSQL catalog uniqueness errors (`pg_type_typname_nsp_index`). The test runner had an earlier one-time setup barrier, but this does not protect a real multi-replica deployment.

**Implementation:** `Database.migrateEdition` in the PostgreSQL backend uses `postgres-js` `begin`, takes a transaction-scoped advisory lock for `montral:edition:migrate`, and passes a **transaction-bound query interface** to Montral's edition-specific migration functions. All edition DDL either commits together or rolls back together, without reserving a second connection. The code path is compatible with **a single connection per Worker request** (`max:1`).

A shared `migrateMontralSchema` coordinator runs the existing locked core migrations first, then the transactionally locked edition migrations. Both the Node startup path and authenticated `/internal/migrate` runtime path use it; Vitest's test-only bootstrap also reuses it. Other backends' optional migration adapter is a compatibility fallback, not evidence of production-grade locking.

## Live local PostgreSQL verification

`apps/api/src/schema-migrate.e2e.test.ts`:
- Creates a **brand-new disposable** test database on 127.0.0.1 (separate from the shared API test database).
- Opens **four independent PostgreSQL pools**, each with `max:1`, and starts all four Montral schema migrations concurrently.
- Confirms each core Drizzle migration executes at most once, required Montral tables exist, and **five** transactional Montral SQL functions exist.
- Forces an error midway through a separate edition migration transaction and verifies the temporary table **does not survive rollback**.
- Confirms overlapping edition lock callbacks serialize without deadlock on a single-connection pool.
- Drops only the test-owned temporary database and closes the pools after validation.

### Final local test and build results

| Check | Verified result |
|---|---|
| API with disposable PostgreSQL 17 | **562/562** tests passing (75 files) |
| Web after Node-target build | **122/122** (25 files) |
| Probe | **20/20** (4 files) |
| **Total** | **704 passing tests** |
| TypeScript and Astro (all packages) | PASS |
| Node API, Node web, Edge Probe bundles | PASS |
| Node + PostgreSQL smoke | PASS |
| Real Chromium signup, webhook capture/inspection, disabled checkout | PASS |
| `pg_dump` and restore | PASS: 42 tables, **110 synthetic organizations**, 5 SQL functions |
| Exact original donor integrity | PASS: **638** files unchanged |

**Caveats:** The Mac uses Node v26.0.0, below Montral's declared Node v26.12.1 minimum. GitHub Actions currently fails before allocating any runner (zero test steps), so green hosted CI on a supported Node version is still absent. No real Cloudflare Hyperdrive multi-replica deployment, failover, permission-limited managed PostgreSQL, production payment provider, external traffic, customer data or public release was tested or authorized.

### Reproduction

Use a local, disposable PostgreSQL database named `montral_test_...` and run `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, and

```sh
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temp-port>/montral_test_<suffix>' \
  pnpm --filter @montral/api exec vitest run src/schema-migrate.e2e.test.ts
```

Full suite: `pnpm --filter @montral/api test`, `pnpm --filter @montral/web test`, and `pnpm --filter @montral/probe test`. Node smoke, Chromium and backup/restore details remain in the previous qualification reports.

**Release decision:** improved local multi-replica schema concurrency; **not approved for production launch**. Hosted migration orchestration, real CI, Cloudflare, payments, privacy and operations gates remain pending.
