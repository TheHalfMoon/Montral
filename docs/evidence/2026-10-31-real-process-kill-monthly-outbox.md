# Real SIGKILL monthly report outbox recovery — 2026-10-31

**Environment:** Authorized Mac, supported Node 24, local PostgreSQL, synthetic-only Montral staged outbox, private GitHub repo. **No production scheduler, external SMTP, hosted database, live account, merchant, or paid services.**

## Why a real process-kill drill was necessary

Earlier `monthly-report-atomic-enqueue` and staged dispatcher tests simulated transaction exceptions and worker restarts by creating new database connections. They could not show the effect of terminating a real Node process while a PostgreSQL transaction was open or after a durable outbox attempt. A false-positive risk exists if a TS/JS loader creates a subprocess and the test kills only its parent while the database client continues running and ultimately commits.

## Reproducible, guarded local qualification

`pnpm --filter @montral/api qualify:monthly-kill` runs `apps/api/scripts/qualify-monthly-kill.ts` with a real `SIGKILL` signal against **dedicated detached Node process groups** and checks PostgreSQL state after disconnect. It requires an already-disposable `TEST_DATABASE_URL` with a loopback hostname and `montral_test_*` database name. It then creates a **different new `montral_kill_<random>` database**, migrates it, seeds only synthetic workspace/owner addresses, starts child workers with **minimal environment variables (no inherited GitHub/payment/provider secrets)**, and destroys its fixture database and private local delivery sink. Neither the script nor its child is a production job, service, scheduler, route or deployment action.

The child uses Montral's real `claimMonthlyReportsWithRecipients`, `claimMonthlyOutboxAttempt` and `runStagedMonthlyOutboxBatch` logic. The report data and SMTP acceptances are synthetic. It writes only `accepted` markers to a local file with `fsync` to independently represent a provider acceptance without network connectivity. It records no raw addresses, body content or authentication tokens. The script never sends external mail.

## Actual kill boundaries asserted

1. **Within an uncommitted owner-snapshot transaction:** a disposable PostgreSQL trigger pauses the *real* transaction after INSERT, before UPDATE/COMMIT. The orchestrator sees the backend's `PgSleep` wait state and sends `SIGKILL` to the worker's entire process group. It waits for PostgreSQL to release the sleeping session and verifies **no month claim, no recipient row, no email debit, and no idempotency reservation**. This is actual rollback after OS process death, not a caught exception.
2. **Committed snapshot before any SMTP attempt:** the child commits the month and `prepared` recipient and is killed. A freshly spawned worker recovers the record, records the first attempt, accepts one synthetic message and charges one email; subsequent restarts do not replay.
3. **Durably claimed attempt and quota before SMTP:** the child commits `attempted` and one monthly usage reservation, then is killed. After restart, the recipient remains `attempted` and **no** SMTP call happens. This intentionally sacrifices possible delivery to preserve at-most-one-attempt semantics.
4. **Synthetic provider accepted before recording the result:** the child's transport persists and fsyncs one acceptance marker and then never resolves; the process group is killed. PostgreSQL still has a durable `attempted` record and one quota reservation. A new worker does **not** accept or debit again. External SMTP provider idempotency is neither implemented nor claimed.
5. **Historic org-only claim with no recipient rows:** recovery does not infer consent to retry or construct missing recipients. No quota, new outbox record, or SMTP request occurs.

The worker's only death mechanism is OS SIGKILL rather than an application-level `throw`. The precommit transaction necessarily waits for the local PostgreSQL session to exit before claiming rollback. An initial overly long `pg_sleep` exposed that PostgreSQL can remain in its sleep even after its client is killed; the test uses a bounded 7-second sleep, kills the detached **process group**, and waits for server disconnect, preventing a misleading immediate rollback assertion.

## Limitations / release decision

This is a **real OS crash drill with synthetic, local file-backed provider acceptance**. It does not qualify external SMTP delivery, actual transport/provider timeouts, managed PostgreSQL failover/PITR, network partition handling, full report-content immutability, production scheduler migration, or deployed multi-region workers. The staged worker remains unconnected to live cron. The default-disabled owner review API remains an **attestation**, not independent provider evidence verification. Historical pre-outbox claims remain permanently non-replayable unless independently reconciled. **NO-GO for production rollout** until remaining release gates and explicit authorization are satisfied.

## Validation results

Full supported Node and monorepo test counts, three production-target builds, local Chromium and SMTP loopback, restore fingerprints and donor file hashes are appended after qualification. Hosted GitHub Actions fail before runner assignment due to account billing/spend-limit status; this local drill is not a substitute for green hosted CI.

## Final verified Mac results

- **`MONTHLY_REAL_SIGKILL_DRILL_PASS`**, from the documented command on supported Node v24.22.1 / pnpm 10.0.0 / local PostgreSQL 17.9: `KILL_PRECOMMIT_ROLLBACK_PASS`, `KILL_COMMITTED_SNAPSHOT_RECOVERY_PASS`, `KILL_ATTEMPT_BEFORE_SMTP_NO_REPLAY_PASS`, `KILL_AFTER_PROVIDER_ACCEPTANCE_NO_REPLAY_PASS`, `KILL_LEGACY_CLAIM_NO_RESURRECTION_PASS`. Ran successfully both before and after isolating child environments from parent credentials. The final run also used cancellable process-exit timeouts.
- **941/941 full local tests passed**: 686 API, 111 PostgreSQL, 20 Edge Probe, 124 Web. The SIGKILL drill is a **separate additional system-level qualification** and is not counted as a Vitest case.
- Monorepo `pnpm -r typecheck` PASS. Production Node API, Node Web SSR, and Edge Probe builds PASS; Node/PostgreSQL HTTP health, configuration, MCP discovery and dashboard smoke PASS.
- Real local Chromium synthetic user/signup, monitor, incident, webhook, disabled billing, password-reset privacy and **default-disabled owner-review UI** `BROWSER_E2E_PASS`. Synthetic SMTP `SMTP_LOOPBACK_PASS` for verification, channel, incident down/recovery and account recovery. No external mail.
- `RESTORE_DRILL_PASS`: **45 PostgreSQL tables (36 nonempty), 118 synthetic organizations**, seven required transactional SQL functions, and exact per-table row counts and normalized SHA-256 content fingerprints after real `pg_dump` and `pg_restore`. Hosted PITR, load and regional failover remain unqualified.
- **43 embedded Drizzle migrations** synchronized and **638 pinned donor-source files** verified unchanged. No core schema migration, provider, scheduler, or deployment behavior changed by this qualification.
- The isolated `montral_kill_*` database and fsynced local acceptance sink were destroyed after qualification. Every subprocess was SIGKILL terminated or exited cleanly, and no test database remained.

Hosted GitHub Actions must be checked independently. Passing this local SIGKILL drill does not resolve account billing/spend limits, external email delivery ambiguity, production scheduler rollout, or the project's NO-GO release status.
