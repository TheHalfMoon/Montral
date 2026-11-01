# Malformed project-selector cookie does not terminate an authenticated request

**Local engineering date:** 2026-11-01 Asia/Riyadh. **Environment:** private Montral code, supported Node 24.22.1, macOS only, fresh disposable PostgreSQL on loopback; no customer data, deployment, paid systems or remote services.

## Bug reproduced before fix

`cookieValue` in the HTTP authentication middleware parsed the optional `montral_project` selection with `decodeURIComponent` without a guard. Percent-escape sequences such as `%ZZ`, an isolated `%`, malformed multibyte UTF-8 or invalid surrogates raised an uncaught `URIError` in normal request processing. An attacker or broken client could therefore turn an otherwise valid workspace session into HTTP 500, rather than using the default authorized project. This is an availability and client-input robustness issue, **not** a claim of privilege escalation or credential compromise.

A focused `vitest` regression was **RED** before the fix: 1 of 2 tests failed with `URIError: URI malformed` in `middleware.ts:137`.

## Minimal correction and regressions

`cookieValue` now returns `undefined` on invalid URL escapes and malformed UTF-8, preserving the existing normal-project fallback. Valid encoded strings and regular cookies remain unchanged. No authorization bypass, role changes, quota weakening, auth flags, or project-mapping relaxation were made. The new `cookie-selection.test.ts` covers ordinary, absent, malformed escapes and invalid UTF-8. The existing real-PostgreSQL membership E2E test also checks that a *valid member session* can still list its workspace monitors with each malformed selector; once membership is revoked, the existing 403 protections remain in force.

## Qualification

- Focused RED (pre-fix): 1 of 2 failed with uncaught URIError; GREEN (after fix): 2/2.
- Full macOS Node 24.22.1/pnpm 10.0.0/PostgreSQL 17.9 tests **965/965 PASS**: API **707/707**, DB **114/114** with explicit `DATABASE_URL`, Edge Probe **20/20**, Web **124/124** after Node web build. TypeScript/Astro checks and three production Node API, Edge Probe and Node Web builds PASS.
- Node/PostgreSQL health/config/MCP/dashboard smoke PASS; real headless Chromium signup/monitor/manual incident/webhook/disabled-checkout/reset URL privacy PASS; local SMTP verification, alerts, cron down/recovery and account recovery PASS without external SMTP.
- Local `pg_dump`/`pg_restore` SHA-256 validation PASS for **46 tables**, each table row count and normalized fingerprint, 8 synthetic workspaces/projects/monitors and 8 SQL functions. All **five actual SIGKILL** staged monthly outbox recovery boundaries PASS; all **638 pinned donor source files** integrity check PASS.
- Initial full run had 12 failures in unrelated staged month-dependent fixtures. See [separate documented calendar correction](2026-11-01-calendar-stable-monthly-outbox-e2e.md). Full test rerun on fresh isolated PostgreSQL was 965/965 after both test-only fixture corrections; hosted CI must not be inferred from a local pass.
- No real deployments, paid integrations, production data, DNS/Cloudflare, billing or live SMTP were touched.

## Persistent external blockers

GitHub-hosted CI can be prevented from starting by account spending/payment controls; a local pass never substitutes for hosted CI. Managed database recovery, real multi-region probes, hosted email and merchant verification, external security/privacy and accessibility assessments and explicit release permission are still outstanding.
