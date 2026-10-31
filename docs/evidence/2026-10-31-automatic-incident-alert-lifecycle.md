# Montral — automatic incident and recovery alert lifecycle qualification

Date: **2026-10-31**. Repository: PRIVATE `TheHalfMoon/Montral`. Base commit: `98ca42a468a623739697182f66e048c46a31c1b7`. Authorized **Mac only**, isolated PostgreSQL, synthetic-only.

## Scope

The previous browser qualification proved manual incident declaration, acknowledgement, private updates and manual resolution in Chromium. Separate monitor tests covered failure and recovery counters, but no single real-PostgreSQL test had asserted that the automatic monitor incident and both email alerts completed together.

New `apps/api/src/automatic-incidents.e2e.test.ts` runs the actual `checkOne` heartbeat evaluation and the public heartbeat API route against disposable PostgreSQL 17, while substituting only the outbound email transport with an in-memory collector. It does not dial any monitored external website or send mail externally.

## End-to-end assertions

1. Create a synthetic workspace through the real auth API and a synthetic email channel. Clear account-verification mail from the in-memory collector before checking incident notifications.
2. Create a heartbeat monitor with **failureThreshold=2** and **recoveryThreshold=2**, attached to the synthetic channel.
3. Simulate the **first elapsed heartbeat deadline** through the actual scheduler's `checkOne`, ensuring it records one failed check but leaves **no incident and no alert**.
4. Simulate the **second elapsed deadline**: monitor transitions to `down`, exactly **one automatic incident** is stored as `investigating`, and exactly one failure alert is delivered to the in-memory recipient.
5. Another failure during the same outage does **not** create a duplicate incident or re-send the initial alert.
6. Send one authenticated-by-token heartbeat via the actual public route: the monitor stays `down` at one successful ping, with **no early recovery alert**.
7. Send a second heartbeat: the monitor becomes `up`, the incident transitions to `resolved` with `resolvedAt`, and exactly one recovery alert is delivered.
8. Inspect the real `alert_delivery` PostgreSQL ledger, confirming `incident.opened` and `incident.resolved` both have `status=sent`.

This qualifies the locally persisted automatic lifecycle, including notification generation and retry-safe incident identity, but **not** real SMTP deliverability, managed queues, external probes, Cloudflare regions or subscriber email delivery.

## Local environment and reproducibility

- Disposable PostgreSQL on Mac loopback `127.0.0.1:55452`, database `montral_test_20261031o`; the user's existing PostgreSQL on 5432 was not altered.
- Node v26.0.0 on Mac, below the repository's declared supported Node v26.12.1 minimum.
- Verify with `TEST_DATABASE_URL='postgres://<local>@127.0.0.1:<port>/montral_test_<suffix>' pnpm --filter @montral/api exec vitest run src/automatic-incidents.e2e.test.ts`.
- Initial focused run exposed **one test-fixture issue**: account creation also uses the same fake mail transport. The fixture now explicitly resets that collector after setup; the test then passed **1/1**.
- The **full API suite passed 565/565 tests across 76 files**, including the new automatic lifecycle test.
- Web passed **122/122 across 25 files** (after Node-target build); Probe passed **20/20 across 4 files**, for **707 passing tests total**, no skipped tests in final runs.
- Monorepo TypeScript/Astro checks, production Node API, Node web and optional Edge Probe bundles passed.
- Node+PostgreSQL smoke passed for health, configuration, MCP discovery and dashboard HTML.
- Real Chromium browser smoke passed (manual incident declare/ack/internal/resolve, heartbeat monitor create/pause/resume, webhook capture/inspection and disabled billing).
- Disposable PostgreSQL backup/restore succeeded with **42 tables, 110 synthetic organizations and 5 SQL functions**.
- Immutable donor source verification confirmed **638** files matching all three pinned snapshots.

## Release decision

**Local automatic incident lifecycle and synthetic email alert generation:** qualified.

**Production and commercial launch:** still NOT qualified. GitHub-hosted CI has failed without a runner or executed steps; real SMTP and payment sandbox credentials were not used; Cloudflare multi-region, monitoring under real outages, managed PostgreSQL DR, legal/privacy requirements, and public release are outstanding. Keep GitHub repository private, and do not publish or activate payments.
