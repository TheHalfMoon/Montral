# Montral integration plan

## Phase 0 — exact-source preservation (in progress)
- Import each upstream git-tracked snapshot intact under neutral Montral vendor names.
- Record commit hashes, originating URLs, licensing and verified file counts. Preserve third-party notices.
- Verify exact Git-tracked file manifests, no secrets accidentally copied, private repository and push.
- Clean Mac working directory only after remote verification.

## Phase 1 — functional Montral core
- Copy reusable MIT core to active `apps/montral-api` and `apps/montral-web`.
- Rename customer-facing UI and active package/application identifiers, config endpoints, docs and telemetry to Montral, while retaining attribution in legal register.
- Run core unit/integration/e2e suites on CI with ephemeral PostgreSQL.
- Single working login, project, monitor, incident and status page.

## Phase 2 — probe adapter
- Formal ProbeRequest/ProbeResult contract with timeout/error semantics and security guardrails.
- Maintain Montral's active edge-probe implementation under `apps/probe`.
- Add compatibility tests for HTTP/TCP/DNS where Cloudflare supports them and avoid duplicate monitoring costs.
- CI demonstrates identical incident semantics across probe adapters.

## Phase 3 — secure webhook receiver
- Use the Montral-native webhook receiver in `apps/api`; no duplicate legacy application is included.
- Implement modern `services/montral-hooks`: inbox lifecycle, capture, redact, retention, inspect, replay, API, pagination.
- Integrate auth/workspace ownership and secret rotation, quotas, event expiry and abuse/rate limits.
- E2E: create inbox, send request, inspect event, replay to allowed target, confirm isolation.

## Phase 4 — unified dashboard and MCP
- Single navigation, branded Montral UI, webhook pages and cross-project alerts.
- Expose Montral REST + MCP tools with OAuth consent scopes; validate unauthorized requests and mutation audit trails.
- Arabic and English UI support can be added once core parity works.

## Phase 5 — business/launch
- Create Montral Edition for plans, credit accounting, provider webhooks, failed-payment lifecycle, refunds and cancellation.
- Free and paid plans use strict resource limits. Build checkout with a provider approved for user's country.
- Fix CI/security issues, test backup/restore and migrations, privacy/retention and rate limits, onboard pilot accounts.
- Release only when the release gates in `docs/RELEASE-GATES.md` pass; there is no automatic public launch.

## Non-goals/constraints
- Never mechanically splice three incompatible apps into one runtime.
- No dependency on legacy PHP code in live requests.
- No source notice removal or false claims that source code was authored by Montral.
- No development files left permanently on Mac; never delete remote or user-owned unrelated projects.
