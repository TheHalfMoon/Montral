# Hosted PostgreSQL 17 restore drill: match the pg_dump client major version

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private GitHub Actions test runner, synthetic PostgreSQL 17 service. No production database, paid service, or deployment is involved.

## Verified hosted CI failure

GitHub Actions [41294148320](https://github.com/TheHalfMoon/Montral/actions/runs/41294148320) passed source integrity, Node/TypeScript/Astro, all API/PostgreSQL/probe tests, all three production builds, production-route web tests and Node/PostgreSQL smoke. It failed its **full-table backup/restore** step before taking a dump. The trace clearly recorded:

```text
pg_dump: error: aborting because of server version mismatch
pg_dump: detail: server version: 17.11 (Debian ...)
pg_dump version: 16.15 (Ubuntu ...)
```

The GitHub `ubuntu-latest` runner's default PostgreSQL client is 16 even though the CI database service is `postgres:17`. A *major-version-older* pg_dump refuses to back up a newer server. This does not indicate a source row/content mismatch: the custom archive was never written. The command's exit status correctly made the workflow fail; it must not be skipped or suppressed.

## Correction

Add a dedicated **Install PostgreSQL 17 backup client** GitHub Actions step immediately before the existing backup drill. Use PostgreSQL's official PGDG signed APT repository, install `postgresql-client-17` in the ephemeral runner, check that the major-version-17 `pg_dump` and `pg_restore` binaries exist, print their versions, and prepend `/usr/lib/postgresql/17/bin` to `GITHUB_PATH`. This causes the original *unchanged* `scripts/qualify-backup.mjs` to use PostgreSQL 17 for dump and restore and execute the full 46-table source-versus-restored SHA-256 fingerprint and row-count verification. It does not change the actual database server, downgrade checks, delete data, add new paid services, or use any customer information.

## Qualification and limitations

- Root cause confirmed from hosted GitHub Actions stderr (server 17.11 / client 16.15).
- Local macOS PostgreSQL 17.9 backup/restore with 46 tables, eight synthetic organizations/projects/monitors and all-content SHA-256 fingerprints was already PASS on the preceding commit. This patch edits CI only; the same restore validator remains unchanged.
- Actual hosted PostgreSQL dump/restore and the downstream Chromium and SMTP steps must be checked on the new commit before calling hosted CI green. If runner package retrieval is unavailable, treat that as a real infrastructure blocker; never silently skip the restore drill.
- Node 20 deprecation warnings on third-party GitHub actions are separate from this failure, and the workflow's temporary Node-24 override is not proof of future action compatibility.
