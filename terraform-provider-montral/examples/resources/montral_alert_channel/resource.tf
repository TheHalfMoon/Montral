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
