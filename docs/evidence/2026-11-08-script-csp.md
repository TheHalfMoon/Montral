# Hash-based script Content Security Policy for web pages

## Gap
The web app had no `script-src` policy (PR #15 added framing, base, object
and form restrictions only), so injected markup that reached a page could run
script.

## Change
- Astro's `security.csp` emits a `<meta>` policy on every page:
  `script-src 'self' https://challenges.cloudflare.com` plus SHA-256 hashes,
  `object-src 'none'`, `base-uri 'self'`. No `'unsafe-inline'` or
  `'unsafe-eval'` for scripts. Styles keep `'unsafe-inline'` because React
  and the pages render `style=""` attributes; Google Fonts CSS is allowed.
- Astro hashes only its own scripts (hydration, bundled modules), not
  `is:inline` ones, so every inline script now lives in `src/inline/*.js`,
  is rendered byte-for-byte with `set:html` of a `?raw` import, and
  `astro.config.mjs` adds the SHA-256 of each file. This works the same for
  static and server-rendered pages (a runtime `Astro.csp.insertScriptHash`
  from the layout did not reach the SSR status page's policy).
- The status page subscribe script got per-request values through
  `define:vars`; it now reads them from a JSON data block (`<` escaped), so
  the script text and hash are constant.
- The app shell script moved to a typed bundled module (`lib/app-shell.ts`).
- `<ClientRouter />` is off by default: Astro's CSP does not support it, and
  only a harmless `astro:before-swap` listener depended on it.

## Evidence
- `scripts/verify-csp-hashes.mjs` (CI, after the Node web build): every
  executable inline script on all Astro-built pages is in that page's
  `script-src` hashes, and the policy has no `unsafe-*`. Locally: 71 inline
  scripts on 31 pages. It first found that no `is:inline` script was hashed.
- The CI Chromium journey (`qualify-browser.mjs`) records every
  `securitypolicyviolation` through a CDP binding on all pages it visits,
  including a server-rendered status page, fails on any, and checks that an
  injected inline script is reported and does not execute.
- Locally in Chromium: no violations on the SSR status page, app, incidents,
  API docs, changelog, 404 and sign-in pages; the 404 script ran and an
  injected script was blocked.

## Limits
- The policy is a `<meta>` placed by Astro after the first `<head>` script,
  so content before it is not covered; that region is template-only.
- The hand-written landing page (`public/index.html` and translations) is
  not built by Astro and has no script policy.
- `style-src` allows inline styles. No `connect-src`/`img-src` restriction.
