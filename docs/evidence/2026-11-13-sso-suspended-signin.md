# Workspace SSO sign-in during platform suspension (2026-11-13)

## Gap
The existing `requireOrg` middleware blocks suspended workspace API operations, and SCIM writes were serialized with operator suspension, but workspace-owned OIDC SSO could still initiate or finish a sign-in during suspension, including first-time JIT account/membership creation.

## Implementation
- For a workspace-scoped connection, `/api/auth/sso/start` returns the same generic 404 as an unconfigured connection while the workspace is suspended. This does not disclose operator notes or suspension reason.
- A callback started before suspension re-reads `workspace_suspension` immediately after consuming flow state, before IdP discovery, token exchange or user provisioning; it refuses with the existing generic `connection_disabled` browser redirect. The flow is single-use even on refusal.
- After IdP validation, a workspace JIT provisioning transaction takes `organization FOR SHARE` before inspecting suspension and the SCIM gate; operator suspend takes `organization FOR UPDATE` first. A JIT membership insert cannot outrun a committed suspension while waiting on the organization lock.
- Existing identities and link flows recheck suspension after the slow provider exchange, before creating a generic Better Auth session.
- Instance-wide SSO and unrelated tenant flows are unchanged.

## Regression qualification
- Added a real PostgreSQL/SyntheticIdp E2E covering a pre-started callback, refusal of new starts by email and workspace slug, no token exchange, no new user, no private note exposure, an unaffected other tenant and normal JIT provisioning after unsuspension.
- Must run exact-head typecheck and PostgreSQL 17/18/macOS CI; no external IdP, merchant, production data or real secrets are used.

## Boundary
A suspension committed **after** the final recheck but just before an existing user's generic session is created may still yield a session; that session cannot use the suspended workspace APIs or credentials. The JIT membership mutation itself is serialized with suspension on the PostgreSQL backend. No claim is made that this eliminates all login-session races or handles custom-domain re-verification policy. Full product release stays NO-GO.
