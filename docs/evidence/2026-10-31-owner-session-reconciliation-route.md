# Staged owner-session monthly reconciliation HTTP API — 2026-10-31

**Scope:** PRIVATE `TheHalfMoon/Montral`, authorized Mac, local-only synthetic tests. **Not deployed, published or enabled.** Existing monthly-report sender, scheduled checks and payment flags remain unchanged.

## Prior blocker

The durable reconciliation audit (migration `0042`) and `Repo.reconcileMonthlyReportRecipient` already enforced current workspace owner membership, provider-acceptance cooldown and a single non-replayable decision. But its `actorUserId` input came from the caller; the repository did not itself authenticate that actor. Exposing the repository method directly to an HTTP client would permit identity impersonation unless an identity-authenticated route existed.

## New staged HTTP boundary

New `apps/api/src/routes/monthly-reconciliation.ts`, registered under the existing `requireOrg` Hono router at `/api/monthly-reconciliation`, is **off by default**. Both the explicit `MONTRAL_RECONCILIATION_ENABLED=true` flag and the presence of the hosted metering `claimMonthlyOutboxAttempt` entitlement are required before the route responds. Merely building the app or enabling ordinary billing does not turn this flag on.

- `GET /api/monthly-reconciliation/summary?month=YYYY-MM` returns only scoped counts (`pending`, `unresolved`, `confirmed`), with `Cache-Control: no-store`. No address, provider reference, audit hash or stored message is exposed.
- `POST /api/monthly-reconciliation/review` accepts only JSON `{month, recipientUserId, decision, evidenceRef, acknowledgment}` with strict validation, where `acknowledgment` is exactly `I_verified_external_provider_evidence`. The response is only `{applied: boolean}`. The route does **not** independently verify a real provider ID; acceptance is an owner attestation.
- Routes require a Better Auth **interactive session** through the existing `requireOrg`, re-check the `requestPrincipal.kind === session`, reject all API keys and agent OAuth grant identities, and require a *currently owned* active workspace. The repository re-checks current owner membership while locking the audit transaction. No actor ID or workspace ID comes from the JSON body.
- POST requires the browser's `Origin` header to exactly match the configured `WEB_ORIGIN` (no Origin is rejected) and a JSON Content-Type, independently of CORS. It has persistent per-owner/per-workspace rate limits of 12 requests/hour via the existing PostgreSQL limiter. Strict schemas reject forged actor identity fields, malformed periods, invalid evidence tokens and claims lacking explicit acknowledgment.
- No route invokes SMTP, requeues a recipient, refunds/debits metering, or transitions a recipient to `prepared`. A reviewer may only record one owner-attested accepted/unresolved outcome after the database's 30-minute in-flight safety window. Repeated requests remain idempotently rejected by the unique audit row.

## Actual local checks

Four newly added real Hono+Better Auth/PostgreSQL E2E tests verify: feature disabled/default and metering-disabled states; anonymous/bearer credential refusal; current-owner vs member access and refusal of cross-origin, invalid JSON, unacknowledged or forged-user requests; authenticated accepted review and repeat refusal; tenant isolation and recent-attempt safety gate; missing Origin denial and 12/hour persistent rate limit. These tests use only synthetic addresses and no external mail provider.

## Explicit remaining risks

This gated HTTP API is **not** an operator dashboard and is **not** a production rollout. The browser/UI control for displaying redacted evidence, independent provider verification, controlled approval policy, auditable privileged actions, secure retention and ownership changes, real external SMTP timeouts and managed PostgreSQL PITR are still to be qualified. Users must never be instructed to enable this experimental flag or deploy this route in production based on local tests alone. Hosted GitHub Actions currently cannot allocate runners due to the owner's account payment/spend cap.

## Qualification

Full test and system-drill counts are added only after completing local qualification; a pass in synthetic Hono tests does not establish a live SMTP guarantee or exactly-once email delivery.

## Verified Mac qualification

- Supported **Node v24.22.1 / pnpm 10.0.0 / PostgreSQL 17.9** on an authorized Mac; complete **938/938 local tests PASS**: 685 API (including four owner-session HTTP tests), 111 PostgreSQL, 20 Edge Probe and 122 Web.
- Monorepo TypeScript PASS; production Node API, Node Web SSR and Edge Probe builds PASS; Node/PostgreSQL config/health/MCP/dashboard smoke PASS.
- Real local headless Chromium synthetic signup, monitors/incidents, webhooks, disabled merchant billing and reset-link privacy `BROWSER_E2E_PASS`. Synthetic SMTP loopback `SMTP_LOOPBACK_PASS`, no external provider involved.
- `pg_dump` → `pg_restore` local `RESTORE_DRILL_PASS`: **45 tables (36 populated), 116 synthetic organizations**, seven critical SQL functions, identical row counts and normalized SHA-256 fingerprints across each table. Not cloud PITR/failover evidence.
- All **43 embedded Drizzle migrations** synchronized; all **638 pinned donor source files** verified. The new HTTP route needs no schema migration.
- Initial full API suite found that the experimental feature flag was missing from Docker's environment mapping. Added explicit `${MONTRAL_RECONCILIATION_ENABLED:-false}` to `docker-compose.yml`, and documented the disabled flag in both environment examples. The environment guard tests and then the entire clean-database suite passed.

Hosted CI and external-provider qualification remain unverified; these results authorize no production rollout.
