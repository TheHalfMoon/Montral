# Montral target architecture (design, not yet implemented)

## One user journey
A customer signs up once, creates an organization/workspace and projects, sets HTTP/API checks and webhook inboxes, views incidents/status pages, creates an API key, and connects MCP. One account/session, no iframe or separate legacy app login.

## Control plane: Montral API and web
- Montral core: Hono API, better-auth, PostgreSQL via Drizzle, web frontend and scoped REST/MCP support.
- Tenant boundary: every monitor, incident, webhook endpoint, event, replay, API token, audit record and entitlement bound to authenticated workspace/project. Enforce authorization server-side, never trust an arbitrary workspace header.
- Canonical state: PostgreSQL schema extensions with migrations. Do not join two databases by shared IDs without an explicit mapping or use user-controlled target URLs unsafely.
- Idempotency: unique event IDs, delivery IDs and retried job keys for webhook processing and monitor incident transitions.
- Montral API: `/api/v1/*` for new public endpoints, docs/contract tests. Existing core routes may remain until versioned migration proves parity.

## Monitoring / probe plane
- Reuse the Montral scheduler and monitor/incident lifecycle by default.
- `ProbeRequest` -> adapter -> `ProbeResult` with target, method, timeout, region, status, latency, timestamp, error category, trace ID.
- Reuse portable Cloudflare Workers / D1 probe patterns from the second source behind that adapter, only for checks where they genuinely improve cost/coverage.
- Do not start a second scheduling loop against the same monitor; account for probe quotas/credits and external Cloudflare limits.
- Multi-region verdicts (implemented): unreachable or drained probes never vote; a verdict that rests on one region because the others are missing is confirmed from the scheduler's own location; plan region caps apply at run time. See EDGE-PROBE.md and OPERATOR.md.
- Explicit SSRF protection: deny private/loopback/link-local/metadata targets by default; cap redirects, response size, headers, time, concurrency and user-supplied body.

## Webhook plane
- Montral's own webhook receiver is the supported implementation. No archived legacy stack is part of the runtime.
- New `montral-hooks` endpoint receives HTTP requests through modern runtime, with bounded body sizes, signed endpoint IDs, rate limiting, scoped retention, and optional encrypted object storage for large payloads.
- Inspect URL, method, selected headers/body (redacted as appropriate), timing, delivery source and decode formats; user can replay with scoped credentials and anti-SSRF protection.
- Events stored in workspace/project-owned tables; cursor pagination and retention policies; secure ingestion even if webhook sender is anonymous.
- Make webhook delivery processing asynchronous and idempotent; maintain safe audit metadata without logging secrets.

## AI/MCP interface
- Extend existing OAuth 2.1 MCP / API key scope model.
- Existing monitor/incident tools remain first-class; add `list_webhook_inboxes`, `list_webhook_events`, `inspect_webhook_event`, `create_test_webhook`, `replay_webhook_event` only after authorization, rate limits and explicit side-effect semantics.
- Do not expose raw webhook credentials, signatures, secrets or tokens in MCP results.

## Commercial edition
- Separate Montral `Edition` adapter (existing core extension point) for plans, credit limits, meter, billing callbacks, upgrade/downgrade/cancel/past-due lifecycle.
- Payment provider through hosted checkout + verified, deduplicated webhook events; never trust frontend payment success.
- Plan credits derived from actual outbound checks and payload storage, not unconstrained monitor counts.
- No production provider keys in GitHub.

## Deployment intent
- Development/prototyping: Mac ephemeral workspace and GitHub Actions CI; free provider tiers only where quota permits.
- Production: Cloudflare Workers + PostgreSQL for core, optional object storage and queue; a modern webhook receiver behind same-origin routing. Paid infrastructure may be needed as traffic grows.
- Reliability: isolated queues, alert retries, encryption/secrets, health checks, PITR backups, tests, rollout/rollback and observability.
