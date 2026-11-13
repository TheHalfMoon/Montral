# First-tab late notice layout qualification (2026-11-13)

## Problem
The known-state tab-memory fix in #83/#84 paints a previously remembered email-verification or allowance banner with the page. On a browser tab's **first** sign-in or its first metered workspace, no state exists in sessionStorage. A slow `/api/me` or `/api/usage` response could insert a banner above buttons after their first paint, moving the pointer target. Revisited tabs were already protected, but first visits (ledger row 59) were not.

## Change
- The first time `VerifyBar` learns `emailVerified === false` from the API rather than tab storage, it marks the alert as late and paints it fixed in a bounded top-right notice. No address or account data is persisted beyond the existing boolean tab flag.
- `UsageBar` uses a fixed, dismissible lower-right notice if no previously remembered usage alert existed on the first paint, and on workspace scope changes. Already-known notices still render inline with the page. The rule does not read or expose metered counts or billing credentials.
- CSS uses a bounded viewport width and height, safe-area offsets and mobile insets. Existing accessibility semantics (`role=alert`/`role=status`), keyboard dismiss and localized text remain intact. Neither notice participates in document flow when shown late.
- Both banners are still absent when no notice applies. No new network request, database column, deployment or paid dependency.

## Regression coverage
- Five-project `e2e/tests/journey.spec.ts` newly clears the tab's verification flag, delays `/api/me`, verifies the first unverified banner is visible and fixed, checks accessibility and confirms a later reload paints it inline.
- Five-project `e2e/tests/cloud-usage.spec.ts` clears usage tab memory, delays synthetic near-limit usage, verifies the fixed notice and no movement of a monitor search input, checks a11y and reloads to verify normal inline mode.
- The tests use the existing disposable self-hosted server, a synthetic unverified user, and synthetic metered API responses. No production API, provider or real billing.

## Boundaries
A fixed banner can temporarily cover a portion of a small viewport. It remains dismissible and scroll-bounded; this is preferable to silently shifting the target of a pointer action. First-load report and dynamic workspace scopes must pass exact-head hosted browser/a11y and web typecheck CI before merge. Full hosted product and BYOC release remain NO-GO.

## Stale-session and workspace reply protection
- A separate issue surfaced during review: a slow `/api/usage` request from a former workspace could otherwise restore its near-limit alert and billing-role flag after `montral:scope`. `UsageBar` now uses the same generation-token pattern already used on the webhook inbox page: any scope change, later refresh or unmount invalidates older responses before their state and session-tab memory writes.
- `VerifyBar` now ignores an in-flight `/api/me` response after unmount, so leaving the authenticated app cannot re-store a stale unverified-email flag.
- The pure request-token regression asserts latest-wins, scope invalidation and unmount suppression; the existing browser journeys still verify the visible account/quota flows. No new sensitive persistence.
