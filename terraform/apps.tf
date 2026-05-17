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

# Repo-level Actions secrets — workflows mint installation tokens at runtime
# from the App ID + private key.
resource "github_actions_secret" "developer_app_id" {
  repository      = github_repository.this.name
  secret_name     = "DEVELOPER_APP_ID"
  plaintext_value = var.developer_app.app_id
}

resource "github_actions_secret" "developer_app_private_key" {
  repository      = github_repository.this.name
  secret_name     = "DEVELOPER_APP_PRIVATE_KEY"
  plaintext_value = var.developer_app.private_key_pem
}

resource "github_actions_secret" "reviewer_app_id" {
  repository      = github_repository.this.name
  secret_name     = "REVIEWER_APP_ID"
  plaintext_value = var.reviewer_app.app_id
}

resource "github_actions_secret" "reviewer_app_private_key" {
  repository      = github_repository.this.name
  secret_name     = "REVIEWER_APP_PRIVATE_KEY"
  plaintext_value = var.reviewer_app.private_key_pem
}
