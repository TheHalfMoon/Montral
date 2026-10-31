# Montral CI Chromium gate — 2026-10-31

## Purpose

The existing real Chromium user journey (`scripts/qualify-browser.mjs`) previously ran only on the Mac during qualification. The private repository now requires it as a dedicated GitHub Actions job step, after Node/web build and smoke and before SMTP qualification. This change does **not** deploy or publish anything.

## Fail-closed isolation

- The workflow locates a preinstalled Chrome or Chromium binary and fails if absent. It does not download a browser or contact an external browser service.
- It creates `montral_test_browser_ci` on the existing disposable PostgreSQL 17 CI service, runs the journey against that database only, and removes it on success or failure with a shell exit trap.
- The browser script now accepts only loopback PostgreSQL hosts with names matching `montral_test_*`; a database merely containing `test_` in another name is rejected before connecting.
- The journey uses synthetic signup, heartbeat monitor create/pause/resume, manual incident declare/acknowledge/internal note/resolve, webhook inbox capture/view and disabled payment UI. No customer traffic or real billing is used.

## Actual local verification

- Mac: real preinstalled Chrome Headless Shell (`chromium_headless_shell-1248`) passed the complete original Chromium journey against a freshly created disposable PostgreSQL database before the isolation-guard edit.
- The invalid database name `customer_test_production` was refused by the tightened guard before browser startup.
- `pnpm -r typecheck`, `pnpm --filter @montral/api build:node` and `DEPLOY_TARGET=node pnpm --filter @montral/web build` passed with Node v24.15.0; **v24.15.0 is below the repository's supported v24.22.1**, so these results are supplementary, not supported-runtime qualification.
- After the migration-race repair, an independent fresh disposable PostgreSQL database passed **574/574 API**, **20/20 probe** and **122/122 web** tests, as well as the **updated** Chromium browser journey and `verify_sources.py` (**638/638** donor source files). The shell returned exit 0 and deleted the temporary database. See [migration race evidence](2026-10-31-test-migration-lock-qualification.md).

## Remaining gate

GitHub Actions runs on `main` still fail in seconds with `ubuntu-latest` runner name blank and no job steps, so the new browser step has **not** been qualified on hosted CI. It must run green on an exact commit before release. Do not turn on paid infrastructure or publish the private repository.
