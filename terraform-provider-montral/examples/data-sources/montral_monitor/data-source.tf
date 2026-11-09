data "montral_monitor" "api" {
  name = "API health"
}

output "api_monitor_status" {
  value = data.montral_monitor.api.status
}
