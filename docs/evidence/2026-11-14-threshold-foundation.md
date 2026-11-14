# Threshold identity foundation and public landing page (2026-11-14)

Branch `design/montral-threshold-foundation-20261114`, cut from `main@93a00bb`.

## What changed

- **Identity.** The owner-approved Threshold mark (a horizontal bar with a small offset square) replaces both
  previous marks (the "M" zig-zag and the pulse line) everywhere they were drawn: app sidebar, auth shell, docs
  header and footer, 404 and the public status page header. `apps/web/scripts/gen-brand.mjs` is the single source of
  the mark geometry and writes `public/favicon.svg`, `public/brand/*.svg`, and (with `--png`) the touch, PWA, e-mail
  and Open Graph PNGs. `design/og.html` is the Open Graph source.
- **Tokens.** `public/brand/threshold.css` holds the fonts and all colour, type, spacing, radius, motion and layer
  tokens for light and dark themes. Both the landing pages and the Astro app load it (`layouts/Base.astro`), so the
  previous duplicate token sets (landing inline vs. `global.css`) are gone. Brand foundations: Ink `#171713`,
  Signal `#F04D35`, Paper `#F5F2EB`, Surface `#FFFDF8`.
- **Semantics.** Signal red marks change and the brand only. Status colours are separate and each state has its own
  shape so meaning never depends on colour alone: operational = circle (`--ok`), degraded = triangle (`--warn`),
  down/critical = diamond in crimson (`--down`, visibly different from Signal), maintenance = ring (`--info`).
  Interactive state (selected navigation, focus, toggles, links) moved from green to Ink with a 2 px focus ring.
- **Fonts.** Newsreader (display), Inter (interface) and JetBrains Mono (code), self-hosted as Latin and Latin-Ext
  variable WOFF2 subsets in `public/fonts/` with their SIL OFL 1.1 licence texts. `font-display: swap`; CJK text
  falls back to system families (PingFang SC, Microsoft YaHei, Noto Sans/Serif SC, Hiragino). No font service is
  contacted; `scripts/verify-no-remote-fonts.mjs` passes.
- **Landing page (`/`).** Rebuilt `public/index.html` + `public/landing.js` through the existing generator: navigation
  (Product, Features, Solutions, Open source, Documentation, Sign in, Get started), hero "Make change impossible to
  miss.", an accessible tabbed product tour (Monitoring, Incidents, Status pages, Webhooks; WAI-ARIA tabs with arrow,
  Home/End and 1-4 keys), the Observe → Detect → Respond → Restore loop, capability sections (monitoring, incidents,
  on-call, alerting, status pages, webhooks), developers (REST, MCP, embeds), editions, self-hosting, FAQ, final call
  to action and footer. All sample data is labelled synthetic. Complete en / zh-CN / ja / es dictionaries (195 keys).
  The page follows the operating-system theme unless the visitor chose one.
- **Edition-aware navigation.** Billing is hidden unless `/api/usage` reports `metered: true` and
  `canManageBilling`, and `/api/billing` reports `billingConfigured`. Plan & usage stays metered-only. Hiding is
  presentation only; routes remain guarded by the API.

## Claims checked against the code

| Landing claim | Source |
|---|---|
| Regional probes agree before alerting | `apps/api/src/probes.ts` `combine` / `requiredFailures` (majority or `minFailing`) |
| Maintenance holds alerts but keeps results | `apps/api/src/scheduler.ts` (`inMaintenance`: results recorded, status/incidents untouched) |
| Rotations handle time zones and DST | `apps/api/src/oncall-engine.ts` header notes and `timeZone` formatter |
| Replay to a URL you name; custom response with delay | `apps/api/src/montral-hooks.ts` replay route and `delayMs` |
| Monitor types listed | `apps/api/src/routes/monitors.ts` type enum |
| 14 alert channels listed | `apps/api/src/routes/channels.ts` |
| API key header, MCP endpoint | `apps/web/src/pages/docs/regions.astro`, `docs/mcp.astro` |
| Cloud not launched, no prices | Copy states it plainly; no price, plan or checkout is shown |

## Local verification (Windows 11, Node 24.19, pnpm 10.0.0)

| Check | Result |
|---|---|
| `python scripts/verify_sources.py` | `MONTRAL_SOURCE_ONLY_PASS` |
| `bash scripts/verify-active-branding.sh` | `MONTRAL_ACTIVE_BRAND_SCAN_PASS` |
| `node scripts/verify-no-remote-fonts.mjs --negative-control` | `MONTRAL_NO_EXTERNAL_FONTS_PASS` (183 sources) |
| `node scripts/landing-csp.mjs --check` | `LANDING_CSP_CHECK_PASS` (4 pages) |
| `DEPLOY_TARGET=node pnpm --filter @montral/web build` | Complete |
| `node scripts/verify-csp-hashes.mjs apps/web/dist/client` | `CSP_HASHES_PASS` (75 inline scripts, 35 pages) |
| `astro check` | 0 errors, 0 warnings |
| `pnpm --filter @montral/web test` | 34 files, 186 tests passed |
| Visual capture (system Edge, 1440 x 900 and 390 x 844, light and dark) of `/`, `/zh-Hans`, `/login`, `/signup`, `/docs`, `/docs/self-host`, `/404` | 28 captures, no console errors |

Not run locally: PostgreSQL-backed API tests and the Playwright/axe matrix (Docker engine unavailable on this
machine); they run in the PR's required CI. `e2e/tests/dark-mode.spec.ts` now expects the Threshold dark background
(`#141411`), and `e2e/tests/cloud-usage.spec.ts` asserts that Billing is hidden on unmetered deployments.

## Independent review (before merge)

An independent reviewer read the full diff (no edits). Findings and resolution:

| Severity | Finding | Resolution |
|---|---|---|
| High | Light `--ok` on its 10% tint over `--bg`/`--surface-2` was 4.41:1 (status strip, `.pill.up`) | `--ok` darkened to `#17664A` (5.35:1 on tint over `--bg`, 5.00 over `--surface-2`) |
| Medium | Dark theme: avatar initials `#fff` on light `--ink-2` (1.5:1) | `.av` text uses `var(--bg)` |
| Medium | Dark theme: toggle knob `#fff` on `--ink` track (1.2:1) | knob uses `var(--surface)` when on |
| Low | Status footer showed a raw key for `overall: "unknown"` | footer badge only for operational / degraded / outage |
| Low | `html[lang=zh-CN]` overrode the font stacks with an unloaded family | rule removed; stacks come from `threshold.css` |
| Low | Unloaded "Instrument Serif" / "Geist Mono" names in onboarding, meters, 404, docs | `var(--serif)` / `var(--mono)` |
| Low | `:root --shadow-sm` in `global.css` overrode the dark token | removed; `--accent-line` defined (was undefined) |
| Low | `aria-label` on role-less `div`/`pre`; language menu `li` without `role="none"` | `role="group"` where labelled, labels dropped from `pre`, `role="none"` added |

## Known limitations

- The authenticated app still uses its existing layouts and components; only tokens, fonts and marks changed here.
  The app shell, data views and per-feature redesign follow in later PRs.
- The public status page does not yet honour the page's `theme` setting (pre-existing).
- Landing `aria-label`s on decorative regions are English in every language.
