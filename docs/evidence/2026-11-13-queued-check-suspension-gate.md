# Previously leased checks and operator suspension (2026-11-13)

## Risk
`claimDue` excludes currently suspended workspaces, but Cloudflare Queue can deliver a previously leased check up to 40 seconds later, after an operator suspends the workspace. Previously, `monitorsByIds` loaded any unpaused monitor regardless of suspension and `beginRuns` could start its generation. This could run a scheduled network check and charge credits for a suspended workspace.

## Fix
- The queue consumer's `monitorsByIds` repository lookup excludes suspended workspaces. This also protects old messages lacking a lease token when suspension has committed before fetch.
- The generation/token `beginRuns` database update also rejects suspended workspaces, closing the gap where suspension commits between monitor loading and the start decision.
- Both guards use the existing `workspace_suspension` table and require no schema changes, new external connections, or paid services.
- An unstarted leased generation remains eligible after the operator lifts the suspension; future scheduled claims continue to exclude suspended workspaces.

## Regression coverage
- Real PostgreSQL repository test: lease first, suspend, assert the worker read returns no monitor, modern and legacy run starts are refused without advancing lastRunGeneration, unsuspend and assert the same generation can begin.
- Queue-consumer unit test: assert zero spend for a filtered monitor, and zero spend when the database rejects the start after the original read.
- Qualify exact PR head with hosted PostgreSQL 17/18, browser, load, macOS, failover and restore CI before merge.

## Scope and known limitations
This closes the **already-suspended before fetch or beginRuns** gap. It is not a cancellation mechanism for a probe already started before suspension, and the fetch and start checks are not fully serialized with operator suspension. A suspension that commits after the final successful start guard can still overlap an in-flight check; legacy tokenless messages that were loaded before suspension do not invoke `beginRuns`. Do not claim a hard no-egress-after-suspension guarantee without separate coordinated cancellation and operator-lock design.

No live providers, pricing, billing configuration, deployments or release changes.
