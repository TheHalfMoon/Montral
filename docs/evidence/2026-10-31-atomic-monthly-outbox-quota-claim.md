# Atomic monthly recipient outbox + email quota claim — 2026-10-31

**Repo:** PRIVATE `TheHalfMoon/Montral`. **Mac only** on Node 24.22.1 / pnpm 10.0.0, local PostgreSQL 17.9. **Synthetic data only**. No paid services, deployment, release, production SMTP, or connected merchant.

## Previous gap and implemented boundary

The earlier staged monthly recipient outbox (`monthly_report_recipient`, migration 0041) and idempotent email quota ledger (`montral_usage_reservation`, `montral_spend_usage_once`) operated **separately**. Retrying after a worker crash between two independent commits might leave a stale `prepared` recipient while an email allowance had already been debited. Simply retrying that prepared recipient could double-send when SMTP acceptance is ambiguous.

`migrateMontralMetering` now installs a **staged** `montral_claim_monthly_report_send` SQL function using a single PostgreSQL transaction. The optional, metered-only `Entitlements.claimMonthlyOutboxAttempt(org, month, userId)` wraps this function and is intentionally **not connected to the active monthly email sender**.

- Locks the prepared `(organization, report month, recipient user)` row `FOR UPDATE`, and only then obtains the existing email-usage advisory lock through `montral_spend_usage_once`. Concurrent workers therefore cannot claim/send the same recipient twice. No new lock-order inversion is introduced with existing general email spends.
- Requires valid `YYYY-MM`, a canonical UTC first-of-month accounting period immediately after that report month, the original opted-in and claimed workspace month, current **owner** membership, and an unchanged recipient email snapshot. Invalid/missing cases consume **no quota** and never mint a send authorization.
- In one transaction, inserts/replays the deterministic idempotency key `monthly:{reportMonth}:{userId}`, uses the shared budget, and commits the outbox transition: **fresh granted** => `attempted`, **exhausted quota** => terminal `skipped`, **previously reserved key** => terminal `uncertain`, even if the previously booked quota was granted. An attempted row can never return to prepared via the API. Existing schema requires an `attempted_at` timestamp on skipped records: there it marks the **quota decision**, not an SMTP provider attempt. No provider request is performed in the function.
- On a transaction abort **all three state changes roll back together** (outbox, email quota, idempotency row). Any retry following a **committed** `attempted` row returns `already_claimed` and **must never cause a second SMTP send**. Returning `attempted` would permit the one and only future send, after commit; it does not imply that email was delivered. The eventual sender must coordinate provider errors, timeouts and operator reconciliation while never blindly replaying ambiguous attempts.
- The established ordinary email-metering path and real monthly report sender remain unchanged. Disabled metering exposes no staged method. All outputs are fixed enum-like strings, no recipient addresses, secrets, or database errors logged by the new method.

## Adversarial SQL integration tests

Eight new synthetic PostgreSQL E2E tests cover 20 simultaneous per-recipient claims (one winner and one debit); 25 owners competing with 3 already-consumed free-tier emails (17 first attempts, 8 terminal skipped, budget capped at 20); intentional rollback of the claim transaction (all three records restored); a preexisting charged reservation which becomes terminal `uncertain`; exhausted quota; ownership removal, email edit, workspace opt-out, stale report claim and unknown recipient; invalid report/accounting-month pairs and noncanonical periods; and feature-disabled non-metered mode.

## Local verification and release boundary

The completed local qualification used supported **Node v24.22.1 / pnpm 10.0.0**, disposable PostgreSQL 17.9 on an authorized Mac:

- Full suite: **665 API + 95 PostgreSQL + 20 Edge Probe + 122 Web = 902/902 passing**. The eight new atomic-claim E2E cases passed, as did the earlier outbox and idempotent-metering tests.
- Monorepo TypeScript `pnpm -r typecheck` passed on the changed code; production Node API, Node web SSR and Edge Probe builds passed; Node/PostgreSQL HTTP health, config, MCP and HTML dashboard smoke passed.
- Real local headless Chromium signup/monitor/incident/webhook/disabled-billing/reset-link-privacy E2E: **BROWSER_E2E_PASS**; synthetic Node SMTP delivered only to a loopback mail sink: **SMTP_LOOPBACK_PASS**. No external recipient/provider qualification.
- `pg_dump` → `pg_restore` **RESTORE_DRILL_PASS: 44 tables (36 nonempty), 110 synthetic organizations**, all normalized per-table SHA-256 contents and row counts matched. `scripts/qualify-backup.mjs` requires **seven critical SQL functions** (including the new atomic claim) and six Montral edition tables after restore. Does not qualify hosted PITR/failover or production load.
- All **638 pinned donor-source hashes** verified unchanged; Drizzle's **42 embedded migrations** remain in sync. The new function is a Montral edition migration, not a new Drizzle core migration.

An additional final monorepo typecheck, exact remote Git SHA/PRIVATE visibility check and temporary-file cleanup must pass before reporting the commit as published to the private repository.

**Not implemented:** production report SMTP dispatch via outbox, crash recovery for claim-before-owner-snapshot, timeout reconciliation, authenticated operator review of `uncertain`, end-to-end external provider deliverability, hosted GitHub Actions qualification, production Cloudflare/DNS/regions, managed PITR/failover/load, and security/privacy/accessibility/legal release approval. Local tests do not grant permission to publish or turn on paid functionality.
