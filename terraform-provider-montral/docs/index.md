---
page_title: "montral Provider"
subcategory: ""
description: |-
  Manages monitors, alert channels, status pages, maintenance windows and project escalation of a [Montral](https://github.com/TheHalfMoon/Montral) deployment through its REST API, authenticated with an API key.
---

# montral Provider

Manages monitors, alert channels, status pages, maintenance windows and project escalation of a [Montral](https://github.com/TheHalfMoon/Montral) deployment through its REST API, authenticated with an API key.

This provider is **unpublished**: build it from source and point Terraform at it with `dev_overrides` (see the [README](../README.md)).

## Example Usage

```terraform
terraform {
  required_providers {
    montral = {
      # unpublished: build from source and use dev_overrides (see the README)
      source = "thehalfmoon/montral"
    }
  }
}

# Pass the API key as MONTRAL_API_KEY rather than writing it here.
provider "montral" {
  endpoint   = "https://montral.example.com"
  project_id = "00000000-0000-4000-8000-000000000000" # optional: defaults to the key's first project
}
```

<!-- schema generated from the provider schema (tfplugindocs format) -->
## Schema

### Optional

- `api_key` (String, Sensitive) Montral API key (`montral_...`), created under Settings → API keys. May also be set with the `MONTRAL_API_KEY` environment variable. The key's workspace (and project limit, if any) decides what the provider can reach.
- `endpoint` (String) Base URL of the Montral deployment, such as `https://montral.example.com`. May also be set with the `MONTRAL_ENDPOINT` environment variable. TLS certificates are always verified.
- `project_id` (String) Default project UUID for resources that do not set their own `project_id`. May also be set with `MONTRAL_PROJECT_ID`. Without it, the key's first project (or the workspace's default project) is used.
