resource "montral_monitor" "db" {
  name   = "Database port"
  type   = "tcp"
  target = "db.example.com:5432"
}

# One window for one monitor
resource "montral_maintenance_window" "upgrade" {
  name        = "PostgreSQL upgrade"
  starts_at   = "2026-12-05T02:00:00Z"
  ends_at     = "2026-12-05T04:00:00Z"
  monitor_ids = [montral_monitor.db.id]
}

# Every Sunday 03:00-03:30 Toronto time until the end of March, for every monitor of the project
resource "montral_maintenance_window" "weekly" {
  name      = "Weekly patching"
  starts_at = "2026-12-06T03:00:00-05:00"
  ends_at   = "2026-12-06T03:30:00-05:00"
  recurrence = {
    frequency = "weekly"
    time_zone = "America/Toronto"
    until     = "2027-03-28T03:00:00-04:00"
  }
}
