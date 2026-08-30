# Design: PR-based workflow per-agent model resolution

**Issue:** [#149](https://github.com/mfrancza/agentic-development-workflow/issues/149)

**Parent design:** [`split-model-labels-by-agent-type.md`](split-model-labels-by-agent-type.md)
— this sub-issue implements the PR-based-workflow rows of that design's
"Affected workflows" table.

## Summary

Extend the two-tier `model:*` waterfall (per-agent tier → generic tier →
`vars.DEFAULT_MODEL`) — already implemented for issue-driven workflows in
[#148](https://github.com/mfrancza/agentic-development-workflow/issues/148) — to
the three PR-driven workflows:

- **`agent-review.yml`** already calls the `resolve-model` composite action
  against PR labels but omits `agent-type`, so it uses the single-tier
  fallback. Add `agent-type: review` to opt it into the waterfall.
- **`agent-fix-checks.yml`** and **`agent-respond-review.yml`** currently pass
  `vars.DEFAULT_MODEL` to the container directly and never read any labels.
  Add a step to resolve the originating issue (via `Closes #N` in the PR body,
  reusing the pattern from `agent-fix-deployment.yml`), then call
  `resolve-model` with `agent-type: developer` against that issue's labels.
  Fall through to `vars.DEFAULT_MODEL` when the PR body carries no
  `Closes #N`.

The label-lookup logic (fail-loud when multiple labels match a tier) already
lives in `.github/scripts/src/resolve-model.ts`; no new resolver code is
needed. The only genuinely new activity is a small `find-linked-issue`
composite action that parses `Closes #N` out of a PR body.

## Requirements as understood

From the issue body and grooming Q&A:

1. **`agent-review.yml`**: check `model:review:*` on the PR first, then
   generic `model:[^:]+$` on the PR, then `vars.DEFAULT_MODEL`. Labels are on
   the PR, not on an issue.

2. **`agent-fix-checks.yml`** and **`agent-respond-review.yml`**: extract the
   issue number from the PR body using `Closes #N` (case-insensitive) — the
   same pattern already implemented in `resolve-deployment.ts` for
   `agent-fix-deployment.yml`. If an issue number is found, check
   `model:developer:*` on that issue, then generic `model:[^:]+$`, then
   `vars.DEFAULT_MODEL`. If no `Closes #N` is present, fall through directly
   to `vars.DEFAULT_MODEL`.

3. **Fail loud on multiple matches** at either resolution tier. This is
   already enforced by `resolveModel()` in `.github/scripts/src/resolve-model.ts`;
   this design just wires the callers into the tiered mode.

4. **Timing**: the label-lookup step must run after the developer-agent
   installation token is minted, since the token is what authorizes the label
   reads. The `Closes #N` lookup itself only reads public PR metadata and can
   use the workflow `GITHUB_TOKEN` (same as `agent-fix-deployment.yml`'s
   `resolve-deployment` step).

5. **Out of scope for this issue** (per the grooming notes): issue-driven
   workflows — those are handled by
   [#148](https://github.com/mfrancza/agentic-development-workflow/issues/148),
   already merged.

### Note on the `DEFAULT_CLAUDE_MODEL` naming in the issue body

The issue text refers to `vars.DEFAULT_CLAUDE_MODEL`. That variable was
renamed to `vars.DEFAULT_MODEL` when multi-provider support landed, and every
current call site uses `vars.DEFAULT_MODEL`. This design uses the current
name; no behavioural change is implied.

## Design

### Decision 1: `agent-review.yml` — add `agent-type: review`, no other changes

**Decision:** Add `agent-type: review` to the existing `resolve-model`
composite-action call in `agent-review.yml`. Do not touch anything else in
that workflow.

**Rationale:** The `resolve-model` composite action already accepts an
optional `agent-type` input; when set, it applies the two-tier waterfall
against the same subject (PR in this case) — first labels matching
`model:review:*`, then labels matching `^model:[^:]+$`, then the default. The
single-tier behaviour used today is exactly what happens when `agent-type` is
omitted. Passing `agent-type: review` is therefore the minimum-diff change
that meets the requirement.

**Alternative considered — inline the two-tier logic in a `run:` step**:
rejected. Every other resolve-model call site uses the composite action;
adding a workflow-specific shell path would fork the resolver, doubling the
test surface for identical behaviour.

### Decision 2: `find-linked-issue` composite action for the `Closes #N` lookup

**Decision:** Add a new composite action at
`.github/actions/find-linked-issue/action.yml` backed by
`.github/scripts/src/find-linked-issue.ts`. The action takes a PR number and
returns two outputs: `proceed` (`"true"` if a `Closes #N` reference was
found, `"false"` otherwise) and `issue_number` (the parsed integer, present
only when `proceed=true`). Include Vitest unit tests at
`.github/scripts/test/find-linked-issue.test.ts` that mirror the PR-body
parsing cases in `resolve-deployment.test.ts` (well-formed body, missing
reference, null body, case-insensitive match, first-match wins on multiple
references).

**Rationale:** By the shell-vs-TypeScript threshold documented in `AGENTS.md`
("A `run:` block moves to a TypeScript activity when it contains any of:
API-response parsing, conditional branching, pagination, or an
error-handling policy"), this step qualifies for extraction — it makes an
API call, parses the response body with a regex, and has a fall-through
error-handling policy (no reference → skip; do not fail the run).

The action is intentionally single-purpose and used by two workflows; a
reusable composite is worth the ~50 lines. The `resolve-deployment` activity
already carries the same regex (`/closes\s+#(\d+)/i`) and the same
skip-on-no-reference policy, so the parsing semantics are already codified
and reviewed.

**Alternative considered — inline `gh api` + shell regex**: rejected.
Untrusted PR-body text would flow into a shell script; even with `env:`
indirection the regex handling is easier to get wrong than the TypeScript
version, and the pattern is already the canonical one for this repo.

**Alternative considered — reuse `resolve-deployment`**: rejected. That
activity's contract is "SHA → workflow run + issue"; it starts from a
deployment SHA and does the workflow-run and PR lookups en route. Refactoring
it to accept a PR number in place of a SHA would blur its contract and
complicate its test matrix. A tiny sibling activity is cleaner.

**Alternative considered — extend `resolve-model` to accept a PR number and
resolve the linked issue itself**: rejected. `resolve-model`'s current
contract is "read labels off one subject, return a model name". Teaching it
to hop from PR to issue would smear two responsibilities into one activity
and complicate the tests for other call sites that already work correctly.

### Decision 3: Extract the `Closes #N` regex to `src/lib/close-ref.ts`

**Decision:** Move the `Closes #N` regex from `resolve-deployment.ts` into a
new shared helper at `.github/scripts/src/lib/close-ref.ts`
(`parseClosesRef(body: string | null): number | undefined`). Both
`resolve-deployment.ts` and the new `find-linked-issue.ts` import from it.

**Rationale:** Prevents the two copies from drifting. The extraction is a
mechanical one-liner in each caller and the helper is trivial to unit-test
in isolation. Keeping the regex in one place also means future changes to
the reference pattern (e.g. supporting `Fixes #N` or `Resolves #N`) touch
one line, not two.

**Alternative considered — duplicate the regex**: rejected on
drift-prevention grounds; the two copies would need to be kept in sync in
every future PR that touches `Closes #N` handling.

### Decision 4: Step ordering and token scoping in the two feedback workflows

**Decision:** In both `agent-fix-checks.yml` and `agent-respond-review.yml`,
insert two new steps immediately after the "Mint installation token for
developer-agent" step and before "Run agent":

1. **`Resolve linked issue from PR body`** — calls the new
   `find-linked-issue` composite action with `token: ${{ github.token }}`.
   The workflow-level `GITHUB_TOKEN` already has `pull-requests: read`;
   using it here matches the `agent-fix-deployment.yml` precedent
   (`token: ${{ github.token }}` on its `resolve-deployment` step) and keeps
   the minted app token out of a step that only reads public PR metadata.

2. **`Resolve Claude model from issue labels`** — calls the existing
   `resolve-model` composite with `token: ${{ steps.setup.outputs.token }}`
   (the minted developer-agent token), `subject-type: issue`,
   `subject-number: ${{ steps.linked-issue.outputs.issue_number }}`,
   `repo: ${{ github.repository }}`, `agent-type: developer`,
   `default-model: ${{ vars.DEFAULT_MODEL }}`. This
   step is gated on `steps.linked-issue.outputs.proceed == 'true'` so it is
   skipped when no `Closes #N` was found.

The `Run agent` step then passes
`model: ${{ steps.model.outputs.claude_model || vars.DEFAULT_MODEL }}` — the
`||` fallback covers both branches (issue found and resolved, and issue not
found so the resolve step was skipped and `claude_model` is empty).

**Rationale for step ordering:** The issue explicitly requires the label
lookup to run after the token is minted. Placing the `find-linked-issue`
step in the same block keeps the "resolve everything, then run" phase
grouped and readable. In both workflows the existing preflight steps
(`filter-agent-pr` in `agent-fix-checks.yml`,
`check-reviewer-feedback` in `agent-respond-review.yml`) already skip cleanly
when the workflow should not proceed, and the token mint is already gated on
their outputs — the new steps inherit the same gating pattern (a
`steps.filter.outputs.proceed == 'true'` / `steps.feedback.outputs.proceed == 'true'`
guard on each new step).

**Rationale for the two-token split (workflow token for `Closes #N`, app
token for label read):** minimum scope per step. The workflow `GITHUB_TOKEN`
is fine for reading a public PR body; the app token is what the rest of the
repo uses for reading issue labels (see every other `resolve-model` call
site). Matching the `agent-fix-deployment.yml` precedent keeps the pattern
consistent across the codebase.

**Alternative considered — always pass the minted token to both steps**:
acceptable and slightly simpler, but breaks the "workflow token for public
metadata, app token for agent-scoped reads" precedent set by
`agent-fix-deployment.yml`. Rejected on consistency grounds.

**Alternative considered — a single composite that does both the PR-body
lookup and the label resolution**: rejected. The two activities are on
different subjects (PR body vs. issue labels) and use different tokens; a
merged action would fight both boundaries. Two thin composites compose more
cleanly than one thick one.

### Decision 5: `AGENTS.md` update in the same PR as the workflow changes

**Decision:** In the sub-issue that updates `agent-fix-checks.yml` and
`agent-respond-review.yml`, also update two stale sentences in `AGENTS.md`:

1. In the `model:<agent-type>:<name>` bullet (Labels section): remove the
   parenthetical `review (\`model:review:haiku/sonnet/opus\` pre-provisioned
   in the label picker; current PR-based workflows use single-tier \`model:*\`
   resolution and ignore per-agent labels)` — it will be false once all three
   PR-based workflows are on the waterfall.

2. In the `agent:review` label bullet: update the model-selection sentence
   "Model selection follows the same `model:*` label logic as issue-driven
   runs: if a `model:*` label is present on the PR, that model is used; if
   none is present, `vars.DEFAULT_MODEL` is used; if more than one `model:*`
   label is present, the workflow fails loudly." — after issue #361 ships
   `agent-type: review`, this sentence understates the two-tier waterfall
   (per-agent labels are checked first, then generic `model:*`, then default)
   and must be updated to describe it accurately.

**Rationale:** `AGENTS.md`'s "Keeping Documentation Current" section makes
documentation-in-the-same-PR the standard; the current wording explicitly
describes the pre-conversion behaviour, so leaving it in place after the
conversion would be a lie by omission. Bundling the doc update with the
last workflow change (rather than the first) means the docs reflect the
merged state accurately at every point in the merge sequence.

**Alternative considered — a separate doc-only PR after all workflows
land**: rejected — extra process for a two-line edit.

## Out of scope

- **Issue-driven workflows.** Already implemented in
  [#148](https://github.com/mfrancza/agentic-development-workflow/issues/148)
  (`agent-implement.yml`, `agent-groom.yml`, `agent-design.yml`,
  `agent-fix-deployment.yml`).
- **Terraform label provisioning.** The 12 per-agent labels
  (`model:{groom,design,developer,review}:{haiku,sonnet,opus}`) are already
  provisioned by [#147](https://github.com/mfrancza/agentic-development-workflow/issues/147);
  this design only wires the workflows into them.
- **Grooming-criteria changes.** The grooming agent's label emission is
  handled by [#150](https://github.com/mfrancza/agentic-development-workflow/issues/150).
- **Multi-provider model handling.** The per-agent labels are provider-neutral;
  the entrypoint's existing provider inference (per `docs/design/multi-provider-models.md`)
  applies unchanged.
- **Broader `Closes #N` reference syntax.** The regex stays `Closes #N`
  (case-insensitive), matching the current `resolve-deployment` behaviour.
  Supporting `Fixes #N` / `Resolves #N` / cross-repo references is a
  separate change.
- **PRs that reference multiple issues.** The activity takes the first
  `Closes #N` — matching the `resolve-deployment` precedent. Multi-issue PRs
  are rare in this repo and out of scope here.

## Task breakdown

Issues #147, #148, and #150 (siblings in the parent design) are unblocking
context; this table lists only the new work introduced by this sub-issue.

| Issue | Task | Depends on |
|-------|------|-----------|
| [#360](https://github.com/mfrancza/agentic-development-workflow/issues/360) | Add `find-linked-issue` composite action + TypeScript activity + Vitest tests; extract `Closes #N` regex to `src/lib/close-ref.ts` and refactor `resolve-deployment.ts` to import it | — |
| [#361](https://github.com/mfrancza/agentic-development-workflow/issues/361) | Add `agent-type: review` to the `resolve-model` step in `agent-review.yml` | — |
| [#362](https://github.com/mfrancza/agentic-development-workflow/issues/362) | Wire `find-linked-issue` + `resolve-model` (`agent-type: developer`) into `agent-fix-checks.yml` and `agent-respond-review.yml`; update the `model:<agent-type>:<name>` bullet in `AGENTS.md` to remove the "PR-based workflows use single-tier resolution" caveat | Issue #360 |
| [#363](https://github.com/mfrancza/agentic-development-workflow/issues/363) | End-to-end validation: on a test PR with per-agent and generic model labels on both PR and linked issue, confirm each PR-based workflow (review, fix-checks, respond-review) picks the correct model per the waterfall; confirm PR without `Closes #N` still falls through to `vars.DEFAULT_MODEL` | Issues #360, #361, #362 |

Issues #360 and #361 are independent and can proceed in parallel. Issue #362
depends on #360 (the new composite action must exist before the two
workflows can consume it). Issue #363 (end-to-end validation) depends on all
three implementation tasks.

Dependencies are recorded natively as GitHub `blocked_by` relationships on
the issues.
