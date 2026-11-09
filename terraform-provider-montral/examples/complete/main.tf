# A complete stack: an alert channel, monitors that use it, a public status page showing them, a maintenance window,
# and project escalation. Run with MONTRAL_ENDPOINT and MONTRAL_API_KEY set (see the README for dev_overrides).
terraform {
  required_providers {
    montral = {
      source = "thehalfmoon/montral"
    }
  }
}

provider "montral" {}

variable "ops_webhook_url" {
  type        = string
  sensitive   = true
  description = "Where alerts are POSTed."
}

variable "site" {
  type    = string
  default = "https://www.example.com"
}

data "montral_project" "current" {}

resource "montral_alert_channel" "ops" {
  name          = "Ops webhook"
  type          = "webhook"
  secret_config = { url = var.ops_webhook_url }
}

resource "montral_monitor" "site" {
  name        = "Website"
  type        = "http"
  target      = var.site
  keyword     = "<title>"
  channel_ids = [montral_alert_channel.ops.id]
  tags        = ["terraform"]
}

resource "montral_monitor" "api" {
  name          = "API"
  type          = "http"
  target        = "${var.site}/api/health"
  json_path     = "status"
  json_expected = "ok"
  channel_ids   = [montral_alert_channel.ops.id]
  tags          = ["terraform"]
}

resource "montral_monitor" "nightly_job" {
  name         = "Nightly job"
  type         = "heartbeat"
  interval_sec = 86400
  grace_sec    = 3600
  channel_ids  = [montral_alert_channel.ops.id]
}

resource "montral_status_page" "public" {
  slug  = "example-status"
  title = "Example status"
  components = [
    { monitor_id = montral_monitor.site.id, group_name = "Web" },
    { monitor_id = montral_monitor.api.id, group_name = "Web" },
    { monitor_id = montral_monitor.nightly_job.id, group_name = "Jobs" },
  ]
}

resource "montral_maintenance_window" "upgrade" {
  name        = "Database upgrade"
  starts_at   = "2026-12-05T02:00:00Z"
  ends_at     = "2026-12-05T03:00:00Z"
  monitor_ids = [montral_monitor.api.id]
}

resource "montral_project_alerting" "current" {
  project_id            = data.montral_project.current.id
  reminder_interval_min = 30
  escalation            = [{ channel_ids = [montral_alert_channel.ops.id], escalate_after_min = 10 }]
}

output "status_page_url" {
  value = montral_status_page.public.url
}

output "nightly_job_ping_url" {
  value     = montral_monitor.nightly_job.heartbeat_url
  sensitive = true
}
