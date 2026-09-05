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
