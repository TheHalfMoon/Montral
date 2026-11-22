# Persistent operational counters for outbound webhook replay

**Status:** merged as PR #122 (`c54f5c6`) after exact-head and main qualification. The manager API now returns the machine-readable unit `admitted_attempts` so clients distinguish admitted replay requests from accepted outbound requests or confirmed remote delivery. This feature is **NOT** billing or a price/plan limit, and does not authorize launch. No production credentials, services or databases were changed.

## Design and limits

- Monthly UTC attempts are counted independently of the incoming `webhookEvents` meter. A replay request is counted after authentication, input validation, event lookup and rate limiting, but **before** outbound resolution/connection and response reading.
- The counter is an atomic PostgreSQL UPSERT in `montral_hook_replay_usage`, primary key `(organization_id, period_start)`; each concurrent admission increases its own workspace's monthly `attempts` exactly once. PostgreSQL supplies the clock; application replicas do not select their own period. Deleting a workspace cascades to its counters.
- No destination URLs, request/response bodies, full headers, inbox identifiers, event IDs, IP addresses or personal information are persisted in the new table. The table stores workspace identifier, UTC month and integer count only. It is one row/workspace/month.
- `GET /api/hooks/replay-usage` is restricted to a manager in the active workspace and returns `{attempts: "N", periodStart: "YYYY-MM-01", periodEnd: "YYYY-MM-01", unit: "admitted_attempts", billable: false}`. The string count avoids JavaScript precision loss. Standard webhook privacy headers prohibit caching, referrers and indexing. The inbox UI says this counts admitted requests, not confirmed deliveries.
- PostgreSQL outage or bad schema fails **before** any outbound replay with a fixed 503. No automatic retry is performed. The operation remains bounded by the existing per-user, per-inbox and per-workspace rate limits. A permitted attempt that later yields 502/504 or blocked DNS is still counted: the counter is **admitted requests**, not confirmed remote deliveries. Those results may be ambiguous, and no automatic refund or resend occurs.
- A repeated user request is a new replay attempt and may reach the destination more than once; the API continues to return `x-montral-replay` with the captured event ID as before. This counter does not promise transport-level exactly-once semantics. Introduce a separately designed idempotency key before claiming that guarantee.
- The existing `webhook_events` ledger is unchanged. There is no monthly outbound quota, chargeable amount, provider integration, monetary calculation or billing decision. Product/commercial owner must approve semantics and independent security/legal tests before any future metered launch.

## Qualification

- Added PostgreSQL E2E concurrent 32-admission test, separate workspace isolation, UTC period boundaries, and no-key leakage.
- Existing real HTTP replay E2E checks a manager's zero-to-one count, that a different workspace sees zero, and that a failed outbound connection still increments the admitted-attempt count; captured event count remains unchanged.
- The migration lives inside the edition migration's advisory lock and is additive. The table contains no unbounded payload rows, only monthly aggregates.
- The initial PR #122 local environment had API typecheck **PASS** and focused Vitest **34 PASSED, 8 SKIPPED** because `TEST_DATABASE_URL` / local PostgreSQL was unavailable. The follow-up's local PostgreSQL 18 replay E2E passed **17/17**, covering an outbound connection failure still counted as an admitted attempt; related API unit tests passed **53/53**, web i18n tests passed **13/13**, API typecheck passed and Astro reported **0 errors**. Exact-head hosted CI remains required for merge and integration.
