# Montral Engineering Status — 2026-10-30

## Completed in this private engineering wave

- Three immutable donor snapshots remain intact, with 638 source files verified by hash.
- Unified Montral monitoring, PostgreSQL API and OAuth REST/MCP with no separate scheduler.
- Montral-managed webhook inboxes, inbox creation/read/delete and sensitive payload viewer restricted to workspace managers. Secret receiver URL shown once; only hash persisted.
- Authorized, per-project webhook capture with 32 KiB bounded body and safe header allowlist; lazy per-inbox cap and scheduled expiry.
- **Real PostgreSQL correction**: PL/pgSQL transactional advisory lock + fresh count statement enforces concurrent 10-inbox limit. Verified 16 parallel creates in five repeated runs; earlier CTE design incorrectly allowed 12.
- Housekeeping on Node and Cloudflare scheduler ticks: remove expired webhook events after 7 days, and inboxes orphaned by deleted projects/workspaces. Direct real Postgres pruning tests passed.
- Fully Montral-branded active web/API/PWA/cache/service-worker metadata; original source copyright and license retained in immutable `vendor/` snapshots.
- CI workflow wired to disposable PostgreSQL 17 service, all suites and self-hosted Node smoke, not deployment.
- Actual isolated PostgreSQL 17.9 run: **535 API tests**, **122 web tests**, **20 probe tests** passed, 0 skipped in these totals. Typechecks, Node/SSR/Cloudflare bundles and Node+PostgreSQL live smoke passed.
- Exact test commands and claims: [Qualification report](evidence/2026-10-30-local-postgres-qualification.md).

## Real blockers (do not claim complete)

1. GitHub Actions jobs failed *before runner assignment* (no steps executed); CI cannot be called green. Check account/organization runner availability and billing limits without enabling paid services.
2. Browser E2E and actual Cloudflare Worker probe deployment/region verification still not performed.
3. Payment provider, free/pro plans, metering and subscription state transitions have NOT been built; no real charges, credentials or deployments attempted.
4. Hosted operational hardening: backup/restore, incident drills, load tests, data privacy, deliverability, webhooks/PWA security, legal/regulatory requirements.
5. Request manager roles, project-scoped API keys and OAuth grants must be subjected to dedicated webhook-route E2E. General core OAuth tests exist, but these exact webhook routes still need this qualification.

## Operating rules

Only user-authorized Mac and GitHub. No Windows. Private repository only. No public release, paid infrastructure, customer data or production payment handling. Maintain historical licenses and provenance. Keep all deliverables in GitHub, remove temporary local clones and disposable databases when remote commit is verified.
