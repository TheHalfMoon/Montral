# OAuth workspace grant cookie malformed encoding resilience

**Engineering date:** 2026-11-01 Asia/Riyadh. **Environment:** private Montral source; synthetic Cookie headers; local macOS, supported Node 24.22.1 and disposable PostgreSQL for full package qualification. No user data, cloud OAuth client registration or deployment.

## Source bug reproduced before repair

The OAuth authorization hook selects the user's approved workspace/project grant through `grantCookie` in `apps/api/src/auth.ts`. This helper performed an unguarded `decodeURIComponent` on the client-controlled `montral_grant` cookie value while processing the authorization flow. A truncated percent escape (`%`) and malformed sequences such as `%ZZ` or invalid UTF-8 threw `URIError: URI malformed` before the PKCE challenge could be checked. That is an avoidable request-availability failure caused by untrusted input, **not evidence of OAuth authorization expansion or token compromise**.

New `apps/api/src/oauth-cookie.test.ts` failed **RED 1/2** with exact `URIError` at `auth.ts` on malformed percent encodings, while ordinary PKCE-bound cookie decoding passed.

## Narrow correction and regression

`grantCookie` now treats malformed percent/UTF-8 decoding as an absent grant choice (`undefined`), rather than throwing an exception into the OAuth handler. Normal valid encoded workspace/project choices are unchanged; a cookie bound to a different PKCE challenge still yields no selection; an empty choice still yields no selection. Invalid client input must not skip the workspace picker. `grantCookie` is exported solely to enable direct deterministic regression testing; this does not add an HTTP route, grant scope or new product capability.

**GREEN 2/2** focused cases on real helper: normal/expired challenge, empty/absent values and a matrix of invalid percent-encoded values. No existing session, workspaces, project scopes, OAuth token verification, PKCE enforcement, or checkout code was changed.

## Qualification limits

Local supported macOS Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9** full package qualification **971/971 PASS**: API **713/713** over 89 files, PostgreSQL DB **114/114** with an explicit fresh test `DATABASE_URL`, Edge Probe **20/20**, and Web **124/124** after production web build. TypeScript/Astro checks and production builds for Node API, Edge Probe and Node Web PASS. Existing OAuth scope/refresh E2E tests were included and passed.

Separate real Node/PostgreSQL health/config/MCP/dashboard smoke PASS; headless Chromium signup, monitor, incident, webhook, disabled billing and reset-link privacy PASS; local SMTP verification, incident down/recovery, channel test and account recovery PASS. `pg_dump`/`pg_restore` verified all **46 tables** (14 nonempty), nine synthetic organizations, exact row counts and SHA-256 content fingerprints and eight SQL functions. Five OS `SIGKILL` staged monthly-outbox crash boundaries PASS without replay or duplicated quotas. All **638 original source snapshot files** and the active source-branding scan PASS. These were local synthetic tests and no real external services were enabled. Hosted GitHub Actions on the new exact revision is checked separately, not inferred. Local helper tests do not establish the behavior of every hosted OAuth client, reverse proxy or credential provider. Production security/penetration review and external OAuth/browser matrix remain OPEN. The private repository must not be deployed or published.
