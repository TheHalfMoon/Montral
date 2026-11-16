# Closed-registration invitation link UX guard — 2026-11-16

**Scope:** web authentication presentation only. No API, database, invitation verification, OAuth, session or registration authorization change.

## Finding

The sign-in footer used `open || location.search` to decide whether to show **Create an account**. When an operator sets `DISABLE_SIGNUP=true`, *any* query string (including an unrelated `?foo=bar`, an `?sso_error`, or a normal `?next=/app`) could show a link to a signup flow that the server correctly refuses for uninvited addresses. The link also appeared briefly before `/api/auth-providers` returned the instance configuration because `open` initially defaulted to `true`.

Invited users remain eligible to register against a closed instance when their email has a pending invitation. `AcceptInvite` explicitly redirects them to `/login?next=/accept-invite/<id>` and `/signup?next=/accept-invite/<id>`. These are legitimate exceptions and must keep working.

## Change

- Represent unknown signup availability as `null` until the server responds, so public signup links do not flash before configuration loads.
- Introduce pure `invitationReturn(search)` and `offerSignupLink(signupOpen, search)` helpers to decide visibility. An invite route may be in the normal, zh-Hans, ja or es namespace; unrelated or malformed/unsafe queries no longer create a closed signup CTA.
- Keep the closed-registration message on the signup page only after the server explicitly reports signup closed.
- Maintain server-side pending-invitation checks unchanged; the client path check is a UI hint, **not** an authorization check.
- Add focused regressions for open, closed and not-yet-known configurations, legitimate invitation destinations and deceptive unrelated redirect parameters, plus the actual UI wiring.

## Qualification

Windows code and whitespace syntax: `node --check` on pure helper and unit file plus `git diff --check`. Native Node 24's TypeScript-strip ESM smoke executed **51 direct assertions** across allowed invitations, invalid links, closed/pending/open signup, and the existing safe `nextPath` behavior. Full Vitest, UI build, browser and exact-head 16-job hosted CI are required prior to merge; Windows local Node is still below the project's configured supported floor.

This does not launch Cloud or enable a merchant. Public Community publication remains **HOLD until explicit `GREEN LIGHT MONTRAL`**, and hosted Cloud/BYOC remain NO-GO pending independent security, legal/privacy/provider and production gates.
