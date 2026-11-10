mock_provider "github" {}

variables {
  repo_owner      = "example"
  agent_allowlist = []
}

run "default" {
  command = plan

  assert {
    condition     = var.max_review_rounds == 8
    error_message = "The root default must be 8."
  }
}

run "zero" {
  command = plan

  variables {
    max_review_rounds = 0
  }

  assert {
    condition     = var.max_review_rounds == 0
    error_message = "The root must accept 0."
  }
}

run "eight" {
  command = plan

  variables {
    max_review_rounds = 8
  }
}

run "maximum_safe_integer" {
  command = plan

  variables {
    max_review_rounds = 9007199254740991
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
