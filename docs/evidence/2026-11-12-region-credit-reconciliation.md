# Region credit reconciliation for scheduled and manual checks (2026-11-12)

## Problem
The scheduler reserved one credit for every effective region allowed by a workspace plan. Drained or unavailable probes did not return a result, yet their reserved credits were left charged; a batch partially granted by the ledger could also retain a remainder too small to fund the next full monitor.

## Change
- For each workspace, store the **single original UTC charge instant** used to reserve its batch. Track each admitted monitor's **actual** reserved credits; a fail-open, self-hosted ledger outage never creates a fake reservation to refund.
- After a scheduled **or manual** non-browser monitor's region measurement completes, refund the difference between its known reservation and **completed region results**, capped at the reservation. A local scheduler check or confirmation is an actual result and counts once; drained/unavailable/no-verdict regions do not.
- A manual single-region spot check that returns `probe_unreachable` refunds its one reserved credit. The existing guard for an operator-drained region still refuses before reserving any credit.
- When a partial batch grant leaves credits that cannot pay for another full monitor, refund the unused remainder at that original charge instant.
- If region measurement throws before a result exists, do not guess at a refund, because network attempts might already have happened. Refund errors are logged through the existing refund helper without falsely reporting success.

## Qualification
- Windows isolated worktree based on main `47ac15d`, Node v24.19 with an engine warning (CI uses pinned eligible Node versions).
- TypeScript typechecks: `@montral/repo`, `@montral/db-pg`, `@montral/api`: PASS.
- Focused `regions-confirm.test.ts`, `resource-meters.test.ts`, `entitlements.test.ts`, `scheduler.test.ts`: **122/122 PASS**, including new tests for drained/unavailable probes, local fallback/confirmation, all remote results, partial grants, and fail-open without phantom refunds.
- `git diff --check`: PASS.
- `probe-regions.e2e.test.ts` adds database-backed assertions for manual multi-region checks (one result versus three), unreachable single-region spot checks, and all three results. This requires exact-head hosted PostgreSQL CI; the local Docker daemon is stopped.
- **Not yet qualified by GitHub**: full PostgreSQL 17/18, macOS, Docker, load and cross-browser checks at this new head. Run exact-head CI before merging.

## Scope boundaries
- No prices, allowance values, private commercial settings, live billing, payment-provider integrations, production deployment, or schema migrations.
- This fixes charged credit totals for scheduled and manual probes but does **not** add persistent per-region customer-facing usage counters or reconcile any historical overcharges. Those remain separate work.
- The community edition remains zero-cost with monitoring allowed during metering outages; metered deployments retain their existing fail-closed behavior.
