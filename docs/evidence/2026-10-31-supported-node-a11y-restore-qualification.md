# Montral supported-Node and scoped accessibility qualification — 2026-10-31

## Scope and constraints

Private GitHub repository, authorized Mac only, disposable loopback PostgreSQL 17.9, synthetic records, no external SMTP, no real payment store, no Cloudflare deployment, and no public release. The exact qualified toolchain is **Node v24.22.1** and **pnpm 10.0.0**. Node was installed in temporary `/tmp` storage and is removed after the verified remote push.

## Product and browser changes

- Login, registration, forgot-password and reset-password screens now expose a semantic `<main>` landmark and a keyboard-focusable "Skip to main content" link.
- The authenticated dashboard now has a labeled sidebar `<nav>` landmark, `aria-current="page"` on active sidebar/mobile route links, a main-content anchor and the same keyboard skip link.
- The React in-app router also synchronizes `aria-current` on every client-side route change, removing it from the old route. The first Chromium attempt exposed that the previous router toggled only visual `.on`; after the fix, the monitor, incident and webhook navigation assertions passed in Chromium on the same session.
- The skip-link visual treatment stays off-screen until focus, uses the existing high-contrast theme variables, and requires no external CSS or service.
- The real Chromium E2E adds checks for the signup main landmark, labels for every signup input, the dashboard navigation landmark, the active monitors link, and skip links on both screens. It still exercises synthetic monitor/incident/webhook workflows, disabled billing and reset-link URL privacy.
- These are **scoped semantic checks**, not a full WCAG audit, keyboard-only navigation review, screen-reader certification, cross-browser matrix or a production accessibility/legal sign-off.

## Verified local results on supported Node

- `pnpm install --frozen-lockfile` PASS; `pnpm -r typecheck` PASS.
- Production builds: `@montral/api build:node` PASS, `DEPLOY_TARGET=node @montral/web build` PASS, `@montral/probe build:edge` PASS.
- Full parallel API suite: **574/574 PASS**; probe: **20/20 PASS**; web: **122/122 PASS**. All used the shared disposable PostgreSQL schema setup where applicable.
- Node+PostgreSQL HTTP smoke PASS (health, configuration, MCP discovery and HTML dashboard).
- Actual local SMTP protocol qualification PASS (verify, test channel, cron-created down alert and recovery alert, single resolved incident), with localhost-only recipient sink and no external messages.
- Updated real headless Chromium browser journey PASS against disposable PostgreSQL, including the signup landmarks, navigation between monitor/incident/webhook pages, skip links and active-route accessibility checks. The initial extra incident-route check failed before the router synchronization fix, then passed after the correction and rebuild.
- Read-only source-integrity check: **638/638 pinned third-party donor files verified**.
- `pg_dump -Fc` to a new, isolated `pg_restore` database PASS: **42 tables, 128 explicitly synthetic organizations**, all webhook/billing/usage tables and five critical functions matched. Scratch and restore databases deleted after the drill.

## Release qualification limitations

- GitHub Actions remains **blocked before runner provisioning**: the `ubuntu-latest` run has no runner name and zero steps. This wave has not made the remote CI green, despite Actions being enabled for the private repository. This is an account/platform provisioning question, not proof that application steps passed or failed.
- Local PostgreSQL 17.9 and Node 24.22.1 are not substitutes for hosted Cloudflare egress, managed database failover, tenant/privacy audits, external SMTP deliverability, genuine merchant integration or a legal accessibility review.
- The repository remains PRIVATE; no customer-facing SaaS or paid feature was enabled.
