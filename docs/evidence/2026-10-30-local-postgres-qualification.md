# Montral Mac/PostgreSQL qualification — 2026-10-30

## Environment and boundaries

This wave used only the authorized **macOS ARM64** machine and private GitHub repository `TheHalfMoon/Montral`. The working copy started at `df4f10f6b39e347e9bc174b38c389f62c7af3c0f`. PostgreSQL 17.9 was initialized in an **isolated disposable cluster** under `/tmp/montral-pg-20261030b` on loopback port 55439. The Mac's pre-existing port 5432 database was untouched. All accounts, webhooks and tokens were synthetic.

## Reproducible verification

```sh
pnpm install --frozen-lockfile
python3 scripts/verify_sources.py
pnpm -r typecheck
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temporary-port>/<disposable-db>' pnpm --filter @montral/api test
pnpm --filter @montral/web test
pnpm --filter @montral/probe test
pnpm --filter @montral/api build:node
DEPLOY_TARGET=node pnpm --filter @montral/web build
pnpm --filter @montral/probe build:edge
TEST_DATABASE_URL='<same-disposable-db>' node scripts/smoke-node.mjs
```

## Verified results

| Gate | Outcome |
|---|---|
| Three donor snapshots | 638 source-file hashes matched |
| All monorepo typechecks | PASS |
| API tests (real database) | **535 / 535 PASS**, no skipped |
| Web tests | **122 / 122 PASS** |
| Probe tests | **20 / 20 PASS** |
| Montral webhook real-session auth / cross-tenant isolation / capture | PASS |
| Bad token, body cap, deleted inbox token, cascade delete | PASS |
| Expired webhook data removed while inbox idle | PASS |
| Atomic inbox creation quota under 16 concurrent calls | **PASS in five consecutive rounds** |
| Node API + Node-target Astro web + Edge probe bundle | PASS |
| Live local Node+PostgreSQL smoke | PASS: /health, /api/config, /.well-known/mcp.json, /app |

## Important bug found and fixed

The initial inbox quota implementation used a PostgreSQL advisory lock in a MATERIALIZED CTE and counted existing inboxes within **the same SQL statement**. At READ COMMITTED isolation, the statement snapshot can precede the lock, so a concurrent run in the full test suite admitted **12 of 16** requests despite the 10-inbox cap.

The replacement creates a `montral_create_hook_inbox` PL/pgSQL function. It first acquires a PostgreSQL **transaction advisory lock**, then counts inboxes in a **separate SQL statement within that function**, inserts or returns NULL. A real PostgreSQL 16-request concurrency test succeeded in five successive test runs after this fix. Quota enforcement is tested in `apps/api/src/montral-hooks.e2e.test.ts`.

## CI and release limits

GitHub Actions for this private repository have failed before runner assignment, with **zero executed steps**. We updated the workflow to provide a PostgreSQL 17 service, run the DB E2E suite, build the production Node app and run a smoke check **when a runner is available**. Do not claim green hosted CI.

Not validated: real browser E2E, actual Cloudflare Worker egress, API key/MCP scoped access on new webhook endpoints, webhook secret at-rest handling, multi-tenant cloud load tests, production backups and incident drills, real email deliverability, provider billing and payments, customer legal/operational requirements. **No deployment or payment was made.** This report establishes local evidence only.
