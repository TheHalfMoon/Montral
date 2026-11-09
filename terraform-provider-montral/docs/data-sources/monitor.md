---
page_title: "montral_monitor Data Source - terraform-provider-montral"
subcategory: ""
description: |-
  Looks up one monitor by `id`, or by `name` within a project (`project_id`, else the provider's project).
---

# montral_monitor (Data Source)

Looks up one monitor by `id`, or by `name` within a project (`project_id`, else the provider's project). Request headers and bodies are not exposed.

## Example Usage

```terraform
data "montral_monitor" "api" {
  name = "API health"
}

output "api_monitor_status" {
  value = data.montral_monitor.api.status
}
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Optional

- `id` (String) Monitor UUID.
- `name` (String) Monitor name (exact match; must be unique in the project).
- `project_id` (String) Project to search by name in.

### Read-Only

- `channel_ids` (Set of String) Alert channels.
- `created_at` (String) Creation time (RFC 3339).
- `expected_status` (Number) Expected HTTP status.
- `failure_threshold` (Number) Consecutive failures before an incident.
- `interval_sec` (Number) Seconds between checks.
- `method` (String) HTTP method.
- `paused` (Boolean) Whether checks are paused.
- `recovery_threshold` (Number) Consecutive successes before recovery.
- `regions` (List of String) Regions.
- `status` (String) Current state.
- `tags` (List of String) Tags.
- `target` (String) Target.
- `timeout_ms` (Number) Check timeout in milliseconds.
- `type` (String) Check protocol.
