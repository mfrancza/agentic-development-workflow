terraform {
  required_version = ">= 1.6.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

# Authenticated via GITHUB_TOKEN env var (PAT with `repo` and `admin:org` scopes
# as needed; for personal repos `repo` is sufficient).
provider "github" {
  owner = var.repo_owner
}

# Manage the existing repository. Run once before first apply:
#   terraform import github_repository.this <repo_name>
resource "github_repository" "this" {
  name        = var.repo_name
  description = "Agentic development workflow — AI agents in an issue-based SDLC"
  visibility  = "private"

  has_issues   = true
  has_wiki     = false
  has_projects = false

  allow_merge_commit     = false
  allow_squash_merge     = true
  allow_rebase_merge     = false
  delete_branch_on_merge = true

  vulnerability_alerts = true
}

# Branch protection: require PR review, block direct pushes to main.
# Agent App installations are NOT in bypass lists — they must go through PRs.
resource "github_branch_protection" "main" {
  repository_id = github_repository.this.node_id
  pattern       = "main"

  required_pull_request_reviews {
    required_approving_review_count = 1
    require_code_owner_reviews      = false
    dismiss_stale_reviews           = true
  }

  enforce_admins          = true
  require_signed_commits  = false
  allows_deletions        = false
  allows_force_pushes     = false
  required_linear_history = true
}
