---
page_title: "montral_maintenance_window Resource - terraform-provider-montral"
subcategory: ""
description: |-
  A scheduled maintenance window: monitors in it open no incidents and send no alerts, and status pages announce it.
---

# montral_maintenance_window (Resource)

A scheduled maintenance window: monitors in it open no incidents and send no alerts, and status pages announce it. Montral's API creates and deletes windows but does not edit them, so every change replaces the window. A recurring window is a bounded daily or weekly series; destroying it cancels the whole series.

## Example Usage

```terraform
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
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Required

- `ends_at` (String) End, RFC 3339 with offset, after `starts_at`. For a series it fixes each occurrence's duration (at most 24 hours).
- `name` (String) Name shown in the dashboard, on status pages and in reminders (1-120 characters).
- `starts_at` (String) Start, RFC 3339 with offset (`2026-12-01T02:00:00Z`).

### Optional

- `monitor_ids` (Set of String) Monitors of this project covered by the window (at most 500); empty (default) covers every monitor of the project.
- `project_id` (String) Project UUID; defaults to the provider's project.
- `recurrence` (Attributes) Repeat the window daily or weekly at the first start's local time, until `until` (within 366 days of `starts_at`). (see [below for nested schema](#nestedatt--recurrence))

### Read-Only

- `id` (String) UUID of the window (for a series, its first occurrence).
- `series_id` (String) Series UUID of a recurring window.

<a id="nestedatt--recurrence"></a>
### Nested Schema for `recurrence`

### Required

- `frequency` (String) `daily` or `weekly`.
- `time_zone` (String) IANA time zone such as `America/Toronto`, or `UTC`.
- `until` (String) Last allowed start (inclusive), RFC 3339 with offset.

## Updates and drift

The API creates, lists and deletes maintenance windows but does not edit them, so changing any argument replaces the
window. The provider reads each window with `GET /maintenance/:id`, so ended windows and long series are refreshed
like any other. A window deleted outside Terraform is created again. An older server without that endpoint makes the
provider fall back to the project's list, which is capped at 1000 windows. A window missing from a full list is then kept
in state with a warning instead of being dropped.
Instants are compared as moments: `2026-12-01T03:00:00+01:00` and `2026-12-01T02:00:00Z` are the same value.
Destroying a recurring window cancels its series: future occurrences are deleted, a running one ends now, and past
ones stay as history.

## Import

Import is supported using the following syntax:

```shell
# by window id (for a series: its first occurrence), or <project_id>/<window_id>
terraform import montral_maintenance_window.upgrade 3f1e1c1a-0000-4000-8000-000000000004
```
