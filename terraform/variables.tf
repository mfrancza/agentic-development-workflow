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
  description = "GitHub App acting as the developer agent."
  type = object({
    app_id          = string
    installation_id = string
    private_key_pem = string
  })
  sensitive = true
}

variable "reviewer_app" {
  description = "GitHub App acting as the AI code reviewer."
  type = object({
    app_id          = string
    installation_id = string
    private_key_pem = string
  })
  sensitive = true
}
