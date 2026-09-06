terraform {
  required_version = ">= 1.6.0"

  # HCP Terraform (state-only backend — execution mode = local so every
  # plan/apply runs in GitHub Actions; HCP only stores state and holds the lock).
  # One-time bootstrap: after creating the workspace in the HCP UI, run
  #   cd terraform && terraform init -migrate-state
  # to copy the existing local state into the HCP workspace.
  # Requires TF_API_TOKEN to be set (see README §2 and §3).
  cloud {
    organization = "mfrancza"
    workspaces {
      name = "agentic-development-workflow"
    }
  }

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
  visibility  = "public"

  # Config state 2 of the public flip (docs/design/public-visibility-flip.md,
  # Decision 2): only applicable once the repo is public. GitHub rejects these
  # settings on a private non-GHAS repo, and the provider sends this PATCH
  # before any visibility change — so this block must merge and apply strictly
  # after the state-1 apply that flips visibility.
  security_and_analysis {
    secret_scanning {
      status = "enabled"
    }
    secret_scanning_push_protection {
      status = "enabled"
    }
  }

  has_issues   = true
  has_wiki     = false
  has_projects = false

  allow_merge_commit     = false
  allow_squash_merge     = true
  allow_rebase_merge     = false
  delete_branch_on_merge = true
}

# ── Modules ──────────────────────────────────────────────────────────────────

module "security" {
  source     = "./modules/security"
  repository = github_repository.this.name
}

module "agent_vars" {
  source              = "./modules/agent-vars"
  repository          = github_repository.this.name
  agent_allowlist     = var.agent_allowlist
  default_model       = var.default_model
  admin_assignees     = var.admin_assignees
  code_reviewers      = var.code_reviewers
  auto_trigger_agents = var.auto_trigger_agents
}

module "branch_protection" {
  source     = "./modules/branch-protection"
  repository = github_repository.this.name
}

module "labels" {
  source     = "./modules/labels"
  repository = github_repository.this.name
}

module "actions_policy" {
  source     = "./modules/actions-policy"
  repository = github_repository.this.name
}

# ── State migration ───────────────────────────────────────────────────────────
# These moved blocks transparently relocate existing state entries into their
# module paths. `terraform plan` will show zero resource changes after they are
# applied.

moved {
  from = github_repository_vulnerability_alerts.this
  to   = module.security.github_repository_vulnerability_alerts.this
}

moved {
  from = github_actions_variable.agent_allowlist
  to   = module.agent_vars.github_actions_variable.agent_allowlist
}

# Two-step chain: old resource name (default_claude_model) → renamed resource
# (default_model) → module path. Terraform follows the chain automatically so
# both a state with the original name and one with the renamed resource arrive
# at the correct final address.
moved {
  from = github_actions_variable.default_claude_model
  to   = github_actions_variable.default_model
}

moved {
  from = github_actions_variable.default_model
  to   = module.agent_vars.github_actions_variable.default_model
}

moved {
  from = github_actions_variable.admin_assignees
  to   = module.agent_vars.github_actions_variable.admin_assignees
}

moved {
  from = github_actions_variable.code_reviewers
  to   = module.agent_vars.github_actions_variable.code_reviewers
}

moved {
  from = github_actions_variable.auto_trigger_agents
  to   = module.agent_vars.github_actions_variable.auto_trigger_agents
}

moved {
  from = github_repository_ruleset.main
  to   = module.branch_protection.github_repository_ruleset.main
}

moved {
  from = github_actions_repository_permissions.this
  to   = module.actions_policy.github_actions_repository_permissions.this
}

moved {
  from = github_issue_label.automation
  to   = module.labels.github_issue_label.automation
}
