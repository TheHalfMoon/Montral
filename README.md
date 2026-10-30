# Montral

**Montral — monitoring, webhooks, APIs and MCP in one developer platform.**

Status: **private, pre-release integration workspace**. No public service, customer data, payments or live monitoring has been enabled.

## Product shape

Montral combines a multi-tenant monitoring core, Cloudflare-based optional probes, and a modern webhook testing service, exposed through one product identity, dashboard, REST API and MCP endpoint.

## Source snapshots

Three full tracked-source snapshots are preserved under `vendor/`:
- `vendor/montral-core/` — authentication, monitoring, incidents, status pages, REST and MCP.
- `vendor/montral-cloud-probes/` — Cloudflare worker-based monitoring, D1 utilities and UI references.
- `vendor/montral-webhooks-legacy/` — legacy webhook receiver and inspector; **never run this legacy PHP application in production**.

These are historical source mirrors for an integration build, **not three production apps**. Source copyright/license records and original attribution remain unmodified. See `docs/SOURCES.md`.

## Integration approach

- Core: adapt the first source into `apps/montral-api` and `apps/montral-web`; preserve auth and workspace scope.
- Probes: transplant the second source's useful check semantics into a versioned Montral probe interface; do not run duplicate schedulers.
- Webhooks: use the third source's request-inspector product behavior and test fixtures to build a secure modern receiver; do not expose unmaintained Laravel 5.4/PHP 7.1.
- Commercial: develop Montral-native billing and entitlements as a separate module; upstream hosted billing is not part of the MIT snapshot.

**Branding requirement:** every newly developed end-user surface and active package must say Montral. Historical source snapshots, original copyright, licenses and source register may keep original source names for provenance. No credit removal or false authorship.

## Safety and release policy

- Private GitHub is the canonical source; Mac is temporary staging only and is cleaned after verification.
- No production deploy, paid resources, production webhooks, customer payments or public release yet.
- No secrets, tokens, payment data, personal data or backups committed.
- See `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION-PLAN.md` and `docs/RELEASE-GATES.md`.
