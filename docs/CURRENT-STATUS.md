# Montral Engineering Status — 2026-10-30

## What is actually implemented

- Private repo `TheHalfMoon/Montral` with 3 immutable donor-source snapshots, 638 files and SHA-256 manifest.
- Active Montral TypeScript workspace copied/renamed from monitored core; generated brand assets replaced, inactive snapshots retain original copyright.
- Working core HTTP monitoring API and OAuth REST/MCP implementation taken from the MIT source; upstream logic is reused (not reconstructed).
- New Montral webhook inbox SQL migration attached to Edition; project isolation, one-time token receiver, safe HTTP header allowlist, 32KiB payload cap, 250 events maximum/inbox and 7-day age on ingestion; 4 MCP tools; dashboard UI.
- Optional signed HMAC Cloudflare HTTP probe with explicit host allowlist, status/keyword checks, no separate scheduler.
- CI workflow configured but does NOT deploy, purchase infrastructure, create a DB or accept customer payments.

## Engineering evidence at time of implementation

- API TypeScript typecheck passed; API unit suite 441 passed / 91 skipped (many skip without `TEST_DATABASE_URL`).
- Frontend typecheck passed; unit suite 121 passed / 1 skipped; Astro production build successful after fixing renamed competitor field.
- Probe TypeScript passed; 20 tests passed for Node/probe and Montral Cloudflare mode.
- Exact 638 source snapshot files verified.
- Full PostgreSQL integration E2E tests, browser E2E, production load tests, SMTP delivery, real Cloudflare probe, billing and external payments: **not performed**.
- No public deployment and no paid resources configured.

## Important follow-ups (NOT complete)

1. Test `montral_hooks` migration in a disposable PostgreSQL instance and actual multi-tenant requests with sessions, API keys and scoped MCP tokens. Existing request fixture tests are not sufficient.
2. Real security review including access control, webhook secret management, replay policy, rate-limit scope across Workers, incoming sensitive payload privacy, incident handling and backups.
3. Ensure webhook retention is enforced by scheduled deletion even after an inbox becomes inactive: current lazy deletion on new event is insufficient.
4. Scale-proof inbox creation and per-plan quota against concurrent requests; current count/insert is not transactional.
5. Implement a production billing Edition, verified provider webhooks, metering, downgrade/cancel/refund, and cost-aware plan guards.
6. Bind the Cloudflare edge probe under `PROBE_REGIONS` in an authorized test deployment; configure allowlist and secret out-of-band. Confirm no duplicate checks.
7. Publish no domain, app, deployment or payment links until explicit launch qualification.

## Zero persistent Mac files

All code must be committed and verified in PRIVATE GitHub; only temporary build paths may be used on Mac and must be removed after GitHub verification. Never use Windows for Montral.
