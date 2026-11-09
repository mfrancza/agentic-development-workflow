# Design: Pin respond-review's force-push lease to the checkout tip

**Issue:** [#770](https://github.com/mfrancza/agentic-development-workflow/issues/770)
**Related designs:** [Shared branch concurrency group](shared-branch-concurrency-group.md) (Issue #769).
**Related issue:** [#771](https://github.com/mfrancza/agentic-development-workflow/issues/771) owns model-issued, in-session pushes.

## Requirements as understood

Issue #770 identifies a data-loss bug in `action_respond_review()` in
`docker/scripts/entrypoint.sh`. After the model exits, the entrypoint fetches
the branch, treats any divergence as a history rewrite, and pushes with an
implicit `--force-with-lease`. Fetching has already moved the remote-tracking
ref to a concurrent writer's commit, so that lease authorizes overwriting the
very commit it should protect.

The runtime evidence is PR #767 on **2026-11-01**, documented in Issue #769:

- Run `41342567276` pushed `b83f95b` at 19:40:57 UTC; respond-review
  [run 41342733649](https://github.com/mfrancza/agentic-development-workflow/actions/runs/41342733649)
  replaced it with `b01805a` at 19:47:36 UTC.
- Run `41344840055` pushed `e57ac0b` at 20:08:01 UTC; respond-review
  [run 41344375599](https://github.com/mfrancza/agentic-development-workflow/actions/runs/41344375599)
  replaced it with `d51405e` at 20:08:08 UTC.

The times quoted in Issue #770 are the overwrites, not the original pushes;
Issue #769 supplies the full timeline. Both respond-review runs have a
`success` conclusion in the Actions API: a green run did not mean safe
publication. This is runtime data loss, not a linter-motivated change.

A local bare-remote/two-clone reproduction on **2026-11-09** also confirmed:

| Experiment | Result |
|------------|--------|
| Amend the agent's commit; another clone pushes; fetch; implicit lease push | Push succeeds; the concurrent commit is no longer an ancestor of the remote branch |
| Same branch tips; lease explicitly against the original checkout SHA | Push is rejected; remote remains exactly the concurrent writer's tip |
| Remote remains at the original checkout SHA; explicit-lease amend push | Push succeeds; remote becomes the amended tip |

The implementation must preserve the concurrent commit or fail non-zero,
including when the writer pushes after the final fetch. An uncontended
amend/rebase must still publish successfully. Audit `fix-checks`, both
`resolve-conflicts` push paths, and `implement` for the same hazard; include
`fix-deployment` and `design` for completeness.

The grooming comment classifies this as a design task and identifies three
open decisions: the baseline, rebase versus failure, and cross-action scope.
There are no additional clarifying answers or permission requests. This design
chooses an immutable checkout baseline, visible failure rather than automatic
reconciliation, and a narrow change to the only entrypoint force-push path.
The existing shared concurrency group is complementary, not a prerequisite:
humans and other writers do not acquire the Actions lock.

## Decisions

### Decision 1 — Capture and validate the baseline before the model runs

Immediately after `gh pr checkout` resolves `BRANCH_NAME`, capture the checked-out
commit. Fetch the branch explicitly into its full remote-tracking ref:

```bash
git fetch --no-tags origin "+refs/heads/${BRANCH_NAME}:refs/remotes/origin/${BRANCH_NAME}"
```

Resolve that ref to a commit and save it as a function-local, read-only
`REMOTE_AT_START`. Require the checked-out commit to equal it. On a mismatch,
fetch failure, missing branch, or invalid commit, fail before invoking the
model, with instructions to retry from a fresh checkout. Do not silently reset
the working tree or accept a newer baseline than the code actually checked out.
The leading `+` here refreshes a **local fetch destination**, not a push.

Capture this before base-branch fetches, review retrieval, or pre-commit checks;
never recompute it after the model or the checks run. `HEAD_BEFORE_CLAUDE`
retains its existing, separate role in detecting whether the model changed HEAD
and selecting the pre-commit diff. No new environment variable is introduced.

**Alternatives:** Relying on the refreshed tracking ref repeats the bug. Using
the pre-model HEAD alone is conservative but leaves checkout/remote mismatch
implicit. Fetching a baseline without comparing it to checkout can authorize
discarding a commit the agent never saw. Explicit fetch plus equality validation
makes the invariant testable and fails safely on the setup race.

### Decision 2 — Ancestry selects the strategy; the original SHA authorizes force

Introduce a sourceable `docker/scripts/lib/branch-push.sh` helper with the
contract `branch_push_review <branch> <remote-at-start>`. It requires `log()`,
returns non-zero on failure, and has no GitHub API or model side effects.
Source it alongside the existing entrypoint helpers. Only respond-review calls
it; do not give the normal-push actions a new force capability.

The helper validates its non-empty baseline as a commit, fetches the branch
using the explicit refspec above, and resolves the observed remote commit once
into `REMOTE_NOW`. It fails closed on fetch/ref-resolution errors. Evaluate
ancestry using the resolved commit, not a tracking ref that can later move.
Distinguish `merge-base --is-ancestor` exit 1 (not an ancestor) from operational
errors; an error is not evidence of divergence.

When HEAD changed, use this decision table in order:

| Relationship after successful fetch | Publication |
|------------------------------------|-------------|
| `REMOTE_NOW` is an ancestor of HEAD, including equality | Normal `git push origin "HEAD:refs/heads/${BRANCH_NAME}"`; local history already contains the observed remote |
| HEAD is an ancestor of `REMOTE_NOW`, but not equal | Fail non-zero with the existing remote-ahead diagnostic; never force |
| Histories diverged and `REMOTE_NOW != REMOTE_AT_START` | Fail non-zero: remote changed during the run; never force |
| Histories diverged and `REMOTE_NOW == REMOTE_AT_START` | Supported history rewrite; push with the explicit start lease below |

```bash
git push --force-with-lease="refs/heads/${BRANCH_NAME}:${REMOTE_AT_START}" \
  origin "HEAD:refs/heads/${BRANCH_NAME}"
```

The full destination ref and explicit `HEAD` source avoid ambiguity and cannot
accidentally publish a different local branch. Do not use bare
`--force-with-lease`, `--force`, a force push refspec, or a freshly observed SHA
as the expected lease value. Keep the baseline unchanged even if the model or
pre-commit command performs additional fetches.

A writer can still push between the final fetch and publication. The server's
explicit lease rejects that force push; a normal push rejects a non-fast-forward
update. Neither rejected push may fall back to a less restrictive command or a
new lease. The unchanged-HEAD path continues to skip publication and re-review.
The existing rejection of a pure rewind (HEAD strictly behind the remote) is
retained; this change preserves amend/rebase support, not a new reset-and-discard
capability.

**Alternatives:** Normal pushes only are safest but break the accepted
amend/rebase behavior. Comparing the two remote SHAs without an explicit lease
leaves a fetch-to-push race. A lease alone protects the remote but omits the
clear concurrent-change diagnostic; use both the comparison and the lease.
Keeping all logic inline makes real-Git tests harder because sourcing the
entrypoint runs initialization and dispatch. A small shell helper follows the
existing `fix-checks-guard.sh` and `pre-commit-checks.sh` testability pattern.

### Decision 3 — Fail visibly; do not rebase automatically or retry force

For concurrent divergence, unavailable remote state, or push rejection, log the
branch, original SHA, observed SHA when available, and local HEAD. Explain that
no unsafe force push was attempted (or that the explicit lease rejected it),
and recommend rerunning from the current remote or manually recovering the
local commits from the run. Propagate failure to the container exit status.
Do not promise that an ephemeral local clone survives the run.

On helper failure, do not request re-review or inject the authored-by-model
marker. On success, retain the existing re-review behavior; marker handling and
the no-change path otherwise remain unchanged. The pre-commit backstop remains
fail-open as already designed; publication safety is a separate fail-closed gate.
No automatic labels, assignments, or PR comments are added for this operational
failure, and no automatic retry mechanism is introduced.

**Alternatives:** Rebasing the model's commits automatically adds conflict
resolution and retesting after the model has finished, and is ambiguous when
the agent amended old commits. Silently skipping the push hides unpublished
work. Retrying with the newly observed SHA defeats the safety property. A
visible failed run matches the existing remote-ahead branch and is the smaller,
reviewable fix.

### Decision 4 — Audit other writers without conflating sibling issues

The current source audit gives the following result:

| Path | Current publication owner / mechanism | Treatment |
|------|---------------------------------------|-----------|
| `respond-review` | Entrypoint; implicit force lease on divergence | Replace with Decisions 1–3 |
| `fix-checks` | Entrypoint; normal `git push origin "$BRANCH_NAME"` | Preserve normal-only publication; test concurrent non-fast-forward rejection |
| `resolve-conflicts` | Entrypoint; normal push after either clean merge or verified conflict resolution | Preserve both normal-only paths; test that a concurrent divergent update is not overwritten |
| `implement` | Model pushes and opens the draft PR; entrypoint verifies it | No entrypoint force-push path to replace; record this boundary, not a claim that every model command is guarded |
| `fix-deployment` | Entrypoint; normal push to its fix branch | Preserve normal-only publication |
| `design` | Model pushes and opens the draft PR | Same audit boundary as implement; no force-push entrypoint path |

Add a focused source-level regression check to prevent force flags or forced
push refspecs being introduced into the audited normal-only entrypoint paths;
behavioral tests remain the authority for lease correctness. Document the audit,
the respond-review failure/recovery contract, and its relationship to the shared
group in `AGENTS.md`; add a concise operator recovery note in `README.md`.
Do not duplicate action/label/trigger inventories or change workflow files.

**Alternatives:** Applying the rewrite helper to every action would broaden
force-push permissions beyond their existing contract. Moving implement/design
publication into the entrypoint, changing prompts, or enforcing in-session
push restrictions belongs to Issue #771. This issue cannot guarantee safety
against arbitrary Git commands issued inside a model session; that is a separate
boundary from the entrypoint's publication decision.

## Validation

Use Vitest-driven Bash tests with an actual temporary bare remote and two
working clones. Source the production helper, not a reimplementation; stub
only logging and deterministic race injection. A one-shot Git wrapper can push
from the second clone immediately before forwarding the helper's push to the
real Git binary, without sleeps or production-only test hooks.

Required cases:

- Normal fast-forward succeeds, including a remote update already incorporated
  into local HEAD; equality is a harmless normal push.
- Divergent amend/rebase succeeds when the remote still equals the baseline.
- A second clone pushes while the model is running: both a local append and an
  amend must fail on divergence and leave the remote tip exactly at the writer's
  commit. Include the strict remote-ahead case.
- Another clone pushes after final fetch but before the force push: the explicit
  lease rejects it and the writer's commit remains reachable at the branch tip.
  Exercise the corresponding normal-push race as well.
- An extra fetch during the simulated model run or pre-commit check cannot
  reauthorize a force push against a changed remote.
- Fetch failure, branch deletion, invalid/missing baseline, and ancestry errors
  fail without attempting a force push. Deletion after final fetch is rejected
  by the explicit lease rather than recreating the branch through force.
- Checkout/baseline mismatch stops before the model; unchanged HEAD skips
  publication; rejection prevents re-review and marker injection. Exercise
  action wiring in an entrypoint harness with model/GitHub side effects stubbed.
- Other audited entrypoint paths retain normal pushes and reject competing
  non-fast-forward updates; do not add force support to make tests pass.

The final validation task runs the integrated action against disposable local
remotes with a stubbed model, including an uncontended rewrite and both race
windows. Record commands, exit codes, original/writer/final SHAs, and reachability
assertions. No live branch force pushes, changes to `main`, provider API billing,
or workflow/security-policy changes are needed to prove this contract.

For implementation changes under `.github/`, run the repository-mandated
`npm ci && npm run typecheck && npm test` in `.github/scripts`, plus `bash -n`
on changed shell files. The design PR itself changes only this document.

## Out of scope

- Changing concurrency groups, workflow triggers, GitHub App identities,
  credentials, branch protection, deployment configuration, or permissions.
- Model-session push enforcement and prompt ownership changes (Issue #771).
- Automatic rebase/merge, force retries, durable storage of unpushed work, or a
  new retry queue following a rejected publication.
- Restoring PR #767's lost commits or modifying historical design documents.
- Detecting a remote that changed and returned to the identical original SHA
  (a lease compares the current tip, not the remote's reflog).
- Treating the helper as a security boundary against a malicious in-container
  process; the existing container/token trust model remains unchanged.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|------------|
| [Issue #843](https://github.com/mfrancza/agentic-development-workflow/issues/843) | Implement sourceable branch publication helper and real-Git lease/race tests (`docker/scripts/lib/branch-push.sh`, `.github/scripts/test/branch-push.test.ts`) | None |
| [Issue #844](https://github.com/mfrancza/agentic-development-workflow/issues/844) | Integrate immutable checkout baseline and guarded publication into respond-review; add action-wiring tests (`docker/scripts/entrypoint.sh`, `.github/scripts/test/respond-review-push.test.ts`) | Issue #843 |
| [Issue #845](https://github.com/mfrancza/agentic-development-workflow/issues/845) | Lock the other entrypoint paths to normal-only pushes, document the audit and operator recovery (`.github/scripts/test/entrypoint-push-audit.test.ts`, `AGENTS.md`, `README.md`) | None |
| [Issue #846](https://github.com/mfrancza/agentic-development-workflow/issues/846) | End-to-end local validation of the integrated entrypoint, concurrent writers, uncontended rewrites, and audit contract; record evidence | Issues #843, #844, #845 |

The helper/test task and audit/documentation task are independent and can run
in parallel: their file ownership does not overlap. Respond-review integration
depends on the helper's settled API. End-to-end validation depends on all three
implementation tasks. Every sub-issue remains `draft` until this design PR
merges; blocked-by relationships record each dependency natively on GitHub.
