# Terraform provider (ledger item 15)

## Gap
Montral had a REST API and an Uptime Kuma importer, but no way to keep monitors, channels and status pages in version
control and apply them repeatably. The competitors in `docs/GAP-MATRIX.md` that offer config-as-code do it with a
Terraform provider or YAML.

## What was built
`terraform-provider-montral/`: a Go module on the Terraform Plugin Framework (protocol 6, Terraform 1.0+ and OpenTofu).

- Provider: `endpoint` (`MONTRAL_ENDPOINT`), `api_key` (sensitive, `MONTRAL_API_KEY`), optional `project_id`
  (`MONTRAL_PROJECT_ID`). It uses Go's default TLS verification and never logs the key. The key goes out only as
  `Authorization: Bearer`, and errors are redacted if a transport ever echoes it.
- Resources, all with create, read, update (or replace), delete and import by id:
  - `montral_monitor`: every type the API accepts (http with keyword or JSON assertions, tcp, dns, heartbeat, ping,
    certificate, domain, websocket, postgres, mysql, redis), interval, timeout, thresholds, regions, slow alerts,
    dependencies, channels, tags, pause. Read-only `status`, `heartbeat_token` and `heartbeat_url`.
  - `montral_alert_channel`: all 14 types. Credentials go in a sensitive `secret_config`, other settings in `config`.
  - `montral_status_page`: slug (replaces), title, theme, visibility, write-only password, uptime thresholds,
    maintenance reminder hours, ordered and grouped components.
  - `montral_maintenance_window`: one-off windows and daily or weekly series. The API cannot edit a window, so every
    change replaces it. Destroying a series cancels it through `DELETE /maintenance/series/:id`.
  - `montral_project_alerting`: alert repeats and up to three escalation levels (`PUT /projects/:id/alerting`). This
    is the escalation-policy API that exists on `main` today.
- Data sources: `montral_monitor` (by id, or by name within a project) and `montral_project` (by id, by name, or the
  current project).
- No API change was needed. Channels and maintenance windows have no single-object GET, so the provider reads them
  through the project's list endpoint.

## Design decisions
- **Drift.** Every Read refreshes from the API. An out-of-band change makes the plan non-empty, and the next apply
  converges. A 404, or an object missing from its list, removes the resource from state, so the plan creates it again.
- **Validation at plan time**, mirroring the API: zod ranges and enums as attribute validators, plus cross-field rules
  ported from `routes/monitors.ts`, `http-request.ts`, `json-assertion.ts` (the JSON path grammar, rule for rule),
  `netguard.ts` (`hostPort` and `strictHostPort` target shapes), `routes/channels.ts` (per-type settings) and
  `routes/maintenance.ts`. Where the API would silently change a value (DNS settings on other types, domain and
  certificate intervals outside 1 h to 1 day, unknown channel settings dropped, `""` turned into null), the provider
  refuses the value instead. Otherwise Terraform would fail later with "inconsistent result after apply".
- **Write-only values.** A status page password is stored as a hash and never returned. Channel credentials, monitor
  headers and monitor request bodies are masked for non-managers. For these values the provider keeps state as the
  source of truth, sends the password only when it changes, and documents the drift limits. `ImportStateVerify`
  ignores only the password.
- **Server defaults.** Values the API fills in by itself (ntfy priority "3") are not forced into state. Auto-enabled
  channels are kept when `channel_ids` is unset; when it is set, it is applied exactly (one PATCH after create).
- **Errors and retries.** Each error names the method, the path, the HTTP status, Montral's `code` and the message.
  zod validation errors are flattened to `path: message`. 429 and 503 are retried with exponential backoff and jitter,
  honouring `Retry-After` (capped at 60 s). Other 4xx answers are never retried. Writes are not repeated after a
  transport error. Unknown fields in answers are ignored.
- **Docs.** `docs/` uses the tfplugindocs layout, rendered from the provider's own schema and `examples/`.
  `TestDocsAreCurrent` fails CI when a page is stale. tfplugindocs itself needs a Terraform binary, so a small renderer
  produces the same format.

## Tests
Unit tests (no server, `go test ./...`):
- `internal/client`: endpoint parsing; auth and project headers; decoding with unknown fields; 429 retry honouring
  Retry-After; 503 backoff growth; Retry-After cap; giving up after the retry budget; no retry for 400, 401, 402, 403,
  404, 409 and 413; transport errors retried for GET but not POST; context cancellation; every API error shape (route
  error with code, zod issues, zod 4 message, non-JSON, empty); the API key never appears in an error.
- `internal/provider`: every schema is valid and the secrets are marked sensitive; monitor cross-field rules (35
  cases); JSON path grammar (accept and reject lists from the API's documentation); channel settings per type (21
  cases); maintenance timing and recurrence; splitting masked or defaulted channel settings; instant equality; import
  ID parsing; docs are current.

Acceptance tests (`TF_ACC=1`, against the real Node server and PostgreSQL 18 in `montral-terraform.yml`):
- `TestAccMonitor_basic`: create, read, in-place update (name, interval, keyword, thresholds, pause), resume, import
  by id and by `<project_id>/<id>` with `ImportStateVerify`, destroy with an API check.
- `TestAccMonitor_replace`: changing the type is a replace (plan check) with a new id.
- `TestAccMonitor_types`: tcp, dns (AAAA, contains), heartbeat (token and URL), ping, certificate, keyword-absent, JSON
  assertion with a POST body and headers, a dependency. Heartbeat and JSON monitors are imported and verified.
- `TestAccMonitor_drift`: PATCH through the API between steps, then a plan-only step expects a non-empty plan, then
  apply is an in-place update back to the configuration.
- `TestAccMonitor_disappears`: delete through the API, then the plan is a create and the id is new.
- `TestAccMonitor_validation`: 13 plan-time errors. `TestAccMonitor_apiError`: a server refusal surfaces as
  `HTTP 400 [dependency_not_found]`.
- `TestAccAlertChannel_basic`: webhook, project-scoped email with auto-enable, ntfy (the server's default priority is
  not forced into state); in-place update of name, enabled and secret URL; import of all three; a type change is a
  replace.
- `TestAccAlertChannel_driftAndDisappears`, `TestAccAlertChannel_validation` (7 cases).
- `TestAccStatusPage_basic`: create with grouped components; in-place update to password visibility; import ignoring
  the password; drift (title, theme and components changed through the API, then converged); slug change is a
  replace; out-of-band delete. `TestAccStatusPage_validation` (5 cases).
- `TestAccMaintenanceWindow_basic`: offset spelling without drift, replace on change, import, out-of-band delete,
  weekly series with destroy cancelling it. `TestAccMaintenanceWindow_validation` (4 cases).
- `TestAccProjectAlerting_basic` (two escalation levels referencing channels, update, import),
  `TestAccProjectAlerting_validation`.
- `TestAccDataSources`: project (current, by id, by name) and monitor (by id, by name).
- `TestAccMultiResource`: a channel, monitors referencing it, a status page referencing the monitors, a maintenance
  window and project escalation. A title change is the only planned update.
- CI also runs `go mod verify`, `go mod tidy -diff`, `gofmt`, `go vet`, the build, and `terraform validate` of every
  example directory through `dev_overrides`.

## CI
Workflow `.github/workflows/montral-terraform.yml`: push to main, pull requests, workflow_dispatch; concurrency as in
`montral-ci.yml`; `contents: read`. It uses `postgres:18.6-alpine`, Node 24.22.1, pnpm 10.0.0,
`actions/setup-go@b7ad1da` (v7.0.0, Go 1.27.3), and `hashicorp/setup-terraform@dfe3c3f` (v4.0.1, Terraform 1.17.1,
wrapper off). `scripts/qualify-terraform.mjs` starts `apps/api/dist/server.mjs` on the disposable
`montral_test_tf_ci` database with the same environment as the other qualification scripts (plus
`ALLOW_PRIVATE_TARGETS=true`, so monitors check the server itself). It waits for `/health`, signs up a synthetic user,
creates an API key through `/api/auth/api-key/create`, checks that the key works on its own, and runs
`go test ./... -v` with `TF_ACC=1`.

The other workflows are unaffected. `verify-active-branding.sh` scans only `apps/` and `packages/`,
`verify_sources.py` checks only `vendor/`, and the Go module is not part of the pnpm workspace.

Results are recorded in the pull request.

## Dependencies
terraform-plugin-framework v1.19.0, terraform-plugin-framework-validators v0.19.0, terraform-plugin-go v0.31.0,
terraform-plugin-log v0.11.0, terraform-plugin-testing v1.16.0 (tests): all MPL-2.0. Transitive modules are MPL-2.0,
MIT, BSD or Apache-2.0, none under the GPL family. Every version is pinned in `go.mod` and `go.sum`.

## Not published
The provider is not uploaded to any registry, and no tags or releases were created. Users build from source and use
`dev_overrides` (README). Publication needs the owner's go-ahead.

## Known limitations and follow-ups
- `montral_escalation_policy` (on-call schedules): the on-call API is in pull request #48 and not on `main`; add the
  resource once it merges.
- A password changed in the dashboard cannot be detected (the API never returns it). With a member's key, neither can
  channel credentials, monitor headers or request bodies.
- Maintenance windows are read from the project's list (the latest 1000). Every change replaces the window.
- Not covered yet: status page custom domains, share links and subscribers; incidents; webhook inboxes; workspace
  settings; project creation.
