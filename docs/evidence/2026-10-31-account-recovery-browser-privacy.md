# Account recovery browser privacy qualification — 2026-10-31

## Scope

Only the Montral private repository and synthetic local browser/HTTP traffic. No external email, payment provider, real accounts, or deployment.

## Improvements

1. The password reset page now includes `meta name="referrer" content="no-referrer"` before fonts, scripts and other third-party resources, while retaining `noindex`.
2. On hydration the client preserves the reset value only in component state and removes the query parameter from the browser address bar using `history.replaceState` without an additional navigation.
3. A missing reset link is treated as invalid and displays a direct request-new-link action, rather than permitting submission with an absent value.
4. `scripts/qualify-browser.mjs` now checks both the URL-scrubbing journey and the missing-link refusal in headless Chromium. It also checks the rendered referrer metadata. No real reset links are generated or displayed by this browser test.

## Verified local evidence

- The actual headless Chromium journey returned `BROWSER_E2E_PASS` after testing monitoring, incidents, webhooks, disabled checkout and both reset page cases.
- `pnpm -r typecheck` and the Node API + Node SSR web production builds passed locally. The built reset HTML contains `name="referrer" content="no-referrer"`.
- Full disposable-database regression on this branch: **574 API**, **20 probe**, **122 web** tests passed; the Edge probe bundle built and 638 donor source hashes verified.
- The existing production-Node SMTP loopback qualification also passed: SMTP handshake and cron-created synthetic down/recovery mail over localhost, with no external delivery.
- The Mac used Node v24.15.0 (below the repository's supported v24.22.1), so results are supplementary, not a replacement for exact-version and hosted CI checks.

## Still out of scope / open

- Actual external email delivery and cross-browser accessibility remain unqualified.
- This browser check deliberately does not validate genuine emailed reset links; the existing API PostgreSQL test covers password-change notifications and session invalidation with a synthetic mail transport.
- The GitHub-hosted CI jobs still fail before runner assignment, so this updated browser test has not executed in hosted CI.
