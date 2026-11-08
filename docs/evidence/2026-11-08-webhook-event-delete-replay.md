# Webhook event deletion and safe development replay

## Gap
Captured webhook events could only be removed by deleting the whole inbox,
and there was no way to resend a captured request to a development endpoint,
the main workflow of a webhook inspector.

## Change
- `DELETE /api/hooks/inboxes/:id/events/:eventId` (owner/admin) removes one
  event, scoped to inbox, workspace and project. MCP gains a destructive
  `delete_webhook_event` tool.
- `POST /api/hooks/inboxes/:id/events/:eventId/replay` (owner/admin) resends
  the stored method, body, content type and allowlisted headers, plus
  `x-montral-replay: <event id>`, to a caller-supplied http(s) URL.
  - The outbound request uses the monitor checker's SSRF protection:
    `urlProblem` plus `guardedFetch` (private, loopback, link-local and
    metadata addresses refused unless the operator set
    `ALLOW_PRIVATE_TARGETS`; DNS pinned to validated addresses).
  - Redirects are not followed (`follow: false`), so a public endpoint cannot
    bounce the replay inward. 10 s deadline (504), 4 KiB response cap,
    20 replays per minute per inbox, strict request schema.
  - Network errors return fixed messages so internal addresses do not leak.
  - Nothing about the replay is stored. Replay is not exposed over MCP: an
    agent should not be able to send outbound requests on a user's behalf.
- The inbox screen adds per-event Delete and a Replay form showing the
  target's status and first 4 KiB of its answer.

## Evidence
`montral-hooks.e2e.test.ts` (PostgreSQL) covers cross-workspace 404s for
delete and replay, event ids from another inbox, refused loopback/private/
metadata/`localhost` targets, rejected `file:`, `ftp:` and malformed input
(which found and fixed a 500 from a refinement on an invalid URL), an
allowed replay to a local endpoint asserting method, body, headers, the
replay marker and the absent `authorization`, truncation at 4 KiB, a 302
returned rather than followed, a fixed 502 for a closed port, and deletion.
`montral-edition.test.ts` checks the MCP tool and that no replay tool exists.
