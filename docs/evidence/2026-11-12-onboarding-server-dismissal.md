# Per-user server-backed onboarding dismissal (2026-11-12)

## Problem
The compact onboarding checklist was hidden using only browser localStorage keyed by workspace. It could reappear on a different device, and two distinct users of the same browser/workspace shared one dismissal flag. Progress itself already comes from real monitor, alert-channel and status-page counts.

## Change
- Migration `0061_onboarding_dismissal` adds a minimal table keyed by (`organization_id`, `user_id`) with `dismissed_at`; both foreign keys cascade when the user or workspace is deleted. The operation is idempotent.
- `GET /api/onboarding/dismissal` returns `{ dismissed: boolean }` and `POST /api/onboarding/dismissal` records a dismissal for the **active authenticated user and workspace**, protected by the existing workspace-membership and SSO requirements. API keys and OAuth agents are refused; both responses are no-store.
- The Monitors page reads this preference before deciding whether to display the compact checklist (avoids an arrival-time layout shift) and hides it only after the server commits a successful POST. On failure it leaves the checklist visible and reports an actionable error.
- It discards stale async responses when the workspace scope switches. The mandatory empty-state checklist with zero monitors continues to show regardless of dismissal; the checklist steps remain computed from live server counts, not stored flags.
- Account export includes the user's own onboarding dismissal rows. Deleting a user or workspace also removes its entries.
- Legacy browser localStorage dismissals are **not migrated automatically**: they were scoped by workspace, not by user, and could belong to someone else on a shared browser. Existing users may need to dismiss the compact checklist once after upgrading. The old helper is deprecated; the current dashboard does not read it.

## Qualification
- `@montral/repo`, `@montral/db-pg`, `@montral/api`, `@montral/web` TypeScript checks and focused onboarding unit tests: local Windows.
- Drizzle-generated 0061 SQL and snapshot; `node scripts/gen-migrations.mjs --check` must pass (62 embedded migrations).
- PostgreSQL integration test checks idempotent dismissal, persistence after sign-in, distinct user membership, second workspace isolation, no anonymous read, response cache policy and actual table row count.
- **All hosted PostgreSQL 17/18, macOS, browser, load and migration/upgrade CI must pass at the exact head before merge.** Local Docker Linux daemon remains offline.

## Boundaries
No paid service, provider or plan changes, no production deployment, and no local Docker/WSL data changes. This is user preference storage only, not an onboarding workflow or paid-edition feature.
