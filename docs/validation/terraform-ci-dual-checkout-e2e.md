# End-to-end validation: Terraform CI dual-checkout fix

**Issue:** [#551](https://github.com/mfrancza/agentic-development-workflow/issues/551)
**Validated on:** 2026-09-12
**Validates:** PRs [#553](https://github.com/mfrancza/agentic-development-workflow/pull/553) and [#554](https://github.com/mfrancza/agentic-development-workflow/pull/554) (Issues #549 and #550)
**Design doc:** [`docs/design/terraform-ci-plan-checkout-isolation.md`](../design/terraform-ci-plan-checkout-isolation.md)

## Summary

This document records the end-to-end validation of the Terraform CI dual-checkout fix
from Issue #548. All five steps in the validation scope passed.

---

## Step 1 — Canary PR

**Canary PR:** [#557](https://github.com/mfrancza/agentic-development-workflow/pull/557)
`chore(terraform): tweak 'do' label description (terraform-ci validation canary)`

A minimal, harmless change was made to `terraform/modules/labels/main.tf` — the
description of the `do` label had `"; implementable"` changed to
`"task; implementable"` — and submitted as a same-repository PR against `main`.
This triggered the `plan` job in `terraform-ci.yml` via `pull_request_target`.

---

## Step 2 — Plan job run verification

**Workflow run:** [#34714882173](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34714882173)

All invariants confirmed from the live run log:

| Invariant | Evidence from log |
|-----------|-------------------|
| Plan job ran to completion | Status: `pass` (27 s) |
| Plan comment posted under `terraform-ci[bot]` identity | PR comment posted by `mfrancza-terraform-ci` (GitHub App); comment ID 5648236318 |
| Provider-allowlist gate reads from `_pr/` | Log shows `lockfile = pathlib.Path("_pr/terraform/.terraform.lock.hcl")` and `for tf_path in glob.glob("_pr/terraform/**/*.tf", ...)` |
| Terraform CLI `working-directory` is `_pr/terraform` | All `terraform init`, `fmt`, `validate`, `plan`, and `show` commands ran in `_pr/terraform` |
| `Post Terraform plan comment` uses `./_base/.github/actions/terraform-plan-comment` | Log shows `Run ./_base/.github/actions/terraform-plan-comment` and `ACTION_PATH: …/_base/.github/actions/terraform-plan-comment` |
| Plan comment content matches expected diff | Comment shows exactly one in-place update: `module.labels.github_issue_label.automation["do"]` — description changed from `"Simple, well-defined; implementable…"` to `"Simple, well-defined task; implementable…"` |

**Plan comment content (abridged):**

```
  ~ resource "github_issue_label" "automation" {
      ~ description = "Simple, well-defined; implementable in a single easy-to-review commit."
                   -> "Simple, well-defined task; implementable in a single easy-to-review commit."
        name        = "do"
    }

Plan: 0 to add, 1 to change, 0 to destroy.
```

---

## Step 3 — Regression test verification

### Passing case (trust-boundary tests on canary PR #557)

The trust-boundary regression tests (`test-terraform-ci-trust-boundary.yml`) ran on
previous PRs that changed the relevant paths and **passed**:

| Job | Run | Result |
|-----|-----|--------|
| `Static lint — plan job trust-boundary invariants` | [#34714351645](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34714351645) | ✅ pass |
| `Runtime marker — _base/ action is used, not _pr/` | [#34714351645](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34714351645) | ✅ pass |

The static-lint job confirmed no `uses: ./.github/actions/` references remain in
the plan job (only `uses: ./_base/.github/actions/` is permitted) and no bare
`working-directory: terraform` references remain (only `_pr/terraform`).

The runtime-marker-test confirmed that:
1. The inject-marker script prepended a sentinel step to `_pr/.github/actions/terraform-plan-comment/action.yml` (on-disk only, never pushed).
2. The plan-comment composite action was invoked via `./_base/.github/actions/terraform-plan-comment`.
3. The `_base/` copy of the action does **not** contain the injected marker.
4. `marker-ran.txt` was **not** created — proving the action loaded from `_base/`.

### Failure case (scratch PR #558 with marker in action file)

**Scratch PR:** [#558](https://github.com/mfrancza/agentic-development-workflow/pull/558)
`test: scratch marker for trust-boundary test validation (DO NOT MERGE — Issue #551)`

A marker step that creates `marker-ran.txt` was temporarily inserted as the first
step of `action.yml` on a scratch branch (`scratch/marker-regression-test`). A
draft PR was opened to trigger the trust-boundary tests.

**Result:** The `Runtime marker — _base/ action is used, not _pr/` job **FAILED** as
expected, because the merge commit (`github.sha`) used for the `_base/` checkout
included the marker step, which ran and created `marker-ran.txt` before the
assertion step ran.

This confirms the test infrastructure correctly detects any step in the action that
creates the sentinel file, regardless of whether the step was injected at runtime or
committed in the PR.

The scratch PR was closed without merging. The scratch branch was deleted.

---

## Step 4 — Apply job verification after merge

**Workflow run:** [#34715348883](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34715348883)

PR #557 was squash-merged to `main`. The `push: main` trigger fired
`terraform-ci.yml`'s `apply` job.

```
module.labels.github_issue_label.automation["do"]: Modifying...
module.labels.github_issue_label.automation["do"]: Modifications complete after 1s
Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
```

The apply job ran and applied the label description change without error. The apply
job's structure was not changed by the fix; this step confirms the plan-job
restructure did not regress the apply side.

---

## Step 5 — Adopter notification

A comment was posted on Issue #548 at:
<https://github.com/mfrancza/agentic-development-workflow/issues/548#issuecomment-5648290799>

The comment links the fix PRs (#553, #554), the design doc, and the canary run
evidence, and describes what consumers who copied the workflow need to do to pick
up the fix.

---

## Conclusion

All five validation steps passed. The dual-checkout fix is live on `main` and
verified correct on a real Terraform PR. The trust-boundary regression tests are
live and demonstrated to work in both passing and failing directions. The adopter
(`mfrancza/drone-laser-tag`) has been notified via Issue #548 that adoption can
resume.
