# Account session refresh identity and response-order guard (2026-11-16)

**Status:** engineering fix under PR qualification. Does not authorize release, deployment, paid services or live credentials.

## Finding

PR #161 added explicit failure handling around session revocation. The previous `Sessions.load()` still retained `current` when `listSessions()` resolved with a server-side error (including `SESSION_NOT_FRESH`), and on a rejected initial/reload request. Old rows could be left visible with previous identity until a refresh finished. Concurrent refreshes could also resolve out of order after one session was revoked and overwrite newer browser state. If the current session id is unknown, **no row should be offered for remote sign-out**, because that row could represent the device being used.

These are source-code failure/race paths; they do not establish that any deployed user has been affected.

## Repair

- `apps/web/src/components/Account.tsx`: clear both prior session identity and displayed rows whenever a refresh begins. Successful results repopulate from paired session-list/current-session responses. A server error, rejected promise, or malformed session date yields no session identity, no stale rows, and the existing localized failure (or recent-login notice for `SESSION_NOT_FRESH`).
- Introduce an incrementing latest-request fence that rejects late success and failure responses from older refreshes. Invalidate in-flight refreshes on component unmount to avoid applying stale updates.
- Reuse the guarded refresh from PR #161 after confirmed revoke-one/revoke-other actions; the existing `busy` cleanup and action success/error toasts remain.
- Add unit coverage of latest-response selection, stale-response rejection and unmount invalidation, plus a source-integration check of error-path identity clearing and actual handler wiring.

## Qualification

A dependency-free Node TypeScript-strip **smoke test of the pure fence** may be run locally on Windows, but the local installed Node 24.19.0 is below this repo's supported minimum 24.22.1 and cannot certify an Astro/React build. Full Vitest, Astro typecheck/build, Playwright signed-in account flow and **11/11 exact-head CI workflows / 16/16 constituent jobs** must pass before merge; newest-main push CI must subsequently pass. This correction does not change Better Auth session validation, revocation, cookies, API routes or grace periods.

Public/community publication stays HOLD until explicit `GREEN LIGHT MONTRAL`. Cloud/BYOC remain NO-GO pending independent security, provider, legal/privacy and infrastructure gates.
