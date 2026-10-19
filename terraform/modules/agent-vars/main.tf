terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

# Expose the sender allowlist as a repository Actions variable so workflow
# `if` conditions can use `fromJSON(vars.AGENT_ALLOWLIST)` instead of
# hardcoding usernames in YAML files.
resource "github_actions_variable" "agent_allowlist" {
  repository    = var.repository
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
  repository    = var.repository
  variable_name = "DEFAULT_MODEL"
  value         = var.default_model
}

# Expose the admin assignees list as a JSON-encoded repository Actions variable
# so workflows can assign issues and PRs to the right humans when the agent
# applies the human-required label and needs a human in the loop.
resource "github_actions_variable" "admin_assignees" {
  repository    = var.repository
  variable_name = "ADMIN_ASSIGNEES"
  value         = jsonencode(var.admin_assignees)
}

# Expose the code reviewers list as a JSON-encoded repository Actions variable
# so workflows can request human PR reviewers when the agent opens a PR and
# wants human sign-off.
resource "github_actions_variable" "code_reviewers" {
  repository    = var.repository
  variable_name = "CODE_REVIEWERS"
  value         = jsonencode(var.code_reviewers)
}

# Expose the developer-agent bot login so workflows can distinguish
# developer-authored PRs from other contributions.
resource "github_actions_variable" "developer_bot_login" {
  repository    = var.repository
  variable_name = "DEVELOPER_BOT_LOGIN"
  value         = var.developer_bot_login
}

# Expose the opt-in two-developer-approvals gate as a string Actions variable.
# GitHub Actions variables are strings; workflows compare this value to "true".
resource "github_actions_variable" "require_two_developer_approvals" {
  repository    = var.repository
  variable_name = "REQUIRE_TWO_DEVELOPER_APPROVALS"
  value         = tostring(var.require_two_developer_approvals)
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
  repository    = var.repository
  variable_name = "AUTO_TRIGGER_AGENTS"
  value         = jsonencode(var.auto_trigger_agents)
}

# Expose the design-agent default model as a repository Actions variable so
# agent-design workflows can prefer it over DEFAULT_MODEL for the design stage.
# An empty value (the default) means "not configured — fall through to
# DEFAULT_MODEL"; the caller stub expresses this as
# `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL`, which evaluates to
# DEFAULT_MODEL when DESIGN_DEFAULT_MODEL is empty, preserving existing behavior
# for any repo that has not yet set this variable.
resource "github_actions_variable" "design_default_model" {
  repository    = var.repository
  variable_name = "DESIGN_DEFAULT_MODEL"
  value         = var.design_default_model
}

# Expose the reviewer models list as a JSON-encoded repository Actions variable
# so the resolve-reviewer-set action can iterate the ordered list of model
# identifiers to try when the multi-reviewer feature selects a reviewer.
# The non-empty guard (vars.REVIEWER_MODELS != '') must precede any fromJSON()
# call in workflow if: expressions — if the variable does not yet exist or is
# empty the expression evaluates to '' and fromJSON('') would throw a runtime
# error; the guard causes the condition to fail closed (multi-reviewer disabled)
# instead.
resource "github_actions_variable" "reviewer_models" {
  repository    = var.repository
  variable_name = "REVIEWER_MODELS"
  value         = jsonencode(var.reviewer_models)
}

# Expose the reviewer model-pair preferences as a JSON-encoded repository
# Actions variable so the agent-review workflow can pass the pairing policy to
# the resolve-model composite action. When enabled, the pairing tier fires below
# the model:review:* / model:* label tiers and above DEFAULT_MODEL, selecting a
# reviewer model based on the authoring model recorded in the PR body.
# The non-empty guard (vars.REVIEW_MODEL_PAIRING != '') must precede any
# fromJSON() call in workflow if: expressions — if the variable does not yet
# exist the expression evaluates to '' and fromJSON('') would throw a runtime
# error; the guard causes the condition to fail closed (pairing disabled) instead.
# The default (enabled = false) preserves existing behavior for any repo that
# has not yet explicitly opted in.
resource "github_actions_variable" "review_model_pairing" {
  repository    = var.repository
  variable_name = "REVIEW_MODEL_PAIRING"
  value         = jsonencode(var.review_model_pairing)
}
