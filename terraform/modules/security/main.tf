terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

# Enable Dependabot vulnerability alerts for the repository.
resource "github_repository_vulnerability_alerts" "this" {
  repository = var.repository
}
