# Webhook inbox quota and billing-action permissions (2026-11-12)

## Problem
An exhausted webhook-events allowance is visible on the general Usage page, but not on the Webhook Inboxes page where users look for captured requests. The global usage bar and usage page also offered a Billing link to ordinary workspace members even though Billing API routes require owner/admin permissions.

## Change
- The metered `GET /api/usage` response exposes a **server-computed boolean** `canManageBilling` by consulting the same `isManager` role rule used by protected routes. Community/self-hosted still returns only `{ metered: false }`.
- The Webhook Inboxes page reads the existing prefetched `/usage` response and displays a direct warning when `webhookEvents.used >= limit` and the limit is positive, with its UTC reset date. It refreshes on existing usage/scope events and discards stale responses from a previous workspace. It has a view-usage link for everyone and an upgrade link for owner/admin only.
- The global usage bar, plan/usage page, exhausted-meter cards, and on-demand check quota-refusal notice hide Billing actions unless `canManageBilling === true`. The check quota notice gives ordinary members a localized reset-only explanation. Unknown permissions default to hidden and never reveal billing links from session-stored alerts.
- The browser journey fixture explicitly represents an owner for positive billing-link assertions and adds negative checks for a synthetic ordinary member (inbox page, Usage page and monitor check refusal). This repairs the pre-existing synthetic fixture mismatch responsible for PR #96's first Playwright failure.
- English and Simplified Chinese strings are included. No new fetch for the global bar; the inbox uses the existing `/usage` endpoint.

## Verification
- Unit tests for the pure inbox warning rule: self-hosted, missing quota, below threshold, zero allowance, manager/member links, and malicious external upgrade URLs.
- PostgreSQL integration asserts a synthetic owner receives `canManageBilling: true`, and an ordinary member added to that same workspace receives `canManageBilling: false` after switching active workspaces.
- TypeScript checks and focused web tests must pass locally; full role/auth + browser regression must pass exact-head GitHub Actions before merge.

## Boundaries
No prices, quota figures, live payments, billing provider, migrations, release or production deploy. A server-side onboarding checklist remains unimplemented and is explicitly outside this PR. Backend Billing endpoints already enforce owner/admin rights; UI changes improve accuracy but are not a security boundary.
