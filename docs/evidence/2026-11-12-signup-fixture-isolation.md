# Deterministic closed-signup qualification (2026-11-12)

## Incident
After PR #100 was merged, both PostgreSQL 17 and 18 jobs on main (workflow 43235445753) failed the existing `signup.e2e.test.ts` assertion: the invited user's sign-up returned HTTP 429 rather than 200. It runs late in the full Vitest E2E suite against a shared PostgreSQL database, after many other synthetic sign-ups. With no trusted client address, all suites share the production `auth:unknown:/api/auth/sign-up/email` bucket; the production implementation intentionally caps that fallback at 300 requests per hour.

## Test-only correction
- Add `TRUST_PROXY: "true"` **only** to this test's synthetic environment, which runs entirely in-process and never serves traffic.
- Give its three signup requests a documented non-routable example client address (`198.51.100.203`) through the validated last-hop `x-forwarded-for` header. This creates one isolated, ordinary per-IP sign-up bucket of **10/hour**, not an unmetered or privileged path.
- Preserve the per-email rate limit, the normal sign-up path, the closed-registration 403 check, the pending-invitation requirement, and the invited user's 200 expectation. No production config, auth code or security limit is changed.
- The separate auth quota tests continue exercising unknown-client, per-email, IPv6 normalization, concurrent admission and 429 responses.

## Qualification
The local focused Vitest file can run where PostgreSQL is connected; Windows Docker Linux engine is not available. Exact-head GitHub PostgreSQL 17/18 and macOS runs, plus the post-merge main tests, are required before considering this CI isolation fix complete.
