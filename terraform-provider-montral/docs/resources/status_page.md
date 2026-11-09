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
  # write-only (Terraform 1.11+): never stored in state; bump the version to send a new password
  password_wo         = var.partner_page_password
  password_wo_version = 1
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
- `password` (String, Sensitive) **Deprecated**: use `password_wo`. Page password (8-200 characters), kept (sensitive) in state and sent when it changes. Works on Terraform versions without write-only attributes.
- `password_wo` (String, Sensitive) Page password (8-200 characters) for `visibility = "password"`, write-only: it is never stored in the plan or state (Terraform 1.11+ / OpenTofu 1.11+). It is sent on create and whenever `password_wo_version` changes. Changing it signs every outside visitor out.
- `password_wo_version` (Number) Any number that you change to send `password_wo` again: Terraform cannot compare a write-only value, so this is the trigger for rotating the password.
- `project_id` (String) Project UUID; defaults to the provider's project.
- `show_latency` (Boolean) Show response times. Default true.
- `theme` (String) `light` (default), `dark` or `auto`.
- `uptime_ok_pct` (Number) Uptime bars are green at or above this percentage (1-100). Montral's default is 99.9; when the argument is removed the current value is kept.
- `uptime_warn_pct` (Number) Uptime bars are amber at or above this percentage (1-100, below `uptime_ok_pct`), red below. Montral's default is 98; when the argument is removed the current value is kept.
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

- `group_name` (String) Group heading (1-60 characters, no surrounding spaces); consecutive components with the same group are shown together. Default `Services`, as in Montral.

## Password

Montral stores a page password as a PBKDF2 hash and never returns it. Set it with the write-only `password_wo`
(Terraform 1.11 or later, OpenTofu 1.11 or later). Its value is never written to the plan or the state. Terraform cannot
compare a value it does not store, so the password is sent on create and whenever `password_wo_version` changes. To
rotate the password, change both.

```terraform
resource "montral_status_page" "partners" {
  slug                = "partners"
  title               = "Partner status"
  visibility          = "password"
  password_wo         = var.partner_page_password
  password_wo_version = 2 # bump to send a new password
}
```

The older `password` argument still works on older Terraform versions, but it is deprecated because it keeps the
password (sensitive) in state. To migrate, replace `password = ...` with `password_wo = ...` and
`password_wo_version = 1`. The next apply sends the password once more and removes it from state.

A password changed in the dashboard is not detected either way. `has_password` shows whether one is set. Removing the
password arguments keeps the stored hash. Every other attribute, including `components`, is refreshed on every plan.

## Import

Import is supported using the following syntax:

```shell
# the page password is never returned by the API: keep it in configuration after importing
terraform import montral_status_page.public 3f1e1c1a-0000-4000-8000-000000000003
```
