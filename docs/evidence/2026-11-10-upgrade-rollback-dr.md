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
  exits 1 with `Database migration history is ahead of this build`. The old server itself never listens: it retries
  its migration and exits 1 after 59 s. Afterwards every table's row count and SHA-256 fingerprint, every catalog
  object (columns, indexes, constraints, triggers with their enabled state, functions) and the migration history are
  unchanged.
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
**Cited run:** [42725960774](https://github.com/TheHalfMoon/Montral/actions/runs/42725960774) on commit `77bb603`
(job 4 min 6 s), with every check passing. Runner: GitHub-hosted `ubuntu-latest`, PostgreSQL 18.6 (Alpine) service,
Node 24.22.1.

| Measurement | Result |
|---|---|
| Seeded dataset | 48 tables before the upgrade (24 non-empty, 177 rows), 53 after |
| Old build start on an empty database | 1.1 s (53 migrations) |
| Seeding through the old API | 1.5 s |
| Pre-upgrade backup (documented command) | 0.22 s, 155 KB |
| HEAD start on the old database, migration included | 0.44 s (53 -> 54) |
| Entities read back after the upgrade | all, field by field; counts unchanged |
| Old build on the upgraded schema | refused: `migrate-plain --check` exit 1; server exit 1 after 59 s; 0 rows, 0 catalog objects changed |
| Rollback restore (createdb + pg_restore, documented) | 0.57 s; exact SHA-256 match with the pre-upgrade state |
| Old build start on the restored backup | 0.44 s |
| Live backups while HEAD runs | snapshot `pg_dump` 0.18 s (173 KB); documented command 0.22 s (173 KB) |
| **RTO** (database dropped -> app verified) | **2.0 s**: createdb 0.10 s, pg_restore 0.50 s, start to healthy 0.44 s, verification 1.0 s |
| Snapshot restore | 0.55 s; 53 tables, 186 rows, every SHA-256 fingerprint and catalog object equal |

## Findings
- **No application defect found.** The upgrade from 17f55c1 kept everything that was checked: sessions, API keys,
  share links, page passwords, custom domains and webhook receiver URLs, with the same `BETTER_AUTH_SECRET`.
- **Rollback is restore-only, by design.** Migrations go forward only, and an old build refuses a newer history
  without writing anything. The self-host docs (en/zh) now give a section "Upgrade and rollback" with the exact
  qualified commands. Back up before upgrading. To roll back, restore into an **empty** database. Restoring a
  pre-upgrade dump over the upgraded database with `--clean` is called out as unsupported: objects the upgrade
  added are not in the dump and would stay behind.
- **Restart loop.** A container started on a database that is too new exits after about a minute and is restarted
  by its restart policy. The loop is harmless (no writes), but it is a sign that the wrong image is running.

## Limits
- The dataset is small (177-186 rows), so the 2.0 s RTO is a floor for the procedure, not a capacity figure.
  Restore time grows with the database, mostly in `pg_restore`. Measure your own with a scratch restore (see
  Backup and restore).
- One previous release (17f55c1) on one PostgreSQL major (18). Upgrades across several releases, and from
  PostgreSQL 17, are not covered here. Major-version moves are dump and restore by design.
- Email verification and the custom domain's DNS proof are set by SQL. Mail delivery and DNS are qualified
  elsewhere.
- Within this qualification, "documented compose command" means `docker exec -i` into the PostgreSQL service
  container, which is what `docker compose exec -T` runs. The compose stack itself is qualified in
  `montral-docker.yml`.
- The migration in this run is 0053 (on-call). When newer migrations land (for example 0054 in #54), this workflow
  upgrades through them on every pull request.
