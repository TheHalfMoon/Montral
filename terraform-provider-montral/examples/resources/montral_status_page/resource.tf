resource "montral_monitor" "api" {
  name   = "API"
  type   = "http"
  target = "https://api.example.com/health"
}

resource "montral_monitor" "web" {
  name   = "Website"
  type   = "http"
  target = "https://www.example.com/"
}

resource "montral_status_page" "public" {
  slug                       = "example-status"
  title                      = "Example status"
  theme                      = "auto"
  external_url               = "https://www.example.com"
  maintenance_reminder_hours = 24
  components = [
    { monitor_id = montral_monitor.api.id, group_name = "Platform" },
    { monitor_id = montral_monitor.web.id, group_name = "Platform" },
  ]
}

# Only workspace members, or people with the password or a share link, can see this page
resource "montral_status_page" "partners" {
  slug       = "example-partners"
  title      = "Partner status"
  visibility = "password"
  password   = var.partner_page_password
  components = [{ monitor_id = montral_monitor.api.id }]
}

variable "partner_page_password" {
  type      = string
  sensitive = true
}

output "status_page_url" {
  value = montral_status_page.public.url
}
