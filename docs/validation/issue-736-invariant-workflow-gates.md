# Issue #736 validation record: invariant workflow gates

**Status:** blocked pending a maintainer-run disposable-repository exercise.

The caller/reusable refactor is on `main` at
`25d77fac8fc0f38344e3df8752835b8c1e772380`. This record separates the
evidence that can be observed with the issue agent's read-only GitHub token
from the event cases that require a credential able to create disposable
issues/PRs and (for one case) temporarily set an Actions variable. No
production setting has been changed for this validation.

## Recorded run evidence

| Case | Result | Evidence |
| --- | --- | --- |
| Unrelated `issues.labeled` event does not call groom | Passed | [agent-groom run 40436461798](https://github.com/mfrancza/agentic-development-workflow/actions/runs/40436461798) was skipped at the caller job while an `agent:developer` label event was processed for issue #736. |
| An owned open issue label reaches the reusable gates | Passed | [agent-implement run 40436461795](https://github.com/mfrancza/agentic-development-workflow/actions/runs/40436461795) ran `implement / gate` and `implement / authorize` successfully before entering `implement / implement`. The run is on the refactored `main` SHA above. |
| Disabled auto-trigger transition is a no-op | Passed | [agent-auto-trigger run 40436463352](https://github.com/mfrancza/agentic-development-workflow/actions/runs/40436463352) completed its `route` job and skipped every transition and authorization job for the observed issue event. |
| Successful CI conclusion does not run fix-checks | Passed | [agent-fix-checks run 40432149133](https://github.com/mfrancza/agentic-development-workflow/actions/runs/40432149133) was skipped for a `workflow_run` delivery whose conclusion was successful. |

The local regression suite also passed at this ref: `npm test` (39 files,
639 tests) and `npx tsc --noEmit`, both from `.github/scripts`. The
workflow-contract tests assert that gate jobs precede per-subject concurrency
for groom, implement, design, and review, and that the three label-routed
callers retain their owned-label guards. This is supporting structural
evidence, not a substitute for the live queue exercise below.

During this validation, the same-repository auto-review transition on the
validation PR correctly added `agent:review`, but both resulting
[`agent-review` runs](https://github.com/mfrancza/agentic-development-workflow/actions/runs/40436778644)
failed at workflow startup before creating a job. The wrapper had stopped
passing `repo` and `default-model` while it still called the pinned `v0.2.0`
review worker, whose released contract requires both. This PR restores those
two values *inside the wrapper* from `github.repository` and
`vars.DEFAULT_MODEL`; it does not restore either public caller input. The
regression assertion in `workflow-call-contracts.test.ts` locks that adapter
in place.

## Required maintainer-run matrix

Run the following in a disposable same-organization repository configured
with the developer and reviewer Apps and pinned to the commit above. Keep
the production repository variables unchanged. Record each Actions URL and
the gate and work-job conclusions in the table below before declaring this
issue accepted.

| Case | Stimulus | Expected evidence |
| --- | --- | --- |
| Owned label, open issue | Apply `agent:groom` to an open disposable issue as an allowlisted actor. | Caller invokes reusable; lifecycle gate and authorization succeed; only then does the locked work job enter `agent-groom-issue-<N>`. |
| Unrelated label | Apply a non-routing label to that issue. | The caller job is skipped; no reusable gate or concurrency-group member is created. |
| Owned label, closed issue | Close a second disposable issue, then apply `agent:groom`. | Caller invokes the reusable, `gate` reports `proceed=false`, and authorization/work are skipped. |
| Same-repository review label | Open a same-repository PR and apply `agent:review`. | Caller invokes reusable; its lifecycle and authorization gates precede the `agent-review-pr-<N>` work job. |
| Fork review label | Apply `agent:review` to a fork-headed PR. | The caller job is skipped before a reusable workflow or secret-bearing job starts. |
| Synchronize without review label | Push to a same-repository PR with no `agent:review` label. | The caller job is skipped. |
| Synchronize with review label | Apply `agent:review`, then push to the same-repository PR. | The caller invokes the reusable and reaches the lifecycle gate; a fork never does. |
| Auto-trigger disabled | With the disposable repository's `AUTO_TRIGGER_AGENTS` key false, open an issue and add `plan` or `do`. | `route` runs; no transition or authorization job runs and no `agent:*` label is added. |
| Auto-trigger enabled | In the disposable repository only, set the relevant `AUTO_TRIGGER_AGENTS` key true and repeat the matching event. | `route` selects exactly one transition and applies the expected `agent:*` label. Reset the variable afterwards. |
| Actionable check conclusion | Allowlist the exact disposable check-run name in `FIX_CHECKS_ALLOW`, fail that check on an agent-authored disposable PR. | `resolve-trigger` runs and accepts only the canonical check name; the work job enters `agent-fix-checks-pr-<N>` after resolution. |
| Successful check conclusion | Deliver a successful run for the same check. | `resolve-trigger` is skipped and no concurrency-group work job is created. |

## Controlled queue proof

Use the open-issue grooming case because its caller has the owned-label guard
and its worker has an observable per-issue group.

1. Hold run **A** in `agent-groom-issue-<N>` (for example, use a disposable
   image whose grooming command waits on a pre-arranged release signal).
2. Remove and re-apply `agent:groom` to enqueue valid run **B**. Confirm in
   the Actions UI that B is pending behind A and record both URLs.
3. Apply an unrelated label while B is pending. Record the resulting
   `agent-groom` run **C**.
4. Confirm C is skipped at the caller job and B remains pending (it must not
   be cancelled or replaced). Release A and confirm B begins and completes.

Capture A/B/C URLs, timestamps, the group name, and each caller/gate/work-job
conclusion in the issue or acceptance PR. Do not use a production image,
production issue, or a workflow-level concurrency override to manufacture
this test.

## Current blocker

The token supplied to the Issue #736 implementation environment can read
workflow runs but cannot identify the authenticated user, create issues or
PRs, edit labels, or read/write repository Actions variables (all relevant
API calls return HTTP 403). Consequently it cannot safely execute the
disposable live matrix or the required controlled queue test. A maintainer
with disposable-repository administration is needed to run the matrix and
append the resulting URLs here.
