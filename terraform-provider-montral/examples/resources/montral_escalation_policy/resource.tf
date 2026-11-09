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
