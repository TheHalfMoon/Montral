# PostgreSQL restore catalog fidelity and fail-closed negative control

**Date:** 2026-11-02 Asia/Riyadh. All tests on an authorized Mac using localhost PostgreSQL 17.9, Node 24.22.1, and disposable databases under `montral_test_*`. No production connection, DNS, Cloudflare, external provider, or customer data.

## Fault demonstrated — RED

Existing `scripts/qualify-backup.mjs` validated all table row counts, SHA-256 normalized row-content fingerprints, table count, selected business tables, and eight named SQL functions. However, it **did not check catalog objects or the enabled state of security/immutability triggers**.

A controlled, temporary `pg_restore` wrapper first performed a normal full restore and then ran **only on the just-created random `montral_restore_test_*` target**:

```sql
ALTER TABLE public.monthly_report_content
  DISABLE TRIGGER montral_monthly_content_no_update_trigger;
```

**Observed old behavior: EXIT 0 / `RESTORE_DRILL_PASS`** even though the database could now permit mutations that the original schema prohibited. All table contents matched; the disabled trigger was a true operational integrity gap.

## Repair — GREEN

The restore drill now takes source schema fingerprints **before and after** the dump and compares them to the restored target, in addition to its previous full-content checks.

- **Columns:** data types, nullability, identity/generated settings, defaults, collation and storage.
- **Relations:** table/view kind, persistence, row-level-security flags and replica identity.
- **Triggers:** full PostgreSQL `pg_get_triggerdef` plus `tgenabled` so disabling an otherwise unchanged trigger fails.
- **Indexes:** normalized `pg_indexes.indexdef`.
- **Constraints:** definitions, types, validated/deferrable/deferred flags.
- **Functions:** PostgreSQL `pg_get_functiondef` for functions in `public`.
- **Views and row-level-security policies:** PostgreSQL view/policy metadata.

Catalog object values are SHA-256 fingerprints; differences report **only the object category and name**, not customer data or serialized function definitions. Source drift during the dump is also rejected. The original data integrity checks and required Montral business tables/functions remain in place.

A permanent `scripts/qualify-backup-negative.mjs` **injects that same corruption into only a fresh test restore**. It requires a localhost `montral_test_*` source, uses a private disposable wrapper, asserts that the drill fails for the exact trigger catalog mismatch, and deletes the wrapper. GitHub Actions runs the negative test after the normal backup/restore drill using its dedicated disposable `montral_test_restore_ci` source.

**Local verification:**
- Before change: corrupt trigger → `RESTORE_DRILL_PASS` (unsafe).
- After change: correct restore → `RESTORE_DRILL_PASS`, with all schema and content fingerprints matching.
- After change: corrupt trigger → expected failure `Restored PostgreSQL catalog differs: triggers:monthly_report_content.montral_monthly_content_no_update_trigger`.
- Direct standalone negative test → `RESTORE_CATALOG_NEGATIVE_PASS`.
- Repeated with **46 migrated tables, 4 nonempty tables, 8 synthetic organizations, 8 projects and 8 monitors**, with no source modifications by the restoration script.

## Limits and release status

This does **not** prove production backup snapshots, WAL PITR, managed PostgreSQL point-in-time rewind, independent disaster-region recovery, encryption, privilege/grant portability, real failover, third-party infrastructure readiness or live billing. External infrastructure and a commercial release remain **NO-GO** without separately authorized qualifications. No provider was enabled or deployed.

## Supported Node and full local package qualification

Using the authorized Mac, Node **v24.22.1** and an independently created disposable PostgreSQL database, bounded test workers (API 2, DB 1): **1,038/1,038 package tests PASS** — API **779/779** in 99 files, PostgreSQL **115/115** in 10 files, Probe **20/20** in 4 files, Web **124/124** in 26 files. TypeScript/Astro typechecks, Node API/Edge Probe/Web production builds, **638/638** pinned donor file hashes and active product branding guard all PASS. The backed-up catalog-positive and intentionally corrupted catalog-negative drills also both pass their expected results on Node 24.22.1 with PostgreSQL 17.9. GitHub-hosted exact-commit verification is separate from local results.
