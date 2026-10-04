# Design: respond-review self-trigger guard — exclude the PR author's own reviews

**Issue:** [#570](https://github.com/mfrancza/agentic-development-workflow/issues/570)
**Context:** `AGENTS.md` § MVP Workflow step 5 (respond-review decision flow);
`AGENTS.md` § Repo-specific security defaults ("Allowlist gating on review authors").
**Related (not duplicate):** Issue [#466](https://github.com/mfrancza/agentic-development-workflow/issues/466)
addresses a different respond-review re-trigger path (stale-SHA review on an
already-pushed update); this design addresses author-identity and
already-settled-feedback loops.

## Requirements as understood

Issue #570 documents a self-triggering loop in `agent-respond-review`:

1. The developer-agent container replies to review threads via the REST
   `pulls/comments/<id>/replies` endpoint. GitHub materialises each reply as a
   `COMMENTED` review authored by `mfrancza-developer-agent[bot]` and fires
   `pull_request_review: submitted`.
2. The caller stub [`.github/workflows/agent-respond-review.yml`](../../.github/workflows/agent-respond-review.yml)
   admits that event because the review author
   (`mfrancza-developer-agent[bot]`) is on `vars.AGENT_ALLOWLIST`. The bot is on
   the allowlist for a different purpose — so agents can apply `agent:*` labels
   to route work to each other (see `AGENTS.md` § Labels) — but that same
   membership makes the bot a trusted *review author* here.
3. The `check-reviewer-feedback` activity
   ([`.github/scripts/src/check-reviewer-feedback.ts`](../../.github/scripts/src/check-reviewer-feedback.ts))
   returns `proceed=true` for every non-approval state without inspecting who
   wrote the review, whether the review carries any content, or whether any
   PR review thread is still unresolved.
4. The container re-reads the latest reviewer-agent review (even one already
   dismissed, with all threads already resolved) and answers it again — the
   fresh REST replies regenerate step 1 and the loop continues.

Observed on PR #567: two bursts (2026-09-12 21:01–21:30 UTC and 2026-10-03
22:22–23:00 UTC). The second burst executed ~21 runs that re-answered a
*dismissed* review whose four threads were already *resolved*, posted ~20
duplicate PR comments and ~80 duplicate thread replies, and consumed the
OpenAI balance before run `37160329361` failed on `no credits remaining` and
broke the chain.

Runtime evidence per `AGENTS.md` § Reverting or replacing code with a passing
live-run history: the loop is a real runtime failure (two independent bursts,
duplicate comments observable on PR #567, credits exhausted) — not a
linter/schema warning. This design modifies working code, and the citation
above satisfies the "runtime evidence" requirement.

### What the fix must deliver

The issue text and grooming notes already prescribe the fix shape. This design
settles the detail — the two guards, how they are plumbed, what the regression
tests must cover, and the documentation surfaces that need updating.

Concretely, after this design ships:

- A `pull_request_review: submitted` event authored by
  `mfrancza-developer-agent[bot]` on a PR authored by
  `mfrancza-developer-agent[bot]` must not reach the agent container.
- A `COMMENTED` review with zero unresolved review threads must be treated the
  same way as an `APPROVED` review with zero unresolved threads — skip.
- A `COMMENTED` review with at least one unresolved thread must still proceed
  (so human reviewers who comment on a thread without approving still get a
  response).
- The composite action + reusable workflow must carry enough information for
  the activity to apply the author-equality check without extra API round
  trips.
- Regression tests cover the three scenarios the issue calls out plus the
  defence-in-depth path.
- `AGENTS.md` step 5 must document the new decision flow accurately —
  specifically the retirement of "non-approval reviews always proceed" as an
  unconditional rule.

## Decisions

### Decision 1 — Apply both guards: caller `if:` plus activity-level defence in depth

Alternatives considered:

- **(a) Caller `if:` only.** The one-liner
  `github.event.review.user.login != github.event.pull_request.user.login`
  on `agent-respond-review.yml`'s job gate breaks every known cycle (the
  developer agent authored the PR, so its own thread replies are rejected
  before any container runs). Cheapest, highest-leverage single change.
- **(b) Activity-level unresolved-thread check only.** For `COMMENTED`
  reviews, apply the same unresolved-thread gate already used for `APPROVED`
  reviews. Also breaks the known loop (the agent's thread replies resolve the
  threads it is answering; subsequent self-fired `COMMENTED` events then find
  zero unresolved threads and skip).
- **(c) Both.** Caller gate stops the vast majority of self-triggered events
  at the cheapest possible layer (no runner spin-up, no activity execution,
  no API calls). Activity gate is defence in depth: if a future caller stub
  omits the author check — or if GitHub ever introduces a new mechanism for
  the PR author to submit a review on their own PR — the activity still
  skips.

**Chosen: (c)** — both. The issue explicitly recommends belt-and-braces, and
the two guards guard different failure modes:

- The **caller `if:`** is the right place for "this event is categorically
  not of interest", because it costs nothing: no runner is allocated, no
  helper is checked out, no composite action runs.
- The **activity-level check** is the right place for "this specific review
  has nothing to respond to", because the activity already encapsulates the
  "nothing to respond to" decision for `APPROVED` reviews. Keeping both
  families of skip in one place is more maintainable than scattering them
  across workflow YAML and TypeScript.

The two guards are not redundant on the specific `COMMENTED`-by-PR-author
path (either one is sufficient there), but each catches cases the other
misses. The caller gate also catches a `CHANGES_REQUESTED` review authored
by the developer agent on its own PR — a nonsensical event, but one that
would otherwise proceed under the activity-level logic (non-approval states
proceed). The activity gate also catches a `COMMENTED` reply authored by a
*different* agent bot (hypothetical future second developer identity) on a
PR authored by the first — the caller gate's equality check would not fire
there.

### Decision 2 — Caller `if:` adds the author-inequality clause; allowlist and PR-author gates kept intact

The current `agent-respond-review.yml` job gate is (after formatting):

```yaml
if: >
  github.event.pull_request.user.login == 'mfrancza-developer-agent[bot]' &&
  (
    contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.review.user.login) ||
    github.event.review.user.login == 'mfrancza-reviewer-agent[bot]' ||
    github.event.review.user.login == 'Copilot' ||
    github.event.review.user.login == 'copilot-pull-request-reviewer[bot]' ||
    github.event.review.user.login == 'github-copilot[bot]'
  )
```

The new clause is added as a **separate top-level conjunction**, not merged
into the review-author block:

```yaml
if: >
  github.event.pull_request.user.login == 'mfrancza-developer-agent[bot]' &&
  github.event.review.user.login != github.event.pull_request.user.login &&
  (
    contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.review.user.login) ||
    github.event.review.user.login == 'mfrancza-reviewer-agent[bot]' ||
    github.event.review.user.login == 'Copilot' ||
    github.event.review.user.login == 'copilot-pull-request-reviewer[bot]' ||
    github.event.review.user.login == 'github-copilot[bot]'
  )
```

Rationale for the structure:

- **Separate clause.** The new predicate expresses a different concept from
  the allowlist (identity equality, not identity membership), and keeping it
  separate avoids tangling the two logics. A future maintainer who wants to
  change the allowlist should not have to re-read a nested boolean to
  understand what "PR author" has to do with anything.
- **Inequality against `pull_request.user.login`, not a hardcoded identity.**
  Writing `!= 'mfrancza-developer-agent[bot]'` works today (the current PR
  author gate already pins to that identity), but ties the clause to the
  current bot slug. Using `pull_request.user.login` keeps the clause correct
  under any future expansion of the PR-author gate (e.g. accepting PRs from
  additional agent identities) without a coordinated edit.
- **No change to the `AGENT_ALLOWLIST` semantics.** The allowlist still
  controls which humans and bots can author trusted reviews. The developer
  agent remains on the allowlist for label-routing (`agent:*` labels), which
  is unrelated to the review-author use case. The issue explicitly keeps the
  allowlist clause as-is.

### Decision 3 — Activity accepts review-author and pr-author as explicit inputs; threaded through the composite action, reusable workflow, and caller stub

The `checkReviewerFeedback` function needs to know both logins to apply the
defence-in-depth author-equality check. Two sourcing options:

- **(a) Fetch from the API inside the activity.** Call `pulls.get` (already
  called for state) and `pulls.getReview` (new) to retrieve the two logins.
  Adds one API round trip per invocation. Logins are already in the event
  payload the caller stub sees, so re-fetching them is pure cost.
- **(b) Thread as inputs.** Add `review-author` and `pr-author` inputs to
  the composite action and the reusable workflow; caller stub passes
  `github.event.review.user.login` and `github.event.pull_request.user.login`
  verbatim.

**Chosen: (b).** The event payload is the source of truth and already lives
in the caller stub. Passing the two strings through is simpler than another
API dependency, saves a round trip, and keeps the activity's test surface
narrow (two more string inputs vs. two more mocked API callbacks).

The input plumbing follows the pattern already used for `review-body`,
`review-id`, and `pr-number` — inputs declared on the reusable workflow,
forwarded into the composite action via `with:`, and consumed by the TS
activity via `core.getInput()`. No new conventions.

Both inputs are **required** on the composite action and reusable workflow.
Making them optional would silently disable the author-equality guard for
any caller that forgets to pass them; "fail loud on ambiguous input" is the
established repo pattern (see `AGENTS.md` § Repo-specific security defaults).

### Decision 4 — Activity decision flow: insert author-equality check at step 1; apply unresolved-thread check to `commented` as well as `approved`

The current decision flow (from the activity's doc-comment):

```
0. PR not open                              → skip
1. Non-approval states                       → proceed (unconditional)
2. Approved: unresolved_threads == 0         → skip
3. Approved: bare-approval fallback          → skip if nothing to respond to
```

The new flow:

```
0. PR not open                               → skip
1. review-author == pr-author                → skip (defence in depth)
2. Non-approval states OTHER than commented  → proceed (unchanged)
3. commented OR approved:
      unresolved_threads == 0                → skip
      unresolved_threads  > 0                → proceed
4. (approved only) bare-approval fallback    → skip if nothing to respond to
```

Specifics:

- **Step 1 (author equality)** runs after the PR-state check so a closed PR
  still short-circuits first (cheapest skip wins). The author-equality skip
  is unconditional on review state — a self-authored
  `CHANGES_REQUESTED` or `APPROVED` on one's own PR is as meaningless as a
  self-authored `COMMENTED`.
- **Step 2** keeps the unconditional-proceed behaviour for every
  non-approval state **except** `commented`. `CHANGES_REQUESTED` and
  `DISMISSED` continue to proceed unconditionally — a `CHANGES_REQUESTED`
  review inherently expresses dissatisfaction regardless of thread state,
  and `DISMISSED` typically means a maintainer wants the agent to try
  again. Only `COMMENTED` is folded into the thread-count path, because
  that is the state GitHub synthesises for thread replies and bare
  "I'm commenting on the PR" reviews — both of which are only actionable
  if an unresolved thread actually exists.
- **Step 3** reuses the existing `countUnresolvedThreads` dependency. No
  new GraphQL query is needed. On GraphQL error, the fall-through differs
  by state: an `APPROVED` review falls through to the existing
  bare-approval fallback (step 4); a `COMMENTED` review proceeds (fail
  open) — there is no body-plus-inline fallback for `COMMENTED` because
  the review's "body" is likely to be meaningful text and the activity
  should not try to second-guess it from thread counts alone.
- **Step 4 (bare-approval fallback)** is unchanged. It stays
  `APPROVED`-only: the body-and-inline-count heuristic is for approvals
  with no threads at all, which does not describe a `COMMENTED` reply.

The case-insensitive comparison for the state string (already applied to
`approved`) is extended to `commented` so `COMMENTED`-vs-`commented`
payload capitalisation differences do not matter.

Alternative considered and rejected: **unify `COMMENTED` with `APPROVED`
across the whole flow (same path, same fallback).** Appealing for symmetry
but introduces a behaviour change for `COMMENTED` reviews whose
unresolved-thread query errors — today those proceed unconditionally;
under full unification they would fall through to body/inline heuristics
and could skip when they shouldn't. The narrower change (thread-count
gate only, with proceed-on-error) stays strictly within the issue's
"zero unresolved threads → skip" rule without widening the fallback.

### Decision 5 — Regression tests cover the three issue-specified cases plus two defence-in-depth cases

The issue requires three cases:

1. `COMMENTED` review by the PR author → skip.
2. `COMMENTED` review by the reviewer agent with zero unresolved threads → skip.
3. `COMMENTED` review by the reviewer agent with one unresolved thread → proceed.

Add two more:

4. `APPROVED` review by the PR author → skip (author-equality applies to all states).
5. `COMMENTED` review by the reviewer agent whose GraphQL thread query errors → proceed (fail open for `COMMENTED`; no fallback to body/inline heuristics).

Each test uses the existing `makeDeps(overrides?)` helper and the
`BASE_INPUT` fixture already in
[`check-reviewer-feedback.test.ts`](../../.github/scripts/test/check-reviewer-feedback.test.ts),
extended with `reviewAuthor` and `prAuthor` fields on the input type. Tests
assert both the `proceed` boolean and the right skip reason substring to
guard against regressions that take the right path for the wrong reason.

### Decision 6 — Document the new flow in AGENTS.md step 5; no README changes

`AGENTS.md` § MVP Workflow step 5 lists the respond-review activity's
decision flow:

> - **Non-approval states** (changes_requested, commented, …) always proceed.
> - **Zero unresolved PR review threads** (primary check for approved reviews): …

After this design ships, `commented` is no longer an unconditional-proceed
state, so the first bullet becomes misleading. Updates:

1. Change "Non-approval states (changes_requested, commented, …) always
   proceed" to list only `changes_requested` and `dismissed` (and any
   future non-approval state that is categorically actionable). Note that
   `commented` is handled by the unresolved-thread rule.
2. Reword the unresolved-thread bullet to say "approved or commented
   reviews" rather than "approved reviews".
3. Add a new bullet at the top of the "ordered checks" list for the
   author-equality skip (between the PR-not-open guard and the state
   dispatch).

`README.md` does not describe this activity in operator-facing terms, so no
README change is required. The composite action's `description:` field and
the TypeScript function's doc-comment are updated as part of the activity
PR to match the new flow (no separate task — they travel with the code).

### Decision 7 — Scope the fix to `respond-review`; do not generalise to other agent workflows

Alternative considered: add a repo-wide "no agent event triggered by the
same agent's own output" convention — a `lib/` helper that every agent
workflow calls to detect self-triggering. Rejected because:

- The specific self-trigger mechanism here (REST replies synthesising a
  `pull_request_review`) does not exist in the other agent workflows.
  Other known re-trigger paths have their own guards (`agent:groom` label
  auto-removed on success, `agent:developer` label auto-removed on PR
  close, re-review `synchronize` cycles idempotent by resolved-thread
  bookkeeping).
- A speculative shared helper would ossify a pattern around one incident.
  If a second self-trigger loop ever lands in a different workflow,
  factor the shared helper then — with two examples driving the
  abstraction instead of one.

This design therefore touches only the four files the issue names and
`AGENTS.md`.

## Out of scope

- **Restoring OpenAI credits** on the maintainer's billing account.
- **Cleaning up the duplicate comments** on PR #567 (manual maintainer
  cleanup; not an automation task).
- **Changing `AGENT_ALLOWLIST` semantics** for `agent:*` label routing.
  The allowlist continues to include the developer-agent bot identity.
- **Stale-SHA re-trigger path** (issue #466 covers a different
  re-trigger root cause; this design does not touch that path).
- **Generalising self-trigger detection** across other agent workflows
  (Decision 7).
- **Introducing a per-review-author rate limit or circuit breaker** —
  the two guards fully close the known loop. If a future unknown
  self-trigger path appears, add a circuit breaker then; adding one
  speculatively now would risk suppressing legitimate rapid review
  bursts (e.g. a reviewer who posts several thread comments in quick
  succession).
- **Reviewing or changing the `pull_request_review` event dispatch
  behaviour from GitHub.** The materialisation of REST replies as
  `COMMENTED` reviews is GitHub's behaviour; the fix must work around
  it, not try to change it.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#571](https://github.com/mfrancza/agentic-development-workflow/issues/571) | Caller `if:` guard: add `github.event.review.user.login != github.event.pull_request.user.login` as a separate top-level conjunction in `.github/workflows/agent-respond-review.yml`'s `respond-review` job gate. Keep the existing PR-author gate and the review-author allowlist/bot clause unchanged. | — |
| [#572](https://github.com/mfrancza/agentic-development-workflow/issues/572) | Defence-in-depth guards in `check-reviewer-feedback`: (i) add required `review-author` and `pr-author` inputs to the composite action [`.github/actions/check-reviewer-feedback/action.yml`](../../.github/actions/check-reviewer-feedback/action.yml) and to the reusable workflow [`.github/workflows/agent-respond-review-reusable.yml`](../../.github/workflows/agent-respond-review-reusable.yml); (ii) wire `github.event.review.user.login` and `github.event.pull_request.user.login` from the caller stub [`.github/workflows/agent-respond-review.yml`](../../.github/workflows/agent-respond-review.yml) into the reusable's inputs; (iii) extend `FeedbackCheckInput` in [`.github/scripts/src/check-reviewer-feedback.ts`](../../.github/scripts/src/check-reviewer-feedback.ts) with `reviewAuthor` and `prAuthor`, insert the author-equality skip at step 1, and fold the `commented` state into the unresolved-thread path (step 3) per Decision 4; (iv) update the function's doc-comment and the composite action's `description:` to match the new flow; (v) add the five regression test cases listed in Decision 5 to [`.github/scripts/test/check-reviewer-feedback.test.ts`](../../.github/scripts/test/check-reviewer-feedback.test.ts). | — |
| [#573](https://github.com/mfrancza/agentic-development-workflow/issues/573) | AGENTS.md: update § MVP Workflow step 5's bulleted list to reflect the new decision flow per Decision 6 — list only `changes_requested` / `dismissed` as unconditional-proceed states, mention `commented` is handled by the unresolved-thread rule, reword the unresolved-thread bullet to cover `approved or commented`, and add the author-equality skip to the ordered checks. | — |
| [#574](https://github.com/mfrancza/agentic-development-workflow/issues/574) | End-to-end validation on a scratch PR: (i) manually craft a `COMMENTED` review authored by `mfrancza-developer-agent[bot]` on an agent-authored PR; verify the `agent-respond-review` run shows as skipped at the job-gate layer (caller `if:` evaluated false) and no activity logs are produced. (ii) Craft a `COMMENTED` review by a human allowlisted account with zero unresolved threads; verify the activity logs the zero-threads skip reason and no container runs. (iii) Craft a `COMMENTED` review by the same human account with one unresolved thread; verify the container runs and posts a reply. (iv) Confirm no regression on `CHANGES_REQUESTED` or `APPROVED` paths via the existing fixtures. | Issues #571, #572, #573 |

Issues #571 and #572 can proceed in parallel — Guard 1 (caller `if:`) and
Guard 2 (activity-level) are logically independent, each is sufficient to
break the known loop on its own, and the files touched do not overlap.
Issue #573 is documentation-only and can also proceed in parallel.
Issue #574 is end-to-end validation and depends on all three implementation
tasks landing.

Dependencies are recorded natively as GitHub blocked-by relationships on
the sub-issues.
