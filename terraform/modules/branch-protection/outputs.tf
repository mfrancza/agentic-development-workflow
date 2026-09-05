output "ruleset_id" {
  description = "ID of the main-protection repository ruleset."
  value       = github_repository_ruleset.main.ruleset_id
}

output "ruleset_name" {
  description = "Name of the main-protection repository ruleset."
  value       = github_repository_ruleset.main.name
}
