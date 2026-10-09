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
  description = "Patterns for non-GitHub-owned Actions and reusable workflows that are explicitly allowed. GitHub matches the full uses: string, so each entry needs a ref: an action is owner/repo@<sha-or-tag> (e.g. \"hashicorp/setup-terraform@<40-char-sha>\"), and a reusable workflow from another owner is OWNER/REPO/.github/workflows/FILE.yml@REF (wildcards allowed, e.g. \"mfrancza/agentic-development-workflow/.github/workflows/*@v0\"). A bare owner/repo entry matches nothing. An empty list (the default) means only GitHub-owned actions and same-repository workflows are permitted."
  type        = list(string)
  default     = []
}
