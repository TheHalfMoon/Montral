# Optional workspace-wide webhook inbox cap (2026-11-12)

## Problem
Montral currently has a hard limit of 10 webhook inboxes **per project**. A hosted operator can define monitor and status-page plan limits, but cannot bound the total number of stored inboxes across a workspace's projects. The existing outbound replay limits are rate limits only; replay usage is not persistently metered.

## Change
- Add optional `limits.webhookInboxes` (integer 0 to 2,000,000,000) to the operator plan catalog, with per-workspace overrides. `maxWebhookInboxes` is exposed through the existing `Entitlements.plan()` contract. No existing plan, pricing, or built-in Community limit is changed; absent/null at runtime means the original **10/project** behavior only.
- Add `montral_create_hook_inbox_v2`, a six-argument PostgreSQL function, that serializes a workspace lock then a project lock, checks 10/project and the optional workspace total, and inserts as one transaction. It returns a distinct reason for project vs workspace cap. Many simultaneous requests across different projects and replicas cannot overbook the workspace quota.
- Preserve the historical five-argument SQL function for rolling updates, changing only its lock ordering to take the same workspace lock first. **Do not enable the optional cap during a mixed-version rollout**: old app replicas do not know the new cap argument. Enable it only after all instances have updated.
- The manager-only HTTP endpoint returns HTTP 402 `webhook_inbox_limit` (with plan, limit and existing configured upgrade URL) for the new workspace cap, or the existing 409 for the 10/project cap. Successful creation still returns the secret URL only once; no secret is included in a rejection.
- Deleting an inbox frees a slot. Reducing a cap never deletes existing inboxes, captured events, or private response configurations.

## Qualification
- Plan-catalog unit tests: missing cap, positive cap, zero override, rejection of negative/fractional/null/text/out-of-range limits.
- PostgreSQL integration: 16 concurrent inserts across two projects under workspace cap 3 must yield exactly 3 successes and 13 `workspace_limit` responses; delete frees capacity; zero cap denies even a fresh project; old SQL function still works. Cleans up test rows.
- HTTP integration: 8 concurrent manager-created inboxes under cap 2 must yield exactly 2 creations and 6 structured HTTP 402 responses. Delete one, create one more, and verify next is refused.
- The existing HTTP regression still enforces 10 per project on uncapped Community.
- Must pass API and catalog TypeScript/unit tests on Windows; exact-head PostgreSQL 17/18, macOS ARM64, browser and load CI is the merge gate.

## Boundaries
This is a *storage-count plan cap*, **not** persistent monthly metering of webhook replay or a replacement for replay rate limiting. No prices, payment calls, new migrations/tables, commercial provider integrations, releases or deployments. Plan catalog commercial values remain private.
