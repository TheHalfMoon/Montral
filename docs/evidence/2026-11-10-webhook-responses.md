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
  configuration; the receiver corrects the record if it sends something else
  (see "Recorded status = sent status"). The 7-argument v1
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
| Content type | `text/plain`, `application/json` (inline), `application/xml`, `text/xml`, `text/csv` (always `Content-Disposition: attachment`), sent with `charset=utf-8`. HTML, SVG, XHTML, JavaScript and everything else refused |
| Headers | at most 20, 8 KiB total; name from the allow-list below, up to 64 characters, no duplicates; value printable ASCII (0x20-0x7E) up to 1024 characters, no CR/LF/NUL/tab/obs-text, no surrounding spaces |
| Delay | integer 0-10,000 ms; waited only after capture and while a slot is free; cancelled when the sender disconnects |
| Per method | optional override of status/type/body/headers/location for POST, PUT or PATCH |

**XML is never rendered as a document.** A browser displays an XML response
as a document and honours XHTML and SVG namespaces inside it: links, meta
refresh and drawing work even when the sandbox CSP blocks scripts, which would
be a spoofed page on the instance's own origin. XML is kept for mocking XML
APIs, but every XML (and CSV) body is sent with `Content-Disposition:
attachment; filename="response.xml"` (`response.csv`), so a browser downloads
it; API clients ignore the disposition. Only `text/plain` and
`application/json` are served inline, and with `nosniff` neither is ever
interpreted as markup. `content-disposition` cannot be set by the user.

**Header allow-list** (case-insensitive, `ALLOWED_RESPONSE_HEADERS` and
`ALLOWED_RESPONSE_HEADER_PREFIXES` in `montral-hook-response.ts`): any `x-*`
name, plus `retry-after`, `content-language`, `warning`, `deprecation`,
`sunset`, `allow`, `accept-patch`, `accept-post`, `request-id`,
`correlation-id`, `idempotency-key`, `traceparent`, `tracestate`, `ratelimit`,
`ratelimit-policy`, `ratelimit-limit`, `ratelimit-remaining`,
`ratelimit-reset`. Every other name is refused, so headers that browsers,
proxies or CDNs add in future are refused by default.

**Reserved even within the allow-list** (`DENIED_RESPONSE_HEADERS`,
`DENIED_RESPONSE_HEADER_PREFIXES`, also kept as defence in depth for
standard names): framing and hop-by-hop headers; `content-type`, `location`,
`content-disposition` (dedicated fields); cookies and authentication
prompts; browser policy (`strict-transport-security`, CSP, `x-frame-options`,
`x-xss-protection`, `permissions-policy`, `clear-site-data`, `alt-svc`,
`refresh`, `link`, client hints `accept-ch`/`critical-ch`, `origin-trial`,
`shared-storage-write`, `activate-storage-access`, `ad-auction-*`,
`attribution-reporting-*`, `service-worker-allowed`...); caching and the
privacy headers (`cache-control`, `expires`, `vary`, `etag`, `last-modified`,
`surrogate-control`, `cdn-cache-control`, `x-content-type-options`,
`x-robots-tag`...); proxy and CDN directives and families (`x-accel-*`,
`x-sendfile`, `x-lighttpd-*`, `x-litespeed-*`, `x-envoy-*`, `x-varnish*`,
`fly-*`, `cf-*`, `x-forwarded-*`, `x-real-*`, `x-original-*`, `x-rewrite-*`,
`x-middleware-*`, `x-vercel-*`, `x-nf-*`, `x-netlify-*`, `x-amz-*`,
`x-goog-*`, `x-ms-*`, `x-cache`, `x-served-by`, `x-powered-by`); and
`access-control-*` (CORS stays the private same-origin policy),
`cross-origin-*`, `sec-*`, `proxy-*`, `x-montral-*`.

**Always sent, never replaceable:** `cache-control: private, no-store`,
`referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
`x-robots-tag: noindex, nofollow` and, on configured responses,
`content-security-policy: default-src 'none'; sandbox; frame-ancestors 'none'`.
They are set after the user's headers; at send time stored headers are
re-checked (token name, field value, allow-list) and a stored configuration
that fails full validation falls back to the default 202.

**Recorded status = sent status.** `montral_capture_hook_event_v2` records the
status it reads from the configuration under the row lock. The receiver then
re-validates and computes the status it will actually send; if they differ
(only possible for a configuration that fails validation, answered with the
default 202) it corrects the event before answering.

**Unchanged:** refusals (404 invalid token, 408 slow body, 413 oversized, 422
malformed, 429 rate-limited) keep their fixed JSON answers; retention (250
events, 7 days), deletion and the per-inbox 120/min rate limit; replay never
uses the configured response and stores nothing.

**Delay and concurrency.** The delay feature never denies or delays capture.
A slot is taken only after the body has been read and the event stored, and
is held while the response waits: at most 5 per inbox, 20 per organization
and 200 in total per server process (per isolate on Cloudflare Workers).
When any of these is exhausted the configured response is sent at once,
without the delay. One organization can therefore hold at most 20 sleeping
requests per process and cannot starve another organization's delayed
inboxes. Inboxes without a delay never take a slot (the load qualification's
hot burst is unaffected). The delay never exceeds 10 s whatever is stored.

**3xx redirects.** A configured `location` makes the receiver URL a redirect
on the instance's own address. Only someone who holds the secret receiver URL
can trigger it, and only with POST, PUT or PATCH (a browser form post, or a
303 that turns it into GET); the target must be an absolute http(s) URL
without credentials. This is an open redirect the manager chooses to
configure, documented in the API reference.

## Tests
- `apps/api/src/montral-hook-response.test.ts` (unit): defaults, status ranges
  (100, 101, 103, 199, 600, fractions, strings refused), location rules
  (javascript:, data:, file:, relative, protocol-relative, credentials, CRLF,
  spaces), header injection (CR, LF, NUL, tab, DEL, non-ASCII, U+2028, padding)
  in names and values; 70 refused names in mixed case (reserved, review
  additions and names simply not on the allow-list) and allowed names
  accepted; count/duplicate/size caps; content-type allow-list; XML and CSV
  always served as attachments (SVG and XHTML payloads), text/plain and JSON
  inline, disposition not overridable; 64 KiB byte cap (multibyte), NUL and
  lone surrogates, bodyless statuses, delay bounds, per-method overrides,
  unknown fields; send-time re-check of a tampered configuration; slot
  accounting per inbox, organization and process, and one organization at its
  cap leaving room for nine others; bounded and cancellable delay, clamp to 10 s.
- `apps/api/src/montral-hooks.test.ts` (mounted routes, fixture database):
  configured status/headers/body with privacy headers, per-method and redirect
  and 204, 400 for invalid configurations, 413 above 512 KiB, refusals (404,
  413, 422, 429) unaffected, reset, manager-only (403) and project scoping
  (404), audit without values; six concurrent delayed requests: all captured
  and answered with the configured status, five after the delay and one at
  once; XML served as attachment; recorded status corrected to the 202 sent
  for an invalid stored configuration; abort on disconnect.
- `apps/api/src/montral-edition.test.ts`: MCP tools build the REST calls and
  refuse values the route would refuse.
- `apps/api/src/montral-hook-response.e2e.test.ts` (real PostgreSQL, mounted
  app): configured answer and per-method override, recorded `response_status`
  per event, audit row with field names and status only, reset; refusals
  unaffected; header injection refused at the API and filtered from a tampered
  row, whose event records the 202 actually sent; XML (application/xml,
  text/xml) with an SVG body served as an attachment, HTML/SVG/XHTML types
  refused; one organization sending 25 concurrent delayed requests (all 25
  captured with status 201, 20 delayed, 5 answered at once) while the same
  organization's undelayed inbox answers immediately and another
  organization's delayed inbox still gets its full delay; member 403 and
  other-workspace 404; replay unaffected; a no-op re-migration holds no
  blocking lock on the webhook tables.
- `apps/api/src/montral-billing-lock-order.e2e.test.ts`: the fresh-install
  shape includes both new columns, and the genuine-upgrade interleave now also
  drops and re-adds them (inbox before event) while the checkout completes.
- `apps/api/src/schema-migrate.e2e.test.ts`: v2 capture function exists after
  concurrent migrations.
- `e2e/tests/journey.spec.ts`: in every browser, configure 201 + JSON body +
  header in the editor, check the preview, save, receive it from a synthetic
  POST, and run the axe WCAG 2.1 AA scan on the inbox page.

## Independent review (PR #47, head 562168e) and fixes
1. (medium) XML could render XHTML/SVG on the instance origin: XML and CSV are
   now always attachments; test added.
2. (medium) Delay slots taken before the body was read, one organization could
   hold all 200: slots are taken after capture, capped at 20 per organization,
   and exhaustion answers immediately instead of refusing; tests added.
3. (low) Recorded status could differ from the sent one on fallback: corrected
   before answering; e2e asserts it.
4. (low) Header deny-list replaced by an allow-list (deny-list kept as defence
   in depth, extended with the reviewer's names).
5. (info) Open-redirect behaviour of 3xx documented here and in the API docs.

## Known limits
- The delay slots are per server process (per isolate on Workers), like the
  manual-check process bound; with several replicas the bounds multiply by
  the replica count. The per-inbox 120/min database rate limit still bounds
  the total, and exhaustion only removes the delay.
- A 3xx location is an open redirect on the instance origin for whoever holds
  the secret receiver URL (see above).
- No CORS configuration: the receiver keeps the private same-origin CORS
  policy, so browsers on other origins cannot read configured responses.
