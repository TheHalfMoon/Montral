# Configurable webhook inbox responses (webhook.site parity)

## Gap
A Montral webhook inbox always answered `202 {"received":true}`. Senders that
expect a specific answer (a 200 with a JSON acknowledgement, a 409 to test
retries, a 302, a slow endpoint to test timeouts) could not be exercised, which
webhook.site offers on its paid tier. Task ledger item 18, gap matrix row
"Custom webhook responses".

## Design
- **Storage.** `montral_hook_inbox.response jsonb` (null = default) and
  `montral_hook_event.response_status smallint` (null for events captured
  before this change). Edition migration in `montral-hooks.ts`, not Drizzle.
  Both `ALTER TABLE ... ADD COLUMN` statements are guarded by `columnExists`
  (`schema-catalog.ts`), so an up-to-date schema issues no table-locking DDL
  (the PR #35 property); a genuine upgrade alters the inbox table before the
  event table, the order a capture locks them in.
- **Capture.** New `montral_capture_hook_event_v2` reads the response
  configuration under the same inbox row lock as the insert and retention
  pruning, records the chosen status on the event, and returns the
  configuration; the stored status therefore always matches the configuration
  the receiver answers with, even while a manager edits it. The 7-argument v1
  function is kept for replicas still running the previous release.
- **API (managers only, project-scoped).** `GET`, `PUT`, `DELETE
  /api/hooks/inboxes/:id/response`. `PUT` reads at most 512 KiB with the same
  10-second read deadline as inbox creation, validates strictly
  (`parseHookResponseConfig`, unknown fields refused), stores the normalised
  configuration and audits `hook_inbox.response_update` with field names, the
  status and nothing else (no body, header values or redirect target). `DELETE`
  restores the default and is audited with the same action.
- **MCP.** `get_webhook_response` (read-only), `set_webhook_response`,
  `reset_webhook_response`. They are thin REST calls with the caller's own
  credentials, so manager role, project grants and the `mcp:write` scope apply
  unchanged. Replay is still not exposed to agents.
- **UI.** "Receiver response" editor on the inbox page: status, content type,
  delay, redirect location (3xx only), body, up to 20 headers, a live preview of
  the exact HTTP response including the fixed headers, save and "use default".
  Events show the status they were answered with. English and Simplified
  Chinese strings (the existing inbox page strings were untranslated and are
  now translated too).

## Rules
| Setting | Allowed |
|---|---|
| Status | integers 200-599 (no 1xx, so no 101). 204, 205 and 304 must have an empty body and get no content type |
| Location | only with 3xx; absolute `http`/`https` URL without credentials, printable ASCII, max 2048 |
| Body | text; all bodies of an inbox together at most 64 KiB UTF-8; no NUL, no lone surrogates |
| Content type | `text/plain`, `application/json`, `application/xml`, `text/xml`, `text/csv`, sent with `charset=utf-8`. HTML, SVG, XHTML, JavaScript and everything else refused |
| Headers | at most 20, 8 KiB total; name an RFC 9110 token up to 64 characters, no duplicates; value printable ASCII (0x20-0x7E) up to 1024 characters, no CR/LF/NUL/tab/obs-text, no surrounding spaces |
| Delay | integer 0-10,000 ms; cancelled when the sender disconnects |
| Per method | optional override of status/type/body/headers/location for POST, PUT or PATCH |

**Header deny-list** (case-insensitive, `DENIED_RESPONSE_HEADERS` and
`DENIED_RESPONSE_HEADER_PREFIXES` in `montral-hook-response.ts`):
- framing and hop-by-hop: `connection`, `keep-alive`, `proxy-connection`,
  `transfer-encoding`, `te`, `trailer`, `upgrade`, `content-length`,
  `content-encoding`, `content-range`, `accept-ranges`, `host`, `date`,
  `server`, `via`, `alt-svc`, `alt-used`;
- set through dedicated fields: `content-type`, `location`;
- credentials and authentication prompts: `set-cookie`, `set-cookie2`,
  `authorization`, `proxy-authorization`, `www-authenticate`,
  `proxy-authenticate`, `authentication-info`;
- browser policy on the instance's origin: `strict-transport-security`,
  `content-security-policy` (and `-report-only`, `x-` variants),
  `public-key-pins*`, `expect-ct`, `x-frame-options`, `x-xss-protection`,
  `permissions-policy`, `feature-policy`, `document-policy`,
  `origin-agent-cluster`, `clear-site-data`, `service-worker(-allowed)`,
  `speculation-rules`, `report-to`, `reporting-endpoints`, `nel`, `refresh`,
  `link`, `content-disposition`, `timing-allow-origin` and similar;
- the hook privacy policy and caching: `cache-control`, `pragma`, `expires`,
  `age`, `vary`, `etag`, `last-modified`, CDN cache controls,
  `referrer-policy`, `x-content-type-options`, `x-robots-tag`;
- reverse-proxy directives: `x-sendfile`, `x-lighttpd-send-file`,
  `x-litespeed-*`, forwarding headers, `x-powered-by`;
- whole families: `access-control-*` (CORS stays as it was: the private
  same-origin policy), `cross-origin-*`, `sec-*`, `proxy-*`, `x-accel-*`
  (nginx internal redirects), `x-forwarded-*`, `cf-*`, `x-montral-*`,
  `x-amz-*`, `x-goog-*`, `x-ms-*`.

**Always sent, never replaceable:** `cache-control: private, no-store`,
`referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
`x-robots-tag: noindex, nofollow` and, on configured responses,
`content-security-policy: default-src 'none'; sandbox; frame-ancestors 'none'`.
They are set after the user's headers; at send time stored headers are
re-checked (token name, field value, deny-list) and a stored configuration
that fails full validation falls back to the default 202, so a row written
outside the API cannot inject or override headers.

**Unchanged:** refusals (404 invalid token, 408 slow body, 413 oversized, 422
malformed, 429 rate-limited) keep their fixed JSON answers; retention (250
events, 7 days), deletion and the per-inbox 120/min rate limit; replay never
uses the configured response and stores nothing.

**Delay and concurrency.** A delayed response takes one of 5 slots per inbox
(200 per process) before the body is read and holds it until the response is
sent or the sender goes away; with no free slot the request is refused with a
fixed `429` and nothing is captured. Inboxes without a delay never take a
slot, so the load qualification's 200-request hot burst (exactly 120 accepted)
is unaffected. The delay never exceeds 10 s whatever is stored.

## Tests
- `apps/api/src/montral-hook-response.test.ts` (unit): defaults, status ranges
  (100, 101, 103, 199, 600, fractions, strings refused), location rules
  (javascript:, data:, file:, relative, protocol-relative, credentials, CRLF,
  spaces), header injection (CR, LF, NUL, tab, DEL, non-ASCII, U+2028, padding)
  in names and values, 50 deny-listed names in mixed case and safe names
  allowed, count/duplicate/size caps, content-type allow-list (HTML, SVG,
  XHTML, JavaScript, parameters, case variants refused), 64 KiB byte cap
  (multibyte), NUL and lone surrogates, bodyless statuses, delay bounds,
  per-method overrides, unknown fields; send-time re-check of a tampered
  configuration; slot accounting; bounded and cancellable delay, clamp to 10 s.
- `apps/api/src/montral-hooks.test.ts` (mounted routes, fixture database):
  configured status/headers/body with privacy headers, per-method and redirect
  and 204, 400 for invalid configurations, 413 above 512 KiB, refusals (404,
  413, 422, 429) unaffected, reset, manager-only (403) and project scoping
  (404), audit without values, delay bound and per-inbox slot refusal, abort on
  disconnect.
- `apps/api/src/montral-edition.test.ts`: MCP tools build the REST calls and
  refuse values the route would refuse.
- `apps/api/src/montral-hook-response.e2e.test.ts` (real PostgreSQL, mounted
  app): configured answer and per-method override, recorded `response_status`
  per event, audit row with field names and status only, reset; refusals
  unaffected; header injection refused at the API and filtered from a tampered
  row; 1.5 s delay with six concurrent requests (five answered after the delay,
  one 429, five stored) while another inbox answers immediately; member 403
  and other-workspace 404 for GET/PUT/DELETE; replay reports the target's
  answer and sends none of the configured headers; a no-op re-migration holds
  no blocking lock on the webhook tables.
- `apps/api/src/montral-billing-lock-order.e2e.test.ts`: the fresh-install
  shape includes both new columns, and the genuine-upgrade interleave now also
  drops and re-adds them (inbox before event) while the checkout completes.
- `apps/api/src/schema-migrate.e2e.test.ts`: v2 capture function exists after
  concurrent migrations.
- `e2e/tests/journey.spec.ts`: in every browser, configure 201 + JSON body +
  header in the editor, check the preview, save, receive it from a synthetic
  POST, and run the axe WCAG 2.1 AA scan on the inbox page.

## Known limits
- The delay slots are per server process (like the manual-check process
  bound); with several replicas the per-inbox bound multiplies by the replica
  count. The per-inbox 120/min database rate limit still bounds the total.
- A 3xx location is an open redirect on the instance origin for whoever holds
  the secret receiver URL; only POST/PUT/PATCH reach the receiver.
- A stored configuration that fails validation (only possible by editing the
  database) is answered with the default 202, while the event records the
  status the SQL function read from it.
- No CORS configuration: the receiver keeps the private same-origin CORS
  policy, so browsers on other origins cannot read configured responses.
