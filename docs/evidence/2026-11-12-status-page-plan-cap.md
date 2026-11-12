# Optional status-page plan caps (2026-11-12)

## Problem
Status pages were unlimited for every hosted plan, even when the catalog was meant to express service limits. This also made an edition's feature gating inconsistent with monitor and region caps. A naive count-then-insert route would exceed a cap under parallel API requests or multiple replicas.

## Implementation
- Add optional `limits.statusPages` to validated operator plan catalogs and per-workspace overrides (integer 0–2,000,000,000). Absent means no cap: this preserves every existing operator catalog, built-in synthetic plan, and all unmetered Community deployments. No default quotas or pricing change.
- Expose `maxStatusPages` on the existing `Entitlements.plan()` value.
- Add `Repo.createStatusPageWithinLimit`: a PostgreSQL transaction acquires an advisory lock keyed by workspace before counting **all projects'** status pages and inserting. Multiple app replicas cannot overbook.
- The status-page creation route refuses exhausted capacity with structured HTTP 402 `status_page_limit`, including `limit`, `plan`, and the existing upgrade path if supplied. Existing pages remain accessible after a plan downgrade; deleting a page frees capacity. All counts include private, public and password pages.
- Only new creations are capped; editing existing pages, public access and customer history are unchanged. Existing `hideBranding` behavior is unchanged.

## Verification
- Catalog tests check omitted cap, positive cap, zero cap and per-workspace overrides, rejecting invalid/negative/fractional/null caps.
- Real PostgreSQL E2E issues eight parallel status-page creation requests under a cap of two: exactly two succeed, the rest receive 402. It deletes one page, creates one and confirms a further request is blocked.
- API, db-pg, repo TypeScript checks, focused catalog test suite and migration guard must pass locally.
- **Hosted PostgreSQL 17/18 exact-head CI, cross-browser and load gates must pass before merge.** Docker Linux is currently unavailable locally.

## Scope
- No schema changes or migration; no paid provider integration, no live billing/price changes, no deployment or release. Feature flags other than existing `hideBranding` remain outside this PR.
