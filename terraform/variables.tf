variable "repo_owner" {
  description = "GitHub user or org that owns the repository."
  type        = string
}

variable "repo_name" {
  description = "Repository name (without owner prefix)."
  type        = string
  default     = "agentic-development-workflow"
}

variable "developer_app" {
  description = "Identifiers for the developer agent GitHub App."
  type = object({
    app_id          = string
    installation_id = string
  })
}

variable "reviewer_app" {
  description = "Identifiers for the AI code reviewer GitHub App."
  type = object({
    app_id          = string
    installation_id = string
  })
}
