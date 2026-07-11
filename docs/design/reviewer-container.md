# Design: Reviewer Container (initial review)

**Issue:** [#39](https://github.com/mfrancza/agentic-development-workflow/issues/39)
**Parent design:** [code-review-agent.md](code-review-agent.md) (issue #27)

## Scope

This doc covers only the decisions left open by the parent design for the
`docker/reviewer/` image and its initial-review behavior. The entrypoint
contract, image recipe, and verdict vocabulary are already specified there and
in the grooming notes on #39; they are not repeated here. Re-review behavior
(thread resolution, approval after fixes) is #41 and out of scope — but
nothing here may preclude it.

## Decisions

### 1. Claude posts the review; the entrypoint verifies it

Two options existed: the entrypoint posts a review assembled from structured
Claude output, or Claude posts the review itself via `gh`. We follow the
repo's established pattern ("entrypoint is minimal; Claude owns the GitHub
side", PR #11): the `review.md` prompt instructs Claude to submit the review
with a single `gh api` call, and the entrypoint verifies after Claude exits
that a review by the reviewer app exists on the PR head SHA — exiting
non-zero if not, mirroring the implement action's "verify PR was opened"
check. This keeps the entrypoint free of review-assembly logic while still
failing loudly when the agent doesn't complete its job.

### 2. One review, one API call

The review is submitted as a single
`POST /repos/{repo}/pulls/{n}/reviews` call carrying the verdict (`event`)
and the inline comments array (`path` + `line`/`side` anchored to the diff).
One call means the verdict and its comments land atomically — no
half-posted review if the agent dies mid-run, and no comment spam followed
by a dangling verdict. Findings that cannot be anchored to a changed line
(e.g. a missing file) go in the review body instead.

### 3. Structural no-write guarantee: two independent layers

- **Image layer:** the reviewer image ships no `git-askpass.sh`, and the
  entrypoint never configures `git config user.*`, `GIT_ASKPASS`, or any
  credential helper for push. The repo is cloned read-only via `gh repo clone`
  (gh injects the token for fetch); nothing in the image ever runs
  `git commit` or `git push`.
- **Token layer:** the reviewer app's installation token has
  Contents (read) only, so even a prompt-injected `git push` cannot succeed.

Neither layer alone is sufficient (a future image edit could add push
paths; a future permission bump could enable them), so reviews of changes to
either must check the other still holds.

### 4. Existing threads are evaluated and resolved *(superseded by [re-review-loop.md](re-review-loop.md) — see issue #116)*

The entrypoint passes existing review threads (with IDs) so the review can
evaluate them against the current diff. The prompt instructs Claude to skip
any finding substantively covered by a still-open thread; for threads whose
findings are now addressed, Claude resolves them via the `resolveReviewThread`
GraphQL mutation before posting the new review — so the verdict reflects only
what truly remains unresolved.

**Note:** The original decision deferred thread resolution to issue #41, with
the initial-review prompt treating threads as context only. That was superseded
in issue #116: the updated `review.md` prompt now actively evaluates open
threads and resolves addressed ones (resolve first, then post the review). See
`docs/design/re-review-loop.md` (decision 2) for the full rationale.

### 5. Knobs match the developer image

`CLAUDE_MODEL` (default `sonnet`) and `CLAUDE_MAX_TURNS` (default 100) keep
the developer entrypoint's semantics so the `model:*` label plumbing in #40
works identically for both images. No `AGENT_ACTION` dispatch: the reviewer
image does exactly one thing, and #41 extends the same code path (richer
context in, thread actions out) rather than adding a second action.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#55](https://github.com/mfrancza/agentic-development-workflow/issues/55) | Dockerfile + entrypoint: env validation, read-only clone, context gathering (diff vs merge-base, threads with IDs, check status), Claude invocation, post-run review verification | — |
| [#56](https://github.com/mfrancza/agentic-development-workflow/issues/56) | `review.md` prompt: Code Review Standards reference, verdict policy, single-call posting recipe, duplicate-skip rule | — |
| [#57](https://github.com/mfrancza/agentic-development-workflow/issues/57) | End-to-end validation against a real PR; capture the local `docker run` invocation for #42 | #55, #56 |

Issues #55 and #56 can proceed in parallel — this document is the contract
between them (the entrypoint provides the context described here; the prompt
consumes it and posts the review). #57 validates the pair end-to-end and is
expected to feed small fixes back into both.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
