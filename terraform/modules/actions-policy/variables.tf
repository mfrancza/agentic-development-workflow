variable "repository" {
  description = "Name of the GitHub repository to configure Actions permissions for."
  type        = string
}

variable "github_owned_allowed" {
  description = "Whether GitHub-owned Actions (actions/*) are allowed to run. Set to true to permit all actions/* without listing them individually."
  type        = bool
  default     = true
}

variable "verified_allowed" {
  description = "Whether Actions from verified creators are allowed. Deliberately false by default: the verified-creators list is a broad GitHub-managed set; admitting it widens the policy for no current benefit. Enable only if a specific verified-creator action is required."
  type        = bool
  default     = false
}

variable "patterns_allowed" {
  description = "List of owner/repo patterns for non-GitHub-owned Actions that are explicitly allowed (e.g. [\"anthropics/claude-code-action\"]). Each entry must correspond to an action pinned to a full 40-character SHA in the consuming workflow YAML. An empty list (the default) means only GitHub-owned actions are permitted."
  type        = list(string)
  default     = []
}
