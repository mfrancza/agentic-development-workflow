# Design: Satisfy the protected-approval-gate required check with a workflow job check on the PR head commit

**Issue:** [#751](https://github.com/mfrancza/agentic-development-workflow/issues/751)

**Supersedes:** Decision 6 ("Publish the check conclusion via the Checks API") and the Checks-API-centric portions of Decisions 7 ("Activation reconciliation"), 8 ("Per-PR serialization"), and 8a ("Cross-PR head-SHA sharing") of [`docs/design/protected-approval-gate.md`](protected-approval-gate.md). The data-model decisions in that document (configuration variables, qualifying-reviewer semantics, trigger set, trust-boundary posture, concurrency model, strictest-wins intersection) are preserved; the publication mechanism is replaced.

## Summary

Switch the gate's publication mechanism from a Checks API-created check-run
(`POST /repos/{owner}/{repo}/check-runs`) to the GitHub Actions auto-emitted
**job check** of a workflow job literally named `protected-approval-gate`
that executes under `pull_request_target` (so its check-run attaches to the
pull request head commit, in the publisher workflow's own Actions check
suite, under integration id 15368). Replace the current
reusable-workflow layer in the publisher with a top-level job (the reusable
pattern mangles the resulting check name into `publish / check`, which does
not match the required context). For review events, scheduled reconcile,
manual backfill, and departed-SHA sibling reconciliation, trigger a **rerun
of the latest `pull_request_target` publisher run**
(`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`) rather than
publishing a new check-run from a workflow run whose head SHA is the
default branch. The job's exit code is the published conclusion: non-zero
on `failure`, zero on `success`.

Alongside the publication change, fix two latent defects in
`.github/scripts/src/check-protected-approval-gate.ts` that the current
Checks-API-based publication hides:

- `evaluateSha` returns `null` when the authoritative open-PR listing has
  not yet caught up with the triggering PR's new head SHA (a documented
  `synchronize` race). Under the new mechanism the job must still exit with
  the correct conclusion for the live state, so the activity falls back on
  the triggering PR directly when the listing omits it.
- The activity writes `conclusion: failure` via `checks.create` while the
  job itself exits 0. Under the new mechanism the job's exit code **is**
  the publication, so a failed evaluation must exit non-zero.

The required-check wiring in the `main-protection` ruleset
(`context = "protected-approval-gate"`, `integration_id = 15368`) does not
change. Operators do not need to re-apply Terraform or rotate the ruleset.

## Requirements as understood

From issue #751 (title: "protected-approval-gate check does not satisfy a
required status check"), its grooming notes, and the maintainer's
clarification that "the fix approach in the issue is just a suggestion, not
a requirement; consider alternatives and the presence of additional edge
cases not reported in this issue":

1. **The merge box must clear once the gate is satisfied.** With
   `ENABLE_PROTECTED_APPROVAL_GATE = true` and the ruleset requiring
   `protected-approval-gate` from integration id 15368, a developer-agent
   PR that reaches its approval count must become mergeable without a
   human having to push an extra commit, close+reopen, or otherwise
   intervene. The current observed symptom — "Expected — Waiting for
   status to be reported" even after the Checks API posts
   `conclusion: success` — is a merge block, not a cosmetic issue.
2. **All publication paths must produce the required check on the PR head
   commit, in the publisher workflow's own Actions check suite.** The
   `pull_request_target` leg, the `workflow_run` (review) leg, the
   reconcile sweep, the manual backfill, and the departed-SHA
   reconciliation must each result in a check-run that the ruleset accepts.
   The current implementation only partially succeeds for the
   `pull_request_target` leg (and even that is undermined by the
   Checks-API-vs-suite-attachment behavior documented in Decision 7 of the
   current design doc).
3. **A failing evaluation must fail the required check.** The current
   activity writes `failure` to the Checks API but exits 0, so if the gate
   were ever retargeted at the workflow job's name, a protected PR with
   zero qualifying approvals would still pass. The fix must make the
   publication unit and the enforcement unit the same object, so an
   evaluation of `failure` and a merge block are the same event.
4. **The `evaluateSha` null-return bug must not leave the required check
   unpublished.** When the authoritative open-PR listing has not yet
   indexed the triggering PR at its new head SHA (observed on
   `pull_request_target: synchronize` events; the maintainer's note calls
   this out as an "additional edge case"), the activity currently exits 0
   with no publication. Under the new mechanism, that produces a job with
   no observable outcome on the live head — breaking the merge gate the
   same way as the primary bug.
5. **The data-model decisions in the current design are preserved.**
   Configuration variables (`PROTECTED_PR_AUTHOR_LOGINS`,
   `REQUIRED_APPROVAL_COUNT`, `ENABLE_PROTECTED_APPROVAL_GATE`,
   `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`,
   `PROTECTED_APPROVAL_REVIEWERS`), qualifying-reviewer semantics,
   latest-opinionated-per-reviewer counting, strictest-wins
   intersection across shared head SHAs, draft handling,
   trigger-event set, per-PR concurrency, and the trust-boundary split
   between publisher (`pull_request_target`) and notifier
   (`pull_request_review` with zero logic + `workflow_run` chain) all
   carry over unchanged. This is a publication-mechanism change, not a
   policy change.
6. **The modified-notifier residual risk documented in Decision 5 of
   the current design is unchanged.** The shipping posture already
   accepts that a same-repository PR that edits the notifier (or adds
   another workflow with `checks: write`) can degrade the effective merge
   gate to the baseline `required_approving_review_count = 1`. The new
   publication mechanism neither aggravates nor remedies that attack
   class (see "Trust-boundary analysis" below), and the human-required
   label on this issue carries forward the same maintainer-confirmation
   obligation.
7. **The publication unit must run inside GitHub Actions. No application
   or publisher process may be run outside Actions as part of this fix.**
   Maintainer-stated constraint (PR #764 review comment on line 667 of
   this file, 2026-11-01): "Not running an application outside actions
   is a requirement at this point — we don't want to deal with other
   infrastructure until we can do it in a comprehensive way." This is a
   hard requirement, not a scoping preference: it disqualifies any
   alternative whose publication mechanism depends on a long-running
   service, a hosted webhook target, a cron-driven external worker, or
   any identity (including a dedicated GitHub App) whose check-runs
   cannot be emitted by Actions itself (Actions-emitted check-runs are
   always App 15368). A dedicated publisher GitHub App — the only
   structural fix that would eliminate the modified-notifier residual
   risk from requirement 6 — therefore remains unavailable to this
   design, independent of whether migrating adopting repos is cheap
   today. When the maintainer later authorizes external infrastructure
   as part of a comprehensive deployment-runtime story, the dedicated
   App can be adopted without breaking the context name or ruleset
   shape chosen here (the ruleset's `integration_id` is the only field
   that would need to flip, and no adopters' workflow files would need
   to change).

### Runtime evidence

Per AGENTS.md § "Reverting or replacing code with a passing live-run
history", a design that proposes to change working workflow expressions
and TypeScript activity code must cite a runtime failure. The runtime
evidence here is the body of issue #751 itself: the observed
`mergeStateStatus = BLOCKED` while the pull request checks panel shows
`protected-approval-gate` as "Expected — Waiting for status to be
reported" even though the Checks API has posted
`conclusion = success | failure` on that name against the PR head SHA.
Decision 9 item 19 of the current design doc already documents the same
observation under "Sweep on a completed-suite head" (asserted 19b: "the
merge box still shows Expected"); this design accepts that the previous
mitigation (push a new commit) is operationally untenable and replaces
the mechanism rather than documenting the limitation.

### Ambiguity resolutions

The issue text proposes a specific fix shape ("the required context is a
GitHub Actions job named `protected-approval-gate`... Review, reconcile,
backfill, and departed-SHA refresh rerun that job on that commit"). The
maintainer's follow-up explicitly flags that this is a suggestion, not a
constraint. The design evaluates three publication mechanisms (Decision
2 below) and selects the issue's proposed shape, because the alternatives
either keep the Checks-API-vs-suite-attachment root cause or require
provisioning a dedicated publisher GitHub App with a publication runtime
outside Actions, which the maintainer disallows under requirement 7
("no application run outside Actions as part of this fix"). The
dedicated-App structural fix is not merely "out of scope" per the parent
design doc; it is affirmatively disqualified for the present fix by the
no-external-runtime requirement, and remains available as a follow-up
once the maintainer authorizes external infrastructure.

Where the issue's proposed fix leaves implementation choices open — in
particular, *how* review events, scheduled sweeps, and departed-SHA
reconciliation re-run that job on the PR head commit — Decision 5 selects
the workflow-rerun API (`POST /actions/runs/{run_id}/rerun`) over
label-toggle, PR-body-edit, `check_run.rerequested`, and
`repository_dispatch` alternatives, with reasons recorded in the
Alternatives table for Decision 5.

## Decisions

### Decision 1 — The current Checks API publication cannot satisfy a required check from the GitHub Actions App when another suite exists on the SHA

**Decision.** State the structural root cause explicitly, so the proposed
fix's shape is not litigated against the symptom alone.

GitHub's `POST /repos/{owner}/{repo}/check-runs` does not accept a
`check_suite_id` parameter. When a workflow run calls `checks.create` with
`head_sha = <PR head>`, GitHub attaches the new check-run to an existing
Actions check-suite on that SHA from the same App (integration id 15368),
typically the first/oldest Actions suite started on that commit — which in
practice is a different workflow (CI, actionlint, secret-scan, etc.) that
happened to run first. The merge box's required-check evaluation looks for
a job of the required context name inside a workflow run's own check suite,
not for any check-run with that name attached to any Actions suite. The
`protected-approval-gate` check-run posted via `checks.create` is therefore
"missing from the latest run of each workflow" list in the checks panel,
and the panel adds a separate "Expected — Waiting for status to be
reported" row that gates the merge box.

In parallel, the publisher's own GitHub-emitted job check is named
`publish / check` (caller job id `publish` + called job id `check` from
the reusable workflow pattern), which does not match the required context.
Both of the existing publication units — the Checks-API-created run and
the auto-emitted job check — fail to satisfy the required check, for
different reasons.

Three paths worsen this because the publisher workflow runs with
`GITHUB_SHA = <default-branch HEAD>` under `workflow_run`, `schedule`, and
`workflow_dispatch`, so the auto-emitted job check lands on the default
branch commit and only the Checks-API run targets the PR head SHA:

- `protected-approval-gate-notify` completes and triggers the publisher via
  `workflow_run` for review events.
- `protected-approval-gate-reconcile` and `protected-approval-gate-backfill`
  invoke `protected-approval-gate-sweep-reusable.yml`.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Treat as a documentation / operator-education issue; the current mitigation (push a new commit) is adequate | The maintainer-filed issue explicitly rejects this. Observed symptom is a hard merge block, not a cosmetic warning, and the "push a commit" workaround requires human intervention on every blocked PR — undoing the gate's self-service intent. |
| Rely on the commit status rollup instead of the required-check lookup | The issue reports that the status rollup does report `SUCCESS` while `mergeStateStatus = BLOCKED`. The two signals are evaluated independently; the ruleset's required-check lookup is the authoritative one for merge decisions. Switching the gate to a commit-status-based rule (`POST /statuses/{sha}` with `required_status_checks { context }`) is addressed in Decision 2's alternatives below. |

### Decision 2 — Publish via the publisher workflow's own job check, with the job name set to the required context

**Decision.** The publisher workflow (`protected-approval-gate-publisher.yml`)
exposes a top-level job whose `name:` is literally `protected-approval-gate`.
The job's auto-emitted check-run (produced by GitHub when the job
completes under a `pull_request_target` event, regardless of exit status)
is named exactly `protected-approval-gate`, attached to the publisher's own
Actions check suite, and bound to the PR head SHA (because
`pull_request_target` associates the workflow run's checks with the PR
head commit). This is the single publication unit the ruleset's required
check consumes. No `checks.create` call participates in the enforcing
publication path.

The current publisher workflow is a thin caller stub that invokes
`protected-approval-gate-reusable.yml` with a single job id `publish`,
and the reusable's single job id is `check`. GitHub's check-name
construction for reusable workflow calls is
`<caller-job-id> / <callee-job-id>`, producing `publish / check`. There is
no `name:` override that eliminates the slash for a reusable call. The
publisher therefore cannot stay a reusable-workflow call under this
design — the publisher workflow inlines the step list (helper-checkout
bootstrap, optional allowlist-resolver token mint, composite-action
invocation) in a single top-level job.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Keep the Checks API publication; force the created run to attach to the publisher workflow's own suite | `POST /repos/{owner}/{repo}/check-runs` has no `check_suite_id` parameter and no documented workaround. Attempting to control attachment order (e.g. by delaying the publisher until all other suites complete) is fragile and does not help the primary failure mode: when CI's Actions suite completes first, the publisher's Checks API run attaches to CI's suite and the merge box ignores it. |
| Keep the Checks API; name the publisher's own job to match | Was tried implicitly by the current design's "job pass/fail for debuggability" path (Decision 6 of the current doc). The reusable-workflow structure prevents the auto-emitted name from being just `protected-approval-gate`. Collapsing to a single top-level job is a prerequisite for *any* fix that uses the auto-emitted name, so the choice is between (a) inline-top-level-job + auto-emitted check (this decision) or (b) inline-top-level-job + Checks API (keeps the suite-attachment root cause for cross-workflow suites and across the non-`pull_request_target` paths — see below). |
| Switch to commit statuses (`POST /statuses/{sha}` with ruleset `required_check { context }`) | Decision 6 of the current design doc rejected this for new integrations. Reconsidering under this design: commit statuses are directly keyed by `(repository, sha, context)` with no check-suite indirection, and they would in principle fix the suite-attachment problem for the paths where the publisher's workflow run SHA is the default branch (`workflow_run`, `schedule`). But commit statuses do not integrate with the Checks tab UI (one-line summary only, no rich output panel for the per-PR qualifying-approval tally), and the ruleset still binds `integration_id = 15368` for the status's source, so the attack surface is identical to the auto-emitted-job-check approach. The auto-emitted-job-check approach matches the ruleset UI's native primitive and keeps the diagnostic affordance the current design built into the Checks API `output.summary` field. Also, the issue text itself explicitly proposes the job-check direction and the maintainer called out "consider alternatives", which this table does — commit statuses are not clearly better than job checks, and are strictly worse for operator-visible debuggability. |
| Provision a dedicated publisher GitHub App and bind the ruleset to that App's integration id | Disqualified by requirement 7 (no application run outside Actions as part of this fix). The maintainer's PR #764 review explicitly asked whether a dedicated App would be the better long-term fix given the small adopter count today, and in the same review clarified that "not running an application outside actions is a requirement at this point — we don't want to deal with other infrastructure until we can do it in a comprehensive way." Actions-emitted check-runs are always App 15368; a dedicated-App publication path therefore necessarily runs its publication unit outside Actions (hosted webhook target, cron-driven external worker, or similar), which is affirmatively excluded. The present design does not foreclose the dedicated-App path: the ruleset's `integration_id` is the only field that would flip, and the context name and workflow shape chosen here allow adopters to migrate without a coordinated breaking change once the maintainer authorizes external infrastructure as part of a comprehensive deployment-runtime story. |
| Rename the required context and leave the publication mechanism alone | Does not address the structural problem (any Checks-API publication under the GitHub Actions App ID has the same suite-attachment behavior). Reversing the symptom by renaming would also require a coordinated ruleset flip, which has its own operational cost. |

### Decision 3 — The job's exit code is the published conclusion

**Decision.** Non-zero exit from the `protected-approval-gate` job
produces an auto-emitted check-run with `conclusion = failure`. Zero exit
produces `conclusion = success`. The activity's existing
`evaluateApprovals` → `ApprovalResult { conclusion }` logic is preserved;
the final step of the composite action maps `conclusion = failure` to
`process.exitCode = 1` (or an explicit `core.setFailed(summary)`) and
`conclusion = success` to `process.exitCode = 0`. The activity continues
to emit human-readable diagnostics via `core.notice` / `core.error` and
`core.summary` so the per-PR qualifying-approval tally is visible on the
job log and in the step summary — these cover the operator-debuggability
affordance that the Checks API `output.summary` field provided.

Currently, the activity writes `conclusion: failure` via
`checks.create` while the process still exits 0 (observable in the
code: `run().catch(core.setFailed)` only triggers on *thrown* errors;
`publishFailure` is called synchronously for every evaluation path but
does not re-throw unless the Checks API itself fails). Under the new
mechanism the job's exit code **is** the published conclusion, so
`failure` must mean `exit 1`.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Keep writing to the Checks API in addition to exiting with the conclusion code | The extra `checks.create` call creates a redundant check-run attached to someone else's suite (same root cause as Decision 1). It would appear in the Checks tab alongside the authoritative one and confuse operators. The composite action does not need redundant publication: the activity's step log and the step summary cover diagnostic needs. |
| Signal `conclusion = failure` via GitHub step annotations only (`::error::`), without exiting non-zero | Step annotations do not affect the job's conclusion. The required check would always pass. |
| Signal via a workflow-level `continue-on-error: true` + a downstream reporter job | Over-engineered for a single publication step. The composite action is already in a single job; exit-code semantics are the simplest and clearest contract. |

### Decision 4 — OFF-mode preview is a sibling job with display name `protected-approval-gate (preview)`

**Decision.** The publisher workflow declares **two** sibling jobs on the
same event triggers:

- **`protected-approval-gate`** — `name: protected-approval-gate`,
  `if: vars.ENABLE_PROTECTED_APPROVAL_GATE == 'true' && github.event.pull_request.draft == false`.
  Runs only when the gate is enabled (and the PR is not draft, per the
  Decision 5 draft-handling contract of the current design doc). Produces
  the enforcing check-run via its exit code.
- **`protected-approval-gate-preview`** — `name: protected-approval-gate (preview)`,
  `if: vars.ENABLE_PROTECTED_APPROVAL_GATE != 'true' && github.event.pull_request.draft == false`.
  Runs only when the gate is disabled. Produces the preview check-run via
  its exit code with identical evaluation logic (so operators can see what
  the gate would conclude if enabled).

Both jobs share the same per-PR concurrency group (so OFF→ON flips do not
race against each other on the same PR) and both invoke the same composite
action with the only difference being the `enabled` input. GitHub emits
one auto-check per executed job per workflow run; because the two jobs
are mutually exclusive by `if:`, exactly one check per publisher run bears
one of the two context names.

Preserves Decision 7 of the current design (OFF-mode never publishes the
enforcing context; the preview context is a diagnostic that never affects
merges). Also preserves Decision 9 item 6 ("OFF → ON on an unchanged open
PR"): the enforcing-context job did not run during the OFF interval, so
there is no stale `success` check-run of that name on the SHA — the
backfill (Decision 6 below) triggers a run that executes the enforcing
job for the first time.

Draft handling is preserved: both jobs skip drafts, and the
`pull_request_target: ready_for_review` trigger (already in the current
design) guarantees a publication on the live head when the PR becomes
ready.

The preview context name retains its space-and-parenthesis form
(`protected-approval-gate (preview)`); job `name:` values support
arbitrary strings including spaces and punctuation.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| One job with branching logic that publishes the preview via a separate Checks API call | Reintroduces the Checks API publication path for the preview, with the same suite-attachment behavior. The preview is not required by the ruleset so the suite attachment does not affect merges, but keeping two publication mechanisms in the activity is harder to reason about and splits the test matrix. Separate jobs keep each publication unit homogeneous. |
| Drop the preview context entirely | The preview is a maintainer-visible dry-run signal (added in Decision 7 of the current design to let operators see what the gate would do before enabling it) and its removal would be a user-facing regression. The task breakdown here treats preview as a first-class citizen. |
| Encode the preview in a separate workflow | More workflow files, more cross-file state to reason about, no benefit — the preview and enforcing paths share the activity exactly. |

### Decision 5 — Review events trigger the publisher via `POST /actions/runs/{run_id}/rerun`

**Decision.** For each `pull_request_review` event, trigger a rerun of
the latest `pull_request_target` publisher run for the affected PR. The
rerun re-executes the publisher workflow using the original event
context (same event payload, same PR head SHA, same base branch
workflow YAML and composite-action pin), and the resulting job check
is auto-emitted on the PR head SHA as a new check-run named
`protected-approval-gate` (or `-preview`) in the publisher's own suite.

The dispatcher is a new trusted workflow that mirrors the current
notifier → `workflow_run` → publisher chain, but instead of publishing
a check-run itself, it:

1. Reads `github.event.workflow_run.pull_requests[0].number` (same shape
   as `agent-fix-checks.yml`; applies the same `!= null` guard for
   fork-headed PRs where `pull_requests` is empty).
2. Finds the latest `pull_request_target` publisher workflow run for that
   PR via `GET /repos/{owner}/{repo}/actions/workflows/protected-approval-gate-publisher.yml/runs?event=pull_request_target&...` filtered to
   `pull_requests[].number == <PR number>` and sorted by `created_at`
   descending.
3. Calls `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` on that
   run id.

The dispatcher runs with `permissions: { contents: read, actions: write, pull-requests: read }`
(the latter two under `workflow_run`'s write-capable token on
same-repo + fork events; `contents: read` for the helper checkout the
TypeScript activity may need). It uses the same `helpers-ref` =
`github.sha` pin as the current publisher (because `workflow_run`'s
`github.sha` is the default-branch HEAD per the current design's
"Trusted helper-ref contract" subsection — unchanged).

**For PRs with no prior `pull_request_target` publisher run**, the
rerun has no run to target. This case is bounded:

- **New PRs just opened**: `pull_request_target: opened` fires
  immediately on PR creation; the dispatcher never sees a review event
  before that run exists. The `opened` run is the first publisher run,
  and all subsequent dispatcher reruns can target it.
- **Pre-existing PRs when the publisher workflow is first deployed**:
  no prior `pull_request_target` run exists. Operational mitigation:
  the operator pushes any no-op commit to the PR branch, which fires
  `pull_request_target: synchronize` and creates a run the dispatcher
  can thereafter rerun. The backfill workflow (Decision 6) documents
  this in its summary when it skips a PR with no prior run. Note: an
  OFF→ON flip is **not** this case — an OFF-mode preview run is a
  qualifying `pull_request_target` publisher run; the backfill reruns
  it, and the rerun executes the enforcing job because
  `ENABLE_PROTECTED_APPROVAL_GATE` is now `true`.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Have the dispatcher publish a check-run via `checks.create` on the PR head SHA | Keeps the Decision 1 root cause. The dispatcher runs under `workflow_run`/`schedule` whose `GITHUB_SHA` is the default branch; its auto-emitted job check lands on the default branch commit, and any `checks.create` targeting the PR head SHA attaches to someone else's suite. The point of this design is to never publish the enforcing context from a workflow run whose SHA is the default branch. |
| Have the publisher itself subscribe to `pull_request_review` directly (no notifier, no dispatcher) | `pull_request_review` loads the workflow YAML and composite-action code from the PR head commit. A same-repository PR could then edit the publisher to publish unconditional `success`. Breaks the trust boundary explicitly defined in Decision 5 of the current design doc. The notifier + `workflow_run` chain exists precisely to run the trusted base-branch publisher under a trusted event, which the rerun pattern preserves. |
| Toggle a label on the PR (apply + remove) to trigger `pull_request_target: labeled` | Workable fallback for the "no prior run" case but noisy as the primary mechanism: every review would churn a label change visible to anyone subscribed to the PR. Also requires adding `labeled` to the publisher's trigger set and reasoning about label races. Rerun API is cleaner. |
| Edit the PR body with a hidden-marker no-op change | Fires `pull_request_target: edited`, which triggers the publisher. But concurrent body edits (e.g. by the developer agent's `respond-review` flow) race with the dispatcher's marker insertion, and the body is a user-visible surface — markers can be noticed, misinterpreted, or accidentally stripped by cleanup rules. Also fragile against the body-edit normalization GitHub performs. |
| Subscribe the publisher to `check_run: rerequested` and call `POST /check-runs/{id}/rerequest` from the dispatcher | `check_run` events load the workflow YAML from the SHA of the check-run's commit (PR head). Same trust problem as `pull_request_review` direct. |
| Use `repository_dispatch` with the PR head SHA as a client payload | `repository_dispatch` runs with `GITHUB_SHA` = default branch, so the auto-emitted check lands on the wrong commit. The whole point is to execute under a `pull_request_target` run so the check attaches to the PR head commit. |
| Dispatch a new `pull_request_target: opened`-shaped synthetic event | GitHub exposes no API for workflow owners to synthesize `pull_request_target` events. The closest is `pulls.update` to fire `pull_request_target: edited`, which is the same critique as "edit the PR body" above. |

**Staleness consideration — rerun uses the original event's base-branch
YAML and `helpers-ref`.** `POST /actions/runs/{run_id}/rerun` re-executes
the targeted run with the SAME workflow YAML the original run executed
(the base-branch commit at the time of the original event). If the
publisher workflow or the composite action has changed since that
commit, the rerun uses the older version. In practice:

- The data-model inputs (variables, config) are re-read at run time, so
  policy changes (e.g. `REQUIRED_APPROVAL_COUNT` bump) take effect on
  the rerun regardless of YAML age.
- Code changes (activity bug fixes) land via code and are picked up on
  the next *natural* `pull_request_target` event (synchronize, edited,
  ready_for_review, closed). Operators who urgently want to re-execute
  a specific PR against a new activity version can push a no-op commit
  to the PR branch; the fresh `synchronize` run uses the current
  base-branch YAML and helpers-ref, and from then on reruns target that
  fresh run.

This staleness window is bounded by one `synchronize` on each affected
PR, which lands naturally during normal development. The design accepts
it as a trade-off for the alternative (triggering a fresh workflow run
via label toggling or PR-body editing, both of which introduce noise or
races that are worse than one-off stale-YAML reruns).

### Decision 6 — Scheduled reconcile and manual backfill use the same rerun mechanism

**Decision.** `protected-approval-gate-reconcile.yml` (scheduled sweep) and
`protected-approval-gate-backfill.yml` (`workflow_dispatch`-only one-shot)
both invoke a shared reusable sweep workflow that:

1. Enumerates all open PRs via `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100` (paginated).
2. For each PR, finds the latest `pull_request_target` publisher run
   (same lookup as the dispatcher in Decision 5).
3. Calls `POST /actions/runs/{run_id}/rerun` on each one.
4. Logs and skips PRs with no prior run (operator intervention required —
   push a no-op commit). The sweep's step summary lists skipped PRs with
   the exact `gh` command to generate a run.

**Staleness inherited from Decision 5.** The sweep's reruns re-execute the
targeted run with the SAME workflow YAML and `helpers-ref` the original
run used (base-branch commit at the time of the original event). This
means the sweep recovers PRs stuck for reasons that re-executing the
old code can fix — a dropped notifier→dispatcher chain, a transient
rerun-API failure in Decision 7's departed-SHA sibling step, pending-run
replacement that discarded a sibling-rerun step, or policy-input changes
(variables are re-read at run time). The sweep does **not** recover PRs
stuck because the shipped activity code or workflow YAML was buggy and
has since been fixed on the default branch — the rerun will re-execute
the old buggy version. For those cases the operator-intervention path
(push a no-op commit to the PR branch to fire
`pull_request_target: synchronize`, which creates a fresh run under the
current base-branch YAML and `helpers-ref`) is the only mechanism; the
sweep's step summary surfaces this guidance alongside the no-prior-run
skip notice so operators have one place to look.

Preserves the existing interval guard (default 10 min via
`ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`) on the scheduled
caller. The backfill caller has no interval guard (it is a manual OFF→ON
step). The sweep continues to execute at `cron: */5 * * * *` as the
baseline schedule granularity (unchanged).

Permissions tighten: the reusable no longer needs `checks: write`
(no `checks.create` call). It needs `actions: write` (for the rerun API),
`pull-requests: read` (for the open-PR listing), `contents: read` (for the
helper checkout), and `actions: read` for the interval guard's own
prior-run lookup.

**No per-SHA deduplication.** The current sweep deduplicates on
`headRefOid` because the Checks API publication unit is per-SHA. Under
the rerun model each publication unit is per-run (per-PR), and reruns on
PRs that share a SHA do not conflict (they produce separate check-runs
on the same SHA, each from a different workflow run). The strictest-wins
intersection in Decision 8a of the current design doc is preserved and
executed inside each individual publisher run via its activity's
Decision 8a logic — see Decision 7 below.

Rate note: `POST /actions/runs/{run_id}/rerun` has GitHub's standard
Actions rate limits (not the general-API 5000/hr); a repo with hundreds
of open PRs on a 10-minute cadence stays well within those limits, and
the current sweep already enumerates every open PR each interval.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Keep the current Checks-API sweep (publish per unique SHA) | Keeps Decision 1's root cause for every sweep: the sweep workflow's SHA is the default branch, so its auto-emitted job check lands there, and its Checks API call attaches to someone else's suite on each PR head. "Expected" never clears for any PR the sweep tries to help. |
| Dispatch an independent per-SHA cleanup workflow via `gh workflow run` | Was considered and rejected under the current Decision 8a Alternatives table (does not survive pending-run replacement; dispatched workflows run on default branch SHA, no PR-head attachment). The rerun model avoids both failure modes. |
| Collapse backfill and reconcile into one workflow with a `force` input | Possible refactor, but the current two-file split clearly separates the one-shot operational action (backfill) from the recurring safety net (reconcile), and both files are already thin caller stubs. Keep the split. |

### Decision 7 — Departed-SHA sibling reconciliation triggers sibling publisher reruns, not cross-PR Checks API writes

**Decision.** On `pull_request_target: synchronize` (departing SHA =
`github.event.before`) and `pull_request_target: closed` (departing SHA =
`github.event.pull_request.head.sha` at close time), the publisher
activity:

1. Computes the triggering PR's own result and emits the usual job check
   on the live head (via exit code). This half is unchanged in intent;
   the publication unit is now the auto-emitted job check instead of a
   `checks.create` call.
2. For each remaining open PR on the departing SHA (looked up via the
   paginated open-PR listing, same source as the current Decision 8a
   candidate resolution), triggers a rerun of that sibling PR's latest
   `pull_request_target` publisher run via `POST /actions/runs/{run_id}/rerun`.
3. Fails loudly (exit non-zero) if the open-PR listing fails, so the
   departed-SHA reconciliation does not silently drop siblings on an
   API error. This is the same fail-closed posture Decision 8a of the
   current design specifies.

Each sibling rerun re-executes the publisher under
`pull_request_target`, computes the Decision 8a strictest-wins
intersection across all open PRs still sharing the sibling's current
head SHA (which is the departing SHA), and emits its own job check on
that SHA. The sibling's check-run reflects the departing PR's absence
automatically because the intersection re-fetches candidates at run
time.

**Why rerun-based**: the alternative (publish via Checks API on the
departing SHA from inside the departing PR's run) is exactly the
Decision 1 failure mode — the created run attaches to someone else's
suite and the merge box ignores it. Triggering the sibling's own
publisher is the only way to get the sibling's auto-emitted job check
on the departing SHA under the sibling's publisher workflow suite.

The current design's "departed-SHA cleanup must survive pending-run
replacement" protection carries over: if the triggering PR's run is
discarded by concurrency replacement before the sibling-rerun step
executes, the scheduled reconcile sweep (Decision 6) re-triggers the
sibling's publisher within one sweep interval. Decision 6 does not need
to know about departed-SHAs; it reruns the latest publisher run for
every open PR, which produces an updated check-run on each PR's own
head SHA (= the departing SHA for the stranded sibling).

The per-PR concurrency group from Decision 8 of the current design is
preserved. The per-SHA secondary concurrency group is **removed**: the
rerun model does not share writes across PRs (each publisher run writes
only its own job check), so the per-SHA lock has nothing to serialize.
The Decision 8a strictest-wins intersection is preserved inside each
publisher run's activity, where it continues to read the full
shared-SHA candidate set and compute the per-PR conclusion so that a
protected PR with insufficient approvals correctly fails every sibling
sharing its SHA.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Keep the Checks API cross-PR write; only change the primary publication path | Fails at exactly the symptom the issue reports: the departing PR's run (on `closed` from an already-completed suite) would still try to publish on the sibling's head SHA via Checks API, and the sibling's merge box stays "Expected". The whole point is to never publish the enforcing context via Checks API. |
| Have the departing PR's publisher send a `repository_dispatch` with the sibling PR number and SHA, triggering a separate workflow that publishes on the sibling's head | `repository_dispatch` runs on default branch SHA; the triggered workflow's auto-emitted job check lands on the default branch commit, not the sibling's head. Same root cause. |
| Dispatch the sibling's publisher via `workflow_dispatch` (not rerun) | `workflow_dispatch` runs on default branch SHA, same problem. Even if the dispatched workflow calls `checks.create` on the sibling's head, we're back to Decision 1. |
| Rely only on the scheduled reconcile sweep for sibling reconciliation (no per-event rerun) | Delays unblock by up to one sweep interval (10 min by default). The current design treats inline per-event cleanup as the fast path and the sweep as the safety net; preserving the fast-path semantics keeps the time-to-unblock on close/synchronize at a few seconds in the normal case. |

### Decision 8 — Fix `evaluateSha` null-return by including the triggering PR as a fallback candidate

**Decision.** The activity change: when `listCandidates(...)` returns an
empty list, but the triggering PR is still open at the triggering head
SHA (observed via a direct `GET /repos/{owner}/{repo}/pulls/{number}`),
include the triggering PR in the candidate set and continue the
Decision 8a strictest-wins intersection with that singleton set.

The current code:

```typescript
async function evaluateSha(...): Promise<ApprovalResult | null> {
  const numbers = await listCandidates(octokit, owner, repo, headSha, excludedPr);
  if (numbers.length === 0) return null;
  // ... compute, return result
}
// ...
if (result) await publishResult(octokit, owner, repo, liveHeadSha, name, result);
```

Returns `null` → no publication → job exits 0 → under the new mechanism,
the auto-emitted job check is `conclusion = success` with no evaluation
having run. For a protected PR with 0 approvals, this is a silent
pass-through that defeats the gate.

The documented condition causing the empty list: `GET /pulls?state=open`
has not yet indexed the triggering PR at its new head SHA (a webhook /
indexer race on `synchronize`). The paginated listing is authoritative
for sibling discovery, but the triggering PR itself can be fetched by
number regardless. Including it as a fallback eliminates the race.

For the scheduled sweep and manual backfill paths, the "triggering PR"
is each enumerated open PR; the same code path applies naturally.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Retry `listCandidates` with exponential backoff | Addresses the race but adds latency to every run and still has a bounded failure case. The direct `pulls.get` on the triggering PR is a single API call and is the authoritative source for that PR's current state. |
| Make the activity fail loudly when the triggering PR is missing from the listing | Would mean every `synchronize` race fails the job (and under the new mechanism, blocks the merge). The race is a GitHub-side eventual-consistency behavior, not a configuration bug — failing loudly on every occurrence is a worse operator experience than falling back on the authoritative per-PR lookup. |
| Trust the event payload's PR number + head SHA directly, skip the open-PR listing | Loses the Decision 8a strictest-wins intersection across shared-SHA siblings — a protected PR sharing a SHA with an unapproved sibling would miss its sibling's contribution. The listing is still needed for shared-SHA discovery; the fallback only covers the case where the listing omits the triggering PR itself. |

### Decision 9 — Remove the Checks API publication path from the activity

**Decision.** `.github/scripts/src/check-protected-approval-gate.ts` no
longer calls `octokit.rest.checks.create`. The function signatures that
mention `name`, `publishResult`, and `publishFailure` are removed or
restructured. The activity's `run()` returns the computed
`ApprovalResult` (plus a departed-SHA sibling list and summary) to the
composite action, which:

- Writes the result's `summary` to `$GITHUB_STEP_SUMMARY` and to
  `core.notice` / `core.error` for log visibility.
- Exits `0` when the result's conclusion is `success` and `1` otherwise.
- For departed-SHA siblings, writes the list of rerun targets and the
  rerun API call results to the step summary; any API-error on rerun is
  logged with `core.warning` but does not fail the job (the scheduled
  reconcile sweep is the safety net).

Preserved: `evaluateApprovals`, `fetchReviews`, `resolveQualifyingReviewers`,
`parseConfig`, `parseReviewerEntries`, the latest-opinionated-per-reviewer
semantics, the fail-closed misconfiguration posture (parse errors still
force `conclusion = failure` → job exits 1 → required check fails), the
Decision 8a strictest-wins intersection, and all unit tests (updated to
assert exit code and summary content rather than `createCheck` call
arguments).

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Keep `checks.create` as a diagnostic second-publication (idempotent, same context name) | Would double-write and create confusion in the Checks tab (two check-runs with the same name on the same SHA, one authoritative-via-job-check and one API-created-in-wrong-suite). Operators seeing two rows would legitimately question which is enforcing. Drop it. |
| Keep `checks.create` only for the preview context | The preview context has the same spin-off benefit from being auto-emitted (via Decision 4's sibling job): one publication mechanism, one code path, one testing surface. |

### Decision 10 — External adopter contract: copy the publisher workflow, keep sweep as reusable

**Decision.** External adopters who consume this repo's workflows via
`uses: mfrancza/agentic-development-workflow/...@ref` now have two
patterns:

- **Publisher**: copy `protected-approval-gate-publisher.yml` into their
  own `.github/workflows/`. The file references composite actions in
  this repo via `uses: owner/repo/.github/actions/<name>@<ref>` using
  the standard `helpers-ref` bootstrap, so logic changes still flow in
  via the pin. Adopters pin the workflow file at the version they want.
  The reasons they cannot invoke a reusable workflow (as currently):
  reusable-workflow call sites produce check names of the form
  `<caller-job-id> / <callee-job-id>`, which does not match the required
  context `protected-approval-gate`.
- **Dispatcher + reconcile + backfill**: these remain reusable
  workflows invoked by thin caller stubs, because none of their jobs
  produce a check-run that satisfies the required context (they only
  trigger reruns). Adopters' caller stubs follow the same pattern as
  the existing `agent-review.yml` etc.
- **Notifier**: unchanged. Adopters copy the (empty) notifier workflow
  file.

Updated: `docs/adopting.md` adds a section explaining the publisher
copy requirement, with a diff-template adopters can apply. The
Terraform-managed Actions variables (`PROTECTED_PR_AUTHOR_LOGINS`,
`REQUIRED_APPROVAL_COUNT`, `ENABLE_PROTECTED_APPROVAL_GATE`,
`PROTECTED_APPROVAL_REVIEWERS`,
`ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`) are unchanged.
Ruleset wiring is unchanged. The `enable_protected_approval_gate_check_integration_id`
default (15368) is unchanged.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Keep the publisher as a reusable and have adopters accept `<caller-job>/<callee-job>` in their required-check name | Reintroduces the slash-in-the-name problem. Adopters would have to maintain the slash in their ruleset, which is confusing and fragile — and this repo's own ruleset would still want the no-slash name, so the two configurations diverge. |
| Package the publisher logic as a composite action adopters invoke from their own thin workflow | Essentially what the composite action already is (`check-protected-approval-gate`). The copy-the-workflow guidance just makes the trigger set and job name explicit for adopters — no new abstraction. |

### Decision 11 — Trust-boundary analysis is unchanged in substance but shifts in mechanism

**Decision.** Decision 5's "Modified-notifier residual risk and
defence-in-depth" subsection carries forward verbatim. The attack
surface under the new design:

- A same-repository PR can still edit the notifier (loaded from the PR
  head commit under `pull_request_review`) to escalate `permissions:`
  and perform arbitrary API calls under the GitHub Actions App token.
- Under the old design, the attack produced a spoofed `checks.create`
  of `conclusion: success` under the enforcing context name. The merge
  box's "ignore Checks API runs that are missing from the latest run
  of each workflow" behavior may or may not reject that spoofed run —
  the current Decision 9 item 3 of `protected-approval-gate.md`
  documents the honest effective-merge-gate degradation to one approval
  under the attack, which is the shipping posture's floor.
- Under the new design, the equivalent attack can either (a) attempt
  the same `checks.create` POST (which the current issue shows is
  ignored by the merge box) or (b) emit a job named
  `protected-approval-gate` from the modified notifier itself (since
  `pull_request_review` jobs attach to the PR head SHA under App 15368).
  Option (b) is new in form but equivalent in effect to the existing
  attack surface — a `pull_request_review`-triggered modified workflow
  can already produce arbitrary auto-emitted job checks. The ruleset's
  `integration_id = 15368` pin and the baseline
  `required_approving_review_count = 1` are the only enforced controls,
  and both carry over unchanged.

The honest effective-merge-gate statement from Decision 5 is unchanged:
with one write-access human approval, the modified-notifier attack can
degrade the gate to the baseline; with zero approvals, the baseline
rule still blocks. The maintainer-confirmation obligation on this issue
carries forward; the `human-required` label on this issue is the
vehicle for that confirmation on the current PR, and the one applied to
#751 is explicitly inherited into this design PR.

The dedicated-publisher-App structural fix (Decision 5 "A stronger
posture is possible but out of scope") remains unavailable under this
design — it is disqualified by requirement 7 (no application run
outside Actions as part of this fix), not merely scoped out — and
remains available as a follow-up once the maintainer authorizes
external infrastructure as part of a comprehensive deployment-runtime
story. The context name and ruleset shape are preserved under this
design so that migration — when later authorized — requires only a
ruleset `integration_id` flip and no changes to adopters' workflow
files.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Use this redesign as the opportunity to adopt the dedicated-publisher-App structural fix | Disqualified by requirement 7 (no application run outside Actions as part of this fix). The maintainer stated on PR #764 review (2026-11-01): "Not running an application outside actions is a requirement at this point — we don't want to deal with other infrastructure until we can do it in a comprehensive way." A dedicated App necessarily runs its publication unit outside Actions, because Actions-emitted check-runs are always App 15368. The maintainer's companion comment on Decision 2's dedicated-App row ("Would a dedicated app be a generally superior solution? There aren't that many adopting repos yet, so let's fix this the optimal way for the long term") asked whether the dedicated App should be the long-term optimal fix adopted now; requirement 7 answers that question: not until the comprehensive deployment-runtime story is in place. The present design preserves the context name and workflow shape so that migration to a dedicated App — if later authorized — requires only a ruleset `integration_id` flip. |
| Narrow the publisher's trigger set to reduce the attack surface (e.g. no `pull_request_target: edited`) | Does not change the attack surface — the modified-notifier attack runs through the untrusted notifier, not the trusted publisher. Narrowing the publisher's triggers would regress functionality (edited catches title/body/base changes that correlate with policy inputs) without security benefit. |

### Decision 12 — Acceptance test contract (updated from Decision 9 of the parent design)

The implementer lands the following tests. Items marked **new** are
specific to the publication-mechanism change; others carry forward from
Decision 9 of `protected-approval-gate.md` with their assertion mode
updated to inspect the ruleset `mergeStateStatus` and `gh pr checks`
rather than the Checks API call arguments.

1. **(new) Merge box clears on success.** With the gate enabled and a
   developer-agent PR reaching the configured approval count on its
   live head SHA, `mergeStateStatus` transitions from `BLOCKED` to
   `CLEAN` (or `HAS_HOOKS`) with no additional operator action — no
   push, no close+reopen. Verify via GraphQL
   `pullRequest { mergeStateStatus }` immediately after the final
   qualifying approval is submitted.
2. **(new) Merge box stays blocked on failure.** Under the same setup
   but with one less than the configured approval count,
   `mergeStateStatus` stays `BLOCKED` indefinitely. Verify the
   `protected-approval-gate` check-run under the publisher's suite has
   `conclusion: failure`.
3. **(new) `evaluateSha` fallback.** Simulate (via mock or recorded
   trace) a `synchronize` event where `pulls.list?state=open` omits
   the triggering PR at the new head SHA. The job must still publish a
   conclusion matching the triggering PR's actual approval state (not
   `success` by default and not an empty exit).
4. **(new) Exit code reflects conclusion.** Unit test the composite
   action's exit code for both `success` and `failure` conclusions.
5. **(new) Review-event rerun.** With a developer-agent PR that failed
   its initial `pull_request_target: opened` publisher run (0
   approvals), submit two qualifying approvals. The notifier fires,
   the dispatcher reruns the publisher's latest `pull_request_target`
   run, and the resulting new publisher run's auto-emitted check on
   the PR head SHA is `conclusion: success`. Assert the merge box
   clears.
6. **(new) Review event on PR with only OFF-mode prior publisher runs.**
   Simulate an OFF→ON flip on a PR whose only prior publisher runs were
   from OFF mode (preview job only). The sweep and dispatcher locate
   publisher runs by `pull_request_target` event alone, so the OFF-mode
   run is a qualifying target. The dispatcher's rerun must target the
   OFF-mode run; after re-executing under
   `ENABLE_PROTECTED_APPROVAL_GATE=true`, the run executes the enforcing
   job and the enforcing check appears. Assert the merge box eventually
   clears without a no-op commit.
7. **(new) Scheduled sweep rerun — safety net for a dropped per-event
   rerun.** Simulate the Decision 7 departed-SHA sibling-rerun step
   emitting a `core.warning` (per Decision 9) because its
   `POST /actions/runs/{run_id}/rerun` call failed transiently; the
   sibling PR therefore has a stale check-run that still reflects the
   pre-close shared-SHA candidate set. Let the scheduled reconcile
   sweep run. Assert the sweep triggers a rerun of the sibling PR's
   latest `pull_request_target` publisher run and the resulting
   check-run on the sibling's head SHA reflects the current open-PR
   intersection (not the pre-close set). **This acceptance contract
   explicitly excludes shipped activity/workflow bug fixes**:
   per Decision 5's "Staleness consideration" subsection and Decision 6's
   "Staleness inherited from Decision 5" subsection, reruns re-execute
   the original run's base-branch YAML and `helpers-ref`, so code
   fixes landed on the default branch do not propagate through sweep
   reruns. Also assert that for a PR stuck because of a shipped
   activity bug fix, the sweep's step summary surfaces the documented
   operator-intervention path (push a no-op commit to fire
   `pull_request_target: synchronize`), and that performing that no-op
   push produces a fresh run under the current base-branch YAML and
   helpers-ref whose auto-emitted check clears the merge box.
8. **(new) Backfill run.** Dispatch the backfill workflow after an
   OFF→ON flip. Assert every open PR either gets a rerun that
   produces an enforcing check (if a prior `pull_request_target` run
   exists) or a logged skip (if not).
9. **(new) Departed-SHA sibling rerun.** Open two PRs on shared head
   SHA H1 (developer-agent + human). Close the dev-agent PR. Assert
   the human PR's publisher is rerun (via the activity's departed-SHA
   step), its check on H1 becomes `success`, and the human PR's merge
   box clears without any activity on the human PR's branch.
10. **(carry) Fork-authored PR publication succeeds.** The
    `pull_request_target` write-capable token on fork PRs is unchanged;
    the publisher's auto-emitted check appears on the fork PR's head
    SHA with the correct conclusion.
11. **(carry) Trust-anchor test (same-repo modified notifier).** The
    specific assertions of Decision 9 item 3 of the parent design carry
    forward with mechanism updates: the authoritative publisher
    publishes the correct per-check conclusion (unchanged); the
    effective-merge-gate degradation under the attack is one approval
    (unchanged). Verify under the new mechanism that the attacker's
    spoofed `checks.create` is still irrelevant to the merge box (new
    affordance) and that the attacker's option to emit a modified-job
    `protected-approval-gate` check via the untrusted notifier is still
    bounded by `required_approving_review_count = 1`.
12. **(carry) Shared head SHA — strictest wins.** Decision 9 items
    10–12 of the parent design, re-asserted against auto-emitted job
    checks instead of Checks API runs.
13. **(carry) Standard counting cases.** Decision 9 item 18 of the
    parent design — unchanged, as the counting logic is unchanged.
14. **(carry) Draft → ready-for-review with unchanged head.**
    Decision 9 item 13 of the parent design — unchanged, as the
    draft-handling and `ready_for_review` trigger carry over.
15. **(new) Preview context behavior.** With the gate OFF, open a
    developer-agent PR and submit two approvals. Assert the
    `protected-approval-gate (preview)` check-run on the PR head SHA
    is `success`, and `protected-approval-gate` does not appear on
    the SHA. Flip the gate ON (and run backfill); assert
    `protected-approval-gate (preview)` disappears and
    `protected-approval-gate` with `conclusion: success` appears.

## Out of scope

- **Adopting the dedicated publisher GitHub App** (Decision 5 stronger
  posture). Available as a future-hardening path; this fix is
  structurally compatible with it (same context name, same ruleset
  pin). The present PR does not establish the App or rotate secrets.
- **Changing the `main-protection` ruleset shape, context name, or
  `integration_id` default.** `protected-approval-gate` + `15368`
  persist through this change; no Terraform re-apply is required.
- **Replacing the notifier with a stronger trust anchor.** The empty
  notifier + `workflow_run` chain is unchanged; the dispatcher takes
  the publisher's old `workflow_run` slot and the publisher's own
  `workflow_run` leg is removed.
- **Changing the configuration variables, their defaults, or their
  validation.** Preserved verbatim.
- **Reworking the counting logic, qualifying-reviewer semantics,
  self-review exclusion, or the Decision 8a strictest-wins
  intersection.** All preserved.
- **Changing draft handling, the `pull_request_target` trigger set
  on the publisher, or the `pull_request_review` trigger set on the
  notifier.** Preserved verbatim.
- **Addressing merge queue (`merge_group`) support.** Still out of
  scope per the parent design.
- **CODEOWNERS integration, team-based required reviewers, or
  path-scoped approval thresholds.** Still out of scope per the
  parent design.
- **Collapsing backfill + reconcile into a single workflow.** The
  two-file split (one `workflow_dispatch`-only, one `schedule` +
  `workflow_dispatch`) is retained for operator clarity.

## Interactions with existing design decisions

- **Parent design doc (`docs/design/protected-approval-gate.md`)** —
  Decisions 1 (required check mechanism), 2 (configuration variables),
  3 (conditional ruleset wiring), 4 (qualifying-reviewer semantics),
  5 (trigger events and trust model, except the Checks API publication
  references), 7 (OFF/preview mode state machine, with the
  publication-unit substitutions above), 8 (per-PR serialization), 8a
  (strictest-wins intersection), and 10 (documentation surfaces) all
  survive this design. Decision 6 (Checks API publication) is
  replaced. Decision 9 (acceptance test contract) is updated per
  Decision 12 above.
- **AGENTS.md § "Branch-protection immutability"** — the pointer to
  the parent design doc stays; add a cross-reference to this doc so
  reviewers see both. No change to the "lowering
  `enable_protected_approval_gate` from `true` to `false` must be
  justified" rule.
- **AGENTS.md § "Keeping Documentation Current"** — list the
  publisher file and the dispatcher file in the Repository Layout
  section (the dispatcher is new; the publisher is already listed and
  stays listed with its restructured role).
- **`docs/adopting.md`** — add the publisher-copy requirement
  described in Decision 10.
- **`terraform/modules/branch-protection/README.md`** — update the
  "backfill after every re-enable" subsection to reference the new
  rerun-based backfill, and note that the "push a new commit to clear
  Expected" caveat from the current doc is retired (the fix is now
  structural).
- **`terraform/modules/agent-vars/README.md`** — unchanged (variables
  carry over).
- **No Terraform resource change is required.** The ruleset
  (`context = "protected-approval-gate"`, `integration_id = 15368`),
  the Actions variables, and the labels are all unchanged. The design
  does not require `terraform apply` to deploy.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| [#759](https://github.com/mfrancza/agentic-development-workflow/issues/759) | TypeScript activity + composite action update: remove the Checks API publication path (Decision 9); make the composite action exit non-zero on `conclusion = failure` (Decision 3); fix the `evaluateSha` null-return by falling back on the triggering PR when the open-PR listing omits it (Decision 8); write the per-PR tally, departed-SHA sibling list, and rerun API outcomes to `$GITHUB_STEP_SUMMARY`. Add a helper (in `.github/scripts/src/lib/`) that given a PR number locates the latest `pull_request_target` publisher workflow run and calls `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`, used by both the publisher activity (for departed-SHA sibling reruns, Decision 7) and the new dispatcher (Decisions 5 and 6). Update unit tests to assert exit code and summary content instead of `createCheck` call arguments. | — |
| [#760](https://github.com/mfrancza/agentic-development-workflow/issues/760) | Publisher workflow restructure: inline `protected-approval-gate-publisher.yml` to a single top-level job named `protected-approval-gate` and a sibling top-level job named `protected-approval-gate (preview)` (Decisions 2 and 4). Both jobs include the helper-checkout bootstrap, optional allowlist-resolver mint, and composite-action invocation inline (no reusable layer). Remove the `workflow_run` trigger from the publisher (moved to the new dispatcher per Decision 5). Preserve per-PR concurrency, draft `if:`, and the full `pull_request_target` trigger set from the parent design. Delete `.github/workflows/protected-approval-gate-reusable.yml`. | Issue #759 |
| [#761](https://github.com/mfrancza/agentic-development-workflow/issues/761) | New dispatcher workflow + sweep rework: add `protected-approval-gate-dispatcher.yml` (triggered by `workflow_run: protected-approval-gate-notify` completed, per Decision 5) that uses the shared rerun helper from issue #759 to re-run the latest `pull_request_target` publisher run for the affected PR. Rework `protected-approval-gate-reconcile.yml` and `protected-approval-gate-backfill.yml` to use a shared sweep reusable (`protected-approval-gate-sweep-reusable.yml`) that enumerates open PRs and reruns each one's latest publisher run (Decision 6), replacing the current per-SHA Checks API publication. Remove the per-SHA concurrency group and the `checks: write` permission from the sweep reusable; add `actions: write`. Preserve the interval guard and the fail-closed listing posture. | Issue #759 |
| [#762](https://github.com/mfrancza/agentic-development-workflow/issues/762) | Documentation: update `docs/design/protected-approval-gate.md` (replace Decision 6 and the Checks-API-centric portions of Decisions 7, 8, 8a, and 9 with cross-references to this document); update `AGENTS.md` (Repository Layout for the new dispatcher file; branch-protection cross-reference); update `docs/adopting.md` (publisher copy requirement from Decision 10; retire the "push a new commit to clear Expected" caveat); update `terraform/modules/branch-protection/README.md` (same caveat retirement; rerun-based backfill wording). Does not touch Terraform code — the ruleset, variables, and labels are unchanged. | Issue #760, Issue #761 |
| [#763](https://github.com/mfrancza/agentic-development-workflow/issues/763) | End-to-end validation on a scratch PR: execute the Decision 12 acceptance tests on the live repository with the gate enabled. Specifically assert `mergeStateStatus` clears to `CLEAN`/`HAS_HOOKS` after qualifying approvals land under each code path (`pull_request_target: opened`, review-event rerun, scheduled reconcile rerun, departed-SHA sibling rerun). Verify the fork-PR path (write-capable token on `pull_request_target`), the preview-context behavior under OFF→ON, and the modified-notifier residual-risk floor (one-approval degradation under attack). | Issue #759, Issue #760, Issue #761, Issue #762 |

Dependencies are recorded natively as GitHub blocked-by relationships on
the sub-issues.
