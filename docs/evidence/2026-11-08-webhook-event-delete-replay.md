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
  - The outbound request is public-only by default (`guardedFetch` with
    `publicOnly`, DNS pinned), even when `ALLOW_PRIVATE_TARGETS` is set:
    that flag lets monitors reach internal services, but replay returns the
    response body, which would turn it into an internal read-back channel.
    A separate `MONTRAL_REPLAY_PRIVATE_TARGETS` opt-in allows private
    development endpoints on self-hosted Node; link-local and cloud metadata
    addresses (169.254/16, 100.100.100.200, fe80::/10, fd00:ec2::254, in
    every IPv4-mapped spelling) stay refused and the connection is pinned to
    the checked addresses. Workers is always public-only.
  - Redirects are not followed (`follow: false`), so a public endpoint cannot
    bounce the replay inward. 10 s deadline (504), 4 KiB response cap measured
    in bytes, 20 replays per minute per inbox, 60 per workspace and 60 per user,
    strict
    request schema.
  - Network errors return fixed messages so internal addresses do not leak.
  - Nothing about the replay is stored. OAuth/MCP agents get 403 on the REST
    route and there is no MCP tool: an agent must not send outbound requests
    on a user's behalf. API keys (the user's own programmatic access) may.
- The inbox screen adds per-event Delete and a Replay form showing the
  target's status and first 4 KiB of its answer.

## Independent review
The first version honoured `ALLOW_PRIVATE_TARGETS` (internal read-back),
rate-limited per inbox only (bypass with more inboxes), allowed OAuth agents
via REST, and measured truncation in characters. All four were fixed. A
re-review then found truncation decided on decoded text (binary replies
misreported); the body is now capped on raw bytes. Compatible and NAT64
IPv6 spellings of metadata addresses and a per-user limit were added.

## Evidence
`montral-hooks.e2e.test.ts` (PostgreSQL) covers cross-workspace 404s for
delete and replay, event ids from another inbox, refused loopback/private/
metadata/`localhost` targets (also with `ALLOW_PRIVATE_TARGETS` alone),
metadata refused even with the replay opt-in, rejected `file:`, `ftp:` and malformed input
(which found and fixed a 500 from a refinement on an invalid URL), an
allowed replay to a local endpoint asserting method, body, headers, the
replay marker and the absent `authorization`, byte-based truncation of a multibyte answer at 4 KiB, a 302
returned rather than followed, a fixed 502 for a closed port, and deletion.
`montral-edition.test.ts` checks the MCP tool and that no replay tool exists;
`oauth-scope.e2e.test.ts` checks an agent with a write grant gets 403 on
replay; `montral-hooks.test.ts` checks the link-local/metadata guard.
