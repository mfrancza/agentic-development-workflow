variable "repo_owner" {
  description = "GitHub user or org that owns the repository."
  type        = string
}

variable "repo_name" {
  description = "Repository name (without owner prefix)."
  type        = string
  default     = "agentic-development-workflow"
}

variable "developer_app_installation_id" {
  description = "Installation ID for the developer agent GitHub App on this repo."
  type        = string
}

variable "reviewer_app_installation_id" {
  description = "Installation ID for the AI code reviewer GitHub App on this repo."
  type        = string
}
