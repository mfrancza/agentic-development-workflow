variable "repo_owner" {
  description = "GitHub user or org that owns the repository."
  type        = string
}

variable "repo_name" {
  description = "Repository name (without owner prefix)."
  type        = string
  default     = "agentic-development-workflow"
}

variable "agent_allowlist" {
  description = "GitHub usernames (and agent bot identities like `<developer-agent-app-slug>[bot]`) permitted to trigger agent workflows (grooming, implement, review, etc.). Include the agent bots themselves so they can apply `agent:*` labels — e.g. an agent applying `agent:review` on its own PR to request a code review. Stored as a repository Actions variable so workflow `if` conditions can reference it without hardcoding names in YAML."
  type        = list(string)
}

variable "default_model" {
  description = "Repo-wide default model passed to all agent workflows via the DEFAULT_MODEL Actions variable. The agent-implement, agent-groom, and agent-fix-deployment workflows can override this on a per-issue basis using a model:<name> label (e.g. model:opus, model:haiku); all other workflows always use this value. Accepts any value supported by the agent --model flag."
  type        = string
  default     = "sonnet"
}

variable "admin_assignees" {
  description = "GitHub usernames to assign to issues and PRs that require human action (e.g. when the agent applies the human-required label and needs a human in the loop). Stored as a JSON-encoded repository Actions variable ADMIN_ASSIGNEES so workflows can parse and assign without hardcoding usernames in YAML."
  type        = list(string)
  default     = []
}

variable "code_reviewers" {
  description = "GitHub usernames to request as PR reviewers when human code review is needed (e.g. when the agent opens a PR and wants human sign-off). Stored as a JSON-encoded repository Actions variable CODE_REVIEWERS so workflows can request reviewers without hardcoding usernames in YAML."
  type        = list(string)
  default     = []
}

variable "auto_trigger_agents" {
  description = "Per-agent:*-label switches that auto-advance the SDLC pipeline. Set a key to true to have agent-auto-trigger.yml automatically apply that stage's agent:* label at the natural upstream signal (issue opened → agent:groom, plan labeled → agent:design, do labeled / draft removed → agent:developer, agent-branch PR opened → agent:review). Every switch defaults to false so existing manual behavior is preserved; flipping a switch opts the whole repo into auto-triggering for that stage. Stored as a JSON-encoded repository Actions variable AUTO_TRIGGER_AGENTS."
  type = object({
    groom     = bool
    design    = bool
    developer = bool
    review    = bool
  })
  default = {
    groom     = false
    design    = false
    developer = false
    review    = false
  }
}

variable "admin_assignees" {
  description = "GitHub usernames to assign to issues that require human action (e.g. issues receiving the human-required label during grooming). The grooming agent reads this list from the ADMIN_ASSIGNEES Actions variable and assigns every username when it applies the human-required label. Set to [] to disable auto-assignment; the agent will log a warning and skip assignment. Stored as a JSON-encoded repository Actions variable ADMIN_ASSIGNEES."
  type        = list(string)
  default     = []
}

variable "code_reviewers" {
  description = "GitHub usernames to request as PR reviewers when the developer agent determines that a PR warrants human code review (e.g. security-sensitive changes). The developer agent reads this list from the CODE_REVIEWERS Actions variable and requests every username as a reviewer. Set to [] to disable auto-reviewer-request; the agent will log a warning and skip the request. Stored as a JSON-encoded repository Actions variable CODE_REVIEWERS."
  type        = list(string)
  default     = []
}
