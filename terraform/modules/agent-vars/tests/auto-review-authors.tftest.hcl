mock_provider "github" {}

variables {
  repository      = "example"
  agent_allowlist = []
}

run "default" {
  command = plan

  assert {
    condition     = github_actions_variable.auto_review_authors.repository == "example" && github_actions_variable.auto_review_authors.variable_name == "AUTO_REVIEW_AUTHORS" && github_actions_variable.auto_review_authors.value == "[]"
    error_message = "The module must publish an empty AUTO_REVIEW_AUTHORS array by default."
  }
}

run "valid_logins" {
  command = plan
  variables { auto_review_authors = ["Alice", "agent-name[bot]", "a"] }

  assert {
    condition     = github_actions_variable.auto_review_authors.value == jsonencode(["Alice", "agent-name[bot]", "a"])
    error_message = "The module must publish the configured authors as JSON."
  }
}

run "empty_entry" {
  command = plan
  variables { auto_review_authors = [""] }
  expect_failures = [var.auto_review_authors]
}

run "null_entry" {
  command = plan
  variables { auto_review_authors = [null] }
  expect_failures = [var.auto_review_authors]
}

run "padded_entry" {
  command = plan
  variables { auto_review_authors = [" alice "] }
  expect_failures = [var.auto_review_authors]
}

run "duplicate_case" {
  command = plan
  variables { auto_review_authors = ["Agent[bot]", "agent[bot]"] }
  expect_failures = [var.auto_review_authors]
}

run "wildcard" {
  command = plan
  variables { auto_review_authors = ["*"] }
  expect_failures = [var.auto_review_authors]
}

run "team_reference" {
  command = plan
  variables { auto_review_authors = ["org/team"] }
  expect_failures = [var.auto_review_authors]
}

run "invalid_login" {
  command = plan
  variables { auto_review_authors = ["invalid--login"] }
  expect_failures = [var.auto_review_authors]
}
