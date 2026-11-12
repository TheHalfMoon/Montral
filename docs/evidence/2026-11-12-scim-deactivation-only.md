# SCIM suspended deactivation is access-revocation only (2026-11-12)

## Risk
The SCIM suspension policy merged in #104 allows a `PUT` or `PATCH` user update with `active=false` so an external identity provider can quickly revoke access during a platform suspension. However, the same request could also carry a changed `externalId`, display name, or given/family name. The original full `PUT` implementation also clears omitted optional attributes, causing identity metadata loss on a seemingly harmless deactivation. A reactivated SCIM identity could then have unexpected metadata changes made while the workspace was suspended.

## Protection
- Add a single `suspendedDeactivation(row, fields)` helper called from both `PUT` and `PATCH` **inside their existing suspension-synchronized PostgreSQL transaction**, with the SCIM user row locked.
- Require `active=false` and reject changed identity/profile fields with a fixed SCIM 403. When optional attributes echo already-stored values, allow them, but reduce the mutation to `{ active: false }` only.
- Omitted optional attributes on suspended `PUT` remain unchanged rather than being cleared. Normal, unsuspended SCIM `PUT` replacement and `PATCH` behavior is unchanged.
- Deactivation still revokes membership, sessions and workspace-pinned keys, and SCIM `DELETE` still works. Operator notes and suspension reasons are not disclosed.
- A changed userName remains prohibited by the existing immutable-name guard.

## Qualification
- Extend the existing full PostgreSQL and synthetic OIDC SCIM E2E: reject `PUT` with `active=false` plus changed externalId, reject `PATCH` mixing `active=false` with changed displayName, preserve the original record after 403, permit unchanged `externalId` echo alongside `active=false`, and verify that an inactive-only `PUT` preserves displayName/externalId.
- Require API TypeScript, local unit/harness checks and all exact-head hosted PostgreSQL 17/18, macOS, browser, load, restore and failover CI before merge.
- No schema change, provider integration, billing change, production deployment or public release. Requires the existing suspension gate from #104 (already on main).
