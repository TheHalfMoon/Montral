---
page_title: "montral_status_page Resource - terraform-provider-montral"
subcategory: ""
description: |-
  A public (or members-only, or password-protected) Montral status page showing monitors as ordered, optionally grouped components.
---

# montral_status_page (Resource)

A public (or members-only, or password-protected) Montral status page showing monitors as ordered, optionally grouped components. Changing `slug` or `project_id` replaces the page.

## Example Usage

```terraform
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
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Required

- `slug` (String) URL slug (3-40 lowercase letters, digits or hyphens), unique on the deployment: the page is served at `/status/<slug>`. Changing it replaces the page.
- `title` (String) Page title (1-120 characters).

### Optional

- `components` (Attributes List) Monitors shown on the page, in order (at most 200). Monitors must belong to the page's project. (see [below for nested schema](#nestedatt--components))
- `external_url` (String) Website the page header links to (http or https).
- `hide_branding` (Boolean) Hide Montral's name and mark (where the plan allows it). Default false.
- `maintenance_reminder_hours` (Number) Hours (0-168) before maintenance starts that subscribers are reminded; 0 = never. Default 24.
- `mcp_enabled` (Boolean) Let the public MCP tools serve this page. Default true.
- `password` (String, Sensitive) Page password (8-200 characters) for `visibility = "password"`. Write-only on Montral's side: it is stored as a hash and never returned, so Terraform keeps the configured value in state, sends it only when it changes, and cannot detect a password changed outside Terraform. Changing it signs every outside visitor out. Removing it from the configuration leaves the stored hash in place.
- `project_id` (String) Project UUID; defaults to the provider's project.
- `show_latency` (Boolean) Show response times. Default true.
- `theme` (String) `light` (default), `dark` or `auto`.
- `uptime_ok_pct` (Number) Uptime bars are green at or above this percentage (1-100). Default 99.9.
- `uptime_warn_pct` (Number) Uptime bars are amber at or above this percentage (1-100, below `uptime_ok_pct`), red below. Default 98.
- `visibility` (String) `public` (default), `members` (signed-in workspace members only) or `password` (members, or anyone with `password` or a share link).

### Read-Only

- `created_at` (String) Creation time (RFC 3339).
- `has_password` (Boolean) Whether Montral holds a password for the page.
- `id` (String) Status page UUID.
- `url` (String) Public address of the page (`<endpoint>/status/<slug>`).

<a id="nestedatt--components"></a>
### Nested Schema for `components`

### Required

- `monitor_id` (String) Monitor UUID.

### Optional

- `group_name` (String) Group heading (1-60 characters, no surrounding spaces); consecutive components with the same group are shown together.

## Password and drift

`password` is write-only on Montral's side: it is stored as a PBKDF2 hash and never returned. Terraform sends it on create
and when the configured value changes, and keeps it (sensitive) in state. A password changed in the dashboard is not
detected. `has_password` shows whether a password is set. Removing `password` from the configuration keeps the stored hash.
Every other attribute, including `components`, is refreshed on every plan.

## Import

Import is supported using the following syntax:

```shell
# the page password is never returned by the API: keep it in configuration after importing
terraform import montral_status_page.public 3f1e1c1a-0000-4000-8000-000000000003
```
