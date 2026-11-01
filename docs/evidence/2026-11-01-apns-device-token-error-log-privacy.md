# Push notification backend error-log token privacy

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private Montral, local synthetic iOS/APNs token and database/channel failure mocks; no Apple endpoint called, no device enrolled, no external deployment or commercial service.

## Two independently reproduced private-token leaks

1. `sendPush` in `apps/api/src/apns.ts` marks provider-rejected devices as dead and attempts repository deletion. If repository cleanup fails, the catch callback logged the **raw database exception message**. A legitimate storage failure can contain a full APNs token or database authentication diagnostic. An `apns.test.ts` regression injected a synthetic `410` APNs response and threw a database exception containing a 64-character synthetic device token plus a unique private marker. **RED**: the console log contained the token and marker, although the delivery correctly stayed non-fatal.
2. `PUT /api/push/devices` automatically creates a workspace push channel when configured with APNs. A failed auto-channel write did not fail the device-registration response but did log the **raw exception `.message`**. A Hono route regression registered a synthetic device while mocking channel creation to fail with the full synthetic device token and private marker. **RED**: the log contained the token and marker, even though the response was HTTP 200.

## Corrections

Both optional error paths now log only a **fixed category** rather than untrusted error details: `could not remove a dead push device; diagnostics suppressed` and `could not create the push channel; diagnostics suppressed`. They still record that cleanup/provisioning failed without the secret, and preserve the existing best-effort delivery/registration semantics. No APNs credentials, device registration format, token lifetime, scopes, retry policy or provider host changed.

**GREEN**: `apns.test.ts` plus the new Hono `push-log-privacy.test.ts` **21/21** pass. These verify that the two synthetic token/marker errors are suppressed, while other APNs payload, device-death, partial-success and failure behavior remains unchanged.

## Boundaries

Local Mac qualification on Node **24.22.1**, pnpm **10.0.0**, PostgreSQL **17.9**: focused **21/21** APNs and Hono privacy tests GREEN. First full API attempt passed 708 cases but one test-suite `beforeAll` exceeded its 10-second PostgreSQL setup timeout, skipping seven retention cases: this run is correctly **FAILED**. The affected retention suite plus both push privacy suites reran on fresh PostgreSQL with **28/28 PASS**. A further complete independent-DB API run passed **715/715 across 90 files** with no skipped hooks. The other packages passed PostgreSQL DB **114/114** with `DATABASE_URL` set, Edge Probe **20/20**, and Web **124/124** after production build: total latest complete package run **973/973 PASS**. TypeScript/Astro checks and three Node API / Edge Probe / Node Web production builds PASS.

Node/PostgreSQL smoke, headless Chromium signup/monitor/incident/webhook/disabled billing/recovery URL handling, localhost SMTP verification/channel/incident recovery/account reset, full **46-table** source-stable dump/restore (nine synthetic organizations, all row counts, SHA-256 normalized content fingerprints and eight required database functions), and all five real macOS OS `SIGKILL` monthly-outbox failure boundaries PASS. No remote provider used. A sporadic slow 10-second local PostgreSQL hook setup remains a test-capacity observation, not a proven root-cause fix. Exact hosted CI is tracked separately and must not be inferred from Mac results. This proves local **error-log redaction** only; external Apple Push Notifications credentials, real iOS delivery, production host logs, APNs billing/entitlements and release remain unqualified. No third-party access was attempted.
