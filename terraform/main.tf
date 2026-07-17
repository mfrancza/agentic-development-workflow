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

# Expose the default model as a repository Actions variable so all
# workflows can pass it to the agent container via AGENT_MODEL. The
# agent-implement, agent-groom, and agent-fix-deployment workflows can
# additionally override this per-issue via a `model:<name>` label
# (e.g. model:opus, model:haiku); other workflows always use this repo-wide
# default.
resource "github_actions_variable" "default_model" {
  repository    = github_repository.this.name
  variable_name = "DEFAULT_MODEL"
  value         = var.default_model
}

moved {
  from = github_actions_variable.default_claude_model
  to   = github_actions_variable.default_model
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

# Labels consumed by the agent workflows. Codifying them here means the label
# picker in the GitHub UI is pre-populated on a fresh repo — users don't have
# to remember exact spellings for the trigger and model-override labels, and
# the grooming agent doesn't need to `gh label create` on demand.
#
# Five groups:
#  - agent:* trigger labels (the workflows in .github/workflows/ gate on
#    these; applying one routes the issue or PR to that agent). Note that
#    `agent:developer`, `agent:groom`, and `agent:design` are applied to
#    issues, while `agent:review` is applied to PRs to request a review from
#    the code review agent (triggers agent-review.yml). Note: the
#    designer-agent workflow does not yet exist; `agent:design` is a reserved
#    placeholder trigger until that workflow lands.
#  - model:<name> overrides (agent-implement / agent-groom /
#    agent-fix-deployment prefer these over the GitHub Actions repository
#    variable `vars.DEFAULT_MODEL` (not a Terraform variable); apply
#    at most one per issue).
#  - grooming labels (the grooming agent applies these based on issue
#    content — see agents/grooming/label-criteria.json).
#  - workflow labels (`human-required` signals that an agent has escalated to
#    a human and the issue/PR should be assigned to a human actor).
#  - lifecycle labels (`draft` is applied by the designer agent to sub-issues
#    it creates; means the issue is scoped by an unmerged design and is not
#    yet ready for implementation).
#
# Note on pre-existing labels: `bug`, `enhancement`, and `question` ship as
# GitHub defaults on new repos. If `terraform apply` errors with 422
# "already_exists" on those, import them first:
#   terraform import 'github_issue_label.automation["bug"]' <repo_name>:bug
locals {
  automation_labels = {
    "agent:developer" = {
      color       = "6f42c1"
      description = "Route this issue to the developer agent for implementation."
    }
    "agent:groom" = {
      color       = "6f42c1"
      description = "Route this issue to the grooming agent to add labels and notes."
    }
    "agent:review" = {
      color       = "6f42c1"
      description = "Request a review of this PR from the code review agent."
    }
    "agent:design" = {
      color       = "6f42c1"
      description = "Route this issue to the designer agent to write a design doc and create draft sub-issues."
    }

    "model:sonnet" = {
      color       = "1d76db"
      description = "Run agents on this issue with Claude Sonnet (overrides DEFAULT_MODEL)."
    }
    "model:opus" = {
      color       = "1d76db"
      description = "Run agents on this issue with Claude Opus (overrides DEFAULT_MODEL)."
    }
    "model:haiku" = {
      color       = "1d76db"
      description = "Run agents on this issue with Claude Haiku (overrides DEFAULT_MODEL)."
    }

    "question" = {
      color       = "d876e3"
      description = "Issue lacks sufficient detail; clarifying questions posted."
    }
    "bug" = {
      color       = "d73a4a"
      description = "Reports incorrect or unexpected behavior in an existing feature."
    }
    "enhancement" = {
      color       = "a2eeef"
      description = "Requests new functionality or an improvement to existing behavior."
    }
    "dependency upgrade" = {
      color       = "0366d6"
      description = "Requests upgrading a library, package, tool version, or other dependency."
    }
    "do" = {
      color       = "0e8a16"
      description = "Simple, well-defined; implementable in a single easy-to-review commit."
    }
    "plan" = {
      color       = "fbca04"
      description = "Complex enough to require design or planning before implementation."
    }
    "human-required" = {
      color       = "b60205"
      description = "A human is needed in the loop — agent should also assign the issue/PR to a human actor."
    }

    "draft" = {
      color       = "d1d5da"
      description = "Scoped by an unmerged design; do not implement yet."
    }
  }
}

# Restrict which Actions can run in this repository. Every third-party action
# used across .github/workflows/ is actions/* (GitHub-owned) — see the audit
# in docs/design/public-visibility-flip.md. Setting allowed_actions = "selected"
# with github_owned_allowed = true and an empty patterns_allowed covers all
# current workflows with zero configured-pattern surface.
#
# verified_allowed = false is deliberate: the "verified creators" list is a
# broad GitHub-managed set; admitting it would widen the policy for no current
# benefit (Decision 3 in the design doc). If a future workflow adds a non-GitHub
# action, the workflow author must (1) add an owner/repo entry to
# patterns_allowed here and (2) pin the action to a full SHA in the workflow
# YAML (per AGENTS.md convention) — the workflow will fail with a "not
# allowed" error if the pattern is missing, which is loud and easily traced.
resource "github_actions_repository_permissions" "this" {
  repository      = github_repository.this.name
  enabled         = true
  allowed_actions = "selected"

  allowed_actions_config {
    github_owned_allowed = true
    verified_allowed     = false
    patterns_allowed     = []
  }
}

resource "github_issue_label" "automation" {
  for_each = local.automation_labels

  repository  = github_repository.this.name
  name        = each.key
  color       = each.value.color
  description = each.value.description
}
