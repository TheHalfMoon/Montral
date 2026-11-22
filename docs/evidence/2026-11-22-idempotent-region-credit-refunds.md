# Idempotent region credit refunds (2026-11-22)

## Finding

PR #93 refunds credits for planned regions that produce no result, at the original UTC charge month. The monthly `montral_usage` row is an aggregate. Before this change a repeated settlement call could subtract the same refund twice; the aggregate clamp at zero did not make the operation idempotent.

## Change

- Add `montral_credit_refund`, keyed by workspace, UTC month, and settlement id, storing the settled amount.
- Apply the usage decrement and refund record insert in one PostgreSQL function transaction. Advisory locks serialize a replay key and coordinate the balance update with ordinary credit spends.
- Replaying the same key and amount is a no-op. Reusing a key with another amount fails without changing usage.
- Scheduled and manual region-check settlements use this operation when the metered entitlement supports it. Existing non-metered Community entitlements remain unchanged; there are no new charges or plan limits.

## Qualification

- `montral-billing.e2e.test.ts`: 26/26 passed against disposable PostgreSQL 18.7, including eight concurrent replays of one refund key and rejection of mismatched key reuse.
- API TypeScript check: no errors. Runtime was Node 24.19.0, below the repository's declared 24.22.1 minimum; CI qualification is still required.
- `git diff --check`: passed.
- Exact-head CI and exact-main workflows remain required before merge.

## Historical limit

The pre-#93 ledger retained only monthly aggregate credits, not per-region attempts or outcomes. There is no reliable way to identify whether a prior charge was for a drained region, an unreachable probe, a local fallback, or a completed remote result. No retrospective adjustment is calculated or issued.
