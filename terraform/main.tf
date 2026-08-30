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
}

resource "github_repository_vulnerability_alerts" "this" {
  repository = github_repository.this.name
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

# Expose the admin assignees list as a JSON-encoded repository Actions variable
# so workflows can assign issues and PRs to the right humans when the agent
# applies the human-required label and needs a human in the loop.
resource "github_actions_variable" "admin_assignees" {
  repository    = github_repository.this.name
  variable_name = "ADMIN_ASSIGNEES"
  value         = jsonencode(var.admin_assignees)
}

# Expose the code reviewers list as a JSON-encoded repository Actions variable
# so workflows can request human PR reviewers when the agent opens a PR and
# wants human sign-off.
resource "github_actions_variable" "code_reviewers" {
  repository    = github_repository.this.name
  variable_name = "CODE_REVIEWERS"
  value         = jsonencode(var.code_reviewers)
}

# Expose the auto-trigger gates as a JSON-encoded repository Actions variable
# so agent-auto-trigger.yml can gate each job on
# fromJSON(vars.AUTO_TRIGGER_AGENTS).<key> == true. All keys default to false
# (opt-in); flipping a key enables auto-advancement for that SDLC stage.
# The non-empty guard (vars.AUTO_TRIGGER_AGENTS != '') must precede any
# fromJSON() call in workflow if: expressions — if the variable does not yet
# exist the expression evaluates to '' and fromJSON('') would throw a runtime
# error; the guard causes the condition to fail closed instead.
resource "github_actions_variable" "auto_trigger_agents" {
  repository    = github_repository.this.name
  variable_name = "AUTO_TRIGGER_AGENTS"
  value         = jsonencode(var.auto_trigger_agents)
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
#    the code review agent (triggers agent-review.yml).
#  - model:<name> overrides (agent-implement / agent-groom /
#    agent-fix-deployment prefer these over the GitHub Actions repository
#    variable `vars.DEFAULT_MODEL` (not a Terraform variable); apply
#    at most one per issue). Covers Anthropic (Claude), OpenAI, and xAI
#    (Grok) models. For Anthropic, the labels split into three tiers:
#    (1) tier aliases (`model:sonnet`/`model:opus`/`model:haiku`) — the
#    grooming agent applies these based on complexity, and each resolves to
#    the latest snapshot of its series; (2) generic series tags (e.g.
#    `model:claude-sonnet-4-5`, `model:claude-3-5-haiku-latest`) — pin to a
#    named series while still floating across snapshots; (3) pinned snapshot
#    IDs (e.g. `model:claude-sonnet-4-5-20250929`) — fully reproducible.
#    The entrypoint accepts any `claude-*` model ID, so ad-hoc pinned labels
#    that are not pre-provisioned here still route correctly at runtime.
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

    # Anthropic — top-level tier aliases (Claude Code CLI resolves each to the
    # latest snapshot of its series). These are the labels the grooming agent
    # applies based on issue complexity.
    "model:sonnet" = {
      color       = "1d76db"
      description = "Run agents on this issue with the latest Claude Sonnet (overrides DEFAULT_MODEL)."
    }
    "model:opus" = {
      color       = "1d76db"
      description = "Run agents on this issue with the latest Claude Opus (overrides DEFAULT_MODEL)."
    }
    "model:haiku" = {
      color       = "1d76db"
      description = "Run agents on this issue with the latest Claude Haiku (overrides DEFAULT_MODEL)."
    }

    # Anthropic — generic series aliases. Each resolves to the latest snapshot
    # of that named series (backwards-compatible with unqualified names per
    # issue #202). Prefer these when a run must stay on a specific series but
    # can float across snapshots within it.
    "model:claude-opus-4-5" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Opus 4.5 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-opus-4-1" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Opus 4.1 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-opus-4" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Opus 4 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4-5" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Sonnet 4.5 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Sonnet 4 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-haiku-4-5" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Haiku 4.5 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-7-sonnet-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3.7 Sonnet snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-sonnet-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3.5 Sonnet snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-haiku-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3.5 Haiku snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-opus-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3 Opus snapshot (overrides DEFAULT_MODEL)."
    }

    # Anthropic — pinned snapshot IDs. Prefer these when a run must be
    # reproducible against a specific Anthropic snapshot. Additional pinned
    # snapshots can be applied ad hoc by name — the developer/reviewer
    # entrypoint accepts any `claude-*` model ID; only the labels that appear
    # here are pre-populated in the GitHub label picker.
    "model:claude-opus-4-1-20250805" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Opus 4.1 snapshot 2025-08-05 (overrides DEFAULT_MODEL)."
    }
    "model:claude-opus-4-20250514" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Opus 4 snapshot 2025-05-14 (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4-5-20250929" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Sonnet 4.5 snapshot 2025-09-29 (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4-20250514" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Sonnet 4 snapshot 2025-05-14 (overrides DEFAULT_MODEL)."
    }
    "model:claude-haiku-4-5-20251001" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Haiku 4.5 snapshot 2025-10-01 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-7-sonnet-20250219" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3.7 Sonnet snapshot 2025-02-19 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-sonnet-20241022" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3.5 Sonnet snapshot 2024-10-22 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-haiku-20241022" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3.5 Haiku snapshot 2024-10-22 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-opus-20240229" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3 Opus snapshot 2024-02-29 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-haiku-20240307" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3 Haiku snapshot 2024-03-07 (overrides DEFAULT_MODEL)."
    }

    "model:gpt-5.6-sol" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-5.6-sol (overrides DEFAULT_MODEL)."
    }
    "model:gpt-5.6-terra" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-5.6-terra (overrides DEFAULT_MODEL)."
    }
    "model:gpt-5.6-luna" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-5.6-luna (overrides DEFAULT_MODEL)."
    }
    "model:gpt-5" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-5 (overrides DEFAULT_MODEL)."
    }
    "model:o3" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI o3 (overrides DEFAULT_MODEL)."
    }

    "model:grok-3" = {
      color       = "1d76db"
      description = "Run agents on this issue with xAI grok-3 (overrides DEFAULT_MODEL)."
    }
    "model:grok-3-mini" = {
      color       = "1d76db"
      description = "Run agents on this issue with xAI grok-3-mini (overrides DEFAULT_MODEL)."
    }
    "model:grok-code-fast-1" = {
      color       = "1d76db"
      description = "Run agents on this issue with xAI grok-code-fast-1 (overrides DEFAULT_MODEL)."
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
