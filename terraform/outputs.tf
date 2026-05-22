output "repo_full_name" {
  description = "owner/name of the managed repository."
  value       = github_repository.this.full_name
}
