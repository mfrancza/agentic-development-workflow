output "agent_allowlist_variable_name" {
  description = "Name of the AGENT_ALLOWLIST Actions variable."
  value       = github_actions_variable.agent_allowlist.variable_name
}

output "default_model_variable_name" {
  description = "Name of the DEFAULT_MODEL Actions variable."
  value       = github_actions_variable.default_model.variable_name
}

output "admin_assignees_variable_name" {
  description = "Name of the ADMIN_ASSIGNEES Actions variable."
  value       = github_actions_variable.admin_assignees.variable_name
}

output "code_reviewers_variable_name" {
  description = "Name of the CODE_REVIEWERS Actions variable."
  value       = github_actions_variable.code_reviewers.variable_name
}

output "auto_trigger_agents_variable_name" {
  description = "Name of the AUTO_TRIGGER_AGENTS Actions variable."
  value       = github_actions_variable.auto_trigger_agents.variable_name
}
