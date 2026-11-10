mock_provider "github" {}

variables {
  repo_owner      = "example"
  agent_allowlist = []
}

run "repository_authors" {
  command = plan

  assert {
    condition     = var.auto_review_authors == tolist(["mfrancza-developer-agent[bot]", "mfrancza-s-claude-code[bot]"])
    error_message = "The repository must enroll exactly its prescribed authors."
  }
}

run "default" {
  command = plan
  variables { auto_review_authors = null }

  assert {
    condition     = length(var.auto_review_authors) == 0
    error_message = "The root default must enroll no authors."
  }
}

run "valid_logins" {
  command = plan
  variables { auto_review_authors = ["Alice", "agent-name[bot]", "a"] }
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
