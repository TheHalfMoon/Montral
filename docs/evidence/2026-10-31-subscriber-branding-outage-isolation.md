# Subscriber notification resilience during branding entitlement outages — 2026-10-31

## Scope

Private `TheHalfMoon/Montral` repository, authorized Mac only. Synthetic subscriber identities, real local PostgreSQL 17.9 and loopback-only email; **no external SMTP**, production data, merchant charge, paid infra, deployment or publication.

## Proven failure mode

`mayHideBranding` queried the workspace plan to decide whether status-page mail could omit the Montral brand. A rejected plan lookup (for example a temporary billing database outage) propagated to `notifySubscribers`, `notifyIncidentUpdate`, or `sendMaintenanceReminders`; after subscriber policy and quota authorization this **cosmetic** check could suppress critical incident-update mail or terminate a claimed maintenance-reminder batch. In addition, `mailSubscribers` created subscriber mail synchronously in `Array.map`: a malformed recipient/renderer exception could interrupt preparation of other recipients before `Promise.allSettled` had any opportunity to isolate it.

## Change and safety contract

- `mayHideBranding` traps plan backend exceptions, logs only a fixed non-secret diagnostic, and returns **false** so messages use standard **Montral-branded mail**; it never assumes that white-labelling is allowed while plan verification is unavailable. A healthy plan still enforces `hideBranding: false`; the existing explicit unmetered self-hosted default is unchanged.
- Subscriber preparation now runs inside async per-recipient tasks that `Promise.allSettled` can isolate, preserving delivery for healthy recipients if a different recipient has malformed data. No provider exception or sensitive recipient content is included in diagnostic logs.
- Subscriber **authorization and quota decisions remain separate and mandatory**: an outage in `canNotifySubscriber` still fails closed and skips sending; an invalid quota grant is not bypassed.
- Does not implement exactly-once mail acceptance: after an ambiguous SMTP acceptance failure, no automatic duplicate send is introduced by this change.

## Tests and local execution

Four new synthetic regressions in `apps/api/src/branding-mail.test.ts` and `apps/api/src/maintenance-reminders.test.ts`: incident updates with a throwing plan query still reach both recipients branded normally, a malformed recipient does not prevent a valid peer from receiving the update, multiple claimed maintenance windows continue sending under standard branding despite plan errors, and failed subscriber access policy is not bypassed when the plan query would also fail.

- Focused alerts, branding, maintenance and report suites **91/91 PASS**.
- Full changed-worktree suite on disposable PostgreSQL: **647 API + 86 PostgreSQL + 20 probe + 122 web = 875/875 PASS**.
- Supported runtime **Node v24.22.1 and pnpm 10.0.0**, all monorepo TypeScript checks PASS; production Node API, Node web SSR and Cloudflare Edge Probe builds PASS; Node+PostgreSQL health/config/MCP/HTML smoke PASS.
- Offline real Chromium browser E2E PASS: signup, monitor/incident/webhook, disabled billing, reset-link URL privacy and anonymous denials.
- SMTP loopback drill PASS: synthetic SMTP verification, alert-channel test, scheduled incident down/recovery and account recovery link to local mail sink; no real external SMTP delivery tested.
- Disposable `pg_dump`/`pg_restore` drill PASS: **42 tables**, per-table counts and normalized SHA-256 data fingerprints, plus five application SQL functions. This quick drill used **one populated table and zero synthetic organizations**, not a production-scale/PITR qualification.
- All **638 pinned original donor file hashes** verified unchanged. Before cleanup, verify GitHub remote SHA equals local and that repository remains PRIVATE.

## Still blocked / out of scope

Hosted GitHub Actions remains blocked **before runner allocation** by the account payment/spending-limit state. External Cloudflare DNS/region/egress and worker deployment, managed PostgreSQL failover/PITR, actual SMTP deliverability, merchant sandbox and refund flow, cross-browser/WCAG and security/privacy/legal review, and explicit release authorization remain unqualified. No hosted deployment, public release or paid services are approved. The green local tests do not imply release readiness.
