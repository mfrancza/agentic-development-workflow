mock_provider "github" {}

variables {
  repo_owner      = "example"
  agent_allowlist = []
}

run "default" {
  command = plan

  assert {
    condition     = var.enable_protected_approval_gate_reconcile_minutes == 10
    error_message = "The root default must be 10."
  }
}

run "five" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 5 }
}

run "ten" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 10 }
}

run "fifteen" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 15 }
}

run "twenty" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 20 }
}

run "thirty" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 30 }
}

run "sixty" {
  command = plan
  variables { enable_protected_approval_gate_reconcile_minutes = 60 }
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
