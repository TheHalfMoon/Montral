# Privacy: suppress unexpected API and password-reset provider diagnostics

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private Montral Node/Workers code, synthetic errors and disposable local PostgreSQL. No paid mail provider, production customer data or external deployment.

## RED: two independently reproduced log leaks

1. Hono `app.onError` previously logged an arbitrary thrown Error object (including its message and stack) even though the HTTP response already was generic `500 {error: "Internal error"}`. An integration fixture injects a synthetic exception through an edition request middleware, asserts the 500 response and inspects `console.error`. Before the fix, the exact synthetic private marker was logged.
2. The Better Auth `onPasswordReset` hook sends a post-reset security notice and correctly treats failures as non-fatal: the password reset itself already succeeded. Its failure catch, however, logged the raw mail provider Error, potentially including a recipient address, provider credentials or token-bearing link. A real PostgreSQL E2E creates a synthetic account, sends a local reset link, forces the security-notice transport to fail with the synthetic recipient and private marker, and confirms reset and subsequent login still succeed. Before the fix, the exact recipient address and private marker were logged.

**RED**: with old production logging temporarily restored in the disposable working tree, both focused tests failed on the private markers. No existing authorization/session behavior was modified for this verification.

## Narrow correction

Unexpected API failures now log only `Unhandled API error; private diagnostics suppressed`; status remains 500 and response remains `{error: "Internal error"}`. Password-reset security notice failures now log only `password-changed email failed; provider diagnostics suppressed`. That notification is still attempted and a failing provider does not roll back a completed password reset. Fixed text preserves operational categories, not user-supplied or third-party diagnostics. Provider details are never passed as additional console arguments.

**GREEN**: both real PostgreSQL integration tests pass, verifying that the generic HTTP 500 has no private marker, the reset still yields HTTP 200, new credentials work, and neither recipient nor transport marker is logged. This is server-application logging hardening only, not an audit of hosted reverse-proxy, managed DB or SMTP provider logs.

## Qualification

Mac full package qualification on Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9** with fresh disposable DB: **982/982 PASS** (API **724/724** over 94 test files, DB **114/114**, Probe **20/20**, Web **124/124**). All TypeScript/Astro checks and Node API / Edge Probe / Node Web production builds PASS. Real Node/PostgreSQL health, config, MCP and dashboard smoke PASS. Headless Chromium signup, monitor, incident, webhook, disabled billing, account reset URL privacy and unauthenticated refusal PASS. Loopback-only SMTP signup verification, channel test, incident down/recovery and password recovery PASS. `pg_dump` and `pg_restore` verified **46 tables** (14 nonempty), **nine synthetic organizations**, all exact row counts and SHA-256 normalized-content fingerprints and eight required database functions. All five OS `SIGKILL` outbox crash boundaries PASS with no duplicate delivery or quota debit. GitHub-hosted CI on the exact new commit remains a separately verified gate. Public launch and any production external services remain `NO-GO` until separately qualified and explicitly approved.
