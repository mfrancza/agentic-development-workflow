# Ensure each App is installed on this repository. Per-repo selection (vs. "all
# repositories") must be chosen in the App settings UI when installing.
resource "github_app_installation_repository" "developer" {
  installation_id = var.developer_app.installation_id
  repository      = github_repository.this.name
}

resource "github_app_installation_repository" "reviewer" {
  installation_id = var.reviewer_app.installation_id
  repository      = github_repository.this.name
}
