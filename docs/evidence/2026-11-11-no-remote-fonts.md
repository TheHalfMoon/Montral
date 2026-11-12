# BYOC: client-side font egress removed (2026-11-11)

Scope: active Montral public landing, multilingual static landing, application layout,
CSP configuration, and local BYOC integration checks.

## What changed

- The application layout and all four standalone landing pages no longer load
  third-party font stylesheets or preconnect to a remote font service.
- Text renders with the existing local system-font fallbacks.
- The Astro CSP no longer permits the remote font stylesheet host.
- The static landing CSP permits local fonts and is regenerated using
  `node scripts/landing-csp.mjs`.
- The BYOC qualification script now rejects served HTML containing an external
  font stylesheet reference instead of merely reporting it.
- The privacy copy reflects that fonts do not require a third-party request.
- `scripts/verify-no-remote-fonts.mjs` recursively inspects 167 current text
  sources in the web app, public pages, design reference, and landing generator,
  so newly added components and routes are also covered. The guard recognizes
  common Google Fonts, Bunny Fonts, Adobe Typekit, and CDNFonts endpoints.
  A negative control creates a new nested route with a synthetic remote font
  link and proves that the recursive scanner discovers and rejects it.

## Local checks (not a substitute for hosted CI)

- `node scripts/landing-csp.mjs`: PASS.
- `node scripts/landing-csp.mjs --check`: PASS, four landing pages.
- `node scripts/verify-no-remote-fonts.mjs --negative-control`: PASS, 167 sources.
- Independent mutation check: a newly added `apps/web/src/pages/*.astro` file
  with an external font URL caused the guard to fail (expected), was removed,
  and the clean source scan passed again.
- `git diff --check`: PASS.
- The full browser and Docker BYOC E2E matrix must pass in GitHub Actions at
  the exact PR head before merge.

## Boundaries

The BYOC recorder still observes the server process, not external requests
made by a user's browser and not optional runner child processes. This
change eliminates the known Google Fonts browser-side dependency, but does
not claim that all browser-side external requests are absent: optional
Turnstile/analytics and status-page favicons remain documented and controlled
separately. No production deployment or billing was enabled.
