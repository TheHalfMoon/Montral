---
page_title: "montral_project_alerting Resource - terraform-provider-montral"
subcategory: ""
description: |-
  Alert repeats and escalation levels of one project (Settings → Alerting).
---

# montral_project_alerting (Resource)

Alert repeats and escalation levels of one project (Settings → Alerting). There is one per project: creating it takes over the project's settings, and destroying it resets them (no repeats, no email repeats, no escalation). Needs a workspace owner's or admin's API key.

## Example Usage

```terraform
data "montral_project" "current" {}

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

# Repeat unacknowledged alerts every 15 minutes; page PagerDuty after 20 minutes
resource "montral_project_alerting" "current" {
  project_id            = data.montral_project.current.id
  reminder_interval_min = 15
  escalation = [
    { channel_ids = [montral_alert_channel.slack.id], escalate_after_min = 5 },
    { channel_ids = [montral_alert_channel.pagerduty.id], escalate_after_min = 20 },
  ]
}

variable "slack_webhook_url" {
  type      = string
  sensitive = true
}

variable "pagerduty_routing_key" {
  type      = string
  sensitive = true
}
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Required

- `project_id` (String) Project UUID.

### Optional

- `escalation` (Attributes List) Up to 3 ordered levels: each notifies its channels when an incident is still unacknowledged that many minutes after it started. Each level must come later than the one before. (see [below for nested schema](#nestedatt--escalation))
- `reminder_email` (Boolean) Repeats also go to email channels. Default false.
- `reminder_interval_min` (Number) Repeat an unacknowledged alert every 5, 10, 15, 30 or 60 minutes (at most 10 repeats); unset = no repeats.

### Read-Only

- `id` (String) Same as `project_id`.

<a id="nestedatt--escalation"></a>
### Nested Schema for `escalation`

### Required

- `channel_ids` (Set of String) 1-5 alert channels (workspace channels or this project's).
- `escalate_after_min` (Number) Minutes after the incident started (1-1440).

## Lifecycle

A project always has alerting settings. Creating this resource overwrites them, and destroying it resets them to the defaults
(no repeats, no email repeats, no escalation).

## Import

Import is supported using the following syntax:

```shell
# by project id
terraform import montral_project_alerting.current 3f1e1c1a-0000-4000-8000-000000000005
```
