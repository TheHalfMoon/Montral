# Staged monthly SMTP review UI + redacted queue — 2026-10-31

**Scope:** PRIVATE `TheHalfMoon/Montral`, authorized macOS host, synthetic data only. **NOT deployed, released, scheduled or publicly linked.** No real mail, live customers, paid services, checkout or merchant activity.

## Why this exists

The previous owner-authenticated, flag-gated reconciliation API allowed a one-time, non-replayable manual audit of SMTP attempts, but provided only aggregate counts. Operators could not safely identify eligible ambiguous attempts without inspecting the raw database, and there was no controlled UI for documenting provider evidence. This change adds a **redacted pending list** and a hidden staged client-side review page while keeping the existing independent server feature flag and permissions.

## New owner-only API capability

`Repo.pendingMonthlyReportReconciliations(orgId, reportMonth, actorUserId)` performs a live owner-role check with a row lock in PostgreSQL and returns **at most 50** eligible unreviewed `attempted`/`uncertain` rows for the specific workspace and month. Only rows older than the current **30-minute** in-flight threshold qualify. Only `recipientUserId` (opaque internal identifier), `state` and `attemptedAt` leave the database. Recipient email addresses, raw provider evidence, SHA-256 audit references and message bodies never appear in the query result. Already reviewed or in-flight rows are omitted. Month input is validated and sorting is deterministic.

`GET /api/monthly-reconciliation/pending?month=YYYY-MM` uses the same **default-disabled** `MONTRAL_RECONCILIATION_ENABLED=true` flag, metering gate, Better Auth interactive-session-only identity, current workspace owner check, and `Cache-Control: no-store` as the pre-existing summary/review routes. API keys, OAuth agents and cross-tenant access do not qualify. A newly added Hono/PostgreSQL E2E case verifies redaction, tenant isolation, cooldown, feature gating and disappearance after a completed review.

## Staged operator interface

`/app/mail-review` routes to a new React `MailReview` component, **deliberately omitted from sidebar and standard navigation**. The Astro shell itself contains no privileged data. The page reads the default prior UTC month, fetches only owner-authorized summary + pending data, displays redacted queue items, allows one candidate selection and provides a required explicit acknowledgment for `provider_accepted` or `unresolved` review. The operator enters an opaque provider reference or incident ticket (not an address, credential or message body), which the backend validates and stores only as SHA-256. It clears the raw reference field after every attempt, never stores it in browser storage or URLs, and shows only a boolean outcome; it does not log the reference.

The client refuses malformed months, evidence tokens, missing selection or missing acknowledgment; **the server repeats all checks**. Changing the month clears the candidate selection and evidence input. Read failures do not reveal privileged data. A disabled feature or non-owner shows a neutral "Review tool unavailable" state. Even directly navigating to the URL in the default-off production-like Node app reveals no delivery data or active review controls. The UI never invokes SMTP, schedules work, requeues a recipient, or refunds an email quota. A provider timeout is not proof of acceptance; an owner-attested "accepted" is a documented assertion, not independent SMTP-provider verification.

The UI is staged-only. It has **no enabled navigation entry, no production release approval, and no provider trust integration**. Web route/helper tests verify UTC rollover, fail-closed form constraints and deep-link routing. The expanded offline real-Chromium smoke drill confirms that a signed-in synthetic workspace owner visiting the hidden route sees only the disabled state and the API remains HTTP 404. No screenshots or recipient records leave the Mac.

## Outstanding release gates

The pending list reveals internal user identifiers to **authenticated owners**, not to anonymous clients, and is capped at 50. A future deployment needs a reviewed policy for identifying the recipient behind an opaque ID, real third-party provider acceptance evidence, operator escalation and approval workflows, privacy/retention decisions, production error budgets, signed/immutable activity audit as appropriate, multiworker real process-kill/SMTP acceptance scenarios and full hosted CI/recovery. The current month's report dispatch still uses the legacy sender; the staged outbox dispatcher remains unconnected to the production scheduler. **NO-GO remains.**

## Final verification

Results of full TypeScript/tests/build, real local Chromium E2E, synthetic SMTP loopback, PostgreSQL backup/restore and 638 donor hashes are appended after those gates finish. Hosted GitHub Actions currently fail at runner allocation because of account billing/spending limit and cannot be represented as passing.

## Final verified Mac qualification

- **941/941 passing**: 686 API, 111 real PostgreSQL, 20 Edge Probe, 124 Web. This includes the new redacted pending-route tenant/cooldown test, UTC month and evidence-form guards, and deep-link routing tests.
- Supported **Node v24.22.1 / pnpm 10.0.0 / local PostgreSQL 17.9** on the authorized Mac. Full monorepo TypeScript PASS; Node API, Web SSR and Edge Probe production builds PASS; Node/PostgreSQL config/health/MCP/dashboard smoke PASS.
- Local-only SMTP `SMTP_LOOPBACK_PASS` for synthetic verification, alert down/recovery and account recovery. No external SMTP provider, real customer address or paid merchant.
- Real headless Chromium `BROWSER_E2E_PASS` (synthetic signup/heartbeat monitor/incident/webhook/disabled billing/reset-link privacy). Expanded real-browser coverage verifies that the **unlisted** `/app/mail-review` deep link renders a neutral feature-disabled state and that the authenticated browser's own `GET /api/monthly-reconciliation/pending` request receives HTTP **404** with the feature flag OFF. It does not attempt a live provider review.
- Local PostgreSQL `pg_dump` / `pg_restore` `RESTORE_DRILL_PASS`: **45 tables (36 nonempty), 118 synthetic organizations**, all per-table row counts and normalized SHA-256 content fingerprints match, including seven required Montral edition SQL functions. Managed PITR, region failover and external-provider deliveries remain unqualified.
- All **43 embedded migrations** in sync; all **638 pinned donor-source file hashes** unchanged. The staged UI/read route requires no new schema migration.
- The first added Chromium gate incorrectly tried to read an HttpOnly session cookie from `document.cookie`; this is correctly forbidden by the browser. The test was corrected to evaluate the API call in the real authenticated browser. A second test-only quoting error was corrected, and the full combined 941-test + real-browser + 118-organization restore run passed. Neither issue required changing production authentication.

**Status:** NOT READY for release. The new page remains inaccessible without the explicit server-side review flag and ownership. No production deployment, live mail, provider verification, production scheduler activation or paid actions occurred.
