# The provider's project (or the API key's default project)
data "montral_project" "current" {}

# Another project of the workspace, by name
data "montral_project" "staging" {
  name = "Staging"
}
