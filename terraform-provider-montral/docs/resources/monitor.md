---
page_title: "montral_monitor Resource - terraform-provider-montral"
subcategory: ""
description: |-
  A Montral monitor: an HTTP(S) check (optionally with a keyword or JSON assertion), TCP, DNS, heartbeat, ping, TLS certificate, domain expiry, WebSocket, PostgreSQL, MySQL or Redis check.
---

# montral_monitor (Resource)

A Montral monitor: an HTTP(S) check (optionally with a keyword or JSON assertion), TCP, DNS, heartbeat, ping, TLS certificate, domain expiry, WebSocket, PostgreSQL, MySQL or Redis check. Changing `type` or `project_id` replaces the monitor.

## Example Usage

```terraform
# An HTTPS check with a JSON assertion, alerting a channel
resource "montral_monitor" "api" {
  name              = "API health"
  type              = "http"
  target            = "https://api.example.com/health"
  interval_sec      = 60
  timeout_ms        = 5000
  failure_threshold = 3
  json_path         = "$.status"
  json_expected     = "ok"
  headers = {
    Authorization = "Bearer ${var.health_token}"
  }
  tags        = ["production", "api"]
  channel_ids = [montral_alert_channel.ops.id]
}

# A keyword check that fails when the page says "maintenance"
resource "montral_monitor" "homepage" {
  name         = "Homepage"
  type         = "http"
  target       = "https://www.example.com/"
  keyword      = "maintenance"
  keyword_mode = "absent"
}

# A heartbeat: your job calls heartbeat_url at least once a day
resource "montral_monitor" "nightly_backup" {
  name         = "Nightly backup"
  type         = "heartbeat"
  interval_sec = 86400
  grace_sec    = 1800
}

resource "montral_monitor" "db" {
  name   = "Database port"
  type   = "tcp"
  target = "db.example.com:5432"
}

resource "montral_monitor" "mx" {
  name               = "MX record"
  type               = "dns"
  target             = "example.com"
  dns_record_type    = "MX"
  dns_expected_value = "mail.example.com"
  dns_match_mode     = "contains"
}

resource "montral_monitor" "tls" {
  name                    = "TLS certificate"
  type                    = "certificate"
  target                  = "www.example.com:443"
  interval_sec            = 86400
  domain_expiry_warn_days = 21
}

resource "montral_monitor" "gateway" {
  name   = "Gateway ping"
  type   = "ping"
  target = "gateway.example.com"
}

resource "montral_alert_channel" "ops" {
  name          = "Ops webhook"
  type          = "webhook"
  secret_config = { url = var.ops_webhook_url }
}

variable "health_token" {
  type      = string
  sensitive = true
}

variable "ops_webhook_url" {
  type      = string
  sensitive = true
}

output "backup_ping_url" {
  value     = montral_monitor.nightly_backup.heartbeat_url
  sensitive = true
}
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Required

- `name` (String) Display name (1-120 characters).
- `type` (String) Check protocol: `http`, `tcp`, `dns`, `heartbeat`, `postgres`, `mysql`, `redis`, `websocket`, `domain`, `certificate`, `ping`. Keyword and JSON checks are `http` monitors with `keyword` or `json_path`. `ping` and `certificate` need the self-hosted Node runtime. Changing it replaces the monitor.

### Optional

- `channel_ids` (Set of String) Alert channel UUIDs this monitor notifies. Unset: Montral's choice (auto-enabled channels on creation) is kept and refreshed. Set: exactly these channels, auto-enabled ones included only if listed.
- `depends_on_monitor_id` (String) Parent monitor UUID in the same project; while it is down this monitor opens no incidents.
- `dns_expected_value` (String) DNS monitors: an answer that must be present.
- `dns_match_mode` (String) DNS monitors: `exact` (default) or `contains`.
- `dns_record_type` (String) DNS monitors: record type (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`). Default `A`.
- `domain_expiry_warn_days` (Number) domain and certificate monitors: fail this many days (1-365) before expiry. Default 30.
- `expected_location` (String) For an expected 3xx: the Location (full http(s) URL or a path starting with `/`) the redirect must point to.
- `expected_status` (Number) HTTP status that counts as healthy (100-599). An expected 3xx is checked without following the redirect. Default 200.
- `failure_threshold` (Number) Consecutive failed checks before an incident opens and alerts escalate (1-10). Default 3.
- `grace_sec` (Number) Heartbeat monitors: extra seconds (0-86400) after a deadline before a ping counts as missed. Default 0.
- `headers` (Map of String, Sensitive) HTTP (or WebSocket handshake) request headers. Sensitive: they often carry tokens.
- `interval_sec` (Number) Seconds between checks (60-86400), or the expected heartbeat period. domain and certificate monitors: 3600-86400. Default 60.
- `json_expected` (String) Text the value at `json_path` must equal or contain; required unless `json_match = "exists"`.
- `json_match` (String) `equals` (default), `contains` or `exists`.
- `json_path` (String) HTTP only: path of one value in a JSON body, such as `status`, `$.data.items[0].state` or `["key with space"]`.
- `keyword` (String) Text the HTTP body (or the first WebSocket message) must contain, or must not contain with `keyword_mode = "absent"`.
- `keyword_mode` (String) `contains` (default) or `absent`.
- `method` (String) HTTP method (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`). Default `GET`.
- `min_regions_failing` (Number) Failed regions needed to mark a multi-region monitor down (0-20); 0 = a majority. Default 0.
- `paused` (Boolean) Pause checks and alerts. Default false.
- `project_id` (String) Project UUID; defaults to the provider's project. Changing it replaces the monitor.
- `recovery_threshold` (Number) Consecutive successful checks before recovering (1-10). Default 1.
- `regions` (List of String) Region ids to check from; `auto` (default) uses this deployment. Explicit regions need configured probes and work for http, tcp and websocket only.
- `request_body` (String, Sensitive) HTTP request body (up to 16384 bytes); not with GET or HEAD. Set Content-Type in `headers`.
- `slow_alert_after` (Number) Consecutive slow checks (0-20) before a slow-response alert; 0 disables them. Default 0.
- `slow_threshold_ms` (Number) Latency (100-60000 ms) above which a successful check counts as slow. Default 1500.
- `tags` (List of String) Dashboard labels (at most 20, each 1-32 characters without surrounding spaces).
- `target` (String) http: absolute http(s) URL; websocket: ws(s):// URL; tcp: host:port; dns and ping: hostname; certificate: host or host:port; domain: registered domain; postgres/mysql/redis: connection URL; heartbeat: leave unset. Private addresses are refused unless the server sets `ALLOW_PRIVATE_TARGETS=true`.
- `timeout_ms` (Number) Check timeout in milliseconds (1000-30000). Default 10000.
- `ws_message` (String) WebSocket only: text sent after the handshake; a reply must arrive within the timeout.

### Read-Only

- `created_at` (String) Creation time (RFC 3339).
- `heartbeat_token` (String, Sensitive) Heartbeat monitors: the secret token of the ping URL.
- `heartbeat_url` (String, Sensitive) Heartbeat monitors: the URL your job calls (GET or POST).
- `id` (String) Monitor UUID.
- `status` (String) Current state (`pending`, `up`, `down`, `paused`, ...). Informational; refreshed on every read.

## Drift

Every argument is refreshed on each plan: a monitor edited or paused in the dashboard shows as a change, and a deleted
monitor is created again. Request `headers` and `request_body` are shown by the API only to workspace owners and
admins. With a member's key they are kept from state and out-of-band changes to them are not detected.
`status` is informational and never causes a diff.

## Import

Import is supported using the following syntax:

```shell
# by monitor id, or <project_id>/<monitor_id>
terraform import montral_monitor.api 3f1e1c1a-0000-4000-8000-000000000001
```
