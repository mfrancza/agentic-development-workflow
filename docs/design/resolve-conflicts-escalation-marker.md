# Design: `resolve-conflicts` escalation marker — decouple the resolver skip-guard from `human-required`

**Issue:** [#438](https://github.com/mfrancza/agentic-development-workflow/issues/438)
**Parent designs:** [docs/design/resolve-conflicts.md](resolve-conflicts.md) (Issue #54), [docs/design/resolve-conflicts-entrypoint.md](resolve-conflicts-entrypoint.md) (Issue #63)

## Requirements as understood

Per issue #438 and its grooming Q&A, the observed bug is that
`action_resolve_conflicts` in `docker/scripts/entrypoint.sh` (lines ~643–650)
skips any conflicted PR that carries the `human-required` label. That guard
was added to prevent the resolver from looping after its own escalation, but
`human-required` has a broader meaning across the repo — the label criteria
in `agents/grooming/label-criteria.json` apply it to any issue or PR that
needs human attention for reasons unrelated to conflicts (security, permissions,
bootstrap steps, deployments, legal/compliance, etc.).

The concrete symptom (from the issue): PR #436 (documentation for the
`terraform-ci` App identity) carried `human-required` because its follow-up
steps involve creating a GitHub App and setting secrets — routine human
bootstrap, not a resolver escalation. When a subsequent push to `main` made
PR #436 conflicted, `agent-resolve-conflicts` run 34140358493 correctly
enumerated it as CONFLICTING, dispatched `resolve (436)`, and the container
silently returned success after logging the label-based skip. The workflow
run reported success, so nothing surfaced beyond a log line.

The design must:

1. **Decouple the two meanings.** The resolver's re-invocation guard must not
   be triggered by `human-required` applied for non-conflict reasons.
2. **Preserve the loop-prevention guarantee.** A PR whose conflicts the
   resolver already escalated must not be re-attempted on every subsequent
   push to `main`; that is the original purpose of the skip guard and must
   survive the fix.
3. **Leave a visible trace when the resolver declines.** Skipping today
   completes as workflow success with only a log-line explanation. A human
   looking at the workflow run must be able to distinguish "resolver
   declined" from "resolver never ran" without reading `container.log`.
4. **Not require a per-PR data model.** State that survives across
   workflow runs must live on the PR itself (label or comment), not in an
   external store.

Grooming notes fix three specifics: the reporter recommends option (a) (a
distinct `conflicts-escalated` label); the fix touches
`docker/scripts/entrypoint.sh`, `docs/design/resolve-conflicts.md`, and (for
option (a)) `terraform/modules/labels/main.tf`; and the visible-trace
requirement is orthogonal to the choice among the three options.

## Decisions

### Decision 1 — Adopt option (a): a distinct `conflicts-escalated` label

The issue names three options:

- **(a) Distinct escalation marker.** New label `conflicts-escalated`
  applied by the resolver on every escalation path; the resolver skips only
  on that label. `human-required` continues to mean "generic human
  attention" and no longer participates in the resolver's own guard.
- **(b) Escalation-comment check.** Keep the single label but skip only if
  a resolver-owned comment (e.g. one starting with a fixed sentinel like
  `## Automated conflict resolution failed`) is already present on the PR.
- **(c) Status quo + doc.** Document that `human-required` on a PR opts it
  out of automated conflict resolution. Cheapest, but keeps the silent-skip
  trap.

**Chosen:** option (a).

Option (c) is rejected because it hard-codes a bug into policy. Any conflicted
PR carrying `human-required` for reasons unrelated to conflicts (bootstrap
steps, validation PRs, etc.) would remain permanently invisible to the
resolver, and the operator would have to hand-resolve — the exact regression
that PR #436 demonstrated. `human-required` is used broadly in the repo
(see the grooming label criteria), so this class recurs.

Option (b) is rejected because it moves the guard's state from a queryable
label into a comment-timeline scan. Correctness depends on a fixed comment
prefix that no other agent, human, or future feature accidentally reuses; a
label is a first-class, indexed primitive that the entrypoint already reads
(`gh pr view --json labels`) with a single API call. The claim in the issue
that option (b) needs no new label is true, but the cost is more API surface
(list comments, paginate, string-match) for a check the label mechanism does
in one JSON field. Comment-timeline state is also fragile against a human
deleting the escalation comment; the label survives.

Option (a) wins on:

- **Semantic clarity.** The label name states exactly what it guards
  (`conflicts-escalated` — "this PR's conflicts have already been escalated").
  Anyone reading the PR page or filtering by label can see it.
- **Compositional labeling.** `human-required` and `conflicts-escalated` can
  coexist on the same PR (they usually will, since a resolver escalation
  is also a human-attention event). Each label answers exactly one question.
- **One-API-call guard.** The existing `gh pr view --json labels` call in
  the preflight is unchanged in shape; only the label name it checks changes.
- **Reversible.** A human who wants the resolver to re-attempt after
  addressing the escalation removes the `conflicts-escalated` label; the
  next push to `main` will trigger a fresh resolution.

The label name `conflicts-escalated` (past-tense verb + noun) matches the
"state marker" style used by `blocked` and `draft` — it describes a state
the label puts the PR into, not an action to take.

### Decision 2 — Apply both `conflicts-escalated` and `human-required` on every escalation path

The three current escalation paths in `action_resolve_conflicts`
(`docker/scripts/entrypoint.sh`) each apply `human-required`:

1. `run_agent` exits non-zero (API failure, max-turn exhaustion, CLI error)
   — lines ~740–745.
2. Marker-verification failure (staged/unstaged markers remain or unmerged
   paths listed) — lines ~791–796.
3. Zero-diff justification-marker missing — lines ~849–854.

All three continue to apply `human-required` (a human genuinely needs to
act), and now **additionally** apply `conflicts-escalated`. The two labels
answer different questions:

- `human-required` — "a human needs to act on this PR." Read by humans
  filtering their queue; triggers `ESCALATION_ASSIGNEE` assignment.
- `conflicts-escalated` — "the resolver has already tried and declined."
  Read only by the resolver's own re-invocation guard.

Applying both keeps the existing operator UX intact (`human-required` still
routes the PR into the "needs human" filter and triggers the escalation
assignee) while giving the resolver its own state marker.

**Alternative considered:** apply only `conflicts-escalated` and stop
applying `human-required`. Rejected because the resolver escalation genuinely
warrants human attention — it is exactly the case the `human-required` label
was designed for — and removing it would drop these PRs off the queues and
saved searches that operators already use.

### Decision 3 — Preflight guard checks only `conflicts-escalated`

The preflight guard (currently checking `human-required`) becomes:

```bash
if echo "$PR_LABELS_JSON" | jq -e '[.labels[].name] | any(. == "conflicts-escalated")' > /dev/null; then
    echo "::notice title=resolve-conflicts declined::PR #${GITHUB_PR_NUMBER} carries 'conflicts-escalated' — a prior resolution attempt escalated to a human; remove the label to re-attempt."
    log "PR #${GITHUB_PR_NUMBER} carries 'conflicts-escalated' label — skipping (prior escalation)"
    return 0
fi
```

`human-required` is no longer read by the resolver at all. A PR carrying
`human-required` alone (for unrelated reasons like PR #436's bootstrap
steps) is treated like any other conflicted PR and resolution is attempted.

### Decision 4 — Visible trace on skip: workflow-run annotation, not a PR comment

The issue requires that "resolver declined" be distinguishable from
"resolver never ran" without reading job logs. Two candidates:

- **(i) Workflow-run annotation** via `::notice::`. Surfaces in the workflow
  run's summary UI and in the run's annotation list. One line per skip, no
  PR-side artifact, no spam.
- **(ii) PR comment on every skip.** Guaranteed visible on the PR itself
  but produces one comment per push to `main` that leaves the PR conflicted.
  On a long-lived escalated PR this is comment spam.

**Chosen:** option (i). The one-time PR comment posted at the moment of
escalation (already produced by all three failure paths) is the durable
PR-side record; the workflow-run annotation on each subsequent skip is the
per-run record. Together they satisfy the visible-trace requirement without
spam.

A PR-side "we tried again and skipped" comment on every push was considered
and rejected: an escalated PR that stays open for days can attract dozens
of pushes to `main`, and each would generate a duplicate comment. Operators
who want to see per-run history can look at the `agent-resolve-conflicts`
workflow runs; the annotation makes each such run self-describing.

The `::notice::` line is emitted from the container's stdout before the
early `return 0`. GitHub Actions parses workflow commands (`::notice::`,
`::warning::`, `::error::`) from any line in the runner's collected output,
including container stdout, so the annotation surfaces as a first-class
run annotation without changes to the workflow YAML.

### Decision 5 — Escalation comments instruct removal of `conflicts-escalated`, not `human-required`

The current escalation comments end with:

> Please resolve the conflicts manually, commit the merge, push, and remove
> the `human-required` label when done.

That instruction is misleading under the two-label model: removing
`human-required` does not unblock the resolver's guard. The updated
instruction is:

> Please resolve the conflicts manually, commit the merge, push, and remove
> the `conflicts-escalated` label when done so future conflicts on this PR
> are auto-resolved again. Remove `human-required` separately when the PR
> no longer needs human attention.

Two removals are named because the two labels answer different questions.
In practice the human resolving the conflict usually removes both at the
same time, but the guidance is explicit so that a PR carrying
`human-required` for an unrelated reason (bootstrap PR that also happened
to have a merge conflict) is not accidentally cleared just to unblock the
resolver — the operator removes `conflicts-escalated` alone and leaves
`human-required` in place.

### Decision 6 — Rollout: Terraform label must exist before the entrypoint change reaches production

`gh pr edit --add-label "conflicts-escalated"` fails if the label does not
exist on the repo. Terraform in this repo is applied out of band by a
maintainer with admin credentials. The Terraform label change (task 1
below) must therefore reach `main` and be applied via `terraform apply`
before the entrypoint change (task 2 below) reaches `main`.

Two alternatives were considered and rejected:

- **Auto-create the label from the entrypoint** (`gh label create ... --force`
  before the `gh pr edit` call). Rejected because it duplicates the
  Terraform module's authority over the label catalog and creates a drift
  path: Terraform is the source of truth for labels, and side-channel
  creation from a container is a smell the reviewer agent would flag.
- **Bundle both changes into a single PR.** Rejected because the two
  changes have different review surfaces (Terraform infrastructure vs.
  shell logic) and this repo's convention is single-concern PRs. The
  sequencing note here plus a merge-order note in each sub-issue is
  sufficient guardrail.

The E2E validation task (task 4 below) depends on both prior tasks being
merged and Terraform being applied.

### Decision 7 — No changes to `agent-resolve-conflicts.yml` or the `find-conflicted-prs` activity

The workflow enumerates conflicted developer-agent-authored PRs and
dispatches one container per PR. The label-based skip lives entirely inside
the container's preflight. Moving the skip up into the workflow (to avoid
spawning the container at all) was considered and rejected: the workflow
already runs one container per PR in parallel; the marginal cost of
spawning a container that exits at preflight is small, and duplicating the
label check into the workflow would create two independent code paths for
the same guard.

The workflow-run annotation from decision 4 is emitted from within the
container; no `find-conflicted-prs` change is needed.

### Decision 8 — Backfill guidance for existing PRs carrying only `human-required`

Once this change is deployed, any currently open conflicted PR that carries
`human-required` (for any reason — resolver escalation, bootstrap, or
other) will be re-evaluated on the next push to `main`:

- If the PR **already had a resolver escalation** before this change, the
  operator should apply `conflicts-escalated` to the PR manually
  (`gh pr edit <N> --add-label conflicts-escalated`) to preserve the
  loop-prevention behavior the old code was providing implicitly. Without
  this step the resolver will attempt to re-resolve the PR on the next
  push to `main`, which is safe (either the merge succeeds or the resolver
  escalates again) but wastes an attempt.
- If the PR **carries `human-required` for unrelated reasons** (like
  PR #436), no action is required — the resolver will now attempt
  resolution on the next push to `main`, which is the intended fix.

This is documented in the sub-issue body for task 4 (E2E validation) and
does not require a separate implementation task. The set of affected PRs
is small (single-digit at the time of design) and each is examinable by
inspection of the PR history.

## Out of scope

- **Auto-remove `conflicts-escalated` on the next push after a human
  resolution.** A push that resolves conflicts arrives via the PR author's
  branch; a workflow gated on `push` to that branch could clear the label,
  but this repo does not have a workflow watching agent branches for this
  purpose, and adding one is more surface than the value warrants. The
  operator removes the label manually as part of finishing the resolution
  (the same pattern used today for `human-required`).
- **Structured re-escalation policy** (e.g. escalate at most N times per
  PR, or backoff before re-attempting a `conflicts-escalated` PR). Deferred
  until a real recurrence pattern is observed. The current model — human
  removes the label to re-attempt — is sufficient.
- **Retroactive workflow-run annotations.** Only future workflow runs
  benefit from the `::notice::` annotation; historical silent-skip runs
  remain silent-skips in the log. Not worth backfilling.
- **Sharing the escalation-marker pattern with other actions.** Other
  agents' escalation guards are not affected by this change; each action
  owns its own guard semantics, and there is no cross-action coupling to
  factor out.
- **Fork-PR conflict resolution.** Already out of scope per the parent
  design; unchanged.
- **The `find-conflicted-prs` activity's mergeability polling.** Unchanged.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#439](https://github.com/mfrancza/agentic-development-workflow/issues/439) | Terraform: add `conflicts-escalated` label to `terraform/modules/labels/main.tf` (workflow-labels group; color `b60205` to match `human-required`, or a distinct escalation shade — implementer's choice; description: "The `resolve-conflicts` agent already tried this PR and escalated; remove to re-attempt."). No AGENTS.md label-list changes needed per the volatile-facts convention. | — |
| [#440](https://github.com/mfrancza/agentic-development-workflow/issues/440) | Entrypoint + prompt + AGENTS.md workflow prose: (1) in `docker/scripts/entrypoint.sh` `action_resolve_conflicts`, change the preflight label check from `human-required` to `conflicts-escalated`; add a `::notice::` workflow annotation on the skip path (decision 4); on all three escalation paths (agent-exit, marker-verification, zero-diff) add `conflicts-escalated` to the `gh pr edit --add-label` call alongside `human-required`; update each escalation comment's closing instruction per decision 5. (2) In `docker/scripts/prompts/resolve-conflicts.md`, no substantive change is required (the agent does not manipulate labels), but review for any stale references to `human-required` as the skip guard. (3) Update AGENTS.md item 6 in the MVP Workflow list — replace "PRs already carrying `human-required` are skipped" with a sentence describing the two-label pattern (skip on `conflicts-escalated`; both labels applied on escalation). | — |
| [#441](https://github.com/mfrancza/agentic-development-workflow/issues/441) | Design-doc updates: amend `docs/design/resolve-conflicts.md` — the "Fallback: abort and flag" section's escalation description (both labels applied) and the "Safety bounds" bullet on `human-required` (change to `conflicts-escalated`). Update `docs/design/resolve-conflicts-entrypoint.md` Decision 8 (`human-required` skip check) to reference this design and describe the new guard. | — |
| [#442](https://github.com/mfrancza/agentic-development-workflow/issues/442) | End-to-end validation: (1) Confirm the reported bug's fix — apply `human-required` alone to a conflicted test PR (or use PR #436 if still open with the operator's consent), force a push that keeps it conflicted, verify the next `agent-resolve-conflicts` run proceeds instead of skipping. (2) Force a resolver escalation on a test PR and verify both `conflicts-escalated` and `human-required` are applied and the escalation comment names `conflicts-escalated` in its closing instruction. (3) Trigger a second push while `conflicts-escalated` is present and verify the resolver skips with a `::notice::` annotation visible in the workflow-run UI. (4) Remove `conflicts-escalated`, trigger another push, verify the resolver re-attempts. Also document the backfill guidance (decision 8) in the validation report. | Issue #439, Issue #440, Issue #441 |

Issues #439, #440, and #441 are independent and can proceed in parallel —
the Terraform module and the entrypoint script are separate files, and the
design-doc updates touch no production code. Issue #442 depends on all
three; per decision 6, Issue #439 must have been Terraform-applied before
Issue #442 can run against a real repo.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
