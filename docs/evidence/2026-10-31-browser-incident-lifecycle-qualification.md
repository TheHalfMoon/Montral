# Montral — real-browser incident lifecycle qualification

**Date:** 2026-10-31. **Repository:** PRIVATE `TheHalfMoon/Montral`. Base commit `b91ff4ea112abc846f65a72af6ccc94793f2a041`. Mac ARM64 only, local-only synthetic data, no hosted dependencies.

## Browser qualification gap closed

Before this wave, the local real-Chromium qualifier covered signup, synthetic heartbeat monitor creation/pause/resume, visiting the incidents list, webhook receipt/inspection and disabled billing. It did *not* exercise user-authored incident management in a real browser.

The extended `scripts/qualify-browser.mjs` now performs the **entire manual incident lifecycle in real Chromium**, using existing React controls and persisting to disposable PostgreSQL:

1. Create a local synthetic heartbeat monitor, pause and resume it.
2. Visit **Incidents** and open the **Declare incident** modal.
3. Submit a synthetic incident with its title and verify the browser navigates to its detail route. The authenticated API confirms it has `investigating` status, `auto=false`, and the requested title.
4. Click **Acknowledge** and verify the button disappears; fetch the incident to confirm acknowledgement is persisted.
5. Select `identified` and **Internal note** in the incident's real React update form, enter a synthetic investigation note, and publish. Assert the timeline renders the note, and the persisted update has `visibility=internal`.
6. Click **Resolve** and verify the browser displays the resolved pill, `resolvedAt` is set, and the resulting resolution update has `visibility=public` (the endpoint's existing subscriber-facing rule).
7. Return to the incident list and confirm the resolved incident appears. Continue all existing webhook and disabled billing regression steps.

**Safety:** the temporary test account has no external notification channels or status-page subscribers. The incident is **manual and synthetic**; no network outage is induced, and no real alert, subscriber email or merchant action is sent. Captured webhook secret URLs are never printed or committed. This test does **not** certify real alert delivery or automatic failure-detection/incident creation.

## Local evidence

- Real Node-target production API/web bundles with isolated PostgreSQL 17 on Mac loopback `127.0.0.1:55451`: **BROWSER_E2E_PASS** including manual incident declare → acknowledge → internal note → resolved, plus synthetic heartbeat monitor, webhook and billing-disabled paths.
- **API: 564/564 passing**, 75 test files; **web: 122/122**, 25 test files; **probe: 20/20**, 4 test files. **Total: 706 passing tests.**
- All monorepo TypeScript/Astro checks passed; Node API, Node-target web and optional Edge Probe production bundles built successfully.
- Node/PostgreSQL HTTP smoke passed for health, configuration, MCP discovery and rendered dashboard.
- Local `pg_dump/pg_restore` passed: **42 tables, 107 synthetic organizations and five** essential transactional Montral SQL functions were recovered.
- Integrity validation passed for **all 638 files** across three immutable donor snapshots.
- The Mac's original PostgreSQL at `127.0.0.1:5432` was not used or altered. This execution used Node **v26.0.0**, which is below Montral's declared supported Node 26 minimum; hosted supported-Node verification is still required.

## Reproduction

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm --filter @montral/api build:node
DEPLOY_TARGET=node pnpm --filter @montral/web build
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temporary-port>/montral_test_<suffix>' \
MONTRAL_CHROMIUM='<locally installed Chromium executable>' node scripts/qualify-browser.mjs
```

## Unqualified before production release

- Real *automatic* monitor failure/recovery transitions and alert-provider delivery, outbound customer email, incident escalations, accessibility and cross-browser/mobile matrix.
- Hosted CI (GitHub Actions jobs currently fail before runner allocation, with zero steps); supported-runtime Node qualification (Mac installed v26.0.0 is below declared minimum).
- Real managed database failure/restore, Cloudflare multi-region tests, vendor test merchant billing, cost/legal/privacy approval and user-authorized publication.

Montral remains **PRIVATE** and **NOT ready for public commercial launch**.
