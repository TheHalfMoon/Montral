# Operator workspace suspension history (2026-11-13)

## Problem
The operator control plane records every workspace suspension and lifting as a workspace-wide append-only audit event, but the platform console previously exposed only the **current** suspension. Operators could not inspect prior actions without joining customer audit data manually. The operator's private note and identity must not leak to workspace members.

## Implementation
- New `GET /api/operator/workspaces/:id/suspension-history?limit=20` (max 50, strict bounds), uses the existing `requireOperator` allowlist, session and recently satisfied MFA. Disabled without explicitly configured operator IDs.
- Selects only `audit_event` entries with matching workspace, target, system actor label and the exact `workspace.suspend`/`workspace.unsuspend` actions. Returns id, action, safe reason and UTC timestamp; no private note, raw event JSON, operator user ID, other customer activity or unrelated workspace data.
- The unlinked `/app/operator` console displays this retained history in the selected workspace. It refreshes after a successful suspension change and drops stale replies on workspace switch or unmount. No extra schema, API privileges, storage, browser cache or remote services.
- The original append-only event is written inside the existing suspension transaction. The history reader never changes a suspension or creates a second event.

## Qualification
- PostgreSQL E2E extends existing real MFA scenario with unauthorised-member and API-key denials, pagination limits, unknown workspace, ordering/actions, consistent safe reasons, no note/identity leakage and cross-workspace isolation.
- Browser synthetic journey covers the refreshed history after suspend/unsuspend and five-project a11y suite.
- Vitest checks the typed client request, encoded IDs, cookie-only credentials and `no-store` rule.
- The exact PR head needs full hosted CI (PostgreSQL 17/18, macOS, WebKit/Firefox/Chromium/mobile, integrity, load, failover, restore, Compose) before merge. Windows remote DC had exhausted monthly tool usage and is not used for this check.

## Limitations
This is **not** a unified platform activity log and cannot reconstruct the specific operator identity from historic customer-anonymised `audit_event` records. Existing audit retention limits history. Payment-suspension self-service and full platform-wide accountability are follow-up items. No deployment/release/payment activation is authorised.
