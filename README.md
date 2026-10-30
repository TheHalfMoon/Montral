# Montral

**Monitoring · Webhooks · API · MCP** — one developer operations platform.

[![Montral CI](https://github.com/TheHalfMoon/Montral/actions/workflows/montral-ci.yml/badge.svg)](https://github.com/TheHalfMoon/Montral/actions/workflows/montral-ci.yml)

> **Private engineering preview — NOT deployed, NOT taking payments, NOT production-qualified.**

Montral is an independently branded project built on three preserved code sources, with a single active runtime and authentication model. It monitors websites, APIs and services; creates incident and status pages; accepts test webhooks; and exposes private operations over REST and OAuth-enabled MCP.

## Current integrated product

- **Monitoring**: Montral API, PostgreSQL repository, scheduler, incidents, notifications, status pages, API keys and MCP tools
- **Webhooks**: Montral-native PostgreSQL inboxes, signed secret receiver URL, capped HTTP event ingestion, per-project access, 7-day retention and web event inspector
- **MCP**: one `/api/mcp` endpoint with monitoring, incident and webhook inbox/event tools; OAuth scopes are enforced through the shared API auth layer
- **Edge monitoring**: optional *on-demand*, HMAC-signed Cloudflare HTTP probe with explicit allowed-host list and no second scheduler
- **Frontend**: unified Montral dashboard with `/app/hooks` and original operational screens

## Local development (temporary environment only)

Requirements: Node.js **24.22.1** (or compatible 22.23.4+ / 26.12.1+), pnpm 10.0.0 and a disposable PostgreSQL instance.

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm --filter @montral/api test
pnpm --filter @montral/web test
pnpm --filter @montral/probe test
pnpm --filter @montral/web build
pnpm --filter @montral/api build:node
pnpm --filter @montral/probe build:edge
DEPLOY_TARGET=node pnpm --filter @montral/web build
# Requires a disposable TEST_DATABASE_URL that can be destroyed after testing:
TEST_DATABASE_URL=postgres://... node scripts/smoke-node.mjs
python3 scripts/verify_sources.py
```

For a **local disposable environment only**, configure `DATABASE_URL` and `BETTER_AUTH_SECRET` (see `.env.example`), then run `pnpm db:migrate`. The Montral webhook schema extension is applied by the Montral Node server during startup or via the protected `POST /internal/migrate` endpoint. Do not expose development credentials.

### Optional Cloudflare probe

The Worker source is `apps/probe/src/edge.ts`, built with `pnpm --filter @montral/probe build:edge`; the example config is `apps/probe/wrangler.edge.jsonc`. **No Worker is deployed by CI.** To enable one, privately provision its `PROBE_SECRET` and explicit `ALLOWED_HOSTS`, build/deploy it separately, and configure `PROBE_REGIONS` on the scheduler with the shared secret. It runs only signed on-demand HTTP checks; the single Montral scheduler retains ownership of monitoring state.

## Upstream source preservation and identity

Three complete git-tracked snapshots remain **unchanged** under `vendor/`:
- `vendor/montral-core/` (monitoring/MCP architecture, MIT)
- `vendor/montral-cloud-probes/` (Cloudflare monitoring donor, Apache-2.0)
- `vendor/montral-webhooks-legacy/` (webhook behavior donor, MIT; insecure obsolete PHP stack **never served in production**)

Original license files and copyright are retained as required, and exact SHAs and every source-file hash are recorded in `docs/SOURCES.md` and `docs/source-manifest.json`. Customer-facing code is Montral-branded; preserving historical names inside legal source evidence is intentional.

## Before launch

**There is no customer billing, live cloud service or privacy/terms approvals. Local isolated PostgreSQL E2E passes, but real OAuth webhook-client verification, cloud qualification and browser end-to-end release checks remain.** The private MVP still needs payment-provider onboarding, subscription entitlements, PostgreSQL full E2E, hardening, cost/load testing, backup/restore, incident drills and final commercial/legal checks. See `docs/RELEASE-GATES.md`.

GitHub is the canonical source. Mac copies are disposable and must be removed after remote verification. Never commit customer data or secrets.
