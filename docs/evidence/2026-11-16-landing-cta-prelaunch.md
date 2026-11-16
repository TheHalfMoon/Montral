# Prelaunch landing call-to-action qualification (2026-11-16)

**Status: engineering change under review; not a release authorization.**

## Finding

The four static landing variants (English, Chinese, Japanese and Spanish) explicitly say that Montral Cloud is not publicly available, but all three primary calls to action in each variant still linked to the local `/signup` route and said "Get started." On a future public project landing without an approved, operating managed service, this could imply that visitors can register for a public Montral Cloud account. This is a public-copy mismatch, not evidence that a hosted service is deployed or receiving users.

## Change

- The nav, hero and footer primary CTA on all four static landings now links to the appropriately localized **Community self-hosting guide**, never to `/signup`.
- The hero secondary CTA links to the general documentation, avoiding duplicate self-hosting buttons.
- EN/ZH/JA/ES wording and `landing.js` language-switch translations agree; the logged-in dashboard navigation and existing sign-in link remain unchanged for already-running self-hosted instances.
- An explicit Vitest regression inspects every static document and translation table, rejecting a reintroduced primary signup CTA.

## Verification

Windows static checks on the new branch: `node --check` for both the test and `landing.js`, `git diff --check`, 6/6 focused source-assertion checks using a temporary dependency-free ESM runner (not claimed as hosted Vitest), and `node scripts/landing-csp.mjs --check` with **LANDING_CSP_CHECK_PASS** for all four landing pages. Full hosted Astro/CI/browser checks remain mandatory before merging.

No account logic, API, database, payments, legal-policy consent, DNS, deployment or public release is changed. Public Community publication stays **HOLD until explicit `GREEN LIGHT MONTRAL`**. Cloud and BYOC remain NO-GO pending external provider, security, legal/privacy and production infrastructure requirements.
