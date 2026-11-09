---
page_title: "montral_escalation_policy Resource - terraform-provider-montral"
subcategory: ""
description: |-
  An escalation policy: ordered steps that notify alert channels, people and whoever is on call on a schedule, each waiting `timeout_min` minutes for an acknowledgement before the next.
---

# montral_escalation_policy (Resource)

An escalation policy: ordered steps that notify alert channels, people and whoever is on call on a schedule, each waiting `timeout_min` minutes for an acknowledgement before the next. Monitors use it through `montral_monitor.escalation_policy_id`. Needs a workspace owner's or admin's API key. Edits use Montral's optimistic concurrency (`version`): a policy changed by someone else since the last refresh is refused, and the next plan shows the difference.

## Example Usage

```terraform
resource "montral_alert_channel" "slack" {
  name          = "Slack #incidents"
  type          = "slack"
  secret_config = { url = var.slack_webhook_url }
}

resource "montral_alert_channel" "pagerduty" {
  name          = "PagerDuty"
  type          = "pagerduty"
  secret_config = { routingKey = var.pagerduty_routing_key }
}

# Slack first; after 10 minutes without an acknowledgement, whoever is on call and PagerDuty; then the team lead.
resource "montral_escalation_policy" "default" {
  name         = "Production"
  repeat_count = 1
  steps = [
    { timeout_min = 10, channel_ids = [montral_alert_channel.slack.id] },
    { timeout_min = 15, channel_ids = [montral_alert_channel.pagerduty.id], schedule_ids = [var.primary_schedule_id] },
    { timeout_min = 30, user_ids = [var.team_lead_user_id] },
  ]
}

resource "montral_monitor" "api" {
  name                 = "API health"
  type                 = "http"
  target               = "https://api.example.com/health"
  escalation_policy_id = montral_escalation_policy.default.id
}

variable "slack_webhook_url" {
  type      = string
  sensitive = true
}

variable "pagerduty_routing_key" {
  type      = string
  sensitive = true
}

variable "primary_schedule_id" {
  type        = string
  description = "On-call schedule UUID (created in the dashboard or the on-call API)."
}

variable "team_lead_user_id" {
  type        = string
  description = "Montral user id of a workspace member."
}
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Required

- `name` (String) Name (1-80 characters, no surrounding spaces).
- `steps` (Attributes List) 1-10 ordered steps. Each needs at least one channel, person or schedule. (see [below for nested schema](#nestedatt--steps))

### Optional

- `project_id` (String) Project the policy belongs to; unset = workspace-wide (usable by every project). Unlike other resources it does not default to the provider's project. A key limited to projects must set it. Changing it replaces the policy.
- `repeat_count` (Number) How many more times the steps run after the last one while nobody acknowledges (0-5). Default 0 (once).

### Read-Only

- `created_at` (String) Creation time (RFC 3339).
- `id` (String) Policy UUID.
- `version` (Number) Montral's revision of the policy, bumped by every change; sent with updates and deletes.

<a id="nestedatt--steps"></a>
### Nested Schema for `steps`

### Required

- `timeout_min` (Number) Minutes (1-1440) to wait for an acknowledgement before the next step.

### Optional

- `channel_ids` (Set of String) Alert channels to notify (at most 10): workspace channels or the policy's project's.
- `schedule_ids` (Set of String) On-call schedules whose current on-call person is notified (at most 5).
- `user_ids` (Set of String) Workspace members to notify directly (at most 20 user ids).

## Concurrency and drift

Montral versions every policy. Updates and deletes send the `version` read at the last refresh, so a policy someone
changed in the meantime is refused (HTTP 409 `version_conflict`) instead of being overwritten. Run `terraform plan`
again to see their change, then apply. Every refresh reads the policy, so edits made in the dashboard show as drift, and a
policy deleted outside Terraform is created again. Deleting a policy detaches it from its monitors, which fall back to the
project's escalation levels.

On-call schedules (`schedule_ids`) are referenced by id. A `montral_oncall_schedule` resource is not provided yet.

## Import

Import is supported using the following syntax:

```shell
# by policy id
terraform import montral_escalation_policy.default 3f1e1c1a-0000-4000-8000-000000000006
```
