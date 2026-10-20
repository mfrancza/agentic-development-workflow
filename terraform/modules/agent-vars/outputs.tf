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

output "fix_checks_allow_variable_name" {
  description = "Name of the FIX_CHECKS_ALLOW Actions variable."
  value       = github_actions_variable.fix_checks_allow.variable_name
}

output "protected_pr_author_logins_variable_name" {
  description = "Name of the PROTECTED_PR_AUTHOR_LOGINS Actions variable."
  value       = github_actions_variable.protected_pr_author_logins.variable_name
}

output "protected_approval_reviewers_variable_name" {
  description = "Name of the PROTECTED_APPROVAL_REVIEWERS Actions variable."
  value       = github_actions_variable.protected_approval_reviewers.variable_name
}

output "required_approval_count_variable_name" {
  description = "Name of the REQUIRED_APPROVAL_COUNT Actions variable."
  value       = github_actions_variable.required_approval_count.variable_name
}

output "enable_protected_approval_gate_variable_name" {
  description = "Name of the ENABLE_PROTECTED_APPROVAL_GATE Actions variable."
  value       = github_actions_variable.enable_protected_approval_gate.variable_name
}

output "enable_protected_approval_gate_reconcile_minutes_variable_name" {
  description = "Name of the ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES Actions variable."
  value       = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.variable_name
}

output "auto_trigger_agents_variable_name" {
  description = "Name of the AUTO_TRIGGER_AGENTS Actions variable."
  value       = github_actions_variable.auto_trigger_agents.variable_name
}

output "design_default_model_variable_name" {
  description = "Name of the DESIGN_DEFAULT_MODEL Actions variable."
  value       = github_actions_variable.design_default_model.variable_name
}

output "reviewer_models_variable_name" {
  description = "Name of the REVIEWER_MODELS Actions variable."
  value       = github_actions_variable.reviewer_models.variable_name
}

output "review_model_pairing_variable_name" {
  description = "Name of the REVIEW_MODEL_PAIRING Actions variable."
  value       = github_actions_variable.review_model_pairing.variable_name
}
