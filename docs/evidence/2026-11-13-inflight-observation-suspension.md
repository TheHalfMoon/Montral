# In-flight check observation vs workspace suspension

Status: PROPOSED, pending exact-head hosted PostgreSQL tests and review. No release or deployment authorized.

## Race and invariant

A scheduled/manual probe may already be measuring a target when an operator suspends its workspace. Previous fences block new claims and starts but did not check `workspace_suspension` inside the observation/heartbeat database transaction. A late measurement could therefore create an observation after suspension committed.

`packages/db-pg/src/coverage.ts` now takes the current monitor's row lock, then holds `organization FOR KEY SHARE` in the same transaction while it checks the suspension table and persists the observation. The operator's suspension route locks that organization `FOR UPDATE` before adding the suspension row, and that lock conflicts with `FOR KEY SHARE`. If suspension commits first, a late observation or heartbeat sees the suspension and returns without writing. If the observation holds the lock first, the operator waits for it to commit before the suspension can commit. Concurrent checks remain compatible with one another because `FOR KEY SHARE` locks do not conflict.

The route also checks monitor paused/configuration/generation fences as before; no schema changes or customer data were added.

## Qualification

- A real-PostgreSQL coverage regression exercises a pre-suspension check snapshot, manual and scheduled results, a heartbeat, and resumption after unsuspension.
- A second regression holds the same organization `FOR UPDATE` lock as the operator transaction while a previously-started result attempts to finish, commits suspension and requires the result to be rejected.
- Windows local TypeScript typecheck PASS; `git diff --check` PASS. The targeted Vitest file was **skipped** without `DATABASE_URL` (17 skipped), so this is **not** a database test pass. Node on that machine is v24.19.0, below the repository's configured minimum for Node 24. Actual supported-runtime and migrated PostgreSQL qualification must come from hosted CI.

## Boundaries

This prevents persistence of late observations on upgraded instances. It does not retroactively cancel outbound network requests, restore spent credits, terminate an alert already claimed before suspension, prevent an older replica without this fence from writing during a rolling upgrade, or invalidate previously delivered external caches. The behavior is not a production deployment authorization; Cloud and Enterprise BYOC remain NO-GO for external release gates.
