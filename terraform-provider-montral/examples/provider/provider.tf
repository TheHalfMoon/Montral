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
