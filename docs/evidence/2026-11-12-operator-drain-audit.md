# Platform probe-region drain audit (2026-11-12)

## Problem
The previous `POST /api/operator/probes/:id/undrain` cleared `drained_by` and `drained_at` without retaining who lifted a drain. Drain/undrain actions were visible only through process-local console logs, which are not durable or shared across replicas.

## Implementation
- Migration `0060_probe_region_operator_audit` introduces `probe_region_drain_event` with a monotonic event ID, region, `drain`/`undrain` action, operator user ID, optional note and UTC timestamp. It adds `last_undrained_by` and `last_undrained_at` to `probe_region_state`.
- `setProbeRegionDrain` now upserts the live state and appends the operator event **in one database transaction**. An audit insert failure aborts the state update. Direct internal seeding with `by: null` records no forged operator event.
- `POST /undrain` passes the authenticated operator ID, while the current `drained_by` remains null after a successful lift. Most recent lift metadata is preserved on the operator region view.
- `GET /api/operator/probes/:id/audit?limit=50` returns up to 100 events newest first and is protected by the pre-existing platform-operator gate: a listed operator must have a fresh browser session with a completed second factor. Non-operators, ordinary workspace members, API keys, bearer tokens and operators without completed MFA are refused.
- This is a **platform-level** history, not a customer workspace audit. No monitor target, probe secret, customer data, or billing content is stored in the event.

## Qualification
- The Drizzle generator created migration 0060 and the embedded migration list was regenerated; `node scripts/gen-migrations.mjs --check` PASS.
- Unit regression checks cover retained last-lift metadata in the operator view and authentication gating.
- PostgreSQL E2E was extended to verify a successful drain and undrain, history ordering, actor IDs, notes, and access denials; it also removes test events during teardown.
- **The new database-backed cases must pass exact-head GitHub Actions on PostgreSQL 17/18 before merge.** A passing local unit suite alone does not qualify the migration.

## Boundaries
No production release, paid integrations, changes to WSL/Docker data, or disclosure of platform operator IDs to workspace members. A unified audit stream for workspace-suspension actions is still separate work.
