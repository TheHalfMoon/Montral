# JSON validation and MCP envelope resource budgets

Status: implementation candidate on the engineering branch; exact-head hosted qualification and merge are required.

## Finding and boundary

Ordinary CRUD routes passed original JSON uploads directly to native Hono/Zod validation. Hono buffered and parsed the entire upload before Zod field limits could discard ignored fields. An authenticated tenant could therefore force unbounded body allocation on the shared API process. The independent patch review also identified the same parsing boundary in the JSON-RPC transport, including the anonymous public MCP endpoint; nested REST validation happened only after the original envelope was already parsed.

The repository-local validator now reads original bytes under a 4 MiB, 10-second total budget before invoking native validation. All production validator imports use this adapter, with a source guard against bypasses. Native inference, async hooks, custom validation functions, query validators, malformed JSON and schema errors remain intact. Hono's runtime body cache receives a promise for bounded bytes; no request clone is introduced. Unexpected upload errors retain a private malformed-JSON 400.

The existing original-stream byte reader moved unchanged into the MCP transport package's explicit `body-budget` subpath. API JSON helpers keep their original exports and smaller per-route limits. Both private and anonymous MCP routes use that same reader before parsing, probes, batch inspection or REST redispatch. Their envelope limit is 5 MiB, including a complete batch, to leave framing room around the existing 4 MiB monitor-import allowance. Authentication, session origins, tool visibility, HMAC input bytes and billing routes are unchanged.

These are per-request bounds, not a claim that arbitrary concurrent request volume cannot exhaust a deployment. There was no production exploit or destructive heap-exhaustion test.

## Reproduction and validation

- Original native validation: oversized ignored-field JSON without Content-Length and with a forged-small value returned 201 instead of 413; an incomplete stream failed to produce a 408 after 10 seconds. Three new regression cases failed before implementation; a legitimate native validation control passed.
- Original MCP transport: both private and anonymous oversized envelopes returned 200 instead of 413, and both incomplete-envelope deadline cases failed. Four regressions failed before the transport change.
- Supported local Node 24.22.1: bounded-validator and shared-reader tests passed 16/16, including UTF-8 exact ceiling, limit-plus-one, declared/chunked length, nonsettling cancellation, stalled streams, errors, custom hooks, query behavior and production import coverage. MCP package TypeScript and its complete unit suite passed 24/24.
- Real disposable PostgreSQL 17.7: authenticated JSON-budget suite passed 5/5, including refusal before project/monitor writes and valid heartbeat creation followed by pause. A fresh full API run is pending; no full API result is claimed yet.
- API TypeScript and Node production bundle, source identity and diff checks passed. API PostgreSQL 17/18 and macOS workflows now also run the MCP package tests without changing the required job count.
- Independent fresh-context pre-patch compatibility investigation and one bypass/regression review ran under `codex-security:fix-finding`. The review's MCP finding was confirmed with failing tests and addressed through the shared reader. This is an engineering review, not external penetration testing.

No production deployment, publication, billing activation, provider call or paid resource is involved. Community publication remains HOLD; Cloud and BYOC remain NO-GO on external gates.
