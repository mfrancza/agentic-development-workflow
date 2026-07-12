# Design: Remove Agent Label When Task Is Complete

**Issue:** [#45](https://github.com/mfrancza/agentic-development-workflow/issues/45)

## Summary

Each `agent:*` routing label currently persists on the issue indefinitely after
the agent finishes its work. This design adds automatic cleanup so that each
agent removes its own routing label once its task is fully done — including any
iterative steps such as review-response cycles and post-merge fixes.

## Requirements (from issue #45 grooming Q&A)

1. **`agent:groom`** — remove the label when the grooming agent's single
   workflow run completes successfully. Completion is well-defined: the
   `agent-groom.yml` workflow run ends.
2. **`agent:design`** — remove the label when the designer's iterative task
   finishes. The natural terminal signal is the design PR being **merged**
   (the designer's work persists through review-response cycles until then).
   Abandoned (closed without merging) design PRs do not trigger removal: the
   label remaining signals the design work is incomplete and may need to be
   restarted.
3. **`agent:developer`** — remove the label when the developer's PR is
   **closed** (merged or abandoned). The developer's iterative loop —
   `respond-review`, `fix-checks`, `fix-deployment` — terminates at PR close.
   For abandoned PRs the label should be removed just as for merged PRs:
   the agent is definitively done, and re-triggering is a deliberate human
   action.
4. **Failure cases** — if an agent workflow errors partway through, the label
   must remain so the issue can be re-routed.
5. **Other `agent:*` labels** — this design covers only the three routing labels
   currently in use. Future agent types follow the same pattern.

## Design

### Decision 1: Workflow step removes the label, not the agent container

**Decision:** Each label removal is a plain shell step in a GitHub Actions
workflow, not a `gh issue edit` call inside the agent container.

**Alternatives considered:**

- *Agent container removes its own label* — requires the container to reach its
  own cleanup block at the end of a successful run. A container that crashes or
  times out never reaches cleanup. Workflow-level steps with `if: success()` are
  more reliable because GitHub Actions handles the step-skip logic automatically.
- *A separate cleanup workflow triggered by `workflow_run: completed`* — adds
  a fan-out: every workflow that finishes would fan into a cleanup workflow,
  which must then look up which issue was involved. More indirection for no
  benefit over adding a step to the originating workflow.

Workflow steps win: they already have the minted installation token in scope
(from earlier steps), they know the issue number from the event payload, and
the `if: success()` default means a failed container run leaves the label in
place — exactly the desired failure-mode behavior.

### Decision 2: `agent:groom` cleanup — final step in `agent-groom.yml`

Add one step after the "Run grooming agent" step in `agent-groom.yml`:

```yaml
- name: Remove agent:groom label
  if: success()
  env:
    GH_TOKEN: ${{ steps.setup.outputs.token }}
  run: |
    set -euo pipefail
    gh issue edit "${{ github.event.issue.number }}" \
      --repo "${{ github.repository }}" \
      --remove-label "agent:groom"
```

`if: success()` is the default for steps but is stated explicitly for clarity:
the label stays when any preceding step fails.

The developer-agent App already has Issues: read/write, so no permission change
is needed. The `permissions:` block in the workflow controls `GITHUB_TOKEN`, not
the custom minted token — no change needed there either.

### Decision 3: `agent:design` cleanup — extend the `undraft-sub-issues` job in `agent-design.yml`

The `undraft-sub-issues` job already fires on `pull_request: closed` (merged,
design branch), extracts `PARENT_ISSUE` from the branch name
`design/issue-{N}`, and holds a minted developer-agent token. Adding one
`gh issue edit --remove-label "agent:design"` call at the end of that job's
existing script requires no additional token-minting, no new job, and no new
trigger.

**Why not a separate job?** A separate job would duplicate token-minting and
branch-name parsing; the existing `undraft-sub-issues` job is the right location
because it already owns the "react to design-PR merge" logic.

**Abandoned design PRs:** The `undraft-sub-issues` job already gates on
`github.event.pull_request.merged == true`, so it does not fire when a design
PR is closed without merging. This is intentional: the `agent:design` label
remaining on an issue signals the design work is incomplete. If a human wants to
restart the designer they simply re-apply the label.

### Decision 4: `agent:developer` cleanup — new workflow `agent-pr-merged.yml`

**Decision:** A new workflow file `agent-pr-merged.yml` triggered on
`pull_request: [closed]` handles developer-agent label removal.

**Why not extend `agent-design.yml`?** That file already handles
`pull_request: [closed]` events for a different purpose (design-branch merge
detection). Adding developer-agent PR tracking to it mixes two unrelated
concerns and makes the job conditions harder to reason about.

**Why not extend `agent-respond-review.yml`?** That workflow fires on
`pull_request_review: submitted`, not on PR close — a different event entirely.

A new standalone `agent-pr-merged.yml` is the cleanest option. It:

1. Triggers on `pull_request: [closed]`.
2. Gates on `github.event.pull_request.user.login == 'mfrancza-developer-agent[bot]'`
   (same authorship gate as `agent-respond-review.yml`).
3. Fires for **both** merged and abandoned (closed without merging) PRs:
   in both cases the developer agent's iterative loop is definitively over.
4. Extracts the linked issue number from `Closes #N` in the PR body — the same
   lookup pattern used in `agent-fix-deployment.yml`.
5. Removes `agent:developer` from the linked issue using the minted token.
6. Skips cleanly (logs a message, exits 0) if no `Closes #N` reference is found
   — not every developer-agent PR necessarily closes an issue
   (e.g. `fix-deployment` PRs).

**Security posture:** The workflow does not use `GITHUB_TOKEN` for any
mutating action — all writes use the minted developer-agent installation token,
consistent with every other agent workflow. The `permissions:` block stays
minimal (`contents: read`; the minted token carries its own scopes). No
`pull_request_target` is needed because the workflow reads only the PR event
payload (no repo checkout required for a label-removal step). No checkout step
is needed, following the pattern of the `undraft-sub-issues` job in
`agent-design.yml`.

**Concurrency:** `agent-pr-merged-pr-{N}` per PR, `cancel-in-progress: false`
(consistent with other agent workflows).

### Decision 5: What if the label is already absent or the issue is closed?

`gh issue edit --remove-label` exits 0 whether or not the label was present
before the call. Removing a label that is not there is a no-op. Similarly, the
call succeeds for a closed issue as long as the token has Issues: write. No
special handling needed.

## Out of scope

- **`agent:review` cleanup.** This label lives on PRs (not issues) and the
  re-review loop is designed to continue while the label is present. Its
  lifecycle is already managed by whoever applied it. No change.
- **New `agent:*` types.** Future agent types will need their own cleanup
  strategies following the same pattern (workflow step or PR-close handler);
  this design does not prescribe a mechanism for unknown future agents.
- **Notification on label removal.** No comment or notification is posted; the
  label disappearing is the signal.
- **Cleanup for abandoned design PRs.** Intentionally out of scope — see
  Decision 3 above.
- **Retroactive cleanup.** Issues that already carry stale `agent:*` labels
  before this lands are not automatically cleaned up; a human may remove them
  manually.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| [#158](https://github.com/mfrancza/agentic-development-workflow/issues/158) | Modify `agent-groom.yml`: add final step to remove `agent:groom` after successful run | — |
| [#159](https://github.com/mfrancza/agentic-development-workflow/issues/159) | Modify `agent-design.yml`: extend `undraft-sub-issues` job to remove `agent:design` from parent issue when design PR merges | — |
| [#160](https://github.com/mfrancza/agentic-development-workflow/issues/160) | New workflow `agent-pr-merged.yml`: on `pull_request: [closed]` by the developer-agent bot, extract linked issue via `Closes #N`, remove `agent:developer` | — |
| [#161](https://github.com/mfrancza/agentic-development-workflow/issues/161) | Update `AGENTS.md`: document that `agent:*` labels are removed on task completion in the Labels section | — |
| [#162](https://github.com/mfrancza/agentic-development-workflow/issues/162) | End-to-end validation: verify each agent removes its label in a real workflow run (groom run, design PR merge, developer PR merge/close) | Issue #158, Issue #159, Issue #160, Issue #161 |

Tasks 1–4 are independent and can proceed in parallel. Task 5 validates the
complete cleanup loop end-to-end.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
