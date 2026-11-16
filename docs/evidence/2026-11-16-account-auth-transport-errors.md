# Account security action transport failures (2026-11-16)

**Status:** Engineering patch under exact-commit CI qualification, no deployment/release authorized.

## Failure mode

The web account settings had security-sensitive Better Auth mutations that assumed each client request would **resolve** to an `{ error }` response:

- `Sessions.end` and `Sessions.endOthers` called `revokeSession` / `revokeOtherSessions` without catching a rejected request. A failed network call could leave an unhandled promise rejection and no useful sign-out error, despite the button clearing `busy`.
- `PasswordChange.submit` made the password change and *then*, optionally, a second request to revoke other sessions. If the second request rejected after the password update succeeded, the handler ended with no success/error toast and an unhandled rejection. Retrying the password change in that state would incorrectly ask the user to use the now-old password. The password fields remained filled even though the actual password had changed.
- A failed session refresh after a successful revoke could similarly reject from the click callback, or leave a stale list as though it were current.

These are identified source-level failure paths, **not** proof of a live user incident.

## Patch

- Add `apps/web/src/lib/account-auth-actions.ts`: `attemptAuthAction` maps transport rejections to an explicit null failure without exposing raw exception details. `changePasswordWithCleanup` returns a discriminated status for password failure, successful update without cleanup, successful update plus revoked sessions, or successful update with cleanup failure.
- Use the helper in account session revoke-one and revoke-other handlers, preserving existing translated server errors and ensuring a failed attempt never reports success. If the post-write reload rejects, clear the list/current-session identity and show the existing localized load error; a successful write remains a successful write.
- Use the password-change outcome in the form handler. A successful password update clears the fields and reports success even when the *separate* session-revoke step fails, while warning the user that other sessions were not signed out. A rejected password request retains the fields and shows the generic localized failure instead of throwing.
- Pure Vitest tests simulate rejected transports, API validation errors, successful changes, successful session revokes, and both API-error and rejected-network cleanup failures. No live credentials, sessions or outgoing service calls.

## Qualification

Require supported Node runtime, frozen install, `pnpm --filter @montral/web test`, typecheck, Astro build, signed-in browser/account journeys and all 11 GitHub Actions workflows / 16 constituent jobs on the **exact final PR head** before merge. Follow with 11 exact-`main` push workflows before claiming combined qualification.

The local Windows host is Node 24.19 (below the repository minimum 24.22.1) and has very low free drive space; no local dependency install or local runtime qualification is claimed. `git diff --check` and code-level review should be completed before PR.

The project stays **Web-first/PWA**. Community publication/tag/deployment HOLD until `GREEN LIGHT MONTRAL`. Cloud/BYOC NO-GO pending independent legal/security/provider/infrastructure gates.
