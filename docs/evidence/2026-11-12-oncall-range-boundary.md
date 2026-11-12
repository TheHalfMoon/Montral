# On-call overrides: clock drift beyond the 90-day API limit (2026-11-12)

## Observation
During PR #106's initial cross-browser suite, WebKit completed most of the signed-in journey but issued an unexpected HTTP 400 for `GET /api/oncall/schedules/:id/overrides` while on `/app/oncall`. The API's `shiftRange` strictly rejects ranges longer than exactly `90 * 86_400_000` milliseconds. The overrides React component constructed `from` from `new Date()` and `to` from a **second** `Date.now() + 90 * DAY` call, so the range almost always exceeded the limit by a few milliseconds. This was a real customer-facing intermittent error, not a security denial, and was only visible in some browser timing patterns.

## Fix
Use `oncallOverrideRange()` to call `Date.now()` once, then derive both ISO timestamps from that captured millisecond value. The result is exactly 90 days in milliseconds, including month changes, leap days and midnight boundaries. No API threshold changes, no relaxation of validation and no extra requests. Other on-call endpoints and shorter shift queries are unchanged.

## Qualification
- Vitest tests verify four deterministic clock inputs and exact `to - from === 90 * DAY`, and a negative-control clock returning two different values to ensure the implementation reads it once.
- Real WebKit/Chromium/Firefox cross-browser journeys must pass the exact PR head; the journey already fails on unexpected 400 responses.
- No schema migration, plan/billing change, external provider connection, deployment or release.
