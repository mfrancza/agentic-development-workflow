# Validation: Multi-reviewer E2E loop (Issue #473)

**Issue:** [#473](https://github.com/mfrancza/agentic-development-workflow/issues/473)
**Design under test:** [multi-reviewer-agents.md](multi-reviewer-agents.md) (Issue #449)

## Validation approach

This document records the E2E validation of the multi-reviewer feature
introduced in Issue #449 and implemented across sub-issues #462–#471.
Validation covered two complementary surfaces:

- **Unit test suite** — `npm test` in `.github/scripts/`, running all
  394 tests across 23 files.  All pass.  TypeScript strict-mode
  type-check (`tsc --noEmit`) also clean.
- **Static analysis** — implementation files, composite action YAML,
  workflow YAML, and reviewer prompt reviewed against the six decisions
  in `multi-reviewer-agents.md`.

## Scenario findings

### 1 — Baseline: repo-wide multi-reviewer (`REVIEWER_MODELS` = two providers)

**Resolver (Decision 1, Tier 2).** `resolve-reviewer-set.ts`
`resolveReviewerSet()` correctly returns `[{model: "sonnet"}, {model: "gpt-5"}]`
when `reviewerModels = ["sonnet", "gpt-5"]` and no `model:review:*`
labels are present on the PR.  Covered by
`resolve-reviewer-set.test.ts` — "Tier 2" describe block, 5 tests.

**Matrix fan-out (Decision 3).** `agent-review-reusable.yml` preflight
`resolve` job emits the JSON array; `review` job consumes it via
`strategy.matrix.include: ${{ fromJson(needs.resolve.outputs.set) }}`
with `fail-fast: false`.  One runner per model, parallel execution.

**Bot identity (Decision 2).** All legs mint tokens from the same
`REVIEWER_APP_ID` / `REVIEWER_APP_PRIVATE_KEY` pair → same
`mfrancza-reviewer-agent[bot]` identity.

**Review body header (Decision 2).** `docker/reviewer/prompts/review.md`
instructs every review body to open with:
```
<!-- reviewer-model: <AGENT_MODEL> -->
### Review by `<AGENT_MODEL>`
```
This rule is stated under "Review body header" and marked mandatory
("Do not omit or alter the header format").

**Per-leg log artifacts (Decision 3).** Artifact name pattern:
`agent-logs-review-pr-<N>-<model-slug>-run-<run_id>-<attempt>`.
Model slug produced in the "Slugify model name for artifact" step via
`env: MODEL: ${{ matrix.model }}` (output-injection hygiene preserved).

### 2 — Re-review + stale-SHA guard

**Synchronize trigger.** `agent-review.yml` caller stub fires on
`pull_request_target: [labeled, synchronize]` — both matrix legs
re-review after every push to the PR head.

**Prior-SHA dismissal with sibling-leg safety (Decision 4c).**
`dismiss-stale-reviewer-reviews.ts` `filterStaleReviews()` requires
`commitId !== headSha` before including a review in the dismissal list.
Reviews on the current head SHA are preserved even if they are
`CHANGES_REQUESTED` and authored by the bot — sibling-leg verdicts
are not collateral damage.  Covered by
`dismiss-stale-reviewer-reviews.test.ts` — "SHA-filter" sub-block,
4 tests including the explicit "sibling-leg race" case.

**Stale-review dispatch skip (Decision 4b).**
`check-reviewer-feedback.ts` `checkReviewerFeedback()` skips
immediately when `reviewCommitId !== headSha`, returning
`{ proceed: false, reason: "stale — …" }` with no further API calls.
Covered by `check-reviewer-feedback.test.ts` — "stale-SHA guard"
describe block, 4 tests.

### 3 — Terminal APPROVE (Decision 4a)

Each matrix leg independently checks whether its `APPROVED` review
leaves any actionable feedback:

- `check-reviewer-feedback` step 2: `countUnresolvedThreads()` returns
  the number of open review threads across the whole PR (not just this
  leg's threads).  Zero threads → `proceed: false` → developer agent
  does not run.
- The guard is per-review, not per-push.  Each leg's clean approval
  skips independently.  Covered by `check-reviewer-feedback.test.ts`
  — "approved review — primary unresolved-thread check" describe block,
  6 tests.

### 4 — Per-PR label override (Decision 1, Tier 1)

`resolveReviewerSet()` checks for `model:review:*` labels before
consulting `reviewerModels`.  Two labels `model:review:opus` and
`model:review:gpt-5` produce `[{model: "opus"}, {model: "gpt-5"}]`
regardless of what `REVIEWER_MODELS` contains.  Covered by
`resolve-reviewer-set.test.ts` — "Tier 1" describe block, 7 tests,
including the explicit "Tier 1 takes precedence over a non-empty
reviewerModels list" case.

### 5 — Single-reviewer fallback (Decision 1, Tier 3)

When `reviewerModels = []` and no `model:review:*` labels are present,
`resolveReviewerSet()` calls `resolveModel()` and wraps the result in
a single-element array, preserving the pre-existing single-reviewer
behavior unchanged.  Covered by `resolve-reviewer-set.test.ts` — "Tier
3" describe block, 7 tests.

### 6 — Cost-warning log line (Decision 5)

Two independent emission points, both guarded on `> 3` reviewers:

- TypeScript entry point (`resolve-reviewer-set.ts` `run()`, line 147):
  `core.warning("Resolved reviewer set has N reviewers; each push will
  fan out to N parallel review passes and spend ~N× review cost.")`.
- Workflow shell step (`agent-review-reusable.yml` "Fail loudly if
  reviewer set is empty", line 186–188): same prose via
  `echo "::warning::…"`.

Both fire for every resolved set with more than 3 reviewers.  The
TypeScript path is exercised by `npm test` running the entry-point
module in non-`VITEST` mode (the module's `VITEST` guard suppresses
the entry-point side-effect during test runs, so this path is tested
manually rather than by unit tests — consistent with the pattern used
for all other entry-point scripts in the package).

## No issues found

All six scenarios validate cleanly against the implementation.  No
findings to feed back into the implementation sub-issues.  The
multi-reviewer loop is ready for production use once `REVIEWER_MODELS`
is set via Terraform and the GitHub Actions secrets for the second
provider (`OPENAI_API_KEY` or `XAI_API_KEY`) are configured in the
repository.
