# Montral — expanded real Chromium monitoring journey

Date: **2026-10-31**, using authorized Mac ARM64 only. Source base: private `TheHalfMoon/Montral`, commit `e953e8abaf9a340f92543cf9993ab80a036b05a2`.

## Gap addressed

The existing real-browser smoke qualified signup, webhook capture and billing-disabled state but did **not** test the primary monitoring product through actual rendered React controls. API/unit tests had monitor coverage; that did not prove that a user could create and manage a monitor through the browser UI.

The existing `scripts/qualify-browser.mjs` now includes a **synthetic heartbeat monitor** journey in the very same isolated Node / PostgreSQL / real Chromium session:

1. Sign up with an ephemeral synthetic local-only account, then enter the canonical `/app` monitors route.
2. Open the **New monitor** dialog, choose **Heartbeat (cron)**, fill the monitor name and submit the actual React form.
3. Wait until the monitor is rendered in the list; verify via the authenticated API that the stored monitor has the expected ID and type.
4. Navigate to the monitor detail page in Chromium, verify the displayed name, click **Pause**, and wait for **Resume** to appear.
5. Click **Resume**, verify the control returns to **Pause**, and verify the persisted monitor is not paused.
6. Open the actual **Incidents** screen and verify its heading is displayed.
7. Continue all previously covered browser E2E checks: create webhook receiver, send synthetic payload, inspect captured event, verify one-time receiver secret disappears after page reload; confirm disabled merchant checkout and unauthenticated private-route denial.

No external URL is monitored, no real incident notification is sent, and no public network resources, hosted browsers or paid tools are used. The Chromium binary is reused from the already-installed Mac cache, and the CDP/browser profile is ephemeral and deleted on exit. The browser script intentionally does not print or persist receiver URLs or authentication tokens.

### Verification

- Actual headless Chrome for Testing renders and executes the complete above journey. **BROWSER_E2E_PASS**, including persistent pause/resume validation.
- Node production API bundle and Node-target web bundle used in the browser smoke compiled successfully.
- **564/564 API tests** (75 files), **122/122 web tests** (25 files), **20/20 probe tests** (4 files): **706/706 local tests passing**, with no skipped tests in the final suites.
- Monorepo TypeScript/Astro checks passed, as did Node API, Node-target web and optional Edge Probe builds.
- Synthetic Node/PostgreSQL health, configuration, MCP-discovery and HTML UI smoke passed.
- Real local `pg_dump` / `pg_restore` recovered **42 tables, 108 synthetic organizations, and five** essential transactional SQL functions, without touching the source database.
- All **638 source files** in three pinned immutable donor snapshots matched the source-integrity manifest.

## Repeatability

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm --filter @montral/api build:node
DEPLOY_TARGET=node pnpm --filter @montral/web build
pnpm --filter @montral/probe build:edge
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temp-port>/montral_test_<suffix>' \
MONTRAL_CHROMIUM='<previously installed local Chrome executable>' node scripts/qualify-browser.mjs
```

Only disposable loopback PostgreSQL was used (`127.0.0.1:55450`). The Mac's pre-existing PostgreSQL instance on port 5432 was left untouched. This Mac has Node v26.0.0, below the repository's supported Node 26 minimum; green hosted CI on a supported runtime is still missing.

## Boundaries

This is a *local browser smoke*, not cross-browser/mobile/accessibility or operational alert-delivery certification. The browser incident page was visited, but no outage was induced and no actual incident notification lifecycle was tested. Scheduled monitoring of third-party endpoints, custom status-page publishing, account recovery, emails and multi-region Cloudflare probes remain outside this offline qualification.

The repo must remain **PRIVATE**. No public deploy, live billing, real merchant test or customer data is authorized; GitHub Actions hosted runner and production operational gates remain separately blocked.
