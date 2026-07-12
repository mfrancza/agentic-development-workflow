# Design: Reviewer Re-Review Loop

**Issue:** [#41](https://github.com/mfrancza/agentic-development-workflow/issues/41)
**Parent design:** [code-review-agent.md](code-review-agent.md) (issue #27)
**Sibling designs referenced:** [reviewer-container.md](reviewer-container.md) (issue #39, initial-review contract), [resolve-conflicts.md](resolve-conflicts.md) (issue #54, cross-references the same GitHub conflict-suppression behavior).

## Scope

This design completes the review loop the parent design sketched: the reviewer
agent re-reviews on new commits, resolves threads whose findings are addressed,
and approves when nothing blocking remains — and the developer-agent's
`respond-review` workflow does not spin up for a clean approval. The initial
review path, the reviewer image, and the `agent-review.yml` label-trigger
workflow are already in place (issues #55/#56/#40); this design does **not**
revisit their decisions and instead layers the update-event and
thread-resolution behavior on top of them.

## Requirements (from issue #41 grooming Q&A)

1. **Re-review on push.** Add `synchronize` to `agent-review.yml` triggers.
   The `agent:review` label is the opt-in flag for continuous review — only
   PRs already carrying it get re-reviewed on push.
2. **Thread lifecycle.** In the reviewer container, compare the new commits
   against prior review threads; resolve addressed threads via the GraphQL
   `resolveReviewThread` mutation; comment on remaining or new findings;
   `APPROVE` when nothing blocking remains.
3. **Loop guard.** After an `APPROVED` review with zero unresolved threads,
   `agent-respond-review.yml` must not dispatch a developer-agent run.
4. **Conflicted-PR limitation.** Document that GitHub drops
   `pull_request` / `pull_request_review` events while a PR is conflicted;
   the workaround is to re-apply `agent:review` after resolving conflicts.

## Design

### 1. `synchronize` trigger on `agent-review.yml`

Add `synchronize` alongside the existing `labeled` type. The tricky part is
that the two event variants need different gating:

- `labeled` — the sender check (`vars.AGENT_ALLOWLIST`) and the label-name
  check (`github.event.label.name == 'agent:review'`) already exist. Keep
  them as-is: the sender is what authorizes the initial enrolment.
- `synchronize` — no `label` object is present on the event, and the sender
  is whoever pushed (typically the developer agent, sometimes a human).
  Gate instead on **the label already being present on the PR**, evaluated
  from `github.event.pull_request.labels.*.name`. No sender check is needed
  because the label was already applied by an allowlisted actor in a prior
  event; the push cannot itself change label state.

Consolidated `if:` condition:

```yaml
if: >
  github.event.pull_request.state == 'open' &&
  (
    (
      github.event.action == 'labeled' &&
      github.event.label.name == 'agent:review' &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)
    ) ||
    (
      github.event.action == 'synchronize' &&
      contains(github.event.pull_request.labels.*.name, 'agent:review')
    )
  )
```

**Alternatives considered.**

- *Sender-check on `synchronize` too.* Rejected: the sender on a push is
  the pusher, not the label-applier. Requiring the pusher to be in the
  allowlist would either exclude legitimate developer pushes (breaking the
  loop) or bloat the allowlist with anyone who might push. The label
  itself is the authorization artifact; guarding on its presence is
  sufficient.
- *Track "reviewing" state in a separate label or file.* Rejected — the
  `agent:review` label is already the opt-in signal per the parent design;
  a second state store adds surface area with no new capability.
- *Do the label check via a preflight `gh` API call.* Rejected — the
  labels are already on the event payload for
  [`pull_request_target`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request);
  a shell step is more code and a network round-trip for the same answer.

Everything else in `agent-review.yml` (concurrency group,
`pull_request_target` choice, model resolution, image build) is unchanged.
`pull_request_target` continues to be intentional: `synchronize` runs from a
PR-authored head, and using `pull_request_target` keeps the workflow YAML
and Docker build context pinned to the base branch, preserving the trust
posture from #40.

### 2. Re-review + thread resolution in the container

The reviewer image already fetches open (unresolved) review threads with
their GraphQL IDs (see `docker/reviewer/entrypoint.sh` around the
`reviewThreads` GraphQL query). The initial-review prompt (`review.md`)
currently instructs Claude to treat them as **context only** — the
prohibition on replying to, resolving, or dismissing them was decision 4 in
`reviewer-container.md`, deferred to this issue.

The re-review behavior is layered on the same code path — no new
`AGENT_ACTION`, no new entrypoint variant. From the container's perspective
the run is identical to the first review; only the prompt changes.

Prompt-level flow (updated `review.md`):

1. Read the diff + open review threads + CI status from the built context.
2. For each open thread, judge whether the finding is now addressed by the
   current diff (line moved, code deleted, logic corrected).
3. Choose the verdict for what remains:
   - `REQUEST_CHANGES` if there are open blocking findings (existing
     unresolved threads deemed still valid, or new blocking findings on
     new code);
   - `COMMENT` if only advisory findings remain;
   - `APPROVE` if nothing blocking or advisory-worth-noting remains.
4. **Post the review** as a single `POST /pulls/{n}/reviews` call, carrying
   any new inline comments and the verdict. This preserves the
   single-review-per-run atomicity from `reviewer-container.md` decision 2.
   If this call fails, abort — do not proceed to thread resolution.
5. **Resolve addressed threads** via the GraphQL `resolveReviewThread`
   mutation, one call per thread ID. Do this **after** the review is posted.

Order matters: **post the review first, then resolve threads**. If thread
resolutions fail after the review lands, the next re-review can retry —
worst case is a thread that remains open but could have been resolved. If
resolutions fail before the review is posted, the run aborts cleanly and the
next re-review sees the same open-thread set and can retry without any drift
between verdict and thread state. A resolution failure is non-fatal: the
review already stands.

**Alternatives considered.**

- *Entrypoint decides which threads are addressed.* Rejected — the
  "is this finding still present?" judgment is semantic, and semantic
  reasoning is what Claude is for. Entrypoint stays mechanical (fetch
  context, run Claude, verify a review exists), matching PR #11's split.
- *Include resolved threads in the context so Claude can re-open them if
  a fix regressed.* Rejected as out of scope (below). If a regression
  happens, Claude will still post a fresh finding on the new diff — a new
  thread rather than a re-opened one — which is noisier but correct.
- *Separate GraphQL mutations bundled into the single review call.*
  GitHub's `submitPullRequestReview` mutation does not accept thread
  resolutions in the same operation. There is no single-call form; each
  `resolveReviewThread` is its own mutation. This is inherent to the API.
- *Reply to the thread when resolving.* Not required by the issue; skip
  for now. The resolve action itself is the record. Adding replies can be
  a follow-up if reviewers find silent resolutions confusing.

The existing post-run verify step (a review by the reviewer bot exists
against the PR head SHA) still works and stays as the fail-loud guarantee.
The verify step does **not** need to check that resolves happened — the
review post is the primary artifact; unresolved threads that should have
been resolved will simply be re-processed on the next re-review, which is
self-healing.

**Small entrypoint touch-up.** The current entrypoint writes an inline note
to the prompt context reading _"Existing open (unresolved) review threads
(context only — do not reply to or resolve them; skip any finding already
covered by an open thread)."_ That note must change: threads are now
actionable (evaluate + resolve if addressed). The rewrite is a
localized-string edit inside `docker/reviewer/entrypoint.sh`; no structural
change.

### 3. Loop guard in `agent-respond-review.yml`

Today's guard skips only a **bare approval** — state == `approved`, empty
body, zero inline comments (on the just-submitted review). It runs the
developer agent for any approval that carries body text or inline comments.

The new requirement: skip whenever the review is `approved` AND the PR has
zero unresolved review threads, regardless of body/inline-comment content
on the review itself. Rationale: an approval with zero unresolved threads
carries no actionable feedback (any inline comment on an approve verdict
is by definition non-blocking, and the reviewer's own summary body is
typically "looks good" chatter). Waking up the developer agent for that
burns compute and adds PR noise.

Implementation: keep the existing bare-approval check (it's a strict
subset of the new one but it's already shipped and tested, and short-
circuits before the extra API call), and add a follow-on check that
queries the PR's `reviewThreads` and skips if `isResolved == true` for
all of them:

```bash
# Fail open on GraphQL errors, same posture as the existing guard.
UNRESOLVED_COUNT="$(gh api graphql -F owner="$OWNER" -F name="$REPO" -F number="$PR_NUMBER" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) { nodes { isResolved } }
      }
    }
  }' --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' 2>/dev/null)" || UNRESOLVED_COUNT=""

if [[ "$UNRESOLVED_COUNT" =~ ^[0-9]+$ ]] && [ "$UNRESOLVED_COUNT" -eq 0 ]; then
  echo "Approval with zero unresolved threads; skipping respond-review."
  echo "proceed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
```

Paginate the thread query only if PRs with >100 threads become plausible;
initially, 100 is well above any expected count. Fail-open
(`|| UNRESOLVED_COUNT=""`) on GraphQL errors matches the existing guard's
posture — an empty string fails the numeric regex check and lets the loop
proceed, so a transient API failure does not silently swallow a real
approval that needs response.

**Alternatives considered.**

- *Replace the bare-approval logic with a strict
  `approved AND unresolved==0` check.* Rejected: the existing guard is
  already shipped and covers the common case; layering the tighter check
  on top is additive and avoids re-testing the bare-approval path.
- *Have the reviewer agent leave a signal (e.g. a special label or comment
  keyword) that the loop should stop.* Rejected — adds a new signal
  between agents; the PR's own thread state is already the ground truth
  and does not need shadowing.
- *Skip on any approval, even with unresolved threads.* Rejected —
  approvals with unresolved threads shouldn't happen in the reviewer
  agent's own outputs (its APPROVE only fires when nothing blocking
  remains), but a human approver may approve while leaving open questions,
  and those deserve a response.

### 4. Conflicted-PR limitation: user-visible documentation

The parent design already documents the underlying quirk (GitHub drops
`pull_request` and `pull_request_review` events while a PR is conflicted,
and the events are not replayed after resolution). This design's job is
the operator-facing note: what a user should do to restart the loop.

Locations:

- **`AGENTS.md`** — extend the `agent:review` label bullet in the
  **Labels** section with a short sentence stating the limitation and the
  workaround. One-line addition; no new section (per the "merge-friendly
  documentation" guidance in AGENTS.md).
- **`README.md`** — if the operator guide references the review loop,
  add the same one-liner there. If not, skip; AGENTS.md is authoritative.
- **`docs/design/code-review-agent.md`** and
  **`docs/design/reviewer-container.md`** already document the underlying
  behavior; no changes needed there.

Content of the note (single line):

> GitHub suppresses `pull_request` and `pull_request_review` events while a
> PR has merge conflicts; remove and re-apply `agent:review` after
> resolving conflicts to restart the re-review loop.

**Alternatives considered.**

- *Poll for conflict resolution and auto-restart from
  `agent-resolve-conflicts.yml`* (issue #54). Rejected as out of scope
  here: this is a documentation issue, not a workflow issue, and the
  auto-restart via label re-apply already works today.

## Out of scope

- **Detecting or re-opening resolved threads when a fix regresses.** The
  agent will re-file a fresh finding on the current diff; the previously-
  resolved thread stays resolved. Re-opening resolutions requires extra
  state tracking and can be a follow-up if it becomes a problem.
- **Replying to a thread when resolving.** Silent resolution is
  acceptable; the resolve action itself is the record. Threaded replies
  are a possible enhancement but not required by the issue.
- **Automatic merging on approval.** Human-in-the-loop merge stays
  (parent design).
- **A conflict-aware auto-restart of the re-review loop.** Handled by the
  workaround (re-apply the label); no automation added here.
- **A separate re-review `AGENT_ACTION` variant.** The reviewer image is
  one action; both first-review and re-review flow through the same code
  path, differing only by prompt behavior.

## Task breakdown

Sub-issues are single-PR-sized. The suggested implementation order from
the grooming notes (loop guard → synchronize trigger → re-review logic →
docs) is preserved as a review-risk sequence; the tasks themselves are
independent apart from the end-to-end validation which depends on all of
them.

| Issue | Task | Depends on |
|-------|------|-----------|
| [#114](https://github.com/mfrancza/agentic-development-workflow/issues/114) | Loop guard in `agent-respond-review.yml`: skip when review state is `approved` and PR has zero unresolved review threads | — |
| [#115](https://github.com/mfrancza/agentic-development-workflow/issues/115) | Add `synchronize` trigger + per-event `if:` gating to `agent-review.yml` | — |
| [#116](https://github.com/mfrancza/agentic-development-workflow/issues/116) | Re-review + thread-resolution behavior: rewrite `docker/reviewer/prompts/review.md` (evaluate open threads, post review first, then resolve addressed ones via `resolveReviewThread`); update the "context only" note in `docker/reviewer/entrypoint.sh` | — |
| [#117](https://github.com/mfrancza/agentic-development-workflow/issues/117) | Conflicted-PR limitation note in `AGENTS.md` (label description) and `README.md` if applicable | — |
| [#118](https://github.com/mfrancza/agentic-development-workflow/issues/118) | End-to-end validation on a real PR: apply `agent:review`, push new commits, verify addressed threads get resolved, verify `APPROVE` fires when clean, verify `agent-respond-review` skips on that approve | Issue #114, Issue #115, Issue #116, Issue #117 |

Issues #114, #115, #116, and #117 can proceed in parallel — this document
is the contract between them (`synchronize` trigger surface, prompt
resolve-then-review order, loop-guard predicate, doc location). Issue #118
exercises the full loop end-to-end and is expected to feed small fixes back
into the implementation tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
