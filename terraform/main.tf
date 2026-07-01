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

# Expose the sender allowlist as a repository Actions variable so workflow
# `if` conditions can use `fromJSON(vars.AGENT_ALLOWLIST)` instead of
# hardcoding usernames in YAML files.
resource "github_actions_variable" "agent_allowlist" {
  repository    = github_repository.this.name
  variable_name = "AGENT_ALLOWLIST"
  value         = jsonencode(var.agent_allowlist)
}

# Expose the default Claude model as a repository Actions variable so all
# workflows can pass it to the agent container via CLAUDE_MODEL. The
# agent-implement workflow can additionally override this per-issue via a
# `model:<name>` label (e.g. model:opus, model:haiku); other workflows always
# use this repo-wide default.
resource "github_actions_variable" "default_claude_model" {
  repository    = github_repository.this.name
  variable_name = "DEFAULT_CLAUDE_MODEL"
  value         = var.default_claude_model
}

# Protection for the default branch via a repository ruleset (the modern
# primitive — supports granular bypass actors, unlike the legacy
# github_branch_protection resource).
#
# Repository admins can bypass review on PR merges but NOT push directly to
# the default branch; this stops the legacy "delete protection → merge →
# reapply" dance for the repo owner's own PRs while keeping push protection
# intact.
resource "github_repository_ruleset" "main" {
  name        = "main-protection"
  repository  = github_repository.this.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = 5 # Repository Admin role
    actor_type  = "RepositoryRole"
    bypass_mode = "pull_request"
  }

  rules {
    deletion                = true
    non_fast_forward        = true
    required_linear_history = true

    pull_request {
      required_approving_review_count   = 1
      dismiss_stale_reviews_on_push     = true
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = false
    }
  }
}
