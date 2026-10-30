# Montral — concurrent webhook retention and deletion-race qualification

Date: **2026-10-30**. Private GitHub repository: `TheHalfMoon/Montral`.
Source at the start of this wave: `d9f8ee61b6ac080747089b7d4f468fdc419a60c6`.

## Failure mode and correction

Previously the webhook endpoint issued an event `INSERT` and then, in a **separate transaction**, pruned expired events and events beyond the 250 newest per inbox. Simultaneous arrivals could interleave inserts and deletions, potentially temporarily or persistently exceeding the 250-event retention cap. A separate lookup of the inbox followed by an insert could also race with deleting the inbox, causing a foreign-key error/HTTP 500 rather than a safe 404.

The new `montral_capture_hook_event` PL/pgSQL function performs these actions **in one database transaction**:

1. Locks the exact inbox row using `SELECT ... FOR UPDATE` and rechecks the receiver token hash.
2. Rejects missing/deleted inboxes or bad token hashes without writing any event.
3. Inserts the bounded, sanitized event body and allowed headers.
4. Deletes items more than seven days old and events beyond the newest **250** for that inbox, ordered by `created_at DESC, id DESC`.
5. Returns a boolean receipt confirmation only after the transaction completes.

This per-inbox row lock avoids blocking unrelated tenants or inboxes. It protects against simultaneous writers and concurrent inbox deletion. The existing per-IP 120/min abuse-rate control and 32 KiB payload cap remain in place; no secrets or sensitive captured bodies were saved as test evidence.

## Verified real PostgreSQL cases

- Unit and PostgreSQL E2E focused suites: **10 tests passing**.
- **275 concurrent synthetic SQL event submissions** to a single test inbox all succeed, and exactly **250 events remain** afterward.
- Incorrect receiver fingerprint is refused and does not create any event.
- Sending after the inbox is deleted is refused.
- Concurrent application-level delivery versus inbox deletion produces a safe 202 or 404, never a database foreign-key failure. The deleted inbox retains no events due to cascade.
- Previous test paths still validate authorization, tenant separation, 7-day idle expiry, 32 KiB bound, token hashing and a concurrent creation cap of 10 inboxes/project.

## Final local regression qualification

- API: **553/553 tests PASS** (73 files).
- Web: **122/122 tests PASS** (25 files, after the built web bundle).
- Probe: **20/20 tests PASS** (4 files). **695 tests total**.
- Monorepo TypeScript/Astro checks: **PASS** with zero Astro warnings/errors.
- Production Node API, Node-target web and Edge Probe bundles: **PASS**.
- Real Chromium signup, authenticated webhook create/ingest/inspect, secret disappearance, disabled billing, and Node+PostgreSQL smoke: **PASS**.
- The extended restore drill recovered all **42 tables**, **109 synthetic organizations**, and **4** transactional SQL functions, including `montral_capture_hook_event`.
- All **638** immutable donor source files retain their pinned hashes.

## Reproducible commands

```sh
pnpm install --frozen-lockfile
# Synthetic, disposable local PostgreSQL only:
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temporary-port>/montral_test_<suffix>' \
pnpm --filter @montral/api exec vitest run src/montral-hooks.test.ts src/montral-hooks.e2e.test.ts
```

The source donor snapshots are unchanged. No deploys or customer data were involved.

## Limits and unclosed commercial gates

This is **local** PostgreSQL correctness evidence, not a real-world throughput/latency SLA. The provider-side rate limiter itself is separate from the database cap and needs managed-infrastructure evaluation. Production data protection still requires encryption/key management evaluation, payload redaction policies, webhook abuse testing, backup/PITR, and authenticated audit/incident workflows.

GitHub-hosted CI remains blocked before runner provisioning, and the Mac's Node v26.0.0 remains outside the repository's declared supported Node version range. Cloudflare regional reliability, vendor sandbox commerce and legal readiness remain unverified. Do not publish or charge customers.
