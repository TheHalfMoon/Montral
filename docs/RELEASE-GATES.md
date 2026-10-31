# Montral production release gates — no public deployment without passing all

## Completed and locally verified
- [x] Three exact source snapshots and original license notices preserved (638 hashed files)
- [x] Montral active brand, source packages and unified auth/API/MCP runtime
- [x] Montral inboxes, one-time token, event inspector, manager-only sensitive body reads; `private, no-store` and `nosniff` for all authenticated inbox routes
- [x] Real PostgreSQL webhook sessions, tenant isolation, token refusal, upload cap and cascade deletion E2E
- [x] PostgreSQL concurrent inbox limit **10/16** verified over five runs after replacing flawed CTE snapshot locking
- [x] Atomic webhook event insertion and 7-day/250-event pruning under a per-inbox row lock; 275 concurrent PostgreSQL inserts, invalid token and receiver-deletion race passed
- [x] Node/Worker scheduled 7-day event cleanup implemented; direct PostgreSQL idle prune tested
- [x] Scheduler-failure-isolated maintenance for Node and Worker, including seven-day-old sandbox checkout intent cleanup and independent retry tests; 699 local tests passed
- [x] API **564**, web **122**, probe **20** tests and monorepo TypeScript/Astro typechecks passed locally
- [x] API + self-hosted Node web + optional Cloudflare Edge worker build locally
- [x] Node HTTP smoke passed with PostgreSQL: health, config, MCP discovery and HTML UI
- [x] Real headless Chromium journey: signup, **monitor creation/detail/pause/resume**, incident screen, authenticated webhook create/ingest/event viewer, one-time receiver secret, disabled checkout and anonymous read denials
- [x] Disposable local PostgreSQL 17 backup+restore drill: 42 tables, 122 synthetic organizations and 5 transactional functions restored; source preserved
- [x] GitHub Actions workflow configured with PostgreSQL service and smoke step (runner itself unqualified)

## Unresolved production blockers
- [ ] Green GitHub Actions on verified exact commit (current jobs fail before runner provisioning), including tests on a declared-supported Node version
- [ ] Complete browser E2E matrix (account recovery, real failure-to-incident/alert lifecycle, privileged/non-manager events, cross-browser and accessibility); Chromium monitor create/pause/resume plus webhook/billing smoke PASSED
- [x] Dedicated real PostgreSQL API key/OAuth read/write/MCP webhook grants tested, including cross-project refusals
- [x] Local workerd Edge Worker + real scheduler signed regional protocol E2E (5 tests) with mocked outbound fetch; strict host/port/header denial tested
- [ ] Real Cloudflare probe deployment, DNS/egress controls and cross-region checks (still unqualified)
- [ ] Hosted long-running scheduled pruning and orphan deletion behavior, crashes and retry reliability (local failure isolation and database tests PASS)
- [x] Node trusted-proxy client-IP hardening: ignores attacker-supplied CF-Connecting-IP, uses final validated X-Forwarded-For peer, focused spoofing tests pass
- [x] Parallel API test migrations protected with test-only Vitest global setup, verified on new PostgreSQL database; strict production environment-contract gate unchanged
- [ ] Hosted reverse-proxy configuration and rate-limit abuse testing (correct append-only X-Forwarded-For and backend network isolation still unverified)
- [x] PostgreSQL edition DDL migrations serialized per database via transactional advisory lock; 4 independent 1-connection pools on a fresh test DB and atomic rollback verified
- [ ] Hosted multi-replica migrations, Cloudflare Hyperdrive limits, managed PostgreSQL privilege and failover qualification (local 4-replica concurrency test PASS)
- [x] Webhook text ingress rejects malformed UTF-8 and raw NUL before SQL (HTTP 422) with real PostgreSQL E2E coverage
- [x] Missing-client-IP auth fallback rate buckets and per-email signup quota (3/hour), including forged forwarding-header regression
- [ ] Hosted unknown-IP shared-quota usability, CAPTCHA/bot defenses, credential-guessing load and reverse-proxy abuse testing
- [ ] Rate-limit/secret redaction/encryption/privacy/abuse review for captured webhook payloads
- [ ] Production database disaster recovery/PITR, resilience, incident drill and sustained load tests (local disposable pg_dump/restore PASSED)
- [x] Test-mode-only Lemon Squeezy checkout and HMAC webhook simulator, one-time intent binding, idempotency and stale-event tests
- [x] Single pending sandbox checkout per workspace via PostgreSQL advisory-locked reservation; eight simultaneous authenticated attempts produce exactly one checkout
- [x] Old duplicate intents cannot replace an active subscription from a different provider, with signed provider ID validation under the same lock
- [x] Cancellation paid-access deadline enforced directly from the signed provider `ends_at`, even without a subsequent expiry callback; absent/expired deadline immediately revokes preview paid access
- [x] Test-mode-only entitlement assertions, checkout-intent-before-provider race regression, and failed checkout cleanup checked on real PostgreSQL
- [x] Migration upgrade from earlier preview SQL function to eight-argument deadline-aware function tested on a disposable legacy-schema clone
- [x] Optional PostgreSQL atomic credit/email metering and plan caps under concurrent test requests
- [ ] Real Lemon Squeezy test-store checkout + authentic provider callbacks (no connected merchant yet)
- [ ] Production merchant onboarding, settlement validation, real billing, cancellation, refunds, chargebacks and proration
- [ ] Production usage quota/cost/load validation and period aligned with subscription renewal
- [ ] Domain, customer email deliverability, cost budgets and capacity plan
- [ ] Privacy, terms, accessibility and commercial/legal readiness review
- [ ] Explicit user decision to publish the SaaS. Until then, keep repo private and **do not deploy**

Latest local evidence: [Billing/scope qualification](evidence/2026-10-30-billing-scope-qualification.md) and [earlier baseline](evidence/2026-10-30-local-postgres-qualification.md).

Billing preview contract and detailed limits: [Billing sandbox](BILLING-SANDBOX.md).

Local browser + restore details: [qualification report](evidence/2026-10-30-browser-backup-qualification.md).

Local Cloudflare-runtime evidence: [Edge workerd qualification](evidence/2026-10-30-edge-workerd-qualification.md).

Billing lifecycle and backward-compatibility evidence: [2026-10-30 qualification](evidence/2026-10-30-billing-lifecycle-qualification.md).

Webhook burst and deletion-race details: [2026-10-30 atomic capture report](evidence/2026-10-30-atomic-webhook-capture-qualification.md).

Scheduler failure isolation and sandbox nonce cleanup: [2026-10-30 maintenance evidence](evidence/2026-10-30-maintenance-isolation-qualification.md).

Atomic checkout reservation/legacy intent compatibility: [2026-10-30 checkout qualification](evidence/2026-10-30-checkout-race-qualification.md).

Trusted reverse-proxy IP attribution: [2026-10-30 local qualification](evidence/2026-10-30-trusted-proxy-ip-qualification.md).

Local multi-replica migration/rollback evidence: [2026-10-30 qualification](evidence/2026-10-30-multireplica-migrations-qualification.md).

Text webhook input and no-IP auth rate-limit evidence: [2026-10-30 qualification](evidence/2026-10-30-webhook-auth-input-qualification.md).

Expanded real Chromium monitor journey: [2026-10-31 qualification](evidence/2026-10-31-browser-monitor-qualification.md).
