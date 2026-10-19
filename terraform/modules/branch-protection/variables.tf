variable "repository" {
  description = "Name of the GitHub repository to protect."
  type        = string
}

variable "required_approving_review_count" {
  description = "Number of required approving reviews before a PR can be merged into the default branch."
  type        = number
  default     = 1
}

variable "require_two_developer_approvals" {
  description = "Whether to require the configured two-developer-approvals status check before merging. Defaults to false so the gate is opt-in."
  type        = bool
  default     = false
}

variable "require_two_developer_approvals_check_context" {
  description = "Status-check context emitted by the two-developer-approvals workflow when the opt-in gate is enabled."
  type        = string
  default     = "require-two-developer-approvals / check"
}
