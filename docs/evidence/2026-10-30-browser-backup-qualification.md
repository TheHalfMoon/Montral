# Montral — Real Chromium browser + PostgreSQL restore qualification
Date: 2026-10-30. Environment: authorized **macOS ARM64** only. Private GitHub repository **TheHalfMoon/Montral**.
Base SHA: `47c563de9db2f7f2bfddff4b88447cafc41b0afb`.

## Isolation and zero-cost constraints
- Temporary PostgreSQL **17.9** bound to loopback `127.0.0.1:55441` in `/tmp/montral-pg-20261030d`, synthetic database `montral_test_20261030d`.
- The owner's existing `127.0.0.1:5432` PostgreSQL service and data were not touched.
- An **already installed** Chrome for Testing headless binary was reused from the Mac's `~/Library/Caches/ms-playwright/chromium_headless_shell-1248/`. No browser download, paid service, container registry, cloud deployment, payment or real customer account.
- The browser qualifier starts an isolated Node API and local Astro web application, uses Chrome DevTools Protocol through the repository's existing `ws` dependency, and terminates its own processes and temporary Chrome profile at exit.
- Neither webhook receiver secrets, account session tokens, nor browser screenshots are committed to GitHub.

## Exact commands
```sh
pnpm install --frozen-lockfile
pnpm --filter @montral/api build:node
DEPLOY_TARGET=node pnpm --filter @montral/web build
# Only a disposable LOCAL PostgreSQL cluster whose database name begins montral_test_:
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temporary-port>/montral_test_<suffix>' \
MONTRAL_CHROMIUM='<path to already-installed headless Chromium>' \
node scripts/qualify-browser.mjs

TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temporary-port>/montral_test_<suffix>' \
node scripts/qualify-backup.mjs
```

## Browser E2E — PASS
Browser executable reported **Google Chrome for Testing 156.0.8078.4**.

Actual Chromium navigation, JS execution and browser-origin requests validated:
1. Anonymous REST access to private webhook and billing endpoints returns 401.
2. Real rendered `/signup` registration form accepts synthetic account, creates a session, and navigates to `/app`.
3. Authenticated `/app/hooks` opens the real React form, creates a synthetic inbox, and shows its receiver URL **only at creation time**.
4. A POST to that receiver returns HTTP 202, and a subsequent browser click and expansion of the event inspector show the **actual expected synthetic JSON payload**.
5. After page reload, the receiver secret is not present in the rendered document.
6. `/app/billing` renders; absent merchant credentials, it explains that checkout is not configured and disables the checkout buttons.

The first successful browser run completed in 4.06 seconds. A further final post-hardening browser run passed in 4.42 seconds. Earlier scripts uncovered and fixed incorrect test-harness selectors; they did not establish a product failure. The final tests exercised the real built Node server, real PostgreSQL and a real rendered web interface.

## PostgreSQL backup / restore — PASS
`scripts/qualify-backup.mjs` uses `pg_dump -Fc` and `pg_restore --exit-on-error` to a **new randomly named** `montral_restore_test_*` database. Both source URL and target are validated; the script rejects a non-local or non-`montral_test_*` source. It removes only its own created restore target and temporary archive.

Observed verification:
- **42 tables** recovered, including Montral-specific webhook/billing/usage tables.
- **2 synthetic organizations** present in the source at the first drill, matched after restore. The final post-suite rerun successfully restored **108 synthetic organizations** and the same 42 tables/functions.
- All **3 transactional PostgreSQL functions** (`montral_create_hook_inbox`, `montral_apply_billing_event`, `montral_spend_usage`) present in the restore.
- The source was left unchanged. The restored scratch database was removed.

## Webhook viewer cache security

Additional privacy hardening: authenticated `/api/hooks/*` inbox/list/inspector responses now set `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. Focused unit and real PostgreSQL E2E tests passed after the change. This prevents browser/proxy caches from retaining captured request bodies or inbox metadata. It is not an at-rest encryption guarantee.

## Final regression rerun

After adding private `no-store` headers and this reusable test harness, the final all-package qualification passed: **544 API / 122 web / 20 probe tests, 686 total, 0 failed or skipped**, TypeScript/Astro checks, Node API, Node Astro web and Edge probe production bundles, Node/PostgreSQL smoke, real Chromium browser E2E, `pg_dump`/restore on 108 synthetic organizations, and unchanged 638 donor source hashes.

## Release gating: NOT A PRODUCTION APPROVAL
The above are strong local smoke and data-recovery tests, **not** the full customer browser test matrix or managed-database disaster recovery. Untested: production payment lifecycle with a real test merchant, email deliverability, browser accessibility/mobile journeys, real regional probe, production load/fault injection, provider restore/PITR and automated hosted CI.

GitHub Actions at `47c563d`: enabled in repo settings, but job had no assigned runner (`runner_name=""`, zero steps), with failed status. There is no green GitHub CI evidence. Do not publish, advertise availability guarantees or charge customers.
