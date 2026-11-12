# Customer-facing probe-region eligibility indicators (2026-11-12)

## Problem
A monitor's per-region history shows the last result and uptime, but a probe drained by a platform operator or a region skipped after a plan downgrade was still displayed as if a current check were expected. Users could mistakenly interpret stale green/red history as the present probe state.

## Implementation
- Authenticated `GET /api/regions` now attaches `drained: boolean` to each configured region. It uses the existing short-lived global drain cache and returns **only the boolean**, never the operator name/id, note, probe URL, credentials or internal errors. `auto` is always false.
- On the monitor details page, the Regions card labels configured regions **Drained** when paused by an operator, or **Plan limit** when beyond the active workspace's `maxPerMonitor` allowance. A capped region takes priority over a drain label because no check is scheduled there under the current plan.
- The status dot becomes neutral for regions not currently expected to run, so old success/failure records are not presented as a current live status. Historical 24-hour figures remain visible.
- The client refreshes the public region operational flags and the cap alongside its existing 10-second monitor refresh. Cache TTL can make the indicator lag by up to the next polling cycle after a drain/undrain.
- English and Simplified Chinese label/tooltip strings.

## Verification
- Pure front-end unit tests cover active, drained, plan-capped and historical state; no false drained status for `auto`; deduplicated configured regions; prioritization on downgrade.
- PostgreSQL `regions.e2e.test.ts` seeds a drained region with a private note, checks the authenticated response gives only the drained flag, and resets it in teardown.
- API/Web TypeScript checks and unit tests must pass locally; exact-head PostgreSQL 17/18, macOS and browser qualification must pass before merge.

## Out of scope
This does **not** expose a definitive confirmation-of-outage label, because the confirmation note is not currently a reliable client-visible per-region event. Nor does it register probes, distribute credentials, or introduce a secret rotation window. These portions of task ledger row 65 remain open.

No pricing changes, payments, live provider integration, migration, deployment, or production release.
