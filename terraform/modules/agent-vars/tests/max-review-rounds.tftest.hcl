mock_provider "github" {}

variables {
  repository      = "example"
  agent_allowlist = []
}

run "default" {
  command = plan

  assert {
    condition     = github_actions_variable.max_review_rounds.variable_name == "MAX_REVIEW_ROUNDS" && github_actions_variable.max_review_rounds.value == "8"
    error_message = "The module must publish the default as MAX_REVIEW_ROUNDS=8."
  }
}

run "zero" {
  command = plan

  variables {
    max_review_rounds = 0
  }

  assert {
    condition     = github_actions_variable.max_review_rounds.value == "0"
    error_message = "The module must publish 0 as a string."
  }
}

run "eight" {
  command = plan

  variables {
    max_review_rounds = 8
  }

  assert {
    condition     = github_actions_variable.max_review_rounds.value == "8"
    error_message = "The module must publish 8 as a string."
  }
}

run "maximum_safe_integer" {
  command = plan

  variables {
    max_review_rounds = 9007199254740991
  }

  assert {
    condition     = github_actions_variable.max_review_rounds.value == "9007199254740991"
    error_message = "The module must preserve the maximum safe integer as a string."
  }
}

run "negative" {
  command = plan

  variables {
    max_review_rounds = -1
  }

  expect_failures = [var.max_review_rounds]
}

run "fractional" {
  command = plan

  variables {
    max_review_rounds = 1.5
  }

  expect_failures = [var.max_review_rounds]
}

run "unsafe" {
  command = plan

  variables {
    max_review_rounds = 9007199254740992
  }

  expect_failures = [var.max_review_rounds]
}
