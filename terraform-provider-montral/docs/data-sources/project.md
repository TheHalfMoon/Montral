---
page_title: "montral_project Data Source - terraform-provider-montral"
subcategory: ""
description: |-
  Looks up a project of the API key's workspace by `id` or by `name`.
---

# montral_project (Data Source)

Looks up a project of the API key's workspace by `id` or by `name`. With neither, returns the provider's project (or the key's default project).

## Example Usage

```terraform
# The provider's project (or the API key's default project)
data "montral_project" "current" {}

# Another project of the workspace, by name
data "montral_project" "staging" {
  name = "Staging"
}
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Optional

- `id` (String) Project UUID.
- `name` (String) Project name (exact match; must be unique among the projects the key can see).

### Read-Only

- `created_at` (String) Creation time (RFC 3339).
- `organization_id` (String) Workspace id.
