# Montral production release gates — no public deployment without passing all

## Completed and locally verified
- [x] Three exact source snapshots and original license notices preserved (638 hashed files)
- [x] Montral active brand, source packages and unified auth/API/MCP runtime
- [x] Montral inboxes, one-time token, event inspector, manager-only sensitive body reads
- [x] Real PostgreSQL webhook sessions, tenant isolation, token refusal, upload cap and cascade deletion E2E
- [x] PostgreSQL concurrent limit **10/16** verified over five runs after replacing flawed CTE snapshot locking
- [x] Node/Worker scheduled 7-day event cleanup implemented; direct PostgreSQL idle prune tested
- [x] API **544**, web **122**, probe **20** tests and monorepo TypeScript/Astro typechecks passed locally
- [x] API + self-hosted Node web + optional Cloudflare Edge worker build locally
- [x] Node HTTP smoke passed with PostgreSQL: health, config, MCP discovery and HTML UI
- [x] GitHub Actions workflow configured with PostgreSQL service and smoke step (runner itself unqualified)

## Unresolved production blockers
- [ ] Green GitHub Actions on verified exact commit (current jobs fail before runner provisioning)
- [ ] Full browser E2E of account, monitoring, Webhooks UI and privileged events
- [x] Dedicated real PostgreSQL API key/OAuth read/write/MCP webhook grants tested, including cross-project refusals
- [ ] Real Cloudflare probe deployment, DNS/egress controls and cross-region checks
- [ ] Long-running scheduled pruning and orphan deletion behavior, crashes and retries
- [ ] Rate-limit/secret redaction/encryption/privacy/abuse review for captured webhook payloads
- [ ] Backup, restore, resilience, incident drill and sustained load tests
- [x] Test-mode-only Lemon Squeezy checkout and HMAC webhook simulator, one-time intent binding, idempotency and stale-event tests
- [x] Optional PostgreSQL atomic credit/email metering and plan caps under concurrent test requests
- [ ] Real Lemon Squeezy test-store checkout + authentic provider callbacks (no connected merchant yet)
- [ ] Production merchant onboarding, settlement validation, real billing, cancellation, refunds, chargebacks and proration
- [ ] Production usage quota/cost/load validation and period aligned with subscription renewal
- [ ] Domain, customer email deliverability, cost budgets and capacity plan
- [ ] Privacy, terms, accessibility and commercial/legal readiness review
- [ ] Explicit user decision to publish the SaaS. Until then, keep repo private and **do not deploy**

Latest local evidence: [Billing/scope qualification](evidence/2026-10-30-billing-scope-qualification.md) and [earlier baseline](evidence/2026-10-30-local-postgres-qualification.md).

Billing preview contract and detailed limits: [Billing sandbox](BILLING-SANDBOX.md).
