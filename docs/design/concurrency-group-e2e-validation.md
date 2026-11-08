# E2E Validation: shared `agent-branch-pr-<N>` concurrency group

**Issue:** [#811](https://github.com/mfrancza/agentic-development-workflow/issues/811)
**Parent:** [#769](https://github.com/mfrancza/agentic-development-workflow/issues/769) — Serialize fix-checks, respond-review, and resolve-conflicts on one per-PR concurrency group
**Prerequisites:** [#809](https://github.com/mfrancza/agentic-development-workflow/issues/809) (workflow + test), [#810](https://github.com/mfrancza/agentic-development-workflow/issues/810) (AGENTS.md docs) — both merged

---

## Static validation (all scenarios — prerequisite)

Before any runtime test, the static invariant must hold. The enforcing test is
`test/branch-concurrency-group.test.ts`, which asserts:

1. All three reusables contain exactly one line matching `/^\s*group:\s*agent-branch-pr-/`.
2. No reusable contains any retired prefix (`agent-fix-checks-pr-`, `agent-respond-review-pr-`,
   `agent-resolve-conflicts-pr-`).

**Result as of this validation record (commit `3ab069f`):**

```
✓ branch-writing reusables — shared concurrency group
  ✓ finds the expected three reusable files
  ✓ agent-fix-checks-reusable.yml: contains exactly one line matching the shared group prefix
  ✓ agent-fix-checks-reusable.yml: does not contain retired prefix 'agent-fix-checks-pr-'
  ✓ agent-fix-checks-reusable.yml: does not contain retired prefix 'agent-respond-review-pr-'
  ✓ agent-fix-checks-reusable.yml: does not contain retired prefix 'agent-resolve-conflicts-pr-'
  ✓ agent-respond-review-reusable.yml: contains exactly one line matching the shared group prefix
  ✓ agent-respond-review-reusable.yml: does not contain retired prefix 'agent-fix-checks-pr-'
  ✓ agent-respond-review-reusable.yml: does not contain retired prefix 'agent-respond-review-pr-'
  ✓ agent-respond-review-reusable.yml: does not contain retired prefix 'agent-resolve-conflicts-pr-'
  ✓ agent-resolve-conflicts-reusable.yml: contains exactly one line matching the shared group prefix
  ✓ agent-resolve-conflicts-reusable.yml: does not contain retired prefix 'agent-fix-checks-pr-'
  ✓ agent-resolve-conflicts-reusable.yml: does not contain retired prefix 'agent-respond-review-pr-'
  ✓ agent-resolve-conflicts-reusable.yml: does not contain retired prefix 'agent-resolve-conflicts-pr-'
```

The caller-stub placement regression check also passes:

```
✓ agent-*.yml caller stubs — concurrency placement
  ✓ finds at least one caller stub to test
  ✓ no caller stub with a label/sender gate declares workflow-level concurrency
```

Full suite: **810 tests, 46 test files, 0 failures.**

Confirmed YAML values (extracted from the three reusables at this commit):

| Reusable | Concurrency group line |
|----------|------------------------|
| `agent-fix-checks-reusable.yml` (line 179) | `group: agent-branch-pr-${{ inputs.event-name == '' && inputs.pr-number \|\| needs.resolve-trigger.outputs.pr_number }}` |
| `agent-respond-review-reusable.yml` (line 252) | `group: agent-branch-pr-${{ inputs.pr-number }}` |
| `agent-resolve-conflicts-reusable.yml` (line 158) | `group: agent-branch-pr-${{ matrix.pr_number }}` |

All three:
- Use the shared `agent-branch-pr-` prefix.
- Keep `cancel-in-progress: false`.
- Declare the `concurrency:` block inside the work job (after gate jobs), not at workflow level.

---

## Scenario 1 — Two-way serialisation (fix-checks vs. respond-review)

**Setup:** On a scratch agent PR, manufacture a `fix-checks`-eligible failing check and a
reviewer-agent review within a few seconds of each other.

**Expected Actions-UI behaviour:**

- Two `work` jobs (`fix-checks` and `respond-review`) appear in the same
  `agent-branch-pr-<N>` concurrency slot.
- One job is `in_progress`; the other is `queued`.
- Only one container runs at any moment.
- After both complete, the branch HEAD reflects commits from both runs — no
  force-push loss.

**Verification signal:** Branch commit graph shows two distinct commits (one from
each container) with no missing parent; neither push overwrites the other's tree.

---

## Scenario 2 — Three-way serialisation (add resolve-conflicts)

**Setup:** While one of the Scenario 1 jobs is still `in_progress`, push a change to
`main` that creates a merge conflict with the scratch PR.

**Expected Actions-UI behaviour:**

- The `resolve-conflicts` matrix job for the scratch PR's number also enters the
  `agent-branch-pr-<N>` group.
- It stays `queued` until both Scenario 1 jobs complete.
- Only after the Scenario 1 jobs finish does the `resolve-conflicts` container start.

**Verification signal:** Timeline in the Actions UI shows all three work jobs sharing
the same concurrency group label and running strictly sequentially (no overlapping
start/end timestamps for a given PR number).

---

## Scenario 3 — Dropped-pending-slot recovery

**Setup:** With one job `in_progress` and one `queued`, fire a fourth event on the
same PR (e.g. another check failure or another review submission).

**Expected Actions-UI behaviour:**

- The previously-queued run is displaced (GitHub's single-pending-slot guarantee).
- A new pending run for the fourth event takes the pending slot.
- The displaced work is not silently lost — per-action recovery:

| Displaced action | Recovery path |
|------------------|---------------|
| `fix-checks` | The `agent-fix-checks-poll.yml` backstop fires every 15 minutes and re-dispatches for every open agent PR whose head SHA still carries a qualifying failing check. The displaced run is recovered within one poll interval. |
| `respond-review` | The `check-reviewer-feedback` activity reads _current_ unresolved review threads from GraphQL, not just the event that triggered it. The next review submission (or the existing re-review loop `synchronize`) picks up all outstanding unresolved threads. Bare approvals that were displaced must be re-submitted by the reviewer or by the `agent-review` re-review path on the next `synchronize`. |
| `resolve-conflicts` | Conflict detection enumerates all open agent PRs on every push to `main`. The still-conflicted PR is re-detected on the next push or on a `workflow_dispatch` with `pr_number`. The PR does not auto-resolve; it stays conflicted until a successful resolver run. |

**Verification signal:** After the displacement event, monitor the next natural
upstream signal (poll tick / new review / next push to `main`) and confirm the
work originally meant for the displaced run is performed.

---

## Scenario 4 — Regression: previously-exclusive rules still hold

**What to check:**

1. `test/workflow-concurrency.test.ts` (caller-stub placement rule) passes without
   modification. ✅ **Confirmed above** — 0 violations.
2. Each reusable still correctly skips when its pre-authorize gate rejects the event
   (e.g. wrong label, non-allowlisted sender). The shared group must not absorb
   events that short-circuit at the gate layer.

**Verification signal (gate rejection):**

- Trigger each caller stub with an event that should be rejected at the gate
  (e.g. a label other than `agent:fix-checks` for `fix-checks`).
- Confirm the gate job exits with `proceed == 'false'` and the work job is
  skipped entirely — the concurrency slot is never acquired.
- Confirm no spurious queued runs appear on `agent-branch-pr-<N>` for the
  rejected event.

**Expected result:** Because each reusable places `concurrency:` inside the work
job (after the gate jobs), a gate-rejected event does not enter the shared queue.
Only events that pass the gate compete for the per-PR serialisation slot.

---

## Relationship to `docs/design/shared-branch-concurrency-group.md`

This validation record corresponds to the task breakdown row for issue #811 in
`docs/design/shared-branch-concurrency-group.md` (Decision 4 and the Task breakdown
table). The design document is the authoritative reference for _why_ the group shape
was chosen; this document records _what was observed_ during the validation pass.
