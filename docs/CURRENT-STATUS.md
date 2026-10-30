# Montral Engineering Status — 2026-10-30

## Completed in this private engineering wave

- Three immutable donor snapshots remain intact, with 638 source files verified by hash.
- Unified Montral monitoring, PostgreSQL API and OAuth REST/MCP with no separate scheduler.
- Montral-managed webhook inboxes, inbox creation/read/delete and sensitive payload viewer restricted to workspace managers. All private webhook responses set `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. Secret receiver URL shown once; only hash persisted.
- Authorized, per-project webhook capture with 32 KiB bounded body and safe header allowlist; lazy per-inbox cap and scheduled expiry.
- **Real PostgreSQL correction**: PL/pgSQL transactional advisory lock + fresh count statement enforces concurrent 10-inbox limit. Verified 16 parallel creates in five repeated runs; earlier CTE design incorrectly allowed 12.
- Housekeeping on Node and Cloudflare scheduler ticks: remove expired webhook events after 7 days, and inboxes orphaned by deleted projects/workspaces. Direct real Postgres pruning tests passed.
- Montral-branded active web/API/PWA/cache/service-worker metadata and private-only documentation (no fake published images, skills or MCP Registry claims); original source copyright and license retained in immutable `vendor/` snapshots.
- CI workflow wired to disposable PostgreSQL 17 service, all suites and self-hosted Node smoke, not deployment.
- Real Chrome Headless browser smoke: registration, authenticated webhooks, synthetic event inspector, ephemeral receiver-secret handling, disabled billing, and anonymous denials passed.
- Real isolated PostgreSQL `pg_dump -Fc` → `pg_restore` drill to newly created scratch database passed; all 42 tables, 2 synthetic orgs and 3 Montral DB functions survived restoration.
- Actual isolated PostgreSQL 17.9 run: **544 API tests**, **122 web tests**, **20 probe tests** passed after the private billing/metering and OAuth scope wave; one prior transient web test skip was re-run and passed. Typechecks, Node/SSR/Cloudflare bundles and Node+PostgreSQL live smoke passed.
- Current local qualification: [Browser and backup/restore](evidence/2026-10-30-browser-backup-qualification.md) and [Auth, billing and metering](evidence/2026-10-30-billing-scope-qualification.md). Previous wave: [Monitoring and webhook baseline](evidence/2026-10-30-local-postgres-qualification.md).

## Real blockers (do not claim complete)

1. GitHub Actions jobs failed *before runner assignment* (no steps executed); CI cannot be called green. Check account/organization runner availability and billing limits without enabling paid services.
2. A real Chromium signup → webhook create → receive → event inspector → disabled billing smoke and disposable PostgreSQL backup/restore drill **passed** on Mac. Full browser matrix, accessibility/cross-browser testing, actual Cloudflare Worker probe deployment/region verification and hosted disaster recovery remain unfinished.
3. A **private test-mode-only** provider checkout and signed subscription callback, persisted subscription status, single-use intent binding and disabled-by-default plan quotas/atomic metering have been added. These are NOT real payment-provider qualification: no connected merchant, no test-store transaction, no production billing, proration, chargebacks, refunds or production credit-period alignment.
4. Hosted operational hardening: backup/restore, incident drills, load tests, data privacy, deliverability, webhooks/PWA security, legal/regulatory requirements.
5. Project-scoped API keys, OAuth read-only and write grants, and actual MCP webhook tools have passed real PostgreSQL cross-project authorization checks in the extended OAuth integration test. Additional browser and cloud tenancy tests remain.

## Operating rules

Only user-authorized Mac and GitHub. No Windows. Private repository only. No public release, paid infrastructure, customer data or production payment handling. Maintain historical licenses and provenance. Keep all deliverables in GitHub, remove temporary local clones and disposable databases when remote commit is verified.
