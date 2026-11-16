# Web-first installation and native app claims (2026-11-16)

**Status:** Engineering change under review. No release, tag, DNS update, or deployment authorized.

## Verified mismatch

The owner has chosen **web-first/PWA** for Montral. The repository has an Astro/React app shell, PWA manifest and service worker, but does not contain a supported, shipped native iOS client (also recorded in `docs/REBRAND-TRACKER.md`). Before this change the public `/ios` page and its test helper contained a hard-coded TestFlight invitation, its changelog stated that a Montral native iOS beta was publicly available, and the website footer promoted the iOS app. The destination was **not independently verified as an owner-controlled Montral release**. The website also advertised a lack of on-call rotations even though the schedule and escalation implementation is merged.

This is an accuracy and external-link safety defect in an unreleased product, **not** evidence that a live customer was misdirected.

## Implemented scope

- Preserve the established `/ios` route so old bookmarks do not break, but change its visible content to a bilingual English/Chinese **web/PWA installation guide**. It points to the real `/app` route and explains Safari's Share → Add to Home Screen and other browsers' installation affordances without guaranteeing every browser supports PWA installation.
- Remove the obsolete hard-coded TestFlight URL and unused native-link helper and its test; no native app download remains in the source of the phone guide.
- Correct the footer label to **Install web app** (same path for compatibility).
- Remove unverified native beta/iOS page changelog entries, add a dated web-first/PWA entry, and describe existing APNs API support as **compatible separately built clients only**. Public copy does not claim an official native iOS release or a configured hosted APNs service.
- Revise the account phone-management text without changing the existing owner-scoped APNs device API or its regression tests. Existing registered-device metadata remains functional for compatible clients.
- Correct the outdated FAQ, shared capability-gap list, competitor-specific comparisons and segment limitations that said on-call rotations did not exist. Montral already has schedules, overrides and escalation policies; native SMS/voice calling remains unavailable without an external provider. Clarify that browser journeys include a restricted script step, not an arbitrary remote-code execution feature.

## Verification required

`apps/web/src/lib/web-first-copy.test.ts` checks that the route remains discoverable, the install directions are bilingual, public pages do not advertise native TestFlight/App Store downloads, the APNs/PWA distinction is retained, and the inaccurate on-call claim does not recur.

Require supported Node, frozen pnpm installation, all web typechecks/tests, Astro production builds, browser/a11y tests, and full exact-head CI. Real physical Safari/PWA installation and VoiceOver testing remain separately blocked external qualification. The local Windows Node v24.19 is below the repo's minimum 24.22.1 and must not be counted as a passing runtime qualification.

**Publication stays HOLD** until explicit owner `GREEN LIGHT MONTRAL`. Cloud/BYOC remain NO-GO pending their distinct external gates.
