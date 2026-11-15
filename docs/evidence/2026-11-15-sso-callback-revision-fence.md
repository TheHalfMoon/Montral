# SSO callback versus owner configuration changes (2026-11-15)

**Status:** proposed, pending hosted exact-head checks and independent review. Not a claim of production exploitation. No deployments, provider requests, or production database changes.

## Race

The callback looks up an enabled workspace OIDC connection, exchanges the authorization code, creates a Better Auth session, and subsequently marks it as an SSO session. An owner can update or delete the connection while the callback is doing the slow IdP work.

Before this change, `invalidateConnection` deleted the matching sessions at one point in time. A callback that held an old in-memory connection could create and mark a session **after** that deletion. That session could be treated as a current SSO sign-in for this connection until another explicit revocation. This is a concurrency finding, not evidence that it happened in production.

## Fix

- The DB-backed workspace `SsoConnection` lookup captures the exact PostgreSQL `updated_at::text` revision, preserving microseconds without JavaScript `Date` truncation. Instance-wide `OIDC_*` remains env-driven.
- Each owner PUT advances `updated_at` monotonically by at least one microsecond, even when settings are saved twice within the same clock tick or the previous values are restored.
- The callback's SSO marker is inserted through a single SQL statement whose source connection row is selected `FOR SHARE`, constrained by ID, workspace, `enabled`, and the captured revision.
- If the owner updated/deleted first, the stale marker is refused. The newly created Better Auth session is deleted without setting its cookie, and the callback redirects with the existing generic `connection_disabled` code.
- If the marker commits first, the owner's UPDATE/DELETE must wait for the row lock. Existing owner revocation then sees the session marker and deletes it for an issuer/client change or connection removal.
- No schema changes and no extra cache. User-facing errors do not expose the connection's private settings or revocation reason.

## Regression and qualification

A real-PostgreSQL SSO E2E test:
1. Reads a connection snapshot.
2. Saves the same provider settings twice and verifies that every snapshot has a distinct revision.
3. Tries to attach the previously captured revisions to a real session. Both must refuse without inserting a marker.
4. Attaches the latest revision successfully, checks the stored connection ID, and removes the synthetic marker in a `finally` block.

A second real-PostgreSQL E2E regression deliberately pauses a real callback during a synthetic provider token response, saves the same workspace connection through its authenticated owner API, then confirms the old callback redirects with `connection_disabled`, receives no signed-in cookie, and leaves no additional session for that existing user. This covers the complete callback flow and the narrow serialization guard without external provider credentials. Exact-head PostgreSQL 17/18, API typecheck/build, macOS and other repository gates must be verified before merge.

## Scope and limits

- This does not protect sessions on old replicas until every replica has the fix.
- Already committed JIT user/account writes can remain when a late callback is refused. Such a callback receives no session cookie; identity/account cleanup is a separate review question.
- This does not establish whole-repository security clearance, general domain-withdrawal atomicity, or readiness for Montral Cloud/BYOC.
- Publication remains **HOLD** until the owner explicitly authorizes `GREEN LIGHT MONTRAL`.
