# Public status page brand-link fallback (2026-11-16)

**Status:** Engineering PR; no deployment, release or production qualification.

## Defect

Self-hosted default configurations and the web server's fallback `PRODUCT_URL` sent the visible “Powered by Montral” link on public status pages to `https://montral.invalid`. The status page's generator meta tag also contained `montral.invalid`, and the Cloudflare example worker configuration set the credit link to `https://status.example.com` (reserved example address). These are documentation/template placeholders, not public product domains; shipping them as working public credit links breaks attribution and creates a poor trust signal.

## Patch

- The fallback in `apps/web/src/lib/server.ts`, Docker Compose default, Docker environment example and Wrangler template now points to the real owner source repository: `https://github.com/TheHalfMoon/Montral`.
- The page generator metadata identifies the product by its actual name, `Montral`, not a fictional domain.
- Real operators retain the `PRODUCT_URL` override to point the backlink to their own properly configured product site; URL/template defaults do not enable external services or add any network request until a visitor follows the public link.
- A focused Vitest source regression `apps/web/src/lib/public-credit.test.ts` checks all configuration surfaces, the page metadata, the operator override, and the absence of `montral.invalid` in these public credit paths.

## Release and testing

Review real static rendering, browser/a11y, CSP, Docker environment substitution and production Astro build. Require 11/11 exact-head GitHub Actions workflows and 16/16 constituent jobs before merge, then integrated-main qualification. Local Windows Node 24.19.0 is below the repository's 24.22.1 minimum, so this note makes no local runtime qualification claim.

**Community publication HOLD** until `GREEN LIGHT MONTRAL`. Cloud/BYOC NO-GO; no paid service, new domain, or deployment is authorized.
