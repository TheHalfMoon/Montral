# Montral production release gates — no public deployment without passing all

## Completed and locally verified
- [x] Three exact source snapshots and original license notices preserved (638 hashed files)
- [x] Montral active brand, source packages and unified auth/API/MCP runtime
- [x] Montral inboxes, one-time token, event inspector, manager-only sensitive body reads; `private, no-store` and `nosniff` for all authenticated inbox routes
- [x] Real PostgreSQL webhook sessions, tenant isolation, token refusal, upload cap and cascade deletion E2E
- [x] PostgreSQL concurrent inbox limit **10/16** verified over five runs after replacing flawed CTE snapshot locking
- [x] Status-page subscriber email confirmation and unsubscribe token URLs (including redirects and one-click requests) set no-store, no-referrer, nosniff, noindex; real Node smoke and unit tests cover token privacy
- [x] Public bearer-token webhook receiver, owner-only views and all refusal paths (201/202/200/404/413/422/429) consistently set no-store, no-referrer, nosniff and noindex; unit and real PostgreSQL E2E tests pass
- [x] Atomic webhook event insertion and 7-day/250-event pruning under a per-inbox row lock; 275 concurrent PostgreSQL inserts, invalid token and receiver-deletion race passed
- [x] Node/Worker scheduled 7-day event cleanup implemented; direct PostgreSQL idle prune tested
- [x] Scheduler-failure-isolated maintenance for Node and Worker, including seven-day-old sandbox checkout intent cleanup and independent retry tests; 699 local tests passed
- [x] API **574**, web **122**, probe **20** tests and monorepo TypeScript/Astro typechecks passed locally
- [x] API + self-hosted Node web + optional Cloudflare Edge worker build locally
- [x] Node HTTP smoke passed with PostgreSQL: health, config, MCP discovery and HTML UI
- [x] No-provider email fallback cannot expose verification/password reset bearer tokens, message body, recipient or subject to logs; required alert/subscriber/report email now fails closed rather than falsely recording `sent` (dedicated real PostgreSQL 502/failed-ledger E2E, real Chromium log guard)
- [x] Production Node/Nodemailer actual SMTP protocol to loopback sink: verified account/channel, channel test mail, cron-driven auto-incident down alert, heartbeat recovery alert, exactly one persisted resolved incident; no external mail
- [x] Real PostgreSQL auto-incident and synthetic email alert lifecycle: heartbeat 2 missed checks → one down incident/email; no duplicate incident on repeat miss; 2 valid pings → one resolved incident/recovery email; alert ledger confirms both; **no external SMTP**
- [x] Real headless Chromium journey: signup, **monitor creation/detail/pause/resume**, **manual incident declare/acknowledge/internal update/resolve**, authenticated webhook create/ingest/event viewer, one-time receiver secret, disabled checkout and anonymous read denials
- [x] Disposable local PostgreSQL 17 backup+restore drill: 42 tables, 122 synthetic organizations and 5 transactional functions restored; source preserved
- [x] GitHub Actions workflow configured with PostgreSQL service and smoke step (runner itself unqualified)
- [x] Real Chromium signup/monitor/incident/webhook/disabled-checkout journey added to CI workflow using an isolated, automatically deleted `montral_test_browser_ci` database; host-runner execution remains unqualified

## Unresolved production blockers
- [x] Exact supported Node v24.22.1 + pnpm 10.0.0 Mac qualification: 716 local API/probe/web tests, Node/web/edge builds, Chromium, local SMTP, 638 source hashes and PostgreSQL backup/restore of 128 synthetic organizations; hosted CI still separately blocked
- [x] Scoped accessibility smoke: keyboard skip links, auth/dashboard main/navigation landmarks and live `aria-current` synchronization verified across monitor, incident and webhook navigation in Chromium (NOT a full WCAG audit)
- [ ] Green GitHub Actions on exact revision: account billing/spending-limit annotation on run 41206285444 prevents any hosted runner (zero executed steps); no paid changes authorized. Local tests are NOT equivalent to hosted CI.
- [x] Account recovery reset page no-referrer meta, hydrated URL cleanup, and missing-link fallback verified in real Chromium on synthetic input; actual SMTP recovery link remains externally unqualified
- [x] Real local Node SMTP delivers exactly one synthetic account recovery email; separate PostgreSQL tests verify reset token single-use, old/new password authentication, session invalidation, security notice uniqueness and unknown-account non-enumeration (no external SMTP qualification)
- [ ] Complete browser E2E matrix (account recovery, real-world external outage/notification and externally hosted SMTP deliverability, privileged/non-manager events, cross-browser and accessibility); Chromium manual incident lifecycle, monitor, webhook and billing-disabled smoke PASSED
- [x] Dedicated real PostgreSQL API key/OAuth read/write/MCP webhook grants tested, including cross-project refusals
- [x] Local workerd Edge Worker + real scheduler signed regional protocol E2E (5 tests) with mocked outbound fetch; strict host/port/header denial tested
- [ ] Rerun all supported Node/TypeScript/PostgreSQL/API/web/probe and synthetic Lark tests on latest remote SHA. Lark provider acknowledgement is now fail-closed for malformed/empty bodies and generic error messages (code plus regression tests committed, **not executed on final remote revision**, Mac remote usage limit reached). See [Lark evidence](evidence/2026-10-31-strict-lark-webhook-ack.md)\n- [ ] Real Cloudflare probe deployment, DNS/egress controls and cross-region checks (still unqualified)
- [ ] Hosted long-running scheduled pruning and orphan deletion behavior, crashes and retry reliability (local failure isolation and database tests PASS)
- [x] Node trusted-proxy client-IP hardening: ignores attacker-supplied CF-Connecting-IP, uses final validated X-Forwarded-For peer, focused spoofing tests pass
- [x] Parallel API test migrations protected with test-only Vitest global setup, verified on new PostgreSQL database; strict production environment-contract gate unchanged
- [ ] Hosted reverse-proxy configuration and rate-limit abuse testing (correct append-only X-Forwarded-For and backend network isolation still unverified)
- [x] PostgreSQL edition DDL migrations serialized per database via transactional advisory lock; 4 independent 1-connection pools on a fresh test DB and atomic rollback verified
- [ ] Hosted multi-replica migrations, Cloudflare Hyperdrive limits, managed PostgreSQL privilege and failover qualification (local 4-replica concurrency test PASS)
- [x] Webhook text ingress rejects malformed UTF-8 and raw NUL before SQL (HTTP 422) with real PostgreSQL E2E coverage
- [x] Missing-client-IP auth fallback rate buckets and per-email signup quota (3/hour), including forged forwarding-header regression
- [ ] Hosted unknown-IP shared-quota usability, CAPTCHA/bot defenses, credential-guessing load and reverse-proxy abuse testing
- [x] Local outbound provider error/log hardening: subscriber notification ledgers, alert retry failures, custom-header binding warnings and monthly-report email diagnostics do not echo arbitrary external exception text (synthetic credential-in-error regression); external reverse-proxy/provider logs still unqualified
- [ ] Hosted reverse-proxy/access-log bearer-token URL scrubbing, at-rest encryption/key rotation, data-export/privacy review and abuse-load evaluation for captured webhook payloads; HTTP privacy headers alone are not a substitute
- [x] Local 42-table PostgreSQL restore checks per-table SHA-256 normalized-content digests before/after dump and after restore; 128 synthetic organizations/projects/monitors/status pages/channels, equal-row-count tamper detection, and locally replayed CI restore step passed (NOT byte-exact WAL or hosted PITR)
- [x] Local disposable pg_dump/pg_restore of 42 tables, including six populated tables (128 synthetic organizations, projects, monitors, status pages and channels), validates every table count and source stability without modifying the source; NOT hosted PITR or full content fidelity
- [ ] Production database disaster recovery/PITR, resilience, incident drill and sustained load tests (local disposable pg_dump/restore PASSED)
- [x] Test-mode-only Lemon Squeezy checkout and HMAC webhook simulator, one-time intent binding, idempotency and stale-event tests
- [x] Merchant webhook HMAC and billing-event digest use byte-exact streamed request payload; only **after HMAC verification** is strict UTF-8 JSON decoded. Signed malformed UTF-8 rejects HTTP 400, altered bytes with old HMAC reject 401; real PostgreSQL red-to-green E2E
- [x] Equal provider-timestamp collision cannot reactivate paid entitlements after signed cancellation/expiry, including legacy same-provider `subscription_created` replay; shorter cancellation deadline and genuinely new provider after expiry permitted (real PostgreSQL red-to-green regression)
- [x] Single pending sandbox checkout per workspace via PostgreSQL advisory-locked reservation; eight simultaneous authenticated attempts produce exactly one checkout
- [x] Old duplicate intents cannot replace an active subscription from a different provider, with signed provider ID validation under the same lock
- [x] Cancellation paid-access deadline enforced directly from the signed provider `ends_at`, even without a subsequent expiry callback; absent/expired deadline immediately revokes preview paid access
- [x] Test-mode-only entitlement assertions, checkout-intent-before-provider race regression, and failed checkout cleanup checked on real PostgreSQL
- [x] Migration upgrade from earlier preview SQL function to eight-argument deadline-aware function tested on a disposable legacy-schema clone
- [x] Optional PostgreSQL atomic credit/email metering and plan caps under concurrent test requests
- [ ] Real Lemon Squeezy test-store checkout + authentic provider callbacks (no connected merchant yet)
- [ ] Production merchant onboarding, settlement validation, real billing, cancellation, refunds, chargebacks and proration
- [x] Optional monthly reports fail closed on unavailable/invalid email quota. Pre-send preparation/ledger failures now conditionally release matching PostgreSQL monthly claims for retry during reporting window, with 13 focused tests and real PostgreSQL verification. Ambiguous provider outcomes intentionally never requeue; a durable per-recipient outbox remains unqualified
- [x] Subscriber/critical-alert email quota refuses malformed granted counts (safe integer 0..requested only); nine synthetic focused cases passed on Mac. Emergency usage-ledger exceptions intentionally fail open for alert availability.\n- [ ] Repeat full Mac typecheck + PostgreSQL/API/probe/web suites and builds on latest remote commit (Mac control hit monthly usage cap; final pushed revision not rerun)\n- [ ] Production usage quota/cost/load validation and period aligned with subscription renewal
- [x] Local Email binding custom-header compatibility retries only explicitly rejected header schemas, not unrelated post-acceptance errors mentioning `header`; synthetic 1-vs-2 mail attempts and token-log regressions verified (real provider remains unqualified)
- [ ] Domain, **configured** customer email deliverability (without a provider, signup preview cannot deliver verification and alert ledger correctly reports failure), cost budgets and capacity plan
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

Real Chromium manual incident lifecycle: [2026-10-31 qualification](evidence/2026-10-31-browser-incident-lifecycle-qualification.md).

Local auto-incident and synthetic email alert lifecycle: [2026-10-31 qualification](evidence/2026-10-31-automatic-incident-alert-lifecycle.md).

Production Node SMTP over loopback and cron-driven automatic down/recovery delivery: [2026-10-31 qualification](evidence/2026-10-31-local-smtp-cron-qualification.md).

Unconfigured email token-privacy and delivery-accounting evidence: [2026-10-31 local qualification](evidence/2026-10-31-email-fallback-privacy-qualification.md).

Bearer webhook receiver HTTP privacy header qualification: [2026-10-31 local evidence](evidence/2026-10-31-webhook-secret-response-privacy-qualification.md).

Subscription confirmation/unsubscribe token response privacy and supported Node qualification: [2026-10-31 local evidence](evidence/2026-10-31-status-subscription-token-privacy-qualification.md).

Billing signed equal-timestamp replay/paid-access hardening: [2026-10-31 local qualification](evidence/2026-10-31-billing-equal-timestamp-ordering-qualification.md).

Byte-exact signed sandbox merchant webhook qualification: [2026-10-31 local evidence](evidence/2026-10-31-billing-raw-byte-hmac-qualification.md).
