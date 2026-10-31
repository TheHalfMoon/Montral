# Monthly report pre-send rendering qualification — 2026-10-31

## Source and scope

Private `TheHalfMoon/Montral`, authorized macOS host. Supported Node v24.22.1, pnpm 10.0.0, local PostgreSQL 17.9, synthetic owner data only. No real SMTP, payment, Cloudflare deployment or publishing.

## Failure and remediation

Monthly reports were metered *before* their email HTML/text bodies were prepared, one owner at a time. A corrupt report component or invalid later recipient could throw inside `actionEmail` after the email allowance had been spent and after earlier owners might already have been mailed. The crash stopped the rest of the claimed batch; the workspace claim remained spent, with no reliable indication of which owners had received a message.

`sendMonthlyReports()` now prepares and validates all owner messages (including HTML/text rendering) before calling `spendEmails` or attempting any provider send. If any recipient or component fails preparation, it logs a **static non-secret diagnostic**, conditionally releases the still-unattempted workspace-month claim and continues other workspaces. After successful preflight, the existing strict integer quota gate, partial grants and at-most-once provider-attempt semantics remain unchanged. **Once a mail attempt starts it is never automatically replayed** because provider acceptance could be ambiguous.

Three new synthetic tests validate (1) malformed component: no quota charge or provider call, safe claim release and later successful retry; (2) a malformed *later* owner: no earlier owner email and no quota consumption; (3) a failed workspace: another claimed workspace still sends, with no secret-bearing logs.

## Test status

- Targeted monthly report tests: **16/16 PASS** after correcting a test-only mocked TypeScript method signature.
- Complete API suite on a fresh disposable PostgreSQL instance: **650 API + 86 PostgreSQL + 20 probe + 122 web = 878/878 PASS**.
- API Node, web SSR and Edge Probe builds PASS; Node/PostgreSQL HTTP health/config/MCP/dashboard smoke PASS; hashed donor sources **638/638** verified.
- Repository TypeScript packages other than API passed on first monorepo run; the API mock signature was then repaired and **API TypeScript check PASS**. Rerun full `pnpm -r typecheck` on final worktree before commit.
- `BROWSER_E2E_PASS`: actual local headless Chromium signup, monitor and incident workflow, webhook, disabled billing, reset-link URL privacy and anonymous denial.
- `SMTP_LOOPBACK_PASS`: local SMTP delivery for synthetic channel, scheduler down/recovery notifications and password reset to a loopback mail sink; **no external SMTP qualification**.
- `RESTORE_DRILL_PASS`: 42 PostgreSQL tables, five transactional functions, per-table row counts and normalized SHA-256 fingerprints matched after local dump/restore. This quick drill had **one populated table and zero synthetic organizations**, not a production-sized PITR/failover test.

## Release boundary

This **does not** implement a durable per-recipient monthly outbox, replay-safe quota metering, operator reconciliation or exactly-once SMTP delivery. See [design contract](../architecture/monthly-report-recipient-outbox.md). Hosted Actions runners and production Cloudflare, external mail, managed PITR, merchant sandbox and privacy/legal release gates remain open.
