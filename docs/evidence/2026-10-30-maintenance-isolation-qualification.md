# Montral — retention maintenance and scheduler fault isolation

Date: **2026-10-30**. Source base: private `TheHalfMoon/Montral` commit `3e809ca46f9e8b7425b47f15d0eecad24a4fcb51`.

## Scope and design

Montral's existing Node and Cloudflare Worker schedulers used to perform idle-webhook cleanup **only after** a successful monitor scheduling call. A monitoring scheduler failure could defer seven-day webhook expiry indefinitely while the service still answered API requests. Also, expired test-checkout correlation intents persisted forever, creating avoidable state growth.

This engineering wave adds `apps/api/src/montral-maintenance.ts` and `pruneExpiredBillingIntents` to improve both behaviors:

- The maintenance coordinator invokes webhook expiry and test checkout nonce expiry as independent tasks with `Promise.allSettled`. If either task fails, the other is still attempted; errors are reported for retry.
- Node's existing 30-second tick runs monitor scheduling and Montral maintenance in separate failure boundaries. Maintenance runs on the existing five-minute interval, and failures are retried on the next tick without moving the successful-run timestamp.
- Cloudflare Worker's existing cron likewise runs maintenance even when `runDueChecks` fails, preserving error reporting while closing the database pool.
- Test checkout intents whose `expires_at` is **older than seven days** are removed. More recent intents, even if expired, are retained to allow delayed sandbox callbacks. No subscription row or signed event ledger entry is deleted, preserving replay and audit evidence.
- No extra scheduler, Worker, network provider, payment account, secret, or paid service is added. The existing hosted schedule limitations remain.

## Verification — authorized Mac, synthetic-only isolated PostgreSQL

- Database: disposable local PostgreSQL 17, `127.0.0.1:55445`, `montral_test_20261030h`; the Mac's existing database on port 5432 was not modified.
- Dedicated `montral-maintenance.test.ts` cases cover both tasks returning counts, webhook cleanup failing while billing cleanup proceeds, and billing cleanup failing while webhook cleanup proceeds.
- Real PostgreSQL billing E2E inserts an expired intent older than seven days, a consumed expired intent older than seven days, a recent expired intent, and a still-live intent. The maintenance call deletes only the two stale intents, preserves the two recent entries, leaves the signed event ledger unchanged, and is idempotent on retry.
- Final API suite: **557/557 passing** (74 files).
- Final web suite: **122/122 passing** (25 files).
- Probe suite: **20/20 passing** (4 files).
- **Total 699 passing tests**, no skipped tests in the final respective suite runs.
- All monorepo TypeScript and Astro typechecks passed; Node API, Node web and Edge Probe bundles built locally.
- Real Node+PostgreSQL smoke, Chromium signup/webhook/disabled-checkout journey, database dump/restore, and 638 historical donor source hash checks passed.

## Reproducible commands

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
TEST_DATABASE_URL='postgres://<user>@127.0.0.1:<temporary-port>/montral_test_<suffix>' pnpm --filter @montral/api test
pnpm --filter @montral/web test
pnpm --filter @montral/probe test
pnpm --filter @montral/api build:node
DEPLOY_TARGET=node pnpm --filter @montral/web build
pnpm --filter @montral/probe build:edge
TEST_DATABASE_URL='<same-disposable-URL>' node scripts/smoke-node.mjs
TEST_DATABASE_URL='<same-disposable-URL>' MONTRAL_CHROMIUM='<already-installed-Chromium>' node scripts/qualify-browser.mjs
TEST_DATABASE_URL='<same-disposable-URL>' node scripts/qualify-backup.mjs
python3 scripts/verify_sources.py
```

## Outstanding production blockers

This qualifies failure separation and sandbox intent retention **locally**; it is not a guarantee of operational cron delivery, availability or legal record-retention policy. Real Cloudflare Cron scheduling, incidents across process restarts and managed database recovery require hosted evidence. The signed billing event ledger intentionally has **no automatic deletion policy**, because it protects against replay and may be needed for financial audit; establish an approved legal retention policy before real merchant operation. The provider itself has never been connected, and commercial billing is test-mode-only and disabled by default. No public launch, real payments or paid services are authorized.

GitHub Actions on the private repository remained queued awaiting a runner at the beginning of this wave; it was not considered passing. The Mac's installed Node v26.0.0 is outside the repository's declared supported Node range, so local tests do not replace supported-version hosted CI.
