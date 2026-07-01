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
  description = "GitHub usernames permitted to trigger agent workflows (grooming, implement, etc.). Stored as a repository Actions variable so workflow `if` conditions can reference it without hardcoding names in YAML."
  type        = list(string)
}

variable "default_claude_model" {
  description = "Repo-wide default Claude model passed to all agent workflows via the DEFAULT_CLAUDE_MODEL Actions variable. The agent-implement workflow can override this on a per-issue basis using a model:<name> label (e.g. model:opus, model:haiku); all other workflows always use this value. Accepts any value supported by the claude --model flag."
  type        = string
  default     = "sonnet"
}
