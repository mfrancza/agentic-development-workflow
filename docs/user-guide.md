# User guide

This guide covers day-to-day use of the agentic-development-workflow for issue reporters and developers. Installation and repository configuration are covered in [`docs/adopting.md`](adopting.md).

---

## Issue lifecycle

Issues move through the following stages, each driven by GitHub labels:

```
opened → (groom) → do / plan → (design →) implement → CI → review → merge
```

### 1. Open an issue

File an issue with as much context as you can: what you want, why, and any relevant constraints. The grooming agent works best when it has enough information to classify the issue accurately.

### 2. Grooming (`agent:groom`)

Apply the `agent:groom` label to route the issue to the grooming agent. The agent will:

- Add one or more classification labels (`bug`, `enhancement`, `dependency upgrade`, `do`, `plan`, `question`).
- Add a `model:*` label to select the appropriate model tier based on issue complexity — skipped if any `model:*` label (generic or per-agent) is already present on the issue.
- Post clarifying questions as a comment if the issue needs more detail (`question`).

The `agent:groom` label is removed automatically on success. Re-apply it to re-groom.

**Classification labels and their meaning:**

| Label | Meaning |
|-------|---------|
| `question` | Issue lacks sufficient detail; the agent has posted clarifying questions. |
| `bug` | Reports incorrect or unexpected behavior. |
| `enhancement` | Requests new functionality or an improvement to existing behavior. |
| `dependency upgrade` | Requests upgrading a dependency. |
| `do` | Simple, well-defined task; implementable in one easy-to-review commit. |
| `plan` | Complex enough to need design or planning before implementation. |

### 3. Design (`agent:design`)

For issues labeled `plan`, apply `agent:design` to produce a design document before implementation begins. The agent will:

- Create a `design/issue-{N}` branch with a design document under `docs/design/`.
- Open a PR for human review of the design.
- Create draft sub-issues (labeled `draft`) with dependency tracking.

When the design PR merges, the `draft` label is automatically removed from all sub-issues, making them ready for implementation.

### 4. Implementation (`agent:developer`)

Apply `agent:developer` to route the issue to the developer agent. The agent will:

- Create an `agent/issue-{N}` branch.
- Implement the solution and open a PR that closes the issue.

The `agent:developer` label is removed automatically when the PR is closed (merged or abandoned). Re-apply it to start a new implementation cycle.

> **Note:** The developer agent will not run on issues labeled `draft`. Wait for the design PR to merge first.

> **Note:** The developer agent will not run on issues with open blockers. The `blocked` label is applied when blockers are detected; it is removed automatically once all blockers close.

### 5. CI

CI runs automatically on every push to the agent's PR. If CI fails, the agent is re-invoked to diagnose and push fixes — no manual action is needed. You will see new commits appear on the PR.

### 6. Code review (`agent:review`)

Apply `agent:review` to a **PR** (not an issue) to request a review from the code review agent. The agent will:

- Post a review with inline comments and a summary.
- Re-review automatically on every subsequent push to the PR while the label remains.

Human approval is also required before merging — the reviewer agent's approval does not satisfy the branch-protection requirement.

### 7. Merge

Once the PR has at least one human approval and all CI checks pass, a collaborator squash-merges the PR. The linked issue closes automatically via the `Closes #N` line in the PR description.

---

## Available agent behaviors

The following behaviors are triggered by labels. All label-triggered workflows require the sender to be in the repository's `AGENT_ALLOWLIST`.

### Issue labels

| Label | Applied to | Effect |
|-------|-----------|--------|
| `agent:groom` | Issue | Classify the issue and add labels and notes. Removed automatically on success. |
| `agent:design` | Issue | Write a design doc, open a PR, and create draft sub-issues. |
| `agent:developer` | Issue | Implement the issue, open a PR. Removed when the PR is closed. |

### PR labels

| Label | Applied to | Effect |
|-------|-----------|--------|
| `agent:review` | PR | Request a code review. Re-reviews fire on every subsequent push while the label remains. |

### Automatic behaviors (no label required)

| Trigger | Behavior |
|---------|---------|
| CI fails on an agent-authored PR | Developer agent is re-invoked to fix failing checks. |
| Review submitted on an agent-authored PR | Developer agent addresses feedback and pushes updates. |
| Push to `main` creates merge conflicts on open agent PRs | Agent resolves conflicts in parallel per PR; escalates to humans if it cannot resolve confidently. |
| Deployment failure linked to an agent PR | Agent opens a follow-up fix-up PR. |

> **Note:** Operators can also enable an auto-trigger system (`AUTO_TRIGGER_AGENTS`) that automatically advances issues through the pipeline — applying `agent:groom` on issue open, `agent:design` when `plan` is labeled, `agent:developer` when `do` is labeled or `draft` is removed, and `agent:review` when an agent-branch PR is opened — without any manual label action. See [AGENTS.md](../AGENTS.md) for the full auto-trigger gate configuration.

---

## Lifecycle labels

These labels are managed automatically but are visible and useful to understand.

| Label | Meaning | Who applies it |
|-------|---------|---------------|
| `draft` | Issue is scoped by an unmerged design; implementation is not ready yet. | Designer agent (on sub-issues it creates). Removed when the design PR merges. |
| `blocked` | Implementation deferred because the issue has open blockers. Removed automatically when all blockers close and `agent:developer` is applied. | Auto-trigger when blockers are detected; may also be applied manually as a "hold for later" marker — treated identically regardless of origin. |
| `human-required` | A human is needed — agent has escalated. The issue or PR is also assigned to the relevant person. | Agents at escalation points; also applied manually. |
| `conflicts-escalated` | The conflict-resolution agent already tried this PR and escalated. Remove to re-attempt. | Conflict-resolution agent. |

---

## Overriding the model

By default agents use the model chosen by the grooming agent (or the repo-wide default). To override:

- **Generic override** — apply a `model:<name>` label (e.g. `model:opus`, `model:haiku`, `model:sonnet`) to the issue. This applies to all agents that run on that issue.
- **Per-agent override** — apply a `model:<agent-type>:<name>` label (e.g. `model:developer:opus`, `model:groom:haiku`) to select a different model for a specific agent while leaving the others unchanged.
- **PR review model** — apply a `model:<name>` or `model:review:<name>` label to the **PR** to select the model for the reviewer agent.

At most one label is allowed at each tier. Workflows fail loudly if more than one is present.

---

## Escalating to a human

If an agent reaches a decision point that should not be made unilaterally (security-sensitive changes, permission changes, ambiguous requirements), it applies the `human-required` label and assigns the issue or PR to the relevant person. It also posts a comment explaining what input is needed.

To unblock the agent after providing input, remove the `human-required` label and re-apply the relevant `agent:*` label.

---

## Quick-reference: common actions

| I want to… | Action |
|-----------|--------|
| Classify a new issue | Apply `agent:groom` to the issue |
| Start implementing an issue | Apply `agent:developer` to the issue |
| Request a design before implementing | Apply `agent:design` to the issue |
| Get a code review on a PR | Apply `agent:review` to the PR |
| Re-groom a previously groomed issue | Re-apply `agent:groom` |
| Re-run the developer agent after a PR is closed | Re-apply `agent:developer` |
| Re-attempt conflict resolution | Remove `conflicts-escalated`, then push to `main` or use `workflow_dispatch` |
