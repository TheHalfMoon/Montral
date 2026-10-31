# Montral

**Monitoring · Webhooks · API · MCP** — one developer operations platform.

[![Montral CI](https://github.com/TheHalfMoon/Montral/actions/workflows/montral-ci.yml/badge.svg)](https://github.com/TheHalfMoon/Montral/actions/workflows/montral-ci.yml)

> **Private engineering preview — NOT deployed, NOT taking payments, NOT production-qualified.**

Montral is an independently branded project built on three preserved code sources, with a single active runtime and authentication model. It monitors websites, APIs and services; creates incident and status pages; accepts test webhooks; and exposes private operations over REST and OAuth-enabled MCP.

## Current integrated product

- **Monitoring**: Montral API, PostgreSQL repository, scheduler, incidents, notifications, status pages, API keys and MCP tools
- **Webhooks**: Montral-native PostgreSQL inboxes, signed secret receiver URL, capped HTTP event ingestion, per-project access, 7-day retention and web event inspector
- **MCP**: one `/api/mcp` endpoint with monitoring, incident and webhook inbox/event tools; OAuth scopes are enforced through the shared API auth layer
- **Edge monitoring**: optional *on-demand*, HMAC-signed Cloudflare HTTP probe with explicit allowed-host list and no second scheduler; scheduler→workerd contract validated locally with mocked outbound requests (not publicly deployed)
- **Frontend**: unified Montral dashboard with `/app/hooks`, `/app/billing`, and original operational screens
- **Test billing**: optional Lemon Squeezy TEST checkout, signed callbacks and SQL subscription-state ledger (off by default)
- **Optional metering**: DB-atomic monthly check/email credits with Free/Pro/Business preview limits (off by default)

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

**Montral is not yet qualified for customers or real money.** The private preview includes OAuth/MCP webhook-access E2E, test-mode-only provider billing and optional usage metering and bounded cancellation deadlines, but there is no public host, live merchant integration, actual payment-provider sandbox account, or approved commercial terms. The remaining blockers are listed in [release gates](docs/RELEASE-GATES.md). All revenue-related code is disabled by default; no live charges are supported.

Webhook capture uses a PostgreSQL inbox row lock for atomic token revalidation, insertion, seven-day expiry and 250-event retention, including safe simultaneous inbox deletion. The [atomic webhook test report](docs/evidence/2026-10-30-atomic-webhook-capture-qualification.md) reproduces the 275-parallel-event test.

Private-preview housekeeping is performed within the existing Node/Worker scheduler, separately from monitor-check success. It prunes seven-day-expired webhook data and removes sandbox checkout intents only seven days after their deadline, preserving the subscription/event ledger. See [maintenance qualification](docs/evidence/2026-10-30-maintenance-isolation-qualification.md).

Test-mode checkout creation uses a PostgreSQL workspace advisory lock to prevent duplicate pending links; a second legacy provider cannot replace a verified active subscription. See [checkout race qualification](docs/evidence/2026-10-30-checkout-race-qualification.md).

The PostgreSQL backend now serializes edition schema changes with a transaction-scoped advisory lock across multiple Node/Worker instances, including single-connection workers. [The local four-replica qualification](docs/evidence/2026-10-30-multireplica-migrations-qualification.md) verifies first-install DDL and crash rollback; it is not a hosted cloud release qualification.

Webhook inbox capture is text-only (strict UTF-8, no NUL) and rejects invalid data with HTTP 422; unidentified client addresses use bounded authentication fallback quotas rather than silently bypassing limits. See [local input and auth qualification](docs/evidence/2026-10-30-webhook-auth-input-qualification.md). Neither measure replaces production reverse-proxy, CAPTCHA or customer privacy review.

The offline real-Chromium smoke now exercises signed-in heartbeat monitor creation, detail view and pause/resume; a **manual incident declare/acknowledge/internal update/resolve** flow; webhook ingestion; and disabled billing, all with synthetic data. See [2026-10-31 incident lifecycle qualification](docs/evidence/2026-10-31-browser-incident-lifecycle-qualification.md) and [monitor qualification](docs/evidence/2026-10-31-browser-monitor-qualification.md). The browser test does not exercise real alert-provider delivery or an externally hosted browser. Separately, [the automatic heartbeat incident E2E](docs/evidence/2026-10-31-automatic-incident-alert-lifecycle.md) verifies missed-check detection, automatic incident creation, synthetic in-memory down/recovery email alerts and persisted recovery without live SMTP or external requests.

The [local real-SMTP drill](docs/evidence/2026-10-31-local-smtp-cron-qualification.md) launches a disposable PostgreSQL child database, the production Node app, and an isolated loopback SMTP sink. It proves Nodemailer channel tests and cron-triggered automatic down/recovery notifications over the SMTP wire protocol without sending external email. Hosted deliverability is still unqualified.

## Private local qualification

On a disposable **localhost** PostgreSQL database named `montral_test_*`, run the documented real-browser and backup recovery drills with `scripts/qualify-browser.mjs` and `scripts/qualify-backup.mjs`. The browser drill requires an **already installed** Chromium binary provided through `MONTRAL_CHROMIUM` and built Node API/web artifacts. These do not deploy or charge anything. See `docs/evidence/2026-10-30-browser-backup-qualification.md` for commands, verified results and scope limits.

GitHub is the canonical source. Mac copies are disposable and must be removed after remote verification. Never commit customer data or secrets.
