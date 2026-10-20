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
  description = "GitHub logins (users or bots, such as `<developer-agent-app-slug>[bot]`) and <org>/<team-slug> references permitted to trigger agent workflows (grooming, implement, review, etc.). Team references must use the repository owner's organization and are resolved at trigger time by the in-reusable gate step; there is no AGENT_ALLOWLIST_RESOLVED companion variable or scheduled resolver. Include agent bots as explicit entries so they can apply `agent:*` labels. Team references require the allowlist-resolver App secrets (ALLOWLIST_RESOLVER_APP_ID and ALLOWLIST_RESOLVER_APP_PRIVATE_KEY)."
  type        = list(string)

  validation {
    condition = alltrue([
      for entry in var.agent_allowlist :
      trimspace(entry) != "" && (!strcontains(entry, "/") || can(regex("^[^/]+/[^/]+$", entry)))
      ]) && length(distinct([
        for entry in var.agent_allowlist : lower(entry)
    ])) == length(var.agent_allowlist)
    error_message = "agent_allowlist entries must be unique, non-empty logins or <org>/<team-slug> references."
  }
}

variable "default_model" {
  description = "Repo-wide default model passed to all agent workflows via the DEFAULT_MODEL Actions variable. Issue-driven workflows (agent-implement, agent-groom, agent-design, agent-fix-deployment) can override this per-issue via a model:<agent-type>:<name> label (e.g. model:developer:opus, model:groom:haiku — per-agent, takes precedence) or a generic model:<name> label (e.g. model:opus, model:haiku — applies to all agents for that issue); all other workflows always use this value. Accepts any value supported by the agent --model flag."
  type        = string
  default     = "sonnet"
}

variable "admin_assignees" {
  description = "GitHub logins or <org>/<team-slug> references to assign to issues and PRs that require human action. Team references must use the repository owner's organization and are expanded to member logins by the grooming runtime; they require the allowlist-resolver App secrets (ALLOWLIST_RESOLVER_APP_ID and ALLOWLIST_RESOLVER_APP_PRIVATE_KEY). Stored as the JSON-encoded ADMIN_ASSIGNEES Actions variable."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for entry in var.admin_assignees :
      trimspace(entry) != "" && (!strcontains(entry, "/") || can(regex("^[^/]+/[^/]+$", entry)))
      ]) && length(distinct([
        for entry in var.admin_assignees : lower(entry)
    ])) == length(var.admin_assignees)
    error_message = "admin_assignees entries must be unique, non-empty logins or <org>/<team-slug> references."
  }
}

variable "code_reviewers" {
  description = "GitHub logins or <org>/<team-slug> references to request as PR reviewers when human code review is needed. Team references must use the repository owner's organization and pass directly to GitHub for live team-review routing. Stored as the JSON-encoded CODE_REVIEWERS Actions variable."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for entry in var.code_reviewers :
      trimspace(entry) != "" && (!strcontains(entry, "/") || can(regex("^[^/]+/[^/]+$", entry)))
      ]) && length(distinct([
        for entry in var.code_reviewers : lower(entry)
    ])) == length(var.code_reviewers)
    error_message = "code_reviewers entries must be unique, non-empty logins or <org>/<team-slug> references."
  }
}

variable "fix_checks_allow" {
  description = "Check-run names allowed to trigger the fix-checks agent. Stored as the JSON-encoded FIX_CHECKS_ALLOW Actions variable. Entries must be raw Checks API check_runs[].name values, not workflow names or decorated Checks-tab labels. An empty list disables all fix-checks delivery."
  type        = list(string)
  default     = []
}

variable "protected_pr_author_logins" {
  description = "GitHub login list whose PRs require the custom approval threshold. Stored as the JSON-encoded PROTECTED_PR_AUTHOR_LOGINS Actions variable."
  type        = list(string)
  default     = ["mfrancza-developer-agent[bot]"]

  validation {
    condition     = length(var.protected_pr_author_logins) > 0 && alltrue([for login in var.protected_pr_author_logins : trimspace(login) != ""]) && length(distinct(var.protected_pr_author_logins)) == length(var.protected_pr_author_logins)
    error_message = "protected_pr_author_logins must be non-empty and contain unique, non-empty logins."
  }
}

variable "protected_approval_reviewers" {
  description = "Logins and <org>/<team-slug> references whose approvals count toward required_approval_count on protected PRs. Empty means any reviewer other than the PR author counts (not recommended on public repositories). Team references are expanded for the repository owner's organization with the allowlist-resolver App (ALLOWLIST_RESOLVER_APP_ID / ALLOWLIST_RESOLVER_APP_PRIVATE_KEY secrets). Stored as the JSON-encoded PROTECTED_APPROVAL_REVIEWERS Actions variable."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for entry in var.protected_approval_reviewers :
      trimspace(entry) != "" && (!strcontains(entry, "/") || can(regex("^[^/]+/[^/]+$", entry)))
      ]) && length(distinct([
        for entry in var.protected_approval_reviewers : lower(entry)
    ])) == length(var.protected_approval_reviewers)
    error_message = "protected_approval_reviewers entries must be unique, non-empty logins or <org>/<team-slug> references."
  }
}

variable "required_approval_count" {
  description = "Number of latest-per-reviewer non-self APPROVED reviews required for a protected PR. Stored as REQUIRED_APPROVAL_COUNT."
  type        = number
  default     = 2

  validation {
    condition     = var.required_approval_count >= 1 && floor(var.required_approval_count) == var.required_approval_count
    error_message = "required_approval_count must be a positive integer."
  }
}

variable "enable_protected_approval_gate" {
  description = "Whether to require the protected-approval status check before merging. Defaults to false so the gate is opt-in. Stored as ENABLE_PROTECTED_APPROVAL_GATE."
  type        = bool
  default     = false
}

variable "enable_protected_approval_gate_reconcile_minutes" {
  description = "Minimum interval in minutes between protected-approval reconciliation sweeps (minimum 5, GitHub's shortest schedule interval). Stored as ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES."
  type        = number
  default     = 10

  validation {
    condition     = var.enable_protected_approval_gate_reconcile_minutes >= 5 && floor(var.enable_protected_approval_gate_reconcile_minutes) == var.enable_protected_approval_gate_reconcile_minutes
    error_message = "enable_protected_approval_gate_reconcile_minutes must be an integer of at least 5 (GitHub runs schedules at most every 5 minutes)."
  }
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

variable "reviewer_models" {
  description = "Ordered list of model identifiers to try when the multi-reviewer feature selects a reviewer. Each entry is a model name accepted by the agent --model flag (e.g. \"sonnet\", \"claude-sonnet-4-5\", \"gpt-5.6-sol\"). Stored as a JSON-encoded repository Actions variable REVIEWER_MODELS so the resolve-reviewer-set action can iterate the list without hardcoding model names in YAML. Defaults to [] (empty — multi-reviewer is disabled)."
  type        = list(string)
  default     = []
}

variable "design_default_model" {
  description = "Design-agent default model, stored as the DESIGN_DEFAULT_MODEL Actions variable. When non-empty, the agent-design workflow uses this value in place of DEFAULT_MODEL, giving the design stage its own model preference without affecting other agent types. Leave empty (the default) to fall back to DEFAULT_MODEL — the existing behavior is preserved for any repo that omits this variable."
  type        = string
  default     = ""
}

variable "review_model_pairing" {
  description = "Reviewer model-pair preferences. When enabled, the agent-review workflow picks a reviewer model based on the authoring model of the PR (recorded in the PR body by the developer/design agent). Explicit model:review:* / model:* labels on the PR take precedence. See docs/design/configurable-model-pair-preferences.md for the resolver semantics and docs/model-guidance.md for the cross-vendor class table."
  type = object({
    enabled           = bool
    policy            = string       # "different-vendor-same-class" | "same-vendor-same-class" | "same-model" | "explicit-map" | "off"
    preferred_vendors = list(string) # tie-breaking order for "different-vendor-same-class"; also drives the "same-vendor-different-model" fallback vendor sequence
    explicit_map      = map(string)  # author-model → reviewer-model; consulted only when policy == "explicit-map"
    fallback_chain    = list(string) # ordered fallbacks when the primary policy pick is not satisfiable; supported entries: "different-vendor-same-class", "same-vendor-different-model", "default-model"
  })
  default = {
    enabled           = false
    policy            = "different-vendor-same-class"
    preferred_vendors = ["openai", "xai", "anthropic"]
    explicit_map      = {}
    fallback_chain    = ["default-model"]
  }
}
