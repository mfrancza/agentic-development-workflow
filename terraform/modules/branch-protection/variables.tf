variable "repository" {
  description = "Name of the GitHub repository to protect."
  type        = string
}

variable "required_approving_review_count" {
  description = "Number of required approving reviews before a PR can be merged into the default branch."
  type        = number
  default     = 1
}
