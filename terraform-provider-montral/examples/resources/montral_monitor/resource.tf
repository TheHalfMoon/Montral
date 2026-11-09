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
