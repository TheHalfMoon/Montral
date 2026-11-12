# SCIM writes during operator suspension (2026-11-12)

## Threat and decision
Workspace suspension blocks Montral API writes and new access, but the workspace-scoped SCIM bearer endpoint previously continued all provisioning and reactivation. A suspended workspace's IdP must still be able to **revoke** a person's access: blocking deactivation or DELETE would keep sessions and credentials alive until unsuspension. Therefore SCIM must differentiate privilege-granting changes from deprovisioning.

## Implementation
- Leave SCIM bearer validation, rate limits, `GET /ServiceProviderConfig`, schema discovery, `GET /Users` and `GET /Users/:id` unchanged.
- A suspended workspace returns a standard SCIM-formatted 403 to `POST /Users` (even an inactive new record) and `PUT /Users/:id` or `PATCH /Users/:id` unless the submitted change explicitly sets `active=false`. The refusal never returns the operator reason or private note. Do not allow a purely metadata update or an `active=true` reactivation during suspension.
- `PUT` and `PATCH` with `active=false` remain available to deactivate users and remove their workspace membership, sessions and pinned keys. `DELETE /Users/:id` remains available to deprovision and forget the SCIM record. No owner can be deprovisioned, as before.
- For POST/PUT/PATCH, lock the organization's row and then query suspension **inside the same PostgreSQL transaction as the SCIM mutation**. The operator's suspend action locks that same row before writing the suspension. This prevents an in-flight SCIM activation from overtaking a completed operator suspension and avoids inconsistent lock ordering for concurrent actions.
- No changes to Better Auth, SSO login, SCIM token issuance, pricing, provider calls, public deployment, or the underlying workspace suspension schema.

## Verification
- Added synthetic PostgreSQL/SSO E2E assertions for: SCIM bearer GET while suspended, blocked POST and PUT/PATCH reactivation/attribute-only updates, 401 before token scope for a bad token, allowed PATCH `active=false` with session and pinned key revocation, allowed PUT `active=false`, and allowed DELETE. A synthetic private operator note is checked absent from every refusal. Suspensions are removed in `finally` so test runs do not affect subsequent cases.
- Require local API TypeScript and Vitest harness; PostgreSQL-dependent cases must be executed by exact-head PostgreSQL 17/18 CI plus macOS and load qualification before any merge.
- Retained inability to test physical Safari/VoiceOver and separate policy decision on custom-domain rechecks; no claim to close the entire ledger row 60.
