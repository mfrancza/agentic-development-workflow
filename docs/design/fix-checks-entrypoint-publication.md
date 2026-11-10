# Design: Entrypoint-owned publication for fix-checks and respond-review

**Issue:** [Issue #771](https://github.com/mfrancza/agentic-development-workflow/issues/771)
**Related designs:** [Shared branch concurrency](shared-branch-concurrency-group.md),
[checkout-pinned publication lease](entrypoint-force-with-lease.md), and
[pre-commit checks backstop](developer-agent-pre-commit-checks.md).

## Requirements as understood

Issue #771 asks that a fix-checks model diagnose failures, test, and commit
locally, leaving publication to the entrypoint. A normal successful run must
have one push, after the model exits. If a guard is provided, an ordinary
model-issued `git push` must fail with an actionable explanation. An unchanged
branch or an already-equal remote must not turn into an erroneous failure.

The grooming comment on **2026-11-08** asks the design to coordinate prompts,
entrypoint publication, optional enforcement, and tests of session versus
entrypoint pushes. There are no additional maintainer answers resolving the
enforcement choice or expanding the action scope.

### Runtime evidence

The issue reports PR #767, [run 41344840055](https://github.com/mfrancza/agentic-development-workflow/actions/runs/41344840055),
on **2026-11-01**: the model ran `git -C /home/agent/work push` at approximately
20:08:00 UTC and published `e57ac0b`; another respond-review run replaced the
branch before fix-checks' entrypoint push. Inspecting the workflow log confirms
`Pushing fixes` at 20:08:10 UTC followed by a rejection for `agent/issue-759`
with `fetch first`; the run concluded `failure`. The session command and commit
are evidence reported by the issue; the inspected workflow log independently
confirms the second push and its rejection.

The concurrency and lease designs address separate parts of that incident.
This design neither replaces their policies nor claims that preventing an
in-session push eliminates outside-writer races.

### Current ownership and ambiguity resolution

The authoritative `action_*()` functions in `docker/scripts/entrypoint.sh`
and their prompts establish these boundaries:

| Action | Current publisher | Treatment here |
|--------|-------------------|----------------|
| `fix-checks` | Entrypoint normal push after model and checks backstop | Explicit commit-only prompt and session guard; keep one normal push |
| `respond-review` | Entrypoint `branch_push_review` after model and checks backstop, only when HEAD changed | Explicit commit-only prompt and same guard; preserve checkout baseline, leases, and re-review ordering |
| `implement` | Model pushes and opens a draft PR; entrypoint verifies/promotes it | Clarify that its push remains required; do not install the guard |
| `design` | Model pushes design branch and opens a draft PR | Unchanged; do not install the guard |
| `fix-deployment` | Entrypoint pushes its new branch | Leave its existing contract unchanged |
| `resolve-conflicts` | Entrypoint verifies, commits, and pushes the merge | Leave its existing contract unchanged |

The proposal's parenthetical about `implement` cannot mean blindly forbidding
its push: there is no replacement entrypoint push there, and creating a PR
requires the remote branch. Moving that action's publication and PR creation
is a separate lifecycle change. The fix-checks prompt is actually named
`respond-to-checks.md`, and the review prompt is `respond-to-review.md`.

## Decisions

### 1. Define publication ownership in the action-specific prompts

Update `respond-to-checks.md` and `respond-to-review.md` to say: perform checks,
commit locally, and return; **do not push**, force-push, publish through another
tool/API, or disable the guard. The entrypoint publishes after the session.
Remove language such as fix-checks' "verify before pushing" that implies the
model owns publication. Review replies must cite real local commits without
claiming those commits are already published; preserve the existing reply and
maintainer-authentication requirements.

Clarify `implement.md`'s existing instruction as action-specific: for implement,
the model still pushes and creates a draft PR. Keep marker injection and
ready-for-review promotion owned by the entrypoint, as today. Also include the
commit-only reminder in fix-checks' injected task context so the immediate
request and persistent prompt agree.

**Alternatives:** prompt-only guidance is the smallest change but would not
catch a model following habitual Git instructions. A blanket no-push rule
would break implement/design. Choose scoped prompts plus the operational guard
below, not a repository-wide Git prohibition.

### 2. Add a model-session-only pre-push guard, not a new security boundary

Introduce a sourceable helper `docker/scripts/lib/model-push-guard.sh` exposing
`run_agent_without_push`, which takes the same arguments as `run_agent`.
Its contract is to run the existing provider-dispatching function in a
subshell with a temporary hook overlay active in the ephemeral checkout
for the duration of that call:

- Resolve the worktree's effective existing hooks directory to an absolute
  path before changing the environment. Create a fresh private temporary
  directory outside the worktree, with a generated executable `pre-push` hook.
- The hook exits nonzero and writes to stderr:
  `Do not git push in this model session. Commit locally; the entrypoint will push after the session exits.`
- Preserve other effective hooks, including pre-commit and commit-msg, by
  forwarding them through the overlay rather than silently disabling them.
  Resolve paths before overlay activation, handle spaces, and do not copy or
  execute worktree-supplied strings as shell source. The original pre-push
  hook is not invoked for the rejected model attempt; it remains available
  to the later entrypoint push.
- Snapshot the complete previous repository-local `core.hooksPath` setting,
  distinguishing absent, empty, and multiple values. Temporarily point that
  setting at the absolute overlay path. Never change global configuration or
  overwrite existing hooks. Before invoking the model, verify Git actually
  resolves the effective hooks path to the overlay; a higher-precedence
  configuration override must produce a visible setup failure, not an
  apparently guarded session with an inactive hook.
- Call the existing `run_agent` function without changing its provider
  selection, prompt arguments, or output handling. Child shells and ordinary
  `git -C ... push` commands consult the guarded checkout across all three
  providers, without depending on CLI-specific environment forwarding.
- An EXIT trap restores the exact original local setting before removing the
  temporary directory. Restoration uses a captured absolute checkout path,
  not the model's final working directory. Return the model's nonzero status
  unchanged; setup/restoration/cleanup errors must fail visibly, not invoke
  the model or proceed to publication without a working lifecycle. Do not
  mask a model failure with successful cleanup. On success, the parent
  entrypoint sees the original hook configuration, so its push needs no allow
  flag or hook bypass. A container killed before cleanup does not publish;
  the next run creates a fresh clone, as it does today.

Only the fix-checks and respond-review call sites opt in. The global
`run_agent` implementation and all other action call sites remain unguarded.
Pre-commit checks run after the wrapper returns, using the original hooks
configuration, with the existing fail-open check policy unchanged.

**Alternatives:** a permanent repository-local hook can affect unrelated
actions. An environment-only `core.hooksPath` override avoids restoration but
depends on each model CLI forwarding Git configuration variables into tool
shells; checkout-local configuration avoids that additional assumption.
A shared exported allow-push
variable risks being inherited by the model and needs careful push-step
scoping. PATH wrappers miss absolute Git paths and require argument parsing.
Post-session detection cannot undo an early publication and cannot reliably
attribute remote equality to the model rather than an outside writer. Choose
the temporary, checkout-scoped hook because it leaves publication commands
untouched and explicitly restores the existing hook configuration.

This is an accident-prevention guard, **not authorization or containment**.
The same-UID model can bypass a client hook with `--no-verify`, a configuration
override, a fresh clone, or the GitHub API. Prompts prohibit those workarounds;
this issue does not attempt to make them impossible. The existing
[outer-container trust boundary](inner-sandbox-posture.md) and GitHub
permissions remain unchanged. No credentials are withheld, added, or rotated.

### 3. Retain existing publication commands and no-op semantics

In fix-checks the order is:

1. Existing checkout and freshness guard; capture pre-session HEAD.
2. `run_agent_without_push` runs the model, which leaves local commits.
3. Existing `pre_commit_checks_run` backstop.
4. Existing `log "Pushing fixes"` and exactly one normal
   `git push origin "$BRANCH_NAME"`.
5. Existing marker injection, only if publication succeeded.

Keep the unconditional fix-checks push rather than adding a fetch-and-skip
heuristic. Git already succeeds with "Everything up-to-date" when local and
remote tips are equal, including a run with no new commits. Test that behavior
with real Git. Do not suppress all nonzero statuses, special-case stderr text,
or interpret a remote-ahead branch as "nothing to push". A rejected push
remains a visible run failure with no subsequent marker injection and no
force retry. Remote equality alone is not proof of an in-session push.

Respond-review replaces only its model invocation with the wrapper. Its
immutable pre-model `REMOTE_AT_START`, checks backstop, HEAD-change decision,
`branch_push_review`, re-review request, and marker ordering remain governed
by [the lease design](entrypoint-force-with-lease.md). In particular, unchanged
HEAD still skips push/re-review, and equality on a changed-HEAD publication
path is still a successful normal push. Do not capture a new lease after the
session or extend force support to fix-checks.

**Alternatives:** skipping fix-checks' push whenever HEAD is unchanged saves
one no-op command but changes how an outside update is observed and weakens
the simple one-push acceptance evidence. Fetching to detect an earlier model
push adds races without enforcement. Keep native Git no-op behavior and the
existing action-specific publication rules.

### 4. Document the boundary and prove it with real Git

Extend the existing publication-safety guidance in `AGENTS.md` and its
operator-facing counterpart in `README.md`, without duplicating action/env
enumerations or rewriting historical design documents. Describe which model
sessions are commit-only, the guard's diagnostic and bypass limitations,
implement/design's model-owned publication, and recovery by rerunning from
the current remote after a rejected entrypoint push. Unpublished local work
may disappear with the ephemeral container; never recommend a force retry.

Test through the existing Vitest package with Bash subprocesses, disposable
bare remotes, and production helpers/action functions. Stub model CLIs and
GitHub side effects, not Git's push/hook/lease behavior. Preserve the existing
normal-push audit and lease/race tests; a green regex test alone is not proof
that a model push is blocked.

## Validation and acceptance

| Scenario | Required evidence |
|----------|-------------------|
| Compliant fix-checks model commits without pushing | Remote stays at baseline throughout session and checks backstop; one entrypoint push publishes local HEAD, then marker injection |
| Model attempts ordinary `git push` or `git -C <worktree> push` with a new commit | Nonzero hook exit with the exact actionable diagnostic; remote unchanged until the entrypoint runs; model can continue and return success |
| Model attempts ordinary forced/deletion push | Same hook rejection; no remote ref change; no weakening of audited entrypoint normal-only pushes |
| No new fix-checks commit, remote already equal | One entrypoint push succeeds as a no-op, action succeeds, marker handling remains as before |
| Local HEAD already equals remote when publication occurs | Native Git equality succeeds; do not falsely diagnose who published it |
| Guard setup fails or model exits nonzero | Action fails; no entrypoint publication or post-publication GitHub effects; cleanup does not erase the failure |
| Outside clone advances to a conflicting tip during model session or immediately before normal push | Fix-checks push rejects; writer's commit remains the remote tip; no marker injection or force retry |
| Respond-review normal append, no-op, and uncontended amend | Guard blocks session push; existing publication helper and unchanged-HEAD skip retain their current behavior |
| Respond-review concurrent writer, including final-fetch/push race | Existing explicit lease rejects unsafe replacement; original baseline is never refreshed; re-review/marker suppressed on publication failure |
| Existing hook configuration and lifecycle | Pre-commit/commit-msg still run; original pre-push runs for entrypoint; unset/empty/multiple local values restored; global config untouched; effective-path override, restoration, and cleanup failures stop publication; other actions unchanged; temporary overlay removed |
| Anthropic, OpenAI, and xAI runner paths | Stub each CLI while retaining production dispatch; child Git consults the overlay even with a filtered environment, and original provider arguments/output are retained |
| Implement/design compatibility | They remain unguarded and can publish to disposable local remotes; implement prompt still requires push plus draft PR |

Count attempts and remote updates separately: a compliant fix-checks session
has exactly one push command, from the entrypoint. The deliberate-violation
test has rejected model attempts plus one entrypoint push, but only the latter
can update the remote. Use a Git-command recorder and bare-remote receive hook
to distinguish these, not log substring counts alone. Avoid asserting one
push for respond-review's legitimate unchanged-HEAD skip.

The end-to-end task must record commands, exit codes, diagnostic output,
push-attempt counts, original/local/writer/final SHAs, and publication versus
marker/re-review ordering. Run the integrated action against local remotes
with deterministic model/CLI stubs; no live provider billing, production PR
mutation, branch force pushes, or changes to `main` are necessary. A later
ordinary live fix-checks run can corroborate the logs but is not a prerequisite
for demonstrating the contract safely.

Implementation PRs touching `.github/` run
`cd .github/scripts && npm ci && npm run typecheck && npm test`, plus `bash -n`
on changed shell files. This design PR changes only this document.

## Out of scope

- Moving implement/design publication or PR creation into the entrypoint, or
  extending guard adoption to fix-deployment/resolve-conflicts in this change.
- New concurrency groups, trigger expressions, queues, or workflow changes.
- Reworking the settled lease/ancestry policy, automatic merge/rebase recovery,
  or treating a rejected normal push as permission to force-push.
- Enforcing against malicious same-container code, background processes that
  outlive the model session, explicit hook bypass, fresh clones, or API writes.
- Changes to GitHub App identities, token permissions, sandboxing, branch
  protection, deployment settings, or other human-owned security policy.
- Restoring PR #767's lost commits or changing authored-by-model marker
  semantics and review readiness rules.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|------------|
| [Issue #879](https://github.com/mfrancza/agentic-development-workflow/issues/879) | Implement sourceable session-only hook overlay and real-Git lifecycle tests (`docker/scripts/lib/model-push-guard.sh`, `.github/scripts/test/model-push-guard.test.ts`) | None |
| [Issue #880](https://github.com/mfrancza/agentic-development-workflow/issues/880) | Wire fix-checks/respond-review through the wrapper and verify publication/no-op/failure ordering (`docker/scripts/entrypoint.sh`, `.github/scripts/test/fix-checks-push.test.ts`, `.github/scripts/test/respond-review-push.test.ts`) | Issue #879 |
| [Issue #881](https://github.com/mfrancza/agentic-development-workflow/issues/881) | Clarify scoped prompt ownership and operator guidance; add prompt contract tests (`docker/scripts/prompts/respond-to-checks.md`, `docker/scripts/prompts/respond-to-review.md`, `docker/scripts/prompts/implement.md`, `AGENTS.md`, `README.md`, `.github/scripts/test/model-publication-prompts.test.ts`) | None |
| [Issue #882](https://github.com/mfrancza/agentic-development-workflow/issues/882) | End-to-end local validation of integrated actions, provider paths, no-op publication, concurrent writers, and compatibility; record evidence | Issues #879, #880, #881 |

The helper/tests and prompt/documentation tasks have disjoint write sets and
can proceed in parallel. Entrypoint integration depends on the helper API,
not on prompt wording; its changes and tests are separate from both other
tasks. End-to-end validation depends on every implementation task. All
sub-issues remain `draft` until this design PR merges; dependencies are also
recorded as native GitHub blocked-by relationships.
