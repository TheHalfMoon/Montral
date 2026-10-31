# Staged idempotent email quota reservations — local qualification, 2026-10-31

## Scope and invariant

Private `TheHalfMoon/Montral` only, Mac host, supported Node v24.22.1 / pnpm 10.0.0, PostgreSQL 17.9. No paid services, external SMTP, merchant transactions, production deploy or release. **The active monthly report sender is NOT connected to this primitive.** This implements a bounded, replay-safe accounting prerequisite, not end-to-end outbox delivery.

Legacy `spendEmails(org,count)` is atomic but has no caller-supplied idempotency key. A worker that crashes after a quota debit, before recording its phase, might debit the same logical recipient again. Adding a recipient outbox table alone is insufficient. This change introduces a staged single-email reservation primitive, with explicit fresh-vs-replayed distinction.

## Implementation

- Edition migration (serialized transaction via existing `migrateEdition`) creates `montral_usage_reservation`, with an organization-cascade foreign key, period, `emails` kind, bounded opaque idempotency key (1–200 chars), one-unit requested amount, binary grant, and uniqueness over `(organization_id, period_start, kind, idempotency_key)`. It stores no recipient email, SMTP token or provider error.
- New PostgreSQL `montral_spend_usage_once` shares the **same advisory lock** with the current `montral_spend_usage`, so concurrent old and new spenders cannot exceed the existing monthly budget. In the **same transaction**, it persists successful or denied reservations and updates (or does not update) the usage ledger. SQL validates first-of-month UTC periods; invalid kind, key or limit fails closed.
- A repeated key returns its original grant with `is_new=false` without changing the ledger. **A previously granted replay is not permission to send another email.** Denied reservations are also persisted: a later plan upgrade does not silently replay an old blocked logical message. Distinct organization/month/key combinations remain independent.
- Optional `Entitlements.reserveEmailQuotaOnce(org, key)` returns `{granted,newlyReserved}` and is available only when Montral's metering flag is enabled. It is absent in unmetered mode; it is NOT used by `sendMonthlyReports` or other active email paths, so production behavior and flags remain unchanged. The eventual sender must only attempt a message after atomic outbox-phase/quota coordination, not merely because a returned grant is true.
- `scripts/qualify-backup.mjs` now verifies the added **sixth Montral edition table** and **sixth transactional SQL function** exist after `pg_restore`, in addition to per-table SHA-256 comparisons.

## Reproduced PostgreSQL regressions

Seven real-PostgreSQL synthetic E2E cases cover (1) 20 concurrent calls with the same key causing one new grant, (2) old `spendEmails` vs 30 distinct new reservation keys sharing a free-tier budget of 20, (3) denied replay after a plan-limit increase and granted replay after a worker restart, (4) transaction rollback of both quota and reservation together, (5) tenant and accounting-month isolation, (6) malformed idempotency keys, non-email kinds and non-month-start periods rejected with no debit, and (7) disabled metering exposing no staged reservation function. The UTC test initially reused the current month and was corrected to use two independent historical periods; final tests **7/7 PASS**.

## Final Mac qualification

- **657 API + 95 PostgreSQL + 20 Edge Probe + 122 Web = 894/894 passing** on a newly created disposable PostgreSQL database with proper migration bootstrap.
- Full monorepo TypeScript checks, production Node API, Node web SSR and Edge Probe bundles, and Node/PostgreSQL health/config/MCP/dashboard smoke **PASS**.
- Real local headless Chromium signup/monitor/incident/webhook + disabled billing and reset-link privacy checks **PASS**.
- Node SMTP synthetic **loopback-only** delivery/recovery/reset drills **PASS**; this does not prove any external provider will deliver.
- `pg_dump` → `pg_restore` local test **PASS**: **44 tables (36 nonempty), 110 synthetic organizations, 6 critical SQL functions**, exact row counts and per-table normalized SHA-256 content fingerprints matched. Still not a managed cloud PITR/failover/load qualification.
- All **638 pinned donor-source hashes** verified unchanged. Repo private and clean after push; hosted CI must be checked separately because of GitHub billing/spend-limit restrictions.

## Not ready / remaining work

This is **not** transactionally joined to the recipient outbox state machine yet. The latter's `prepared` → `attempted` / `uncertain` / `accepted` transitions remain unused by production SMTP and cannot promise exactly-once delivery. Enabling dispatch requires a single durable workflow for recipient snapshot, quota reservation and state transition, crash-injection tests at each boundary, provider ambiguity reconciliation, and an operator-controlled rollout. Hosted GitHub CI, Cloudflare DNS/real regions, external SMTP provider, managed PostgreSQL PITR, real merchant sandbox, security/privacy/accessibility/legal and explicit publication permission remain outstanding. **No deploy, release, paid enabling or real deliveries authorized.**
