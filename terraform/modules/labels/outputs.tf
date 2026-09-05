output "label_names" {
  description = "Set of all managed label names."
  value       = toset(keys(github_issue_label.automation))
}
