# Validation Report: Two-Label Escalation Pattern for `resolve-conflicts`

**Issue:** [#442](https://github.com/mfrancza/agentic-development-workflow/issues/442)
**Date:** 2026-09-07
**Validator:** developer agent (automated)
**Branch:** `agent/issue-442`

---

## Summary

Static code inspection confirms that all three implementation sub-issues
(#439 Terraform label, #440 entrypoint, #441 design-doc updates) are merged
and correctly implemented. However, **live validation steps 2–4 are blocked**
by a missing runtime prerequisite: the `conflicts-escalated` label has not
yet been created in the repository (i.e., `terraform apply` has not been run
since PR #444 was merged). Step 1 and step 5 are documented below based on
static inspection and repository state inspection. A human operator must run
`terraform apply` and then complete the live workflow run portions of this
report.

---

## Prerequisites Check

| Prerequisite | Status |
|---|---|
| Issue #439 (Terraform `conflicts-escalated` label) | ✅ CLOSED — PR #444 merged |
| Issue #440 (Entrypoint skip-guard + both labels on escalation) | ✅ CLOSED — PR #446 merged |
| Issue #441 (Design-doc updates) | ✅ CLOSED — PR #445 merged |
| `conflicts-escalated` label exists in the repo | ❌ **MISSING** — `terraform apply` has not been run |

The Terraform module (`terraform/modules/labels/main.tf`) defines the
`conflicts-escalated` label correctly. Until a maintainer runs
`terraform apply`, `gh pr edit --add-label "conflicts-escalated"` will fail
with a 422 Unprocessable Entity error from the GitHub API, and any actual
escalation by the resolver will error out. **Steps 2–4 cannot be completed
until this prerequisite is satisfied.**

---

## Step 1 — Bug-fix confirmation (static inspection)

**Goal:** Confirm that a PR carrying only `human-required` (no
`conflicts-escalated`) is no longer skipped by the resolver.

**Finding (static):** `entrypoint.sh` lines 643–651 (as of PR #446,
merged commit `d865c5f`):

```bash
# Skip if PR already carries conflicts-escalated — a prior resolution attempt already
# escalated to a human; do not loop. Preflight check avoids an unnecessary clone.
log "Checking PR #${GITHUB_PR_NUMBER} for conflicts-escalated label"
PR_LABELS_JSON="$(gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --json labels)"
if echo "$PR_LABELS_JSON" | jq -e '[.labels[].name] | any(. == "conflicts-escalated")' > /dev/null; then
    echo "::notice title=resolve-conflicts declined::PR #${GITHUB_PR_NUMBER} carries 'conflicts-escalated' — a prior resolution attempt escalated to a human; remove the label to re-attempt."
    log "PR #${GITHUB_PR_NUMBER} carries 'conflicts-escalated' label — skipping (prior escalation)"
    return 0
fi
```

The guard checks **only** `conflicts-escalated`. The word `human-required`
does not appear anywhere in `action_resolve_conflicts`. A PR carrying
`human-required` alone will proceed to `setup_repo` and the merge attempt —
exactly the corrected behavior described in Decision 3 of the escalation-marker
design.

**Old code reference (before PR #446):** The old guard checked `human-required`,
which caused PR #436 (a bootstrap PR with no conflict-related escalation) to
be silently skipped on workflow run 34140358493. That code path has been
replaced.

**Status:** ✅ Confirmed by static inspection. Live confirmation (creating a
test PR with `human-required`, forcing a conflict, dispatching the workflow)
is pending the `conflicts-escalated` label being created so that the full
flow can be validated without a risk of the escalation path failing mid-run.

---

## Step 2 — Escalation applies both labels (pending live run)

**Goal:** Force an unresolvable conflict and verify both `conflicts-escalated`
and `human-required` are applied, and the escalation comment names
`conflicts-escalated`.

**Finding (static):** All three escalation paths in `action_resolve_conflicts`
apply both labels:

- **Path 1** (agent exit non-zero, lines 741–745):
  ```bash
  gh pr edit "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" \
      --add-label "human-required" --add-label "conflicts-escalated" \
      [--add-assignee "$ESCALATION_ASSIGNEE"]
  ```

- **Path 2** (marker-verification failure, lines 792–796): same `gh pr edit`
  pattern.

- **Path 3** (zero-diff no justification, lines 850–854): same `gh pr edit`
  pattern.

All three escalation comments include the closing instruction:

> "Please resolve the conflicts manually, commit the merge, push, and remove
> the `conflicts-escalated` label when done so future conflicts on this PR are
> auto-resolved again. Remove `human-required` separately when the PR no
> longer needs human attention."

This matches Decision 5 of the design doc.

**Status:** ⏳ Live confirmation blocked — `conflicts-escalated` label does
not exist in the repo. Running `gh pr edit --add-label "conflicts-escalated"`
will fail until `terraform apply` is executed.

---

## Step 3 — Loop-prevention: skip on `conflicts-escalated` (pending live run)

**Goal:** With both labels on a PR, verify the resolver emits `::notice::`,
skips, and posts no new comment.

**Finding (static):** The `::notice::` line (line 648) is emitted before the
`return 0` on the skip path. The function returns without proceeding to
`setup_repo` or any subsequent logic, so no new PR comment can be posted by
this path. The existing escalation comment from Step 2 remains as the durable
PR-side record.

**Status:** ⏳ Live confirmation blocked — requires a PR with both labels
applied (which requires Step 2 to have succeeded, which requires the label to
exist).

---

## Step 4 — Re-attempt after human clears the marker (pending live run)

**Goal:** Remove `conflicts-escalated` (leave `human-required`), trigger
another run, verify the resolver re-attempts.

**Finding (static):** The guard checks only for `conflicts-escalated`. Once
that label is removed, the `jq -e` expression evaluates to false and the
function proceeds past the preflight. `human-required` alone does not trigger
the skip. This is structurally identical to Step 1's analysis.

**Status:** ⏳ Live confirmation blocked — depends on Step 3.

---

## Step 5 — Backfill guidance sanity check

**Goal:** Identify any currently open PRs that carry only `human-required`
and were previously escalated by the resolver (requiring `conflicts-escalated`
to be backfilled for loop-prevention).

**Finding:** As of 2026-09-07, all open PRs were inspected:

```
PR #479 — terraform: validate CI pipeline end-to-end (issue #428)
  Labels: [agent:review]  Mergeable: MERGEABLE

PR #478 — Design: Configurable design/implementer→reviewer model-pair preferences
  Labels: [agent:review]  Mergeable: MERGEABLE

PR #477 — Design: Allow multiple reviewer agents to be specified
  Labels: [agent:review]  Mergeable: MERGEABLE

PR #463 — Design: Update currently available models for all vendors
  Labels: [agent:review]  Mergeable: MERGEABLE

PR #457 — Design: Initial v1.0.0 release
  Labels: [agent:review]  Mergeable: MERGEABLE
```

**None of the currently open PRs carry `human-required`.** No backfill is
required. All open PRs are either mergeable with `agent:review` label. No PR
was silently skipped by the old resolver due to `human-required` being present
without a corresponding `conflicts-escalated` marker.

**Status:** ✅ Complete — no backfill action required.

---

## Workflow Runs Referenced

| Step | Workflow Run | Status |
|---|---|---|
| Implementation merged (entrypoint) | [34158728900](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34158728900) | ✅ success |
| Implementation merged (Terraform) | [34158669925](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34158669925) | ✅ success |
| Implementation merged (design docs) | [34158313453](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34158313453) | ✅ success |
| Step 1 live run | _pending `terraform apply`_ | ⏳ |
| Step 2 live run | _pending `terraform apply`_ | ⏳ |
| Step 3 live run | _pending Step 2_ | ⏳ |
| Step 4 live run | _pending Step 3_ | ⏳ |

---

## Remaining Actions Required

1. **[Immediate — human]** Run `terraform apply` in the `terraform/` directory
   (with admin credentials) to create the `conflicts-escalated` label in the
   repo. Verify with:
   ```bash
   gh label list --repo mfrancza/agentic-development-workflow \
       --json name | jq '.[] | select(.name == "conflicts-escalated")'
   ```

2. **[After terraform apply]** Perform live Steps 1–4:
   a. Create a test branch and PR; add `human-required`; force a merge conflict;
      dispatch `agent-resolve-conflicts` workflow; confirm the run proceeds.
   b. Force an unresolvable conflict on a test PR; let the resolver escalate;
      verify both labels are applied and the comment is correct.
   c. With both labels present, dispatch the workflow again; verify the
      `::notice::` annotation appears and no new comment is posted.
   d. Remove `conflicts-escalated`; dispatch again; verify the resolver re-attempts.

3. **[After live validation]** Update this report with workflow run links for
   Steps 1–4 and mark the issue resolved.
