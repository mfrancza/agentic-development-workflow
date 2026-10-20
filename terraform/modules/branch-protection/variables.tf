variable "repository" {
  description = "Name of the GitHub repository to protect."
  type        = string
}

variable "required_approving_review_count" {
  description = "Number of required approving reviews before a PR can be merged into the default branch."
  type        = number
  default     = 1
}

variable "enable_protected_approval_gate" {
  description = "Whether to require the configured protected-approval status check before merging. Defaults to false so the gate is opt-in."
  type        = bool
  default     = false
}

variable "enable_protected_approval_gate_check_context" {
  description = "Optional override for the protected-approval status-check context. Defaults to require-two-developer-approvals."
  type        = string
  default     = null
  nullable    = true
}

variable "enable_protected_approval_gate_check_integration_id" {
  description = "App integration ID allowed to satisfy the protected-approval required check. Defaults to GitHub Actions."
  type        = number
  default     = 15368
}
