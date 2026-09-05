output "allowed_actions" {
  description = "The allowed_actions setting applied to the repository (`\"selected\"`)."
  value       = github_actions_repository_permissions.this.allowed_actions
}

output "patterns_allowed" {
  description = "The list of non-GitHub-owned action patterns explicitly permitted."
  value       = var.patterns_allowed
}
