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
