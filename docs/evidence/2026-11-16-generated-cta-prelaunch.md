# Generated public-route self-hosting CTA audit — 2026-11-16

**Status:** source-level correction under qualification; no release or production deployment authorization.

## Finding

Public comparison pages (`/alternatives/:tool`) and use-case pages (`/for/:segment`) explicitly say that Montral Cloud is **not publicly available**, yet both reusable EN/ZH templates placed their primary **Start monitoring** link at `/app`. On a public informational project website, that link could wrongly suggest a ready-to-use hosted instance (or simply send visitors to a sign-in page). The secondary CTA offered the self-hosting guide, but was visually subordinate to the unavailable user journey.

## Engineering correction

- EN/ZH primary CTA in both templates now links directly to `/docs/self-host` with a **Self-host Montral / 自托管 Montral** label.
- Secondary CTA leads to `/docs` for broader documentation. Callout headlines now explain that visitors should **run Montral themselves**, not try a live hosted product.
- Both templates retain the existing explicit Cloud-not-publicly-available disclaimer. Existing signed-in app routes, auth logic, API, billing, provider settings, deployment, DNS and operator-owned registration remain unaffected.
- The Vitest source-regression `generated-prelaunch-cta.test.ts` fails if either shared template reintroduces `/app` as the public primary CTA or loses localized instructions.

## Qualification

On Windows, `git diff --check` and `node --check` for the test source passed. The three test bodies passed using a temporary dependency-free Node ESM test shim (**3/3**); this does not substitute for hosted Vitest/Astro/browser qualification. Full exact-head CI **16/16** and integrated-main push CI **11/11** are required prior to engineering signoff.

The Community publication gate remains **HOLD until explicit `GREEN LIGHT MONTRAL`**. Cloud/BYOC remain **NO-GO** pending legal/privacy/security/provider/production approvals. No live hosted service, customer data, billing, release tags or packages are changed.
