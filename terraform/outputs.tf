output "repo_full_name" {
  description = "owner/name of the managed repository."
  value       = github_repository.this.full_name
}

output "developer_app_installation_id" {
  description = "Installation ID for the developer agent App on this repo."
  value       = var.developer_app.installation_id
}

output "reviewer_app_installation_id" {
  description = "Installation ID for the reviewer agent App on this repo."
  value       = var.reviewer_app.installation_id
}
