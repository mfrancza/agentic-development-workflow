output "repository" {
  description = "Name of the repository that has vulnerability alerts enabled."
  value       = github_repository_vulnerability_alerts.this.repository
}
