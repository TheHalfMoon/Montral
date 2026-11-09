# Cross-browser (Chromium, Firefox, WebKit) and WCAG 2.1 AA qualification

Date: 2026-11-09. Branch `engineering/montral-cross-browser-a11y`. All data is synthetic, and every run uses a disposable
local PostgreSQL database.

## What runs

- `e2e/` is a pnpm workspace package (`@montral/e2e`) with `@playwright/test` 1.64.1 (released 2026-10-14) and
  `@axe-core/playwright` 4.14.0 (released 2026-10-15, bundles axe-core 4.14.0). The versions are exact, and both were
  more than two weeks old when added.
- `e2e/global-setup.ts` starts the built self-hosted Node server (`apps/api` `build:node` plus the `DEPLOY_TARGET=node`
  web build) on a free `127.0.0.1` port. It uses `TEST_DATABASE_URL`, with the same environment as
  `scripts/qualify-browser.mjs` (billing and metering off, test-only secrets). It refuses any host other than
  localhost or 127.0.0.1, and any database not named `montral_test_*`. After the run it stops the server with SIGTERM
  and requires a clean exit 0 within 15 s.
- `.github/workflows/montral-browsers.yml` runs on push to main, pull requests and `workflow_dispatch`, on
  `ubuntu-latest` with the `postgres:18.6-alpine` service (the image `docker-compose.yml` ships), Node 24.22.1 and
  pnpm 10.0.0. It builds the API and web for Node and installs the browsers with the pinned Playwright
  (`pnpm exec playwright install --with-deps chromium firefox webkit`, with apt retries and 3 install attempts). It
  creates and drops `montral_test_xbrowser_ci` and uploads the HTML report and traces when a run fails.
  `scripts/qualify-browser.mjs` and its CI step are unchanged.

## Projects (engines and viewports)

| Project | Engine | Viewport / device |
|---|---|---|
| chromium | Chromium (Playwright headless shell) | Desktop Chrome 1280x720 |
| firefox | Playwright Firefox (Juggler) | Desktop Firefox 1280x720 |
| webkit | Playwright WebKit (Linux build) | Desktop Safari 1280x720 |
| mobile-chromium | Chromium | Pixel 7 (touch, mobile UA, 412x839) |
| mobile-webkit | WebKit | iPhone 14 (touch, mobile UA, 390x664) |

Each project runs 5 tests (25 in all), with no retries: a flaky engine counts as a finding.

## Journeys

1. **Landing `/`.** The page renders through its strict-CSP scripts (four sample monitors, `lang="en"`), and the
   policy has a hashed `script-src` with no `'unsafe-inline'`. The test fails on any console error, uncaught
   exception, CSP violation or unexpected failed request.
2. **Sign-in `/login`, sign-up `/signup`, docs `/docs/self-host`.** Each renders with the same console, CSP and
   request checks.
3. **Signed-in journey**, run in every project:
   - Sign up a new synthetic account in the UI.
   - The dashboard renders with its navigation landmark and current-page state.
   - Skip link, by keyboard only: Tab focuses it and it becomes visible. Enter moves to `#main-content`, and focus
     lands on `<main>`.
   - Create a heartbeat monitor in the UI dialog and find it in the list and the authenticated API. The heartbeat
     never probes anything external.
   - Create a public status page in the UI.
   - Create a second page, then in the editor choose "Password or share link", set the password and save.
   - Create a webhook inbox and post one synthetic payload to its receiver. The receiver URL is never printed, and
     failure snapshots redact it. The captured event shows in the inspector.
   - The audit log lists the journey's changes.
   - Clear cookies, which makes the visitor an outsider:
     - The public page returns 200.
     - The password page returns 401 and shows only the lock form, never the title.
     - A wrong password is refused and the page stays locked.
     - The correct password unlocks the page.
     - The access cookie is not readable from script.
   - Any console error, uncaught exception or unhandled promise rejection fails the journey. Rejections from fetches
     aborted by navigation count too. The one exclusion is WebKit's own "Fetch API cannot load <same-origin /api
     URL> due to access control checks." message, which WebKit logs for every request a navigation cancels, even
     one the app handles.
4. **CSP everywhere.** A `securitypolicyviolation` listener is installed before page scripts in every page of every
   test. It reports through console messages, the one channel every engine supports. Any violation fails the test.

The only failed responses accepted are the two designed anonymous ones. Each is listed with its reason in
`e2e/support/fixtures.ts`:

- `GET /api/me` returns 401: the signed-out session probe.
- `GET /api/public/status/montral` returns 404: the hosted service's own status page, which does not exist on a
  self-hosted instance.

## Accessibility (axe-core 4.14.0)

- **Tags:** `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`.
- **Pages checked in every project:**
  - landing
  - sign-in
  - sign-up
  - dashboard (empty)
  - monitor list
  - public status page
  - locked password page
  - audit log (the workspace audit page from #39, with the journey's own events)
  - `/docs/self-host`
- **Thresholds:** `serious` and `critical` violations fail the test. `moderate` and `minor` ones are recorded as
  annotations and printed on an `AXE <project> <page>:` line in the CI log. The full violation JSON is attached to
  the report.
- **Disabled rules:** none (`DISABLED_RULES` is empty).
- **Preload option:** axe's CSSOM preload is turned off with `preload: { assets: ["media"] }`. That preload
  re-downloads the cross-origin Google Fonts stylesheet with XHR, and the landing page's `connect-src 'self'`
  correctly blocks it. The tool, not the app, caused that CSP violation, and no WCAG A or AA rule needs the preload.

### Violations found and fixed in the app

| Found (engines) | WCAG | Fix |
|---|---|---|
| Text contrast 2.85 to 3.5:1 in all projects, from `--faint` #8b938d and `--accent` #0f9d58 (links, nav, phone tabs, hero tags, docs strings and code). axe reported 22 to 53 nodes per page. | 1.4.3 | Light text tokens in `global.css` and the landing pages changed to `--faint` #646c66 and `--accent` #0b7a43, each at least 4.5:1 on `--bg`, `--surface`, `--surface-2` and the 10% accent tint. `--warn` (#c98a0a, 2.7 to 2.95:1) and `--down` (3.95:1 on its tint) failed the same calculation and became #8f6200 and #c42f2f. Dark `--faint` changed to #858e89 (it was 4.07:1). The docs function highlight changed to #3d5ce0 (light) and #7b96ff (dark). |
| `label-content-name-mismatch` on the language buttons (landing, docs) and the custom `Select` (sign-in, sign-up): `aria-label="Language"` hid the visible "English" | 2.5.3 | Removed the aria-label. The visible value now stays in the name, after a visually hidden prefix: "Language: English". |
| `link-name` on the docs header logo link at phone width, where its text is hidden | 2.4.4, 4.1.2 | `aria-label="Montral"` |
| `scrollable-region-focusable` on docs code samples and wide tables | 2.1.1 | `doc-shell.js` adds `tabindex="0"` to exactly the overflowing `<pre>`/`<table>` elements, re-checks on resize, and shows a focus outline. |
| Dashboard skip link did nothing in any engine: the client router intercepted the same-page `#main-content` click and called `preventDefault()` | 2.4.1 | The router leaves same-document fragment links to the browser. `<main>` has `tabindex="-1"`, so focus moves into it. |

### Functional defects the journeys found (all engines)

- **Status page editor crashed for every page.** `StatusPageEditor` called `useState` after its "Loading…" early
  return. React error #310 left the editor empty, so visibility and passwords could not be set in the UI. The hook
  now runs before the return.
- **Slug and ntfy topic patterns were silently ignored.** Browsers compile `<input pattern>` with the `v` flag, where
  `[a-z0-9-]` is an invalid class, so these fields had no client-side validation. The hyphen is now escaped
  (`[a-z0-9\-]`, `[A-Za-z0-9_\-]`).
- **Navigation away from a status page view left a load unhandled.** `api.monitors()` in the editor and
  `api.statusPages()` in the list had no rejection handler, so a request aborted by navigation surfaced as
  "Unhandled Promise Rejection: TypeError: Load failed" (mobile-webkit). The new `lib/mounted.ts` helper, with a unit
  test, ties each load to its effect. Every rejection is handled, results after unmount are dropped, and a real load
  failure is shown instead of an endless "Loading…".
- **On phones, the monitor dialog's Create button sat under the tab bar.** The bottom-sheet modal (z-index 10) was
  below the fixed tab bar (20). The modal now uses z-index 35, still below the drawer (40). Found in the Pixel 7
  project.

## Result

An earlier GitHub Actions run, 42566781804 on `be75093` with a looser journey guard, passed 25/25. All five projects passed the landing, sign-in, sign-up,
docs and signed-in journey tests, and all eight axe pages then in the suite reported 0 serious/critical and 0 moderate/minor
violations. The final PR head is reported in the PR.

Local checks on Windows: `pnpm -r typecheck` (including `astro check` and the new `e2e` package) passed, and
`npx playwright test --list` lists 25 tests in 5 projects. Local runs stop there because the machine has no
PostgreSQL or Docker.

## Not covered

- Real Safari on macOS or iOS hardware, and real Chrome or Firefox on Windows or macOS. Playwright's WebKit is the
  Linux WebKit port with Safari's engine but not Safari's shell, fonts, ITP or Keychain, and the device projects are
  emulation (viewport, touch and UA), not real devices.
- Screen-reader testing (VoiceOver, NVDA, JAWS, TalkBack) and other manual assistive-technology checks. axe finds
  roughly the automatable subset of WCAG; 1.3.1 meaning, focus order quality, 2.4.6 headings and 3.3 error
  suggestions still need human review.
- Dark mode. Axe ran with `prefers-color-scheme: light` only. The dark `--faint` and highlight tokens were corrected
  by calculation, not by an automated run.
- Pages outside the list above: incidents, alerting, team, billing, settings, account, the other docs pages, the
  localized landing pages and the status page editor's own contrast. The editor is exercised functionally but not
  scanned.
- Reflow at 320 CSS px and 200% zoom (1.4.10, 1.4.4), and the motion and animation settings.
