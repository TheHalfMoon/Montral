# Scheduler exception log privacy and housekeeping isolation — 2026-10-31

## Scope

PRIVATE GitHub `TheHalfMoon/Montral`. Owner-authorized Mac only, with supported **Node v24.22.1**, **pnpm 10.0.0**, local **PostgreSQL 17.9**, disposable `montral_test_*` databases and synthetic/loopback fixtures. No production accounts, customer data, paid infrastructure, deployment or release.

## Identified risks and fix

The scheduler printed raw provider, queue, check and PostgreSQL exception objects from `runDueChecks`, its housekeeping steps, batch `checkMany`, and `alertHistory`. These exceptions can carry credentials, webhook URLs, monitor target details or raw request data, and may flow into centralized logs. The inconclusive probe warning also interpolated a probe-provided error string; the healthy-but-partial-region log interpolated a potentially untrusted region diagnostic.

- Replace arbitrary exception messages/objects in queue-send, failed claim release, failed sweep/retry/reminder/escalation, maintenance reminders, monthly digest, individual checks, and incident-delivery-history logs with **fixed diagnostics only**. Preserve the internal monitor ID in check logs to support correlation; those IDs are not user credentials.
- Log inconclusive probes as `probe unavailable` and partial region reachability as `some regions unavailable`, rather than raw upstream payloads.
- Make the hourly `purgeExpired` call use the existing isolated housekeeping wrapper. A purge failure no longer prevents scheduled maintenance reminders/monthly report work within that tick.
- Keep each prior failure/exception behavior: failed queue dispatch still releases unsent claim tokens, rejected individual checks still do not block their peers, billing-credit outage handling remains unchanged, and alert history read errors still allow urgent alerts. Errors may still be returned to API callers or stored by other code paths; this change qualifies **the named scheduler log statements only**, not all logs or reverse proxies.

## Synthetic regressions and Mac qualification

- Three new scheduler regressions verify: (1) queue dispatch and release exceptions containing a synthetic bearer token are never logged, and all failed claims are returned; (2) one rejected monitor check does not log its secret-bearing error; (3) sweep and purge errors are isolated, do not leak a synthetic SMTP/database credential, and do not block retry, reminders, escalation or maintenance processing. Existing partial-region diagnostic assertion was revised to expect privacy-safe output.
- Focused scheduler/entitlements tests: **67/67 PASS**.
- Full local suite on the changed worktree and fresh disposable PostgreSQL: **636 API + 86 PostgreSQL + 20 probe + 122 web = 864/864 PASS**.
- `pnpm -r typecheck` PASS; API Node bundle, Node web SSR and Edge Probe production builds PASS; local Node+PostgreSQL HTTP health/config/MCP/dashboard smoke PASS.
- Real headless Chromium: **BROWSER_E2E_PASS** for synthetic signup, monitor/incident/webhook, disabled billing, password-reset URL privacy and anonymous denies. Node SMTP loopback: **SMTP_LOOPBACK_PASS** for SMTP verification, channel test, scheduler-triggered down/recovery and account recovery email to local sink. No external SMTP or cloud browsers.
- Preserved third-party source snapshots: **638/638** hashes verified; no donor source changes.

## Remaining release gates

GitHub Actions is account-billing/spending-limit blocked before runner assignment ([prior run 41214191733](https://github.com/TheHalfMoon/Montral/actions/runs/41214191733)); exact new SHA hosted CI must be checked independently. Real Cloudflare regions/egress, multi-replica managed Postgres and hosted PITR/load, external SMTP delivery, merchant provider sandbox, end-to-end accessibility/security/privacy/legal review and explicit publication approval remain outstanding. This is a **local engineering qualification**, not production release approval. The repo must remain PRIVATE, with no deployment or paid service activation.
