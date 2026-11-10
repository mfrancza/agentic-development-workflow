mock_provider "github" {}

variables {
  repository      = "example"
  agent_allowlist = []
}

run "default" {
  command = plan

  assert {
    condition     = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.variable_name == "ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES" && github_actions_variable.enable_protected_approval_gate_reconcile_minutes.value == "10"
    error_message = "The module must publish the default as ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES=10."
  }
}

run "five" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 5 }
  assert {
    condition     = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.value == "5"
    error_message = "The module must publish 5 unchanged."
  }
}

run "ten" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 10 }
  assert {
    condition     = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.value == "10"
    error_message = "The module must publish 10 unchanged."
  }
}

run "fifteen" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 15 }
  assert {
    condition     = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.value == "15"
    error_message = "The module must publish 15 unchanged."
  }
}

run "twenty" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 20 }
  assert {
    condition     = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.value == "20"
    error_message = "The module must publish 20 unchanged."
  }
}

run "thirty" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 30 }
  assert {
    condition     = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.value == "30"
    error_message = "The module must publish 30 unchanged."
  }
}

run "sixty" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 60 }
  assert {
    condition     = github_actions_variable.enable_protected_approval_gate_reconcile_minutes.value == "60"
    error_message = "The module must publish 60 unchanged."
  }
}

run "seven" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 7 }
  expect_failures = [var.enable_protected_approval_gate_reconcile_minutes]
}

run "fractional" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 10.5 }
  expect_failures = [var.enable_protected_approval_gate_reconcile_minutes]
}

run "zero" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 0 }
  expect_failures = [var.enable_protected_approval_gate_reconcile_minutes]
}

run "negative" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = -5 }
  expect_failures = [var.enable_protected_approval_gate_reconcile_minutes]
}
