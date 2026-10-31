# Staged monthly report mail reconciliation — 2026-10-31

**Scope:** PRIVATE `TheHalfMoon/Montral`, local Mac and synthetic-only PostgreSQL tests. This is an **internal repository capability only**. It is not exposed as an authenticated HTTP endpoint, CLI or operator dashboard; the active monthly mail sender and scheduler remain unchanged. No external mail, deployment, or paid services are enabled.

## Safety problem and implemented solution

The staged monthly outbox can finish as `attempted` if a process dies after it claims the only send attempt, or as `uncertain` if SMTP times out after possibly accepting the message. Automatically requeuing either state risks duplicate recipient mail and double charging. A privileged operator needs a safe way to record what external provider evidence shows, without triggering retransmission or revealing recipient details.

New **additive Drizzle migration `0042_brief_sister_grimm`** adds `monthly_report_reconciliation` with a unique `(organization_id, report_month, recipient_user_id)` decision, a workspace and recipient FK that cascade on deletion, nullable actor identity cleared upon user deletion, previous state, decision (`provider_accepted` or `unresolved`), SHA-256 evidence digest, and timestamp. Check constraints validate month, state, decision and hash. No raw SMTP reference, recipient address, message body or provider error is persisted. This audit is written only once through the new repository method; the database primary key protects concurrent decisions.

`Repo.reconcileMonthlyReportRecipient` is **staged/internal only**, with explicit owner membership checked and locked *inside* the same database transaction as the recipient row and audit insert. It requires a **caller-supplied, previously authenticated actor ID**: the repository does not itself establish the requester's identity. An operator interface must authenticate this ID independently before calling the method. The method refuses cross-tenant and non-owner review, malformed references, recent in-flight attempts (30-minute delay), absent recipients, and already-decided records. The returned result is a boolean, with no email or sensitive data.

A `provider_accepted` decision means the workspace owner asserts independent provider evidence and changes an old `attempted`/`uncertain` row to `accepted`. **This is not a programmatic external-provider verification**; there is no provider connection in this workflow. `unresolved` leaves or moves the row to `uncertain`. Neither decision ever transitions to `prepared`, grants new quota, invokes SMTP, or permits automatic retry. The audit insert and state change roll back together if either fails. The previous decision cannot be overwritten through this API.

`Repo.monthlyReportReconciliationSummary` gives current workspace owners scoped counts of mature, unreviewed attempted/uncertain records, reviewed-but-unresolved decisions, and owner-attested accepted decisions. The owner-role check and query are in one PostgreSQL transaction. It exposes **no recipient emails, evidence references or hashes**, and is not registered on an HTTP route.

## Local PostgreSQL adversarial regressions

Nine isolated PostgreSQL tests verify: owner reconciliation and SHA-256 privacy; unresolved remains terminal; uncertain to owner-attested accepted without resend; non-owner/cross-workspace/missing-actor rejection; in-flight cooldown and invalid evidence rejection; 12 concurrent reviewers producing one decision; rollback of both state and evidence on injected audit-write failure; review history retention with operator identity anonymized after their account is deleted; and cascade deletion after workspace removal. All synthetic, no provider sends.

## Remaining integration and release gates

The repository checks **membership, not authentication of its actor argument**. Do not expose it through a route or CLI until operator authentication, authorization and confirmation controls are reviewed. Independent provider confirmation, secure operator workflow (including approval of `provider_accepted` assertions), role-change auditing, retention/erasure policy, complete process-kill scenarios, production rollout and monitoring remain to be implemented. SMTP exactly-once delivery cannot be inferred. Existing legacy-month claims never gain resend rights from this audit. Hosted GitHub Actions, Cloudflare edge, external email, managed PostgreSQL PITR/load, merchant sandbox and final legal/privacy/accessibility/security checks remain NO-GO.

## Verification

Final Mac test counts, builds, Chromium E2E, loopback SMTP, dump/restore checks and pinned donor hashes will be recorded once run. Hosted CI has previously failed before runner allocation due to account payment/spend limit and cannot be marked passing based on local checks.

## Final verified Mac qualification

- Node v24.22.1, pnpm 10.0.0, PostgreSQL 17.9; full **934/934** local tests passed: 681 API, 111 PostgreSQL (including all nine new reconciliation tests), 20 Edge Probe and 122 Web.
- Monorepo TypeScript checks, production Node API, Node Web SSR, Edge Probe build, and Node/PostgreSQL health/config/MCP/dashboard smoke: PASS.
- Real local Chromium synthetic user and incident E2E: `BROWSER_E2E_PASS`. Node SMTP loopback delivery/recovery/reset-link: `SMTP_LOOPBACK_PASS`. Neither exercised an external service.
- Local `pg_dump` / `pg_restore`: `RESTORE_DRILL_PASS` on **45 tables (36 populated), 110 synthetic organizations**, seven business-critical PostgreSQL functions, per-table row counts and normalized SHA-256 content fingerprints. Not proof of managed cloud PITR or production failover.
- All **43 Drizzle migrations** synchronized, including additive `0042` and its generated snapshot/journal; all **638 pinned donor source files** verified unchanged.
- An older migration-upgrade regression explicitly pinned `0041` as the latest migration. It was repaired to migrate from historical `0040` through both `0041` and `0042`, and the complete PostgreSQL suite then passed. Do not treat the preliminary test run as qualified.

No live emails, paid services, deployment or release were performed. A later GitHub Actions attempt must be evaluated independently; local tests are not hosted CI.
