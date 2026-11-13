# Operator console: probe drain audit history (2026-11-13)

## Gap
The existing `GET /api/operator/probes/:id/audit` endpoint returns up to 100 append-only region drain/undrain events, but the initial platform console had no view of the history. Operators had to invoke the API manually.

## Implementation
- The restricted, unlinked platform console exposes an **Audit history** action for configured and previously configured probe regions. It uses the existing API with `limit=50`; newest actions appear first.
- Displayed fields are timestamp, action, operator ID and the optional private note. They are shown only inside the operator console and never stored in session/local storage or a shared API cache.
- Switching regions or revoking the operator session invalidates stale audit responses, so an older request cannot repopulate previously hidden operator information.
- API calls continue to use the browser session, `cache: no-store` and server-side recent-MFA authorization. No new permissions, provider accounts or schema changes.

## Qualification
- New Vitest test covers the per-region audit endpoint, path encoding, cookie-only request and cache refusal.
- Synthetic five-browser Playwright journey reads an audit event, displays the operator and private note, then hides it.
- Full exact-head PR CI and review remain mandatory; this branch is stacked on operator-console PR #110 until that change is merged.

## Limits
This is **not** a unified platform audit covering all actions. It displays only the existing append-only probe drain/undrain events. Workspace suspension events remain in customer-scoped audit logs and server logs.
