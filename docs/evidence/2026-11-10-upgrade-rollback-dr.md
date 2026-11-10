# Upgrade, rollback and disaster-recovery qualification

## Gap
Each migration was tested on its own, and backups were restored into scratch databases
(`qualify-backup.mjs`). Nothing had shown that a real installation of the previous release candidate still works
after an upgrade: data, sessions, API keys, share links and webhook receivers. Nothing defined or tested a
rollback, and nothing recovered a database lost under a running server or measured how long recovery takes
(ledger items 23-25).

## Qualification
`scripts/qualify-upgrade.mjs` runs in CI through `.github/workflows/montral-upgrade.yml` on push to main, on pull
requests and on manual dispatch. It uses the shipped `postgres:18.6-alpine` image as a service, PostgreSQL 18 client
tools and Node 24.22.1. It refuses any host other than 127.0.0.1/localhost, any URL with query parameters and any
database not named `montral_test_*`. Every database it creates or drops is that name plus a fixed suffix. All data
is synthetic: monitors target an HTTP server inside the script, and nothing leaves the runner. The JSON summary is
uploaded as the `montral-upgrade-summary` artifact.

The previous release candidate is `17f55c1` ("release-readiness report at c58c24a", #42). It is checked out with
`git worktree` next to the commit under test, and both are built with `pnpm --filter @montral/api build:node`. Both
builds run the self-hosted Node server (`apps/api/dist/server.mjs`) with the same `BETTER_AUTH_SECRET`, one at a
time on the same port.

### A. Upgrade
1. The old build starts on an empty database (53 migrations) and is seeded through its API:
   - 3 users (owner, an invited member who accepted, and another tenant) and 2 projects;
   - 8 monitors: HTTP with keyword, HTTP with JSON assertion, TCP, two heartbeats, DNS and domain (paused, so
     nothing leaves the runner), and HTTP in the second project;
   - 2 channels (webhook, email);
   - 3 incidents with 8 timeline updates (one resolved);
   - 3 status pages: a public page with a custom domain, a password page and a members-only page with a share link;
   - 2 webhook inboxes with 4 events;
   - maintenance windows (one-off and a weekly series, 10 windows);
   - an API key.

   Two shortcuts are taken by SQL, as the e2e tests do: email verification (no mail server) and the DNS proof of the
   custom domain.
2. The old build runs for 35 s, so its scheduler records results. Its behaviour baseline passes, then it stops
   (exit 0).
3. Pre-upgrade backup with the documented command: `docker exec -i <postgres> pg_dump -U montral -Fc <db>`, which is
   what `docker compose exec -T postgres pg_dump ...` runs.
4. HEAD starts on the same database and its migration runs (53 -> 54). Checks:
   - Every seeded entity reads back identically through HEAD's API, field by field (`compareSnapshots`), and the
     entity counts are unchanged.
   - No table lost a row.
   - Behaviour: the old build's session cookie still works; sign-in works and a wrong password is refused; the API
     key works; the member sees the workspace; tenant isolation holds; the share link opens the members page, which
     stays closed without it; the password page unlocks and stays closed without the password; the custom domain
     serves its page and nothing else; webhook events are readable and the receiver URL still accepts events.
   - HEAD's own 30 s scheduler tick records new results with no scheduler failure, and HEAD stops with exit 0.

### B. Rollback
- **The old build on the upgraded schema fails safely.** Its documented read-only check (`migrate-plain.mjs --check`)
  exits 1 with `Database migration history is ahead of this build`, which names the reason. The 17f55c1 server
  itself does not say why: it never listens, retries its migration as if PostgreSQL were still starting, and exits 1
  after 59 s with the generic `Database connection/migration unavailable after bounded startup retries`. A container
  then restart-loops. Afterwards every table's row count and SHA-256 fingerprint, every catalog object (columns,
  indexes, constraints, triggers with their enabled state, functions) and the migration history are unchanged.
- **From this PR on, the server refuses at once and says why.** Found by review of this qualification:
  - `validateMigrationHistory` tags "ahead" and "diverged" histories.
  - `server.ts` exits 1 immediately, before listening and without the retry loop, with
    `database schema is newer than this Montral build; restore the pre-upgrade backup or run the newer build`.
    Connection failures keep retrying (unit test: `startup-schema.test.ts`).
  - The qualification adds a migration row unknown to HEAD and asserts that HEAD exits 1 in 401 ms with that
    message, never retries or listens, and changes no row. The row is then removed and the database is back to its
    upgraded fingerprint.
- **Supported rollback: restore the pre-upgrade backup into an empty database and start the old build.** The
  restore uses the documented container commands (`createdb`, then `pg_restore --no-owner`). The restored database
  equals the pre-upgrade state in every table's row count and SHA-256 fingerprint and in every catalog object. The
  old build starts on it, reads back every seeded entity, passes the same behaviour checks (including the
  pre-upgrade session) and keeps its own migration history (53).

### C. Disaster recovery
1. HEAD runs on the upgraded data, and its scheduler ticks.
2. Two backups are taken **while it keeps running**:
   - `pg_dump -Fc --snapshot=<id>` of a snapshot exported in a REPEATABLE READ transaction. The same transaction
     fingerprints every table, so the dump can be compared exactly.
   - The documented command (`docker exec -i <postgres> pg_dump -U montral -Fc <db>`, checked with
     `pg_restore --list`).
3. Disaster: the server is killed with SIGKILL and the database is dropped.
4. Recovery with the documented commands into a **new database name** (`createdb`, `pg_restore --no-owner` in the
   PostgreSQL container). HEAD starts on it and is verified: sign-in, the old session, the API key, share link,
   password page, custom domain, webhook events, every seeded entity read back, and a scheduler tick. That makes up
   the measured RTO.
5. Integrity:
   - The documented dump restores every table the app did not write during the dump (all 53 here) with an
     identical SHA-256 fingerprint. A table written during the dump would have to restore with a row count between
     its before and after counts.
   - The snapshot dump, restored into another new database, equals the snapshot in all 53 tables (186 rows) and in
     every catalog object.

## Results
**Cited run:** [42736834472](https://github.com/TheHalfMoon/Montral/actions/runs/42736834472) on commit `d952071`,
with every check passing. Times agree within about 10 % with the earlier green run 42725960774 (`77bb603`).
After rebasing on main (OIDC SSO, #49, migration 0054), run
[42756838579](https://github.com/TheHalfMoon/Montral/actions/runs/42756838579) on `ff6ae90` passed with the same
checks while upgrading through two migrations (53 -> 55). HEAD start including both migrations took 0.64 s and the
RTO was 2.0 s (2,047 ms). The snapshot restore was exact over 59 tables and 187 rows. Runner: GitHub-hosted `ubuntu-latest`, PostgreSQL 18.6 (Alpine) service,
Node 24.22.1.

| Measurement | Result |
|---|---|
| Seeded dataset | asserted exactly: 2 projects, 8 monitors, 2 channels, 3 incidents (8 updates), 3 status pages, 1 share link, 2 inboxes (4 events), 10 maintenance windows, 1 API key; 48 tables (22 non-empty, 174 rows) before the upgrade, 53 after |
| Old build start on an empty database | 1.1 s (53 migrations) |
| Seeding through the old API | 1.6 s |
| Pre-upgrade backup (documented command) | 0.21 s |
| HEAD start on the old database, migration included | 0.44 s (53 -> 54) |
| Entities read back after the upgrade | all, field by field; counts unchanged |
| Old build (17f55c1) on the upgraded schema | `migrate-plain --check` exit 1 "history is ahead"; server exit 1 after 59 s (generic retry message); 0 rows, 0 catalog objects changed |
| HEAD on a future schema | exit 1 after 401 ms, "database schema is newer than this Montral build; ...", no retry, no listen, 0 rows changed |
| Rollback restore (createdb + pg_restore, documented) | 0.54 s; exact SHA-256 match with the pre-upgrade state |
| Old build start on the restored backup | 0.44 s |
| Live backups while HEAD runs | snapshot `pg_dump` 0.18 s; documented command 0.21 s |
| **RTO** (database dropped -> app verified) | **2.0 s** (1,965 ms): createdb 0.09 s, pg_restore 0.48 s, start to healthy 0.44 s, verification 0.95 s |
| Snapshot restore | 0.49 s; 53 tables, 189 rows, every SHA-256 fingerprint and catalog object equal |

## Findings
- **No application defect found.** The upgrade from 17f55c1 kept everything that was checked: sessions, API keys,
  share links, page passwords, custom domains and webhook receiver URLs, with the same `BETTER_AUTH_SECRET`.
- **Rollback is restore-only, by design.** Migrations go forward only, and an old build refuses a newer history
  without writing anything. The self-host docs (en/zh) now give a section "Upgrade and rollback" with the exact
  qualified commands. Back up before upgrading. To roll back, restore into an **empty** database. Restoring a
  pre-upgrade dump over the upgraded database with `--clean` is called out as unsupported: objects the upgrade
  added are not in the dump and would stay behind.
- **Restart loop with an unclear message (fixed going forward).** A 17f55c1 container started on a database that is
  too new exits after about a minute with a message that looks like a connection problem, then restart-loops. Builds
  from this PR on exit at once and say what to do. The loop never wrote anything.

## Limits
- The dataset is small (174-189 rows), so the 2.0 s RTO is a floor for the procedure, not a capacity figure.
  Restore time grows with the database, mostly in `pg_restore`. Measure your own with a scratch restore (see
  Backup and restore).
- One previous release (17f55c1) on one PostgreSQL major (18). Upgrades across several releases, and from
  PostgreSQL 17, are not covered here. Major-version moves are dump and restore by design.
- Email verification and the custom domain's DNS proof are set by SQL. Mail delivery and DNS are qualified
  elsewhere.
- Within this qualification, "documented compose command" means `docker exec -i` into the PostgreSQL service
  container, which is what `docker compose exec -T` runs. The compose stack itself is qualified in
  `montral-docker.yml`.
- The migrations upgraded through are 0053 (on-call) and 0054 (OIDC SSO). Newer ones (for example #54's) are
  upgraded through on every pull request and push to main once they land.

## Backup stream integrity (PR #58)

A review of #55 found that the qualification could read a backup before Docker's piped output was fully on disk.
`scripts/docker-file-transfer.mjs` now resolves only when the process exited 0 **and** every byte was read from the
source or flushed to the destination, and fails closed: any non-zero exit, signal, spawn error or stream error on
either side rejects; an existing destination is never overwritten (`wx`); a destination the call created is deleted
again on failure, so no partial backup can be restored later; a process that ignores the kill cannot hang the run.

`scripts/docker-file-transfer.test.mjs` (11 tests, real files, faked Docker process) covers: complete flush when the
process exits first (4 MiB), existing destination untouched (`EEXIST`), destination that cannot be created (`ENOENT`),
a write failing part-way (`ENOSPC`, partial file removed), non-zero exit, early termination by `SIGKILL`, a truncated
source stream (`ECONNRESET`), spawn failure, restore from a missing file, restore input the process stops reading
(`EPIPE`), and a complete 3 MiB restore. Negative control: against #58's original implementation 5 of these tests fail
(partial or invalid backup files left behind).

In the real qualification each documented backup is opened with `pg_restore --list` (this checks the custom-format
header and table of contents only). Completeness is proven by restoring: the rollback restore of the pre-upgrade backup
and the disaster-recovery restore are compared table by table with exact SHA-256 fingerprints, and a truncated copy
(half of a real `pg_dump -Fc` archive) must be refused by the documented `pg_restore --exit-on-error` restore.

**Review of #58 (record).** One independent agent review was run in the engineering session on the final change; it
was not posted to GitHub (the owner's comment on the earlier head `4b7779b` noted that a review was still missing; this
is the review that followed). It found no correctness defect and two low-severity issues, both fixed before merge:
the harness comment and this document overstated what `pg_restore --list` proves (corrected above), and a destination
file opened only after the bounded post-failure wait could have been left behind (now removed as soon as it opens).
Exact-head CI on `d8854bd`: all 13 check runs succeeded. The statement that 5 of the 11 transfer tests fail on the
previous implementation is from a local run recorded in commit `25287d2`; it was not run in CI.

**Coverage boundary.** End to end against real `pg_dump`/`pg_restore`, only the truncated-archive case is proven. Partial
writes, non-zero exit, termination by signal, a broken stream and an existing destination are proven by the unit tests
in `scripts/docker-file-transfer.test.mjs` with real files and a simulated Docker process.
