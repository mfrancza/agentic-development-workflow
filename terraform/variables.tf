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
