# JSON response-body assertions for HTTP monitors

## Gap
An HTTP monitor could only check the status code and whether a keyword appears
in the body. A health endpoint answering `200 {"status":"degraded"}` passed any
keyword check that also matched `"status"`, and there was no way to require one
field of a JSON document to hold one value.

## Change
- `apps/api/src/json-assertion.ts`: a hand-written parser for a small, safe path
  subset (dot keys of letters, digits, `_`, `-`, `$`; `[index]`;
  `["quoted key"]` with JSON escapes; optional leading `$.` / `$[`; at most 32
  segments and 200 characters). No eval, no JSONPath library, no filters,
  wildcards, slices or recursion. Resolution follows own properties of objects
  and in-range array indexes only (`length`, `constructor`, inherited keys and
  `items.0` on an array are "not found").
- Comparison: strings as they are, everything else as compact JSON, so `"42"`
  matches `42`, `"true"` matches `true`, `"null"` matches `null`. `equals` is
  string-form equality, `contains` a substring test, `exists` presence (JSON
  `null` counts as present; `jsonExpected` ignored).
- `httpCheck`: with `jsonPath` set and a method other than HEAD, the body is
  read up to `MAX_BODY_BYTES + 1`; a body over the cap fails ("Response is larger
  than 1000000 bytes; JSON path … not checked") instead of parsing a cut-off
  document. Then "Response is not valid JSON", "JSON path data.x not found", or
  a mismatch message. Status, keyword and JSON assertions must all pass. Any
  value, expected text or path shown in an error is clipped to 80 characters.
- DB: `json_path text`, `json_expected text`, `json_match text not null default
  'equals'` with `monitor_json_match_chk` (migration `0045_monitor_json_assertion`,
  number may be renumbered on merge). The three fields join `keyword` /
  `keywordMode` in the coverage-revision comparison of `updateMonitor` and in
  the account data export query.
- API (`routes/monitors.ts`, shared by REST, MCP `create_monitor` /
  `update_monitor` and import): zod fields with descriptions; `jsonAssertionProblem`
  returns a plain `400 { error }` for a path that does not parse, an assertion on
  a non-HTTP monitor, or `equals`/`contains` without `jsonExpected`. PATCH judges
  the stored assertion with the named fields changed; `null` (or `""` for the
  path) clears it. Export carries the fields; import validates them.
- Remote probes: the Node probe parses the fields and advertises
  `http-json-assertion-v1`; the scheduler requires that capability before
  sending a check with a JSON assertion (cached 30 s per capability), so an old
  probe is "Probe upgrade required for JSON assertions" (unreachable, not a
  pass). The envelope of a monitor without an assertion is unchanged. The
  Cloudflare edge probe does not implement it and returns 400 if sent one.
- UI: optional "JSON assertion" section (path, mode, expected value, helper
  text with an example) in the HTTP form; the detail view shows it. Strings go
  through `t()` with zh entries.
- Docs: `docs/api` field table plus a "Check a value in a JSON response"
  example (English and Chinese).

## Evidence
- `apps/api/src/json-assertion.test.ts`: 36 passed. Parser (dot/bracket/`$`,
  quoted keys with escapes, 22 rejected forms, 32-segment limit, 200-character
  limit), resolution (own keys only, no array/object crossing), comparison
  (equals/contains/exists, numbers, booleans, null, 80-character clipping),
  schema defaults and `jsonAssertionProblem`, and "JSON assertions on remote
  probes > never lets a probe without the capability pass the check, and sends
  the assertion to one that has it".
- `apps/api/src/checker.test.ts > http JSON assertions` (local HTTP server,
  `ALLOW_PRIVATE_TARGETS`): 10 passed: passes when the value equals the expected
  text; fails on a wrong value and says what it found; fails on a missing path;
  fails on a body that is not JSON; supports contains and exists; compares
  numbers and booleans by their JSON text; needs status, keyword and JSON
  assertions to pass together; shows at most 80 characters of a value in the
  error; fails a body over the read cap instead of parsing a cut-off document
  (and passes a body of exactly `MAX_BODY_BYTES`); ignores the JSON assertion
  for HEAD.
- Affected API files run together (`json-assertion`, `checker`, `http-request`,
  `probe-reply-privacy`, `regions`, `mcp`, `dns`, `websocket`):
  9 files (8 passed, 1 skipped), 165 tests passed, 1 skipped (the e2e below).
- `apps/probe`: `handler.test.ts`, `node-server.test.ts`, `edge.test.ts`:
  21 passed, including "carries a JSON assertion through and refuses one it
  could not run" and "refuses a JSON assertion it does not advertise instead of
  passing without it".
- `apps/web`: `zh.test.ts`, `i18n.test.ts`: 12 passed.
- `packages/db-pg`: `migrate.test.ts`, `migration-history.test.ts`: 4 passed
  (`repo.test.ts` skipped without a database).
- `apps/api/src/json-assertion.e2e.test.ts` (create, validation errors, PATCH
  semantics, coverage revision bump, clearing, export/import): skipped locally
  (no `TEST_DATABASE_URL`); runs in CI.
- `tsc -p apps/api --noEmit`, `tsc -p apps/probe`: clean. `pnpm --filter
  @montral/web typecheck`: 0 errors. `scripts/verify-active-branding.sh`: pass.

## Limits
- One assertion per monitor; no wildcards, filters, slices or array-length
  checks. Keys outside `[A-Za-z0-9_$-]` need `["…"]`; single quotes are not
  accepted.
- Bodies over 1,000,000 bytes always fail a JSON assertion. A body with invalid
  UTF-8 is decoded with replacement characters before parsing.
- Numbers compare by their JSON text after parsing: `1.0` in the body is `1`,
  and very large integers lose precision as in `JSON.parse`.
- `equals` with `jsonExpected: ""` matches an empty string; the dashboard sends
  a blank expected value as "not given", which the API refuses for equals and
  contains.
- The edge probe refuses JSON assertions; Node probes must be upgraded before
  regional checks of such monitors return results.
