# Terraform provider for Montral

Manage [Montral](../README.md) monitors, alert channels, status pages, maintenance windows and project escalation as code,
with Terraform (1.0+) or OpenTofu. The provider talks to Montral's REST API (`/api/*`) with an API key.

> **Unpublished.** This provider is not on the Terraform or OpenTofu registry. No release tags or GitHub releases are
> made for it. Build it from source as described below. Publication waits for the owner's go-ahead.

| Kind | Name | Notes |
|---|---|---|
| Resource | `montral_monitor` | http (keyword and JSON assertions), tcp, dns, heartbeat, ping, certificate, domain, websocket, postgres, mysql, redis |
| Resource | `montral_alert_channel` | email, slack, discord, teams, webhook, pagerduty, telegram, ntfy, gotify, pushover, googlechat, mattermost, lark, push |
| Resource | `montral_status_page` | components, groups, theme, visibility, write-only password, maintenance reminders |
| Resource | `montral_maintenance_window` | one-off or daily/weekly series; every change replaces (the API has no edit) |
| Resource | `montral_project_alerting` | alert repeats and up to three escalation levels per project |
| Data source | `montral_monitor` | by id, or by name within a project |
| Data source | `montral_project` | by id, by name, or the current project |

Reference pages for each resource and data source are in [`docs/`](docs/) (tfplugindocs layout). Examples are in
[`examples/`](examples/).

## Build from source

Requirements: Go 1.27.3 (see `go.mod`), and Terraform or OpenTofu.

```sh
cd terraform-provider-montral
go build -o "$HOME/.terraform.d/montral-dev/terraform-provider-montral" .
# Windows: go build -o "%APPDATA%\terraform.d\montral-dev\terraform-provider-montral.exe" .
```

Any output directory works. Put only this binary in it.

## Use the local build (`dev_overrides`)

Tell Terraform to load the provider from that directory instead of a registry. Create a CLI configuration file:

```hcl
# ~/.terraformrc (Windows: %APPDATA%\terraform.rc), or any file named by TF_CLI_CONFIG_FILE
provider_installation {
  dev_overrides {
    "registry.terraform.io/thehalfmoon/montral" = "/home/you/.terraform.d/montral-dev"
  }
  direct {}
}
```

For OpenTofu use the key `"registry.opentofu.org/thehalfmoon/montral"` (OpenTofu reads `~/.tofurc`).

With `dev_overrides`, skip `terraform init` for this provider and run `terraform plan` / `apply` directly. Terraform warns
that overrides are in effect. The warning is expected.

```hcl
terraform {
  required_providers {
    montral = {
      source = "thehalfmoon/montral"
    }
  }
}

provider "montral" {
  endpoint = "https://montral.example.com" # or MONTRAL_ENDPOINT
  # api_key: set MONTRAL_API_KEY instead of writing the key here
  # project_id: optional (MONTRAL_PROJECT_ID); defaults to the key's first project
}

resource "montral_alert_channel" "ops" {
  name          = "Ops webhook"
  type          = "webhook"
  secret_config = { url = var.ops_webhook_url }
}

resource "montral_monitor" "api" {
  name          = "API health"
  type          = "http"
  target        = "https://api.example.com/health"
  json_path     = "$.status"
  json_expected = "ok"
  channel_ids   = [montral_alert_channel.ops.id]
}

resource "montral_status_page" "public" {
  slug       = "example-status"
  title      = "Example status"
  components = [{ monitor_id = montral_monitor.api.id, group_name = "API" }]
}
```

A complete stack (channel, monitors, status page, maintenance window, escalation) is in
[`examples/complete/main.tf`](examples/complete/main.tf).

## Authentication and scope

Create an API key in the dashboard (Settings → API keys). The key belongs to one workspace. If it is limited to some
projects, the provider can reach only those projects. Use a **workspace owner's or admin's** key:

- deleting monitors, channels, status pages and maintenance windows, and editing status pages and project alerting,
  need owner or admin rights;
- channel credentials, monitor request headers and request bodies are returned only to owners and admins. With a
  member's key the provider keeps those values from state and cannot detect changes made to them outside Terraform.

The API key is marked sensitive, read from `MONTRAL_API_KEY` when not set in the provider block, and never logged.
The endpoint must be `https://`, except on `localhost`, `127.0.0.1` or `::1`. A plain `http://` endpoint elsewhere is
refused unless the provider block sets `insecure_http = true`, because the key and every secret would cross the network
unencrypted. TLS certificates are always verified (Go's default trust store, which honours `SSL_CERT_FILE` / `SSL_CERT_DIR` on Linux).
For a deployment behind a private CA, add the CA to the system trust store.

Resources use the provider's `project_id` unless they set their own. Objects that the API lists per project (alert
channels, maintenance windows) import as `<project_id>/<id>` when they are outside the provider's project.

## Behaviour

- **Maintenance windows** are read one by one (`GET /maintenance/:id`), so ended windows and long series beyond the
  list's 1000-window cap are never dropped from state.
- **Drift.** Every read refreshes from the API, so a change made in the dashboard shows in `terraform plan` and the next
  `apply` converges. An object deleted outside Terraform (HTTP 404, or missing from its list) is removed from state and
  planned for creation.
- **Validation.** Plan-time checks mirror the API's rules (ranges, enums, target formats per monitor type, JSON path
  grammar, request bodies only with non-GET/HEAD HTTP, DNS settings only on DNS monitors, explicit regions only for
  http/tcp/websocket, 1 h-1 day intervals for domain/certificate checks, channel settings per type, uptime thresholds,
  maintenance timing). Anything only the server can know (private targets, unknown regions, plan limits, slug
  collisions) is reported from the API at apply time.
- **Errors.** API errors name the call, the HTTP status and Montral's error code, for example
  `Montral API POST /monitors returned HTTP 400 [target_not_allowed]: ...`.
- **Retries.** 429 is retried up to five times with exponential backoff and jitter, honouring `Retry-After` (capped at
  60 s). 503 is retried the same way for reads, updates and deletes. For a POST, which creates something, a 503 is
  retried only when it is Montral's own rolled-back answer (`{"error":"Temporarily unavailable, please retry"}`, sent
  after PostgreSQL rolled the transaction back). A 503 from a proxy could hide a request that was already processed.
  Other 4xx answers are never retried. Transport errors are retried for reads only.
- **Compatibility.** Unknown fields in API answers are ignored, so a newer server does not break an older provider.

### Write-only values and drift limits

| Value | Returned by the API | Provider behaviour |
|---|---|---|
| `montral_status_page.password_wo` | never (stored as a hash) | write-only (Terraform/OpenTofu 1.11+): never in plan or state; sent on create and when `password_wo_version` changes; out-of-band changes undetectable |
| `montral_status_page.password` (deprecated) | never | kept in state (sensitive) for Terraform < 1.11; migrate by replacing it with `password_wo` + `password_wo_version = 1` |
| `montral_alert_channel.secret_config` | to owners/admins only | refreshed with an owner/admin key; kept from state otherwise |
| `montral_monitor.headers`, `request_body` | to owners/admins only | refreshed with an owner/admin key; kept from state otherwise |
| `montral_monitor.heartbeat_token`, `heartbeat_url` | yes | read-only, sensitive |

Sensitive values are still written to the state file, so protect state like any secret store (encrypted remote backend,
restricted access).

## Development

```sh
go vet ./...
go test ./...                                   # unit tests; acceptance tests skip without TF_ACC
MONTRAL_UPDATE_DOCS=1 go test ./internal/provider -run TestDocsAreCurrent   # regenerate docs/ from the schema
```

Acceptance tests (`TF_ACC=1`) create real objects and need a Montral server that allows private targets:

```sh
TF_ACC=1 MONTRAL_ENDPOINT=http://127.0.0.1:8787 MONTRAL_API_KEY=montral_... go test ./... -v
```

In CI, [`.github/workflows/montral-terraform.yml`](../.github/workflows/montral-terraform.yml) builds the Node server and
web app, starts them against a disposable PostgreSQL database (`montral_test_tf_ci`), creates a synthetic user,
workspace and API key through the API ([`scripts/qualify-terraform.mjs`](../scripts/qualify-terraform.mjs)), and runs
the acceptance tests with Terraform 1.17.1.

## Dependencies and licences

| Module | Version | Licence |
|---|---|---|
| github.com/hashicorp/terraform-plugin-framework | v1.19.0 | MPL-2.0 |
| github.com/hashicorp/terraform-plugin-framework-validators | v0.19.0 | MPL-2.0 |
| github.com/hashicorp/terraform-plugin-go | v0.31.0 | MPL-2.0 |
| github.com/hashicorp/terraform-plugin-log | v0.11.0 | MPL-2.0 |
| github.com/hashicorp/terraform-plugin-testing (tests only) | v1.16.0 | MPL-2.0 |

Exact versions of every module, including indirect ones, are pinned in `go.mod` and `go.sum`. The transitive modules
(build and test) are under MPL-2.0, MIT, BSD-2/3-Clause or Apache-2.0 (checked from each module's licence file on
2026-11-09). None is under the GPL family. MPL-2.0 is file-level copyleft: the provider links these modules unmodified,
and its own code is under the repository's MIT licence.

## Not yet covered

- `montral_escalation_policy` / on-call schedules: the on-call API is not on `main` yet (pull request #48). Add the
  resource once it merges.
- Status page custom domains, share links and subscribers; incidents; webhook inboxes; workspace settings.
