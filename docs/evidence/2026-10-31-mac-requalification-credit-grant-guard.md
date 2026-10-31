# Montral Mac requalification and safe credit-grant validation — 2026-10-31

## Scope and provenance

Owner-authorized Mac (Darwin), **private** `TheHalfMoon/Montral`, base commit `368cdd16c1190c595ad3bde36457367b22483532` plus the precisely described changes to `apps/api/src/scheduler.ts` and `apps/api/src/entitlements.test.ts`. No production data, real outbound email, real merchant transaction, paid infrastructure, public deployment or Windows work. All tests used supported **Node v24.22.1**, **pnpm 10.0.0**, **PostgreSQL 17.9** and disposable databases prefixed `montral_test_`.

## Security defect and correction

The scheduler's `withinCredits` trusted the raw return from `Entitlements.spendCredits`. A *successful* but invalid grant (`-1`, `NaN`, `Infinity`, fraction, overgrant, string or `undefined`) could cause incorrect permission to run metered probes, or inconsistent behavior. It also included a raw ledger exception in `console.error`, potentially recording credentials.

The helper now accepts **safe integers 0..requested only**; a malformed grant fails closed for billable monitoring checks, logs a constant diagnostic, and still permits **zero-credit heartbeat checks**. Actual exceptions from the credit ledger preserve the existing monitoring-availability-first policy: run the due probes rather than silence outage detection, but only log the static `credits unavailable` message. This does **not** claim strict quota enforcement when metering is offline. Added **eight** regression cases: seven malformed grants with heartbeat continuity, and an exception containing synthetic credentials with protected logs.

## Local execution evidence

- Prior to this patch, exact private-main `368cdd16`: focused alert Lark/Telegram/routing tests **102/102**, TypeScript PASS, source hashes **638/638**; full suites **625 API + 86 PostgreSQL + 20 Edge Probe + 122 Web = 853/853** PASS, all three builds and live Node/PostgreSQL HTTP smoke PASS.
- After patch, focused scheduler/entitlements suites **64/64**, monorepo TypeScript PASS, donor-source integrity **638/638**.
- After patch, all suites on fresh disposable PostgreSQL: **633/633 API**, **86/86 PostgreSQL**, **20/20 Edge Probe**, **122/122 Web** — **861/861 PASS**. Node API, self-hosted Node web SSR and Cloudflare Edge Probe builds PASS; Node+PostgreSQL HTTP smoke covers health, config, MCP discovery and HTML dashboard.
- Local Node+PostgreSQL — `scripts/qualify-browser.mjs`: **BROWSER_E2E_PASS**, real offline headless Chromium covers signup, synthetic monitor and incident, webhook, disabled billing, account reset URL privacy and anonymous route denial.
- `scripts/qualify-smtp.mjs`: **SMTP_LOOPBACK_PASS**, actual Node SMTP wired to a loopback sink, verifies SMTP auth and test mail, cron down/recovery alerts and synthetic account-recovery link delivery; no external SMTP or inbox qualification.
- `scripts/qualify-backup.mjs`: **RESTORE_DRILL_PASS**, 42 tables with matching SHA-256 fingerprints and counts after `pg_dump`/`pg_restore`, and 5 transactional SQL functions. **This particular quick drill had only one nonempty table and zero synthetic organizations**, so it is not scale/PITR qualification; a separate previous 128-org local drill remains historically documented.

These tests ran on the *worktree source containing the code change*. The record can be replayed against the committed SHA, and documentation-only changes do not affect the executable contents. `git diff --check` and remote-SHA verification are mandatory before any local scratch files are deleted.

## Open release blockers

- **GitHub Actions runner** still cannot start due to the GitHub account **failed payment or spending limit** annotation on [run 41206285444](https://github.com/TheHalfMoon/Montral/actions/runs/41206285444). Local green tests do **not** substitute for hosted CI; account owner must review Billing & plans. No paid remediation attempted.
- Real Cloudflare deployment and cross-region DNS/egress/Hyperdrive, external SMTP deliverability, managed database PITR/failover/scale, real merchant sandbox callbacks and customer billing, full browser/accessibility/security/privacy/legal reviews and explicit publish authorization remain open.
- Repo remains PRIVATE. No deployment or real payment processing is approved.
