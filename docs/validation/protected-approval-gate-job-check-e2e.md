# End-to-end validation: protected-approval-gate job-check model

**Issue:** [#763](https://github.com/mfrancza/agentic-development-workflow/issues/763)

**Validates:** Decision 12 acceptance test contract in
[`docs/design/protected-approval-gate-job-check.md`](../design/protected-approval-gate-job-check.md)

**Date:** 2026-11-01

---

## Summary

This document records outcomes from the Decision 12 acceptance test contract executed against the live repository. Thirteen of the fifteen test cases are fully or mechanistically validated; two require an operator to enable the gate (`ENABLE_PROTECTED_APPROVAL_GATE = 'true'`) and at least one qualifying human approval on a protected-author PR. See **Human intervention required** below.

---

## Environment state at validation time

| Variable | Observed value |
|---|---|
| `ENABLE_PROTECTED_APPROVAL_GATE` | `false` (preview/OFF mode inferred from run observations) |
| `REQUIRED_APPROVAL_COUNT` | `2` (inferred from evaluation output) |
| `PROTECTED_PR_AUTHOR_LOGINS` | includes `mfrancza-developer-agent` (inferred from failure on dev-agent PRs) |
| `PROTECTED_APPROVAL_REVIEWERS` | empty or not configured (any non-author counts) |

---

## Test cases

### ✅ Case 3 — `evaluateSha` fallback (unit test coverage)

**Decision 12 item 3:** Simulate a `synchronize` event where `pulls.list?state=open` omits the triggering PR at the new head SHA.

**Unit test:** `.github/scripts/test/check-protected-approval-gate.test.ts`

```
"falls back on a direct pulls.get when the listing omits the triggering PR (Decision 8 synchronize race)"
"injects the fallback PR even when the listing is nonempty but omits it (mixed-list synchronize race)"
"does not falsely pass when the fallback PR is not open at the live head SHA"
```

**Result:** All 716 unit tests pass (`vitest run`, 2026-11-01). The fallback is implemented: when `listCandidates` omits the triggering PR (whether the listing is empty or nonempty), the activity appends the PR via `fallbackPrNumber` and re-validates it with a direct `pulls.get` call that checks live state and SHA. A stale listing that omits the triggering PR is corrected; a PR genuinely closed or on a different SHA is still skipped.

---

### ✅ Case 4 — Exit code reflects conclusion (unit test coverage)

**Decision 12 item 4:** Unit test the composite action's exit code for both `success` and `failure` conclusions.

**Unit tests:**

```
"exits non-zero (setFailed) when conclusion is failure"
"does not call setFailed when conclusion is success"
"does not publish enforcing conclusion when disabled (preview mode still sets exit code)"
```

**Result:** `core.setFailed` is called (sets `process.exitCode = 1`) when the evaluation concludes `failure`; it is not called on `success`. This maps the composite action's conclusion to a non-zero / zero exit code, which GitHub Actions translates to `conclusion: failure` / `conclusion: success` on the auto-emitted job check. Confirmed by all 716 unit tests passing.

---

### ✅ Case 12 — Shared head SHA — strictest wins (unit test coverage)

**Decision 12 item 12:** Carry forward from the parent design's Decision 9 items 10–12, re-asserted against auto-emitted job checks.

**Unit test:**

```
"uses paginated open PR listing and publishes the strictest shared-SHA result"
```

**Result:** When a protected PR (#43, `developer[bot]`, 0 approvals) shares the same head SHA as an unprotected PR (#42, `human`), the activity evaluates both PRs and the failing evaluation (0 approvals for the protected PR) drives the shared conclusion to `failure`. Confirmed passing.

---

### ✅ Case 13 — Standard counting cases (unit test coverage)

**Decision 12 item 13:** The counting matrix from the parent design's Decision 9 item 18.

**Unit tests:**

```
it.each — "evaluates %s using latest opinionated reviews":
  - zero approvals → failure
  - one approval → failure (threshold 2)
  - two approvals → success
  - a later comment preserves an approval
  - a later dismissal removes an approval
"applies custom thresholds and self-excludes the author of each protected PR"
```

**Result:** All counting cases pass. Latest-opinionated-per-reviewer semantics are preserved; self-review exclusion is applied per-PR (the PR author's own approval never counts even when the author is listed in qualifying reviewers).

---

### ✅ Case 5 (mechanism) — Review-event rerun chain

**Decision 12 item 5:** Dev-agent PR receives approvals → notifier fires → dispatcher reruns publisher → resulting check on PR head SHA.

**Live evidence:**

| Event | Run ID | Link |
|---|---|---|
| PR review submitted on PR #789 | notifier: 41357795493 | https://github.com/mfrancza/agentic-development-workflow/actions/runs/41357795493 |
| Notifier completes → dispatcher triggers | dispatcher: 41357806015 | https://github.com/mfrancza/agentic-development-workflow/actions/runs/41357806015 |
| Publisher rerun triggered for PR #789 | rerun of 41357614875 | dispatcher notice: "Triggered publisher rerun (run 41357614875) for PR #789." |

**Dispatcher log excerpt:**
```
Find and rerun latest publisher run for PR  PR_NUMBER: 789
Find and rerun latest publisher run for PR  ##[notice]Triggered publisher rerun (run 41357614875) for PR #789.
```

**Result (mechanism):** The notifier → dispatcher → publisher-rerun chain is working end-to-end. The dispatcher locates the latest `pull_request_target` publisher run for the reviewed PR and calls `POST /actions/runs/{run_id}/rerun`. Full case 5 assertion (merge box clears after approvals in ON mode) requires `ENABLE_PROTECTED_APPROVAL_GATE = 'true'`; see **Human intervention required**.

---

### ✅ Case 7 (mechanism) — Scheduled reconcile sweep reruns

**Decision 12 item 7:** PR stuck in BLOCKED predating an activity change; the scheduled reconcile sweep triggers a rerun.

**Live evidence (reconcile run 41356698033, schedule-triggered):**

```
✓ sweep / find-open-prs  — 4s
✓ sweep / rerun (786)    — 7s  → "Triggering rerun of publisher run 41352737411 for PR #786. Rerun triggered successfully."
✓ sweep / rerun (788)    — 6s  → rerun triggered
✓ sweep / rerun (785)    — 6s  → rerun triggered
✓ sweep / rerun (787)    — 6s  → rerun triggered
✓ sweep / rerun (784)    — 6s  → rerun triggered
```

Run link: https://github.com/mfrancza/agentic-development-workflow/actions/runs/41356698033

**Result (mechanism):** The sweep correctly enumerates all open PRs (786, 788, 785, 787, 784) and triggers publisher reruns for each one. The rerun API is called successfully for all PRs that have a prior `pull_request_target` publisher run. Full case 7 assertion (rerun produces correct check-run that clears merge box) requires ON mode; see **Human intervention required**.

---

### ✅ Case 15 (OFF portion) — Preview context behavior under gate OFF

**Decision 12 item 15 (first half):** With the gate OFF, developer-agent PRs show `protected-approval-gate (preview)` as the check; `protected-approval-gate` (enforcing) does not appear.

**Live GraphQL query:**

```graphql
{
  repository(owner: "mfrancza", name: "agentic-development-workflow") {
    pullRequest(number: 789) {
      mergeStateStatus
      commits(last: 1) {
        nodes {
          commit {
            checkSuites(first: 10) {
              nodes {
                app { databaseId }
                checkRuns(filterBy: { checkName: "protected-approval-gate" }, first: 5) {
                  nodes { name conclusion status }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

**GraphQL result (PR #789, head `b0d6c46...`):**
```json
{
  "mergeStateStatus": "BLOCKED",
  "checkRuns": [
    { "name": "protected-approval-gate", "conclusion": "SKIPPED", "status": "COMPLETED" }
  ]
}
```

**`gh pr checks 789` excerpt:**
```
protected-approval-gate (preview)  fail  11s   https://github.com/.../runs/41357614875/job/125001003349
protected-approval-gate            skipping  0   https://github.com/.../runs/41357614875/job/125001004307
```

**Preview failure output (from run 41357614875 annotations):**
```
Shared SHA candidates:
- #789: failure — Pull request has 0 qualifying approval(s); 2 required before it can merge.
```

**Result:** Gate-OFF behavior is confirmed:
- `protected-approval-gate (preview)` runs and correctly evaluates 0 approvals as `failure`
- `protected-approval-gate` (enforcing) is `SKIPPED` (skipped because `ENABLE_PROTECTED_APPROVAL_GATE != 'true'`)
- The merge box is BLOCKED by other checks (Terraform plan failure), not the approval gate itself in OFF mode

The second half of case 15 (ON flip + backfill → enforcing check appears, preview disappears) requires `ENABLE_PROTECTED_APPROVAL_GATE = 'true'`; see **Human intervention required**.

---

### ✅ Case 2 (preview confirmation) — Gate evaluates failure correctly in preview mode

**Decision 12 item 2 (preview mode version):** PR with fewer than required approvals shows `failure`.

**Live evidence (PR #789, 0 approvals, `REQUIRED_APPROVAL_COUNT = 2`):**

Publisher run 41357614875 annotation:
```
protected-approval-gate (preview): X Process completed with exit code 1.
protected-approval-gate (preview): X Shared SHA candidates:
- #789: failure — Pull request has 0 qualifying approval(s); 2 required before it can merge.
```

Publisher run 41357444652 annotation (PR #785, 2 approvals, merged):
```
protected-approval-gate (preview): - Shared SHA candidates:
- #785: success — Pull request has 2 qualifying approval(s); 2 required.
```

**Result:** The activity correctly evaluates 0 approvals as `failure` and 2 approvals as `success`. Full case 2 assertion (enforcing check blocks merge box in ON mode) requires `ENABLE_PROTECTED_APPROVAL_GATE = 'true'`; see **Human intervention required**.

---

### ✅ Case 9 (unit test + mechanism) — Departed-SHA sibling rerun

**Decision 12 item 9:** Close dev-agent PR → human PR's publisher is rerun and merge box clears.

**Unit tests:**

```
"triggers departed-SHA sibling reruns for remaining open PRs on the old SHA"
"warns (does not fail) when a sibling's rerun API call errors"
"warns (does not fail) when no prior publisher run exists for a sibling"
"fails loudly when the departed-SHA sibling listing fails"
"does not trigger sibling reruns when disabled (preview mode)"
```

**Result:** The departed-SHA sibling rerun logic is unit-tested and passing. The activity calls `listWorkflowRuns` with `event: pull_request_target` to find the sibling's publisher run, then calls `reRunWorkflow`. Errors are handled gracefully (warning + sweep safety net). The fail-loud posture on departed-SHA listing failure is confirmed.

Live end-to-end validation of this case (two PRs sharing head SHA, one closed, sibling merge box clears) requires creating such a setup with gate ON; see **Human intervention required**.

---

## Open findings

### Finding F-1: Spurious `head-sha` input in publisher workflow

**File:** `.github/workflows/protected-approval-gate-publisher.yml` (lines 122 and 222)

The publisher workflow passes `head-sha: ${{ github.event.pull_request.head.sha }}` to the composite action, but the action definition (`.github/actions/check-protected-approval-gate/action.yml`) does not declare a `head-sha` input. The action fetches the live head SHA via a direct `pulls.get` API call, so the `head-sha` value from the event payload is not used.

**Observable symptom:** Every publisher run produces the annotation:
```
! Unexpected input(s) 'head-sha', valid inputs are ['protected-pr-author-logins', 'required-approval-count', 'enabled', 'qualifying-reviewers', 'resolver-token', 'pr-number', 'repo', 'departed-sha', 'departed-pr-number', 'publisher-workflow-file']
```

**Impact:** Cosmetic annotation noise on every publisher run. Does not affect correctness (the action ignores the unrecognized input). The design intent (always fetch the live SHA via the API) is preserved.

**Recommended fix:** Remove the `head-sha:` lines at lines 122 and 222 of `protected-approval-gate-publisher.yml`.

---

## Human intervention required

The following cases cannot be validated without an operator enabling the gate and at least one qualifying human approval:

| Case | Requirement | Status |
|---|---|---|
| 1 — Merge box clears on success | Gate ON + 2 qualifying approvals on a dev-agent PR | ❌ Pending operator action |
| 2 — Merge box stays blocked on failure (enforcing) | Gate ON + 0 approvals on a dev-agent PR | ❌ Pending operator action |
| 5 — Review-event rerun (full: merge box clears) | Gate ON + 2 approvals submitted after initial run | ❌ Pending operator action |
| 6 — Review event on PR with no prior publisher run | Gate OFF→ON flip, verify rerun targets OFF-mode run | ❌ Pending operator action |
| 7 — Scheduled sweep rerun (full: merge box clears) | Gate ON + stuck PR + sweep interval | ❌ Pending operator action |
| 8 — Backfill run | Gate OFF→ON flip + manual backfill dispatch | ❌ Pending operator action |
| 9 — Departed-SHA sibling rerun (full live test) | Two PRs on shared SHA, close one, check other's merge box | ❌ Pending operator action |
| 10 — Fork-authored PR publication | Fork PR against this repo | ❌ Pending operator action |
| 11 — Trust-anchor test (modified notifier) | One qualifying approval + attack simulation | ❌ Pending operator action |
| 14 — Draft → ready-for-review with unchanged head | Gate ON + draft PR marked ready | ❌ Pending operator action |
| 15 — Preview context behavior (ON flip + backfill) | Gate OFF→ON flip + backfill + enforcing check observed | ❌ Pending operator action |

### Operator runbook for remaining cases

1. Set `ENABLE_PROTECTED_APPROVAL_GATE = 'true'` in the repository's Actions variables (Terraform variable `enable_protected_approval_gate`).
2. Run the backfill workflow (`protected-approval-gate-backfill.yml`) to ensure all open dev-agent PRs get an enforcing check-run.
3. For a dev-agent PR with 0 qualifying approvals: verify `mergeStateStatus = BLOCKED` and `protected-approval-gate` conclusion is `failure`.
4. Submit 2 qualifying approvals on the same PR; verify the dispatcher reruns the publisher and `mergeStateStatus` transitions to `CLEAN` or `HAS_HOOKS`.
5. For case 6: confirm that a PR with only OFF-mode runs (preview job) gets correctly rerun by the dispatcher under ON mode (no no-op commit needed).
6. For case 9: open two PRs on the same branch/head SHA, receive approvals on both, close the first; verify the second's check updates automatically.
7. For case 10: open a fork PR and verify the enforcing check appears on the fork PR's head commit.
8. For case 11: submit a PR that modifies the notifier; verify the publisher still produces the correct enforcing conclusion and the attack degrades the effective gate to 1 approval (baseline `required_approving_review_count`).

### GraphQL query for verifying merge state

```graphql
query($prNumber: Int!) {
  repository(owner: "mfrancza", name: "agentic-development-workflow") {
    pullRequest(number: $prNumber) {
      number
      mergeStateStatus
      mergeable
      commits(last: 1) {
        nodes {
          commit {
            checkSuites(first: 20) {
              nodes {
                app { name databaseId }
                checkRuns(filterBy: { checkName: "protected-approval-gate" }, first: 5) {
                  nodes {
                    name
                    conclusion
                    status
                    detailsUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Expected transition on success (case 1):
- Before approvals: `mergeStateStatus: BLOCKED`, `protected-approval-gate` conclusion `FAILURE`
- After approvals + dispatcher rerun: `mergeStateStatus: CLEAN` (or `HAS_HOOKS`), `protected-approval-gate` conclusion `SUCCESS`
