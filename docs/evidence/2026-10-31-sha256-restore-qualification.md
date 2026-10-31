# Montral PostgreSQL SHA-256 content restore qualification — 2026-10-31

## Scope

Authorized Mac, private Montral repo, **Node v24.22.1 / pnpm 10.0.0**, local disposable PostgreSQL 17.9, synthetic-only seed data. No live merchant, third-party SMTP, Cloudflare production region, public publication or production data was used.

## Why this additional gate exists

The earlier database restore qualification checked the 42 schema tables, 5 business-critical functions, and per-table **row counts**. A backup with a changed row value but unchanged row count could slip past that validation. This update makes the check sensitive to **actual row values**:

- `scripts/qualify-backup.mjs` derives a deterministic `to_jsonb(record)::text` representation for every row, calculates a SHA-256 digest for each row, sorts those digests so physical row ordering is immaterial, then SHA-256 hashes the sorted sequence. This creates a separate content fingerprint for **every table**, including empty tables. Duplicate rows contribute repeated digests.
- All source table fingerprints are collected before the backup and again after `pg_dump`. The drill refuses to approve a source that changed in between, including same-row-count edits.
- After `pg_restore` to a new temporary database, the drill verifies the whole table set, each table's row count, and its full normalized-content fingerprint. Any mismatch fails the qualification and reports only the relevant table names, not secret row values.
- A pass is printed only **after** the restored temporary database and dump files are removed successfully. This is still a bounded local drill, not a hosted PITR or a guarantee against concurrent mutations between checks.

## Verified on local PostgreSQL

- Migrated a new disposable database through the built Node Montral API; normal HTTP smoke passed.
- Seeded **128 synthetic organizations, 128 projects, 128 heartbeat monitors, 128 status pages, and 128 alert channels**. The 42-table restore returned: **6 nonempty tables, all 42 content fingerprints matched, 5 business-critical functions present**. No production traffic or external alerts were generated.
- Adversarial checksum discrimination: created two synthetic rows, changed the `payload` of one row without inserting/deleting rows, and confirmed the total row count stayed 2 while the content SHA-256 fingerprint changed. This verifies the specific gap that count-only checks miss.
- Added a self-contained GitHub Actions step after Node smoke and before browser qualification. It creates and migrates its own disposable PostgreSQL database, seeds 8 synthetic organizations/projects/monitors, runs the same SHA-256 restore drill, and drops the database via a shell trap.
- Extracted and executed that **exact CI shell block locally**, not an approximation: `RESTORE_DRILL_PASS: 42 tables (4 nonempty), 8 synthetic organizations, every table row count and SHA-256 content fingerprint matched`; both scratch and restored databases cleaned.
- Node/API/web production builds passed on Node v24.22.1; full TypeScript, API, probe and web test suites and donor integrity checks were rerun locally as part of this wave.

## Explicit limitations

- Uses normalized PostgreSQL JSONB values rather than a byte-for-byte disk or WAL comparison. Hash collisions are theoretically possible. The `string_agg` approach is **not intended for unbounded production-size databases**; qualification executes on explicitly disposable, small synthetic data only.
- Changes to the source during a backup that reverse before both snapshots are checked cannot necessarily be detected. A production PITR backup strategy needs managed snapshots, replication/WAL and independent recovery exercises.
- **GitHub Actions hosted CI is still runner-blocked:** before this commit, jobs returned with empty runner names and zero executed steps despite Actions being enabled. The CI shell step was replayed locally but has not been qualified by hosted CI.
- Cloudflare live probes, external SMTP, production merchant checkout, abuse/privacy review and publishing approval remain open. Keep Montral private and do not deploy or activate billing.
