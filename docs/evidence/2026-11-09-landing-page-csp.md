# Strict Content Security Policy for the hand-written landing pages

## Gap
`apps/web/public/{index,es,ja,zh-Hans}.html` are not built by Astro, so the
hash-based script policy of PR #19 did not cover them. Each page ran two inline
scripts with no policy at all.

## Change
- `scripts/landing-csp.mjs` moves the large page script (identical on all four
  pages) to `/landing.js` and writes a `<meta>` policy as the first element
  after `<meta charset>`, so it covers every script:
  `default-src 'self'; script-src 'self' 'sha256-<pre-paint>';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;
  connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`.
- The small pre-paint script (theme and language before first paint) stays
  inline and is allowed only by its hash. No `unsafe-inline`/`unsafe-eval` for
  scripts; `default-src 'self'` blocks third-party loads and connections.
  Styles keep `unsafe-inline` for the sample uptime bars' `style` attributes.
- The script refuses inline event handlers and `javascript:` URLs, and
  `--check` fails CI when a page is edited without refreshing the policy.
- Framing, `base-uri`, `object-src` and form targets are also sent as headers
  by the Node server (`web-security-headers.ts`).

## Evidence
- `node scripts/landing-csp.mjs --check` (new CI step): four pages, one hashed
  pre-paint script each, policy before the first script.
- `scripts/verify-csp-hashes.mjs` now also covers these pages (they carry the
  policy meta): every inline script must be in its page's hashes.
- Chromium journey: visits `/`, `/es`, `/ja` and `/zh-Hans`; both scripts must
  run (four sample monitors rendered, `lang` applied), the policy must be
  strict, and any CSP violation fails the run.
- Reviewed the page script: its two `fetch` calls are same-origin; the only
  `insertAdjacentHTML` renders static sample data; fetched values reach the DOM
  through `textContent`.
