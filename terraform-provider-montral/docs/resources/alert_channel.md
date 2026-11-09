---
page_title: "montral_alert_channel Resource - terraform-provider-montral"
subcategory: ""
description: |-
  A Montral alert channel (email, Slack, Discord, Teams, webhook, PagerDuty, Telegram, ntfy, Gotify, Pushover, Google Chat, Mattermost, Lark or push).
---

# montral_alert_channel (Resource)

A Montral alert channel (email, Slack, Discord, Teams, webhook, PagerDuty, Telegram, ntfy, Gotify, Pushover, Google Chat, Mattermost, Lark or push). Credentials go in the sensitive `secret_config`; everything else in `config`. Changing `type`, `scope` or `project_id` replaces the channel.

## Example Usage

```terraform
resource "montral_alert_channel" "slack" {
  name          = "Slack #incidents"
  type          = "slack"
  secret_config = { url = var.slack_webhook_url }
}

resource "montral_alert_channel" "oncall_email" {
  name        = "On-call email"
  type        = "email"
  scope       = "project"
  auto_enable = true # new monitors of the project alert it
  config      = { to = "oncall@example.com" }
}

resource "montral_alert_channel" "pagerduty" {
  name          = "PagerDuty"
  type          = "pagerduty"
  secret_config = { routingKey = var.pagerduty_routing_key }
}

resource "montral_alert_channel" "ntfy" {
  name   = "ntfy"
  type   = "ntfy"
  config = { priority = "4" }
  secret_config = {
    url   = "https://ntfy.sh"
    topic = "example-alerts"
  }
}

resource "montral_alert_channel" "telegram" {
  name          = "Telegram"
  type          = "telegram"
  config        = { chatId = "-1001234567890" }
  secret_config = { botToken = var.telegram_bot_token }
}

variable "slack_webhook_url" {
  type      = string
  sensitive = true
}

variable "pagerduty_routing_key" {
  type      = string
  sensitive = true
}

variable "telegram_bot_token" {
  type      = string
  sensitive = true
}
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Required

- `name` (String) Display name (1-80 characters).
- `type` (String) Channel type: `discord`, `email`, `googlechat`, `gotify`, `lark`, `mattermost`, `ntfy`, `pagerduty`, `push`, `pushover`, `slack`, `teams`, `telegram`, `webhook`. `push` needs APNs configured on the server.

### Optional

- `auto_enable` (Boolean) New monitors of the project start out alerting this channel. Default false.
- `config` (Map of String) Non-secret settings: `to` (email), `chatId` (telegram), `priority` (ntfy, "1"-"5", default "3"), `device` (pushover).
- `enabled` (Boolean) Whether alerts are delivered. Default true.
- `project_id` (String) Project of a `project`-scoped channel; null for workspace channels.
- `scope` (String) `workspace` (default): shared by every project of the workspace. `project`: only the project in `project_id` (or the provider's project). A key limited to projects can create `project` channels only.
- `secret_config` (Map of String, Sensitive) Credentials: `url` (slack, discord, teams, webhook, googlechat, mattermost, lark, ntfy, gotify), `secret` (lark), `botToken` (telegram), `routingKey` (pagerduty), `token` (ntfy, gotify, pushover), `topic` (ntfy), `userKey` (pushover). Montral returns them only to workspace owners and admins; with any other key they are write-only and kept from state, so out-of-band changes to them cannot be detected.

### Read-Only

- `created_at` (String) Creation time (RFC 3339).
- `id` (String) Channel UUID.

## Secrets and drift

Settings Montral treats as credentials (`url`, `secret`, `botToken`, `routingKey`, `token`, `topic`, `userKey`) belong in
`secret_config`, which is sensitive. The API returns them only to workspace owners and admins. With such a key, `terraform plan`
detects any out-of-band change. With a member's key the API returns placeholders instead: the provider then keeps the values from
state and cannot detect a credential changed outside Terraform (names, toggles and plain settings are still refreshed).
Both maps are stored in the state file. Protect it like any other secret store.

Settings the API fills in itself (ntfy `priority = "3"`) are left out of state unless configured.
Montral refuses to delete a channel that monitors still alert. Terraform removes the monitor reference first when both
are in the same configuration.

## Import

Import is supported using the following syntax:

```shell
# workspace channels by id; a project channel outside the provider's project as <project_id>/<channel_id>
terraform import montral_alert_channel.slack 3f1e1c1a-0000-4000-8000-000000000002
```
