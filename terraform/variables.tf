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
  description = "Default Claude model used by agents when no model label is set on the issue. Stored as a repository Actions variable (DEFAULT_CLAUDE_MODEL) so workflows can pass it to the agent container. Accepts any value supported by the claude --model flag (e.g. sonnet, opus, haiku)."
  type        = string
  default     = "sonnet"
}
