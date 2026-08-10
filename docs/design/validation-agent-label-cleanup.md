# End-to-end Validation: `agent:*` Label Removal on Task Completion

**Issue:** [#162](https://github.com/mfrancza/agentic-development-workflow/issues/162)  
**Validates:** [#45](https://github.com/mfrancza/agentic-development-workflow/issues/45)  
**Validation date:** 2026-08-10

## Summary

This document records the end-to-end validation of the three `agent:*` label
cleanup paths implemented in issues #158, #159, #160, and #161.

| Path | Mechanism | Result |
|------|-----------|--------|
| `agent:groom` | Final step in `agent-groom.yml` with `if: success()` | ✅ **PASS** |
| `agent:design` | `undraft-sub-issues` job in `agent-design.yml` on design-PR merge | ✅ **PASS** |
| `agent:developer` | `agent-pr-merged.yml` on `pull_request.closed` | ❌ **FAIL** |

**Overall status:** Issue #45 cannot be closed; path 3 (`agent:developer`) is
non-functional and requires an implementation fix.

---

## Path 1: `agent:groom`

### Happy path

Workflow run
[`30871652130`](https://github.com/mfrancza/agentic-development-workflow/actions/runs/30871652130)
(2026-08-04) confirmed that the `Remove agent:groom label` step ran and
successfully removed `agent:groom` from issue
[#236](https://github.com/mfrancza/agentic-development-workflow/issues/236)
after the grooming container exited 0.

Relevant log lines:
```
groom  Remove agent:groom label  ISSUE_NUMBER: 236
groom  Remove agent:groom label  https://github.com/mfrancza/agentic-development-workflow/issues/236
```

Post-run label state of issue #236: `agent:groom` is absent. ✅

### Failure mode

Workflow run
[`30871117043`](https://github.com/mfrancza/agentic-development-workflow/actions/runs/30871117043)
(2026-08-04) confirmed that when the grooming container exits non-zero
(`Process completed with exit code 1`), the `Remove agent:groom label`
step is skipped — the `if: success()` condition on that step prevents it
from running. The label remained on issue #236, allowing a re-trigger
(which succeeded in run `30871652130` above). ✅

---

## Path 2: `agent:design` (`undraft-sub-issues` job)

### Happy path

Workflow run
[`31349191866`](https://github.com/mfrancza/agentic-development-workflow/actions/runs/31349191866)
(2026-08-10) confirmed that when the design PR for branch `design/issue-64`
was merged, the `undraft-sub-issues` job:

1. Extracted parent issue number `64` from `HEAD_REF: design/issue-64`.
2. Found 2 sub-issues (#130, #131).
3. Removed `draft` from sub-issue #130 (success URL returned).
4. Removed `draft` from sub-issue #131 (success URL returned).
5. Removed `agent:design` from issue #64 (success URL returned).

Relevant log lines:
```
undraft-sub-issues  Remove draft label…  Design PR merged for branch design/issue-64; removing draft label from sub-issues of issue #64.
undraft-sub-issues  Remove draft label…  Found 2 sub-issue(s).
undraft-sub-issues  Remove draft label…  Removing draft label from issue #130.
undraft-sub-issues  Remove draft label…  https://github.com/mfrancza/agentic-development-workflow/issues/130
undraft-sub-issues  Remove draft label…  Removing draft label from issue #131.
undraft-sub-issues  Remove draft label…  https://github.com/mfrancza/agentic-development-workflow/issues/131
undraft-sub-issues  Remove draft label…  Done un-drafting 2 sub-issue(s).
undraft-sub-issues  Remove draft label…  Removing agent:design label from parent issue #64.
undraft-sub-issues  Remove draft label…  https://github.com/mfrancza/agentic-development-workflow/issues/64
```

Post-run label state:
- Issue #64: `agent:design` absent; retains `enhancement`, `plan`. ✅
- Issue #130: `draft` absent; now carries `agent:developer` (development work in progress). ✅
- Issue #131: `draft` absent. ✅

### Failure mode

The `undraft-sub-issues` script uses `set -euo pipefail` and explicitly calls
`exit 1` when the sub-issues API call fails or when a label is still present
after a failed `gh issue edit` attempt. No label removal occurs if the script
exits before reaching those lines. This matches the required behavior (label
stays on the issue when the workflow errors). ✅ (Confirmed by code review;
no observed failure run available to cite.)

---

## Path 3: `agent:developer` — `agent-pr-merged.yml`

### Result: ❌ BROKEN

The `agent-pr-merged.yml` workflow (Actions workflow ID `325749893`) has **never
fired on a `pull_request.closed` event** since it was merged to `main` on
2026-08-04.

#### Symptom: persistent "workflow file issue" failures

Every commit pushed to any branch that contains `agent-pr-merged.yml` produces
a failed workflow run for this workflow file with 0 jobs and conclusion
`failure`. GitHub displays: *"This run likely failed because of a workflow file
issue."* All such runs carry `event: push`, not `event: pull_request`:

| Run ID | Date | Branch | Event | Conclusion |
|--------|------|--------|-------|------------|
| `31349125791` | 2026-08-10 | main | push | failure |
| `31349191773` | 2026-08-10 | main | push | failure |
| `31345483827` | 2026-08-10 | main | push | failure |
| `30871267194` | 2026-08-04 | main | push | failure |
| `30871044730` | 2026-08-04 | agent/issue-160 | push | failure |
| `30763528522` | 2026-08-02 | agent/issue-160 | push | failure |

A query for `pull_request`-triggered runs against this workflow ID returns zero
results (`total_count: 0`).

#### Evidence: label not removed after developer-agent PR merge

PR [#239](https://github.com/mfrancza/agentic-development-workflow/pulls/239)
was authored by `mfrancza-developer-agent[bot]`, contains `Closes #109` in its
body, and was merged on 2026-08-10T02:11:46Z — after `agent-pr-merged.yml`
was present on `main`. Issue
[#109](https://github.com/mfrancza/agentic-development-workflow/issues/109)
still carries the `agent:developer` label; the workflow never fired. ❌

PR [#221](https://github.com/mfrancza/agentic-development-workflow/pulls/221)
was authored by `mfrancza-developer-agent[bot]` and closed (without merge) on
2026-08-10T00:42:40Z. No label-removal workflow ran for its linked issue. ❌

#### Investigation

The YAML is syntactically valid. The `pull_request: types: [closed]` trigger is
identical in structure to the working `undraft-sub-issues` job in
`agent-design.yml`. The `actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1`
SHA resolves correctly to `v3.2.0`. No BOM or non-standard encoding was found.

The failure predates any other change to the file — the first push to branch
`agent/issue-160` (before the workflow was even merged to `main`) already showed
the same "workflow file issue" pattern. The root cause was not determined during
this validation pass; the YAML content as committed does not surface an obvious
schema violation.

#### Required follow-up

A follow-up issue should be opened to debug the schema validation error in
`agent-pr-merged.yml` and restore the `pull_request.closed`-triggered label
removal. Until that fix merges, `agent:developer` labels are not automatically
removed when developer-agent PRs are closed.

---

## Failure-mode summary

| Label | Mechanism | Verified failure-mode behavior |
|-------|-----------|-------------------------------|
| `agent:groom` | `if: success()` on removal step | ✅ Label stays when container fails (run `30871117043`) |
| `agent:design` | `set -euo pipefail` + explicit `exit 1` before removal | ✅ Label stays when API/permission errors occur (code review) |
| `agent:developer` | N/A — workflow never fires | Label always stays (unintentionally — see Path 3) |
