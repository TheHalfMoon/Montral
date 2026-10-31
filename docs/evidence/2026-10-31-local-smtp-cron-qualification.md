# Montral — local real SMTP protocol and automatic incident alert drill

**Date:** 2026-10-31 (Asia/Riyadh). Source base: PRIVATE `TheHalfMoon/Montral` at `754c8d10cc16903b1bcba8599b2f6a68fb10817f`. **Mac only**, no deployments, customer data or paid tools.

## Why this is a new qualification

The previous `automatic-incidents.e2e.test.ts` verified the scheduler, PostgreSQL, incident lifecycle and a **mocked in-memory mail transport**. That did not exercise the actual Node production configuration for Nodemailer, real SMTP protocol negotiation and recipient handoff. Hosted SMTP and public deliverability were therefore still entirely unqualified.

`scripts/qualify-smtp.mjs` now starts a **real loopback TCP SMTP sink**, plus a separate build of the **production Node server** against disposable local PostgreSQL. Unlike a mocked `sendEmail`, the Node runtime uses its existing `SMTP_HOST`/`SMTP_PORT` config and the actual Nodemailer SMTP transport. All network listeners bind **127.0.0.1**. The SMTP sink rejects any `RCPT TO` other than **`@example.test`**, accepts a bounded DATA message, and stores mail only **in memory** for assertions. It is explicitly not an SMTP relay or production mail server.

## Verified path

1. Check that Node has started and its `smtp.verify()` handshake completes against the local sink.
2. Register a unique synthetic account via the existing auth API and create an email notification channel with recipient `synthetic-recipient@example.test`.
3. Invoke the real `POST /api/channels/:id/test` endpoint. Verify exactly one SMTP DATA message is accepted for that synthetic recipient, with the expected Montral test notification. Confirm the authenticated channel is persisted.
4. Create a synthetic heartbeat monitor with `failureThreshold=1` and `recoveryThreshold=1` attached to the same SMTP channel.
5. Advance only that monitor's local PostgreSQL next-check timestamp so it is due. Invoke the real `POST /internal/run-checks` Node cron route, which leases the monitor and dispatches to the actual in-process queue.
6. Confirm the scheduler opens one automatic outage and the **real SMTP sink receives the down alert**. No monitored external target is fetched: the missed heartbeat is a local deterministic timeout.
7. Send a valid heartbeat token to the running Node API, confirm the monitor recovers, and verify **the real SMTP sink receives the recovery alert**, with exactly one persisted resolved automatic incident.

**Result:** `SMTP_LOOPBACK_PASS`, including Node's SMTP verify and automatic down/recovery messages. This is a true SMTP wire-protocol and production-Node configuration integration test, **not** mocked email transport.

## Reproduction and guardrails

Requires an already built production Node bundle, installed `psql`, and a **disposable** PostgreSQL database on 127.0.0.1 named `montral_ci` (GitHub service DB) or matching `montral_test_*`. The test refuses another hostname/database name. Credentials and message contents never leave Mac loopback and are not written as evidence. The script also creates a **fresh child database** named `montral_test_smtp_<pid>`, runs the Node API and cron queue against it, and drops only that owned database on exit. This prevents older API-suite monitors from saturating the cron lease/queue and makes the test repeatable. It prefers a heartbeat whose deterministic scheduler slot is zero (no artificial delay). All Node and SMTP processes and sockets are closed in cleanup.

```sh
pnpm install --frozen-lockfile
pnpm --filter @montral/api build:node
DEPLOY_TARGET=node pnpm --filter @montral/web build
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temporary-port>/montral_test_<suffix>' \
  node scripts/qualify-smtp.mjs
```

The GitHub Actions workflow has a new local-SMTP qualification step after Node/web builds and the existing smoke. **This does not imply GitHub Actions succeeded**: the GitHub-hosted runner was not allocated in prior runs (0 steps), and the actual hosted run for this commit must complete before claiming CI qualification.

### Local test suite/build evidence

- **565/565 API tests** passed (76 files), **122/122 Web** (25 files, after Node-target build) and **20/20 Probe** (4 files): **707 passing tests**, with no skipped tests in the final suites.
- Monorepo TypeScript/Astro typechecks; Node API, Node web, optional Edge Probe production builds all passed.
- The *production* Node SMTP TCP integration passed first on a clean fixture. Re-running against the shared DB exposed a queue scheduling collision from hundreds of other test monitors; the isolated child database and slot selection fixed this. **Three subsequent isolated runs all passed**, and the count of orphan `montral_test_smtp_*` databases was **zero**.
- Node/PostgreSQL health/config/MCP/HTML smoke passed.
- Real Chromium smoke passed: registration, monitor management, manual incidents, webhook capture and disabled checkout.
- Local PostgreSQL backup+restore passed: **42 tables, 217 synthetic organizations and 5 transactional SQL functions**.
- All **638 files across 3 pinned donor snapshots** matched SHA-256 integrity checks.
- The local Mac runs Node v26.0.0, **below** the repo's declared v26.12.1 minimum; supported-Node hosted test evidence remains unavailable.

## Remaining release blockers

**Not tested:** a real email provider, SMTP authentication/STARTTLS/TLS using provider credentials, domain DNS SPF/DKIM/DMARC, external mailbox delivery, bounce/complaints, provider quotas, long-running cloud monitoring, regional Cloudflare probes, live merchant sandbox, legal/privacy review, public deployment and real customer alerts. The app stays PRIVATE and must not publish or charge.
