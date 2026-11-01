# Status-page subscriber email: current-manager authorization

**Date:** 2026-11-01 (Asia/Riyadh). **Scope:** private Montral source, synthetic users and subscriber addresses only; no external inboxes, deploy, paid services or customer data.

## Privacy failure reproduced on real PostgreSQL

`GET /api/status-pages/:id/subscribers` returned `[{ id, email, confirmedAt, createdAt }]` to any authenticated member of the page's workspace, even though the adjacent `DELETE /api/status-pages/:id/subscribers/:sid` already required current owner/admin status and the API hides channel credentials from ordinary members. A real authenticated **member** reading a synthetic confirmed subscriber email obtained **HTTP 200**. The new PostgreSQL `subscriber-privacy.e2e.test.ts` was **RED** before the fix: expected 403 but got 200 at the contact-list endpoint. This was a personal-data authorization exposure to lower-privilege workspace members, not an unauthenticated or cross-tenant read.

## Correction

Use the existing `requireManager` guard for the list endpoint, querying the **current database membership role** on every request (including OAuth/API-key access through the same existing authenticated path). Maintain the existing workspace/project-isolated `getStatusPage` check and subscriber DELETE authorization. Ordinary members still access the page's non-contact metadata and public status information; current owners/admins still see and remove their subscribers. The React editor now catches forbidden contact-list reads, discards any previously held contact addresses, and does not throw unhandled rejections; other network errors show a small error message rather than an infinite loading state. Subscriber contact-list responses (including manager denials) now use `private, no-store`, `no-referrer`, `nosniff` and `noindex` to avoid accidental HTTP caching or indexing; English/Chinese API docs and error translation updated.

## Regression evidence

The fixed **real PostgreSQL** test covers: an owner receiving the confirmed synthetic address, member contact reads denied 403 with no email in response, regular page reads still 200, member DELETE still 403, other-workspace owner 404, anonymous 401, live member→admin promotion then access 200, and live admin→member demotion then access 403 using the same existing session. Focused authorization test **GREEN 1/1**. A separate RED test reproduced a missing `cache-control` header on manager denial, followed by GREEN tests validating all four contact-list privacy headers on successful reads and no-store on refusals.

Mac full requalification on the role-guard/UI fix: Node 24.22.1, pnpm 10.0.0, and a fresh disposable PostgreSQL 17.9 database. **708/708 API**, **114/114 DB**, **20/20 Probe** and **124/124 Web** tests PASS (**966/966 total**). TypeScript/Astro checks and three Node API, edge probe and Node web production builds PASS. After the additional privacy-header middleware change, the focused PostgreSQL E2E regression PASS and TypeScript checks plus Node API rebuild PASS. **638/638 original pinned donor files** and the active-branding scan PASS. Hosted CI on the new commit is separately checked and is not inferred from these local tests. This does not replace external personal-data handling, at-rest encryption, log retention and privacy/legal reviews needed for release.
