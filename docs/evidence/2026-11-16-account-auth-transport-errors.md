# Account security action transport failures (2026-11-16)

**Status:** Engineering patch pending exact-commit CI qualification. No deployment or release is authorized.

## Failure mode

The web account settings contained security-sensitive Better Auth calls that assumed every request **resolved** to an `{error}` response.

- Session revocation, two-step verification, account deletion, GitHub account linking/unlinking, and sign-in reauthentication could reject on transport/network errors, leaving unhandled click-handler promises or spinners without a user-facing failure.
- `PasswordChange.submit` changes the password and **then** optionally revokes other sessions. If that separate revocation request failed after a successful password update, the page did not confirm the completed password change. The user might then retry using the now-old password.
- A rejected password-change request is **ambiguous**, not evidence the write failed: the server may have committed it before the response was lost. Similarly, losing the response to session revocation cannot prove whether it was committed. Never mark these events as certainly successful or failed without a server response.
- A session list reload that rejected after successful revocation could show stale rows or generate an unhandled rejection.

These are verified source-code failure paths, **not** evidence of a live user incident.

## Patch

- `apps/web/src/lib/account-auth-actions.ts`: `attemptAuthAction` catches transport rejections into a sentinel value without exposing raw exception contents. `changePasswordWithCleanup` distinguishes a server refusal, unconfirmed initial password change, confirmed password change, successful revocation, known revocation failure, and unconfirmed revocation.
- `Account.tsx`: session sign-out buttons report errors and show success only on a confirmed result. Refresh failures clear stale session rows and current-session identity, while retaining the confirmed action's success toast.
- Password form: ambiguous password updates show the new localized EN/ZH message to **verify the new sign-in before retrying**; confirmed password changes clear fields and report partial success correctly, even if the other-session revocation fails or is unconfirmed. Existing server-side invalid-password, short-password and rate-limit messages remain.
- Apply the same transport guard to two-step verification enable/confirm/disable, account deletion, GitHub link/unlink, and GitHub reauthentication. A transport rejection while checking a TOTP must not be misreported as an invalid code. QR-code generation errors also show the existing generic error instead of leaving a stuck spinner; no TOTP URI or backup code is logged.
- `apps/web/src/lib/account-auth-actions.test.ts`: deterministic Vitest tests for rejected transport, server refusal, success, both cleanup-failure types, and a source-integration check for the actual handlers. No live credentials, sessions or external provider calls.

## Qualification

Require supported Node, frozen pnpm installation, `pnpm --filter @montral/web test`, Astro typecheck/build, signed-in browser account journeys and all **11 GitHub Actions workflows / 16 constituent jobs on the exact final PR head** before merge. After any merge, require 11 successful push workflows for the latest `main` before claiming combined engineering qualification.

The authorized Windows host has Node 24.19 (below the repository minimum 24.22.1) and limited free drive space; no local dependency install or local runtime PASS is claimed. `git diff --check` passed. The initial PR head's CI was superseded by a later improvement; always examine latest-head CI.

Montral stays **Web-first/PWA**. Community publication/tag/deployment HOLD until explicit `GREEN LIGHT MONTRAL`. Cloud/BYOC NO-GO pending independent security, legal, live-provider, and infrastructure gates.
