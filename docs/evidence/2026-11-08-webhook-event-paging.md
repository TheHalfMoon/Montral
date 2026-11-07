# Webhook inbox events beyond the newest 50 were unreachable

## Failure mode
Each inbox atomically retains up to 250 events for seven days, but
`GET /hooks/inboxes/:id/events` returned only the newest 50 with no paging.
Events 51-250 were stored, counted against retention, and impossible to
inspect through the API or the UI. There was also no way to filter or search
captured requests. The inbox screen applied event responses without checking
which inbox they belonged to, so a slow response for a previously selected
inbox could replace the events of the current one.

## Change
- The events route now pages by keyset `(created_at, id)` with an opaque
  `next` cursor (the last event id). A cursor whose event was evicted returns
  `410` instead of silently restarting or skipping rows.
- Optional `method` (POST/PUT/PATCH) and `q` filters. `q` is a bound
  parameter; `%`, `_` and `\` are escaped so they match literally.
- The query schema is strict: unknown parameters and malformed cursors are
  `400`. Tenant scope is unchanged: the inbox ownership check runs before
  any cursor lookup, and the cursor must belong to the same inbox.
- The UI adds a method filter, search, and "Load older events", and drops
  responses superseded by a newer inbox or filter selection.
- The API reference documents the webhook endpoints, limits and stored
  header allowlist.

## Evidence and limits
A new PostgreSQL E2E test inserts 120 events (60 sharing one timestamp, so
ordering must break ties by id) and pages through them: all 120 are returned
exactly once in non-increasing time order. It also covers the method
filter, literal `%` and `_` search, `400` for invalid input, `410` for an
evicted cursor, and `404` for another workspace that uses a valid cursor. The
webhook unit suite and both web/API typechecks pass locally against
PostgreSQL 17. Per-event deletion and safe replay remain unimplemented.
