# Design: Fix-checks on opted-in failing PR checks

**Issue:** [#627](https://github.com/mfrancza/agentic-development-workflow/issues/627)

## Summary

Expand `agent-fix-checks.yml`'s trigger from `workflow_run` on a single
same-repo workflow (`CI`) to a **hybrid** of `workflow_run` (for every
same-repo workflow operators enumerate) **and** `check_run.completed`
(for cross-repo workflow checks delivered via org rulesets and for
third-party checks), backed by a **scheduled polling backstop**
(`agent-fix-checks-poll.yml`) that guarantees coverage for any origin
where `check_run` events are suppressed by GitHub's recursion guard, so
the developer agent reacts to every explicitly selected failing check
reported against an agent-authored PR. Both event triggers are required because the
`check_run` recursion guard prevents `check_run` events from firing for
check suites created by GitHub Actions in the same repository — a
`check_run`-only trigger would silently lose the existing same-repo CI
failure path. The polling backstop is required because the recursion
guard's cross-repository and head-SHA clauses are not explicitly
exempted in the docs: cross-repo (org-ruleset) Actions origins and
third-party checks on an Actions-associated SHA may also be suppressed,
and a time-based backstop is the only delivery-independent fallback.
Introduce a repo-wide `FIX_CHECKS_ALLOW` Actions variable (JSON array
of check names, default `[]`) that the caller stub consults on the
`check_run` branch of the trigger (and the polling backstop consults on
every PR). An empty list disables fix handling until an operator
explicitly opts a displayed check name in; the `workflow_run.workflows`
list remains the separate delivery subscription for same-repository Actions.
Preserve the existing agent-authored trust gate; dedupe per PR via (a) a two-job
stub whose reusable-call job uses `needs.resolve-pr.outputs.pr_number`
as the concurrency key — the same group used by the polling backstop so
event-driven and polled invocations do not run in parallel — plus (b) an
in-container freshness guard added to `action_fix_checks()` that
short-circuits queued runs whose work is already done or whose HEAD has
pending replacement checks.

## Requirements (from Issue #627 and grooming Q&A)

The reusable workflow and the caller stub today only fire when a workflow
named `CI` in the same repository completes with `conclusion == 'failure'`
(`.github/workflows/agent-fix-checks.yml`, `workflows: ["CI"]`). The
grooming notes confirm the architectural implications: `workflow_run` is
scoped to workflows defined in the same repository, so expanding
`workflows:` cannot cover (a) same-repo workflows the operator may add in
the future without editing this file, (b) failing checks reported by
workflows defined in another repository via an organization ruleset, or
(c) third-party check providers.

Restated requirements, in the design's own words:

1. **Trigger covers every opted-in failing check on an agent-authored PR.** Same-repo
   workflow jobs, cross-repo (org ruleset) workflow checks, and third-party
   checks must all start the agent only when their displayed check names
   appear in the caller-configured allowlist; same-repo workflows must
   additionally appear in `workflow_run.workflows` to provide their delivery
   path. The agent-authored trust gate is
   preserved: a failing check on a human PR must not start the agent.
2. **Caller-configured allowlist by check name.** The allowlist is
   names of **checks** (e.g. `"CodeQL"`, `"Lint"`), not workflow file
   names, because third-party checks have no workflow file at all. An empty
   list allows no `check_run` or polled checks. The default is empty. Callers set the list via a
   repository Actions variable without editing the reusable workflow —
   matching the `AUTO_TRIGGER_AGENTS` / `AGENT_ALLOWLIST` pattern already
   used in this repo.
3. **One PR with several failing checks produces one run (not one per
   check).** When `N` checks fail on the same PR in quick succession, the
   agent runs at most once concurrently for that PR, and the agent (which
   already fetches the full `gh pr checks` state inside the container)
   addresses every failing check in a single pass.
4. **Unlisted checks do not start a run.** A later failure of an allowed
   check does start one; pending checks are classified by the post-lock guard.
5. **The caller stub documents how to set the allowlist.** External
   consumers who reference the reusable workflow write their own thin
   caller stubs; the stub comments and the design doc are the single
   authoritative references for the variable name, format, and defaults.
6. **The fix-checks agent prompt is unchanged; `action_fix_checks()`
   grows a short freshness guard.** The container entrypoint already
   enumerates every failing check with `gh pr checks` (see
   `action_fix_checks()` in `docker/scripts/entrypoint.sh`) and the
   agent fixes whatever it finds. Decision 4c adds a short preamble to
   `action_fix_checks()` that exits 0 without invoking the agent when no
   allowed checks are failing on the current HEAD or when
   replacement checks are still pending; this is required to make
   requirement 3 ("one run per PR") hold against the race where a
   queued run inherits a stale HEAD or empty-but-already-fixed state.
   The `respond-to-checks.md` prompt is untouched and the agent's view
   of the PR is still independent of which check triggered the
   workflow.

### Clarifying resolutions

- **Which GitHub check conclusions count as "failing"?** The GitHub
  checks API documents several terminal conclusions: `success`, `failure`,
  `neutral`, `cancelled`, `timed_out`, `action_required`, `stale`,
  `skipped`. The issue says "failing check". This design treats
  `failure`, `timed_out`, and `action_required` as the actionable set —
  these are the conclusions GitHub treats as blocking a required-check
  policy. `cancelled`, `skipped`, `stale`, and `neutral` are not failures
  and must not start the agent.
- **Which check names does the allowlist match against?** The
  `check_run` event payload's `check_run.name` field. For a (cross-repo
  or third-party) GitHub Actions-authored job this is the job name as
  displayed in the PR check list (not the workflow file name, and not
  the workflow `name:` key). Document this explicitly in the stub
  comment so operators look at the PR's "Checks" tab rather than at
  `.github/workflows/*.yml` to find the right string. The allowlist is
  applied again by the post-lock guard to every delivery path; same-repo
  Actions also need their workflow in the stub's `workflows:` list.

## Design

### Decision 1: Trigger — hybrid `workflow_run` + `check_run.completed`

**Decision.** `agent-fix-checks.yml` subscribes to **both**
`workflow_run: [completed]` (for same-repo GitHub Actions failures, with
`workflows:` enumerating every same-repo workflow whose failures should
start fix-checks) and `check_run: [completed]` (for failing checks whose
origin is **not** same-repo GitHub Actions — i.e. workflows defined in
another repository via org rulesets, and third-party check providers).
Neither trigger is removed; each handles the delivery class the other
cannot see.

**Why the hybrid.** `check_run` is **not** a superset of `workflow_run`
for same-repo Actions. GitHub documents a recursion guard on the
`check_run` event: workflows are not triggered by `check_run` activity
whose check suite was created by GitHub Actions, nor by activity whose
head SHA is associated with GitHub Actions (see
`https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#check_run`).
In practice this means a failing job in a same-repo workflow does
**not** deliver a `check_run.completed` event that our workflow can
observe, so a `check_run`-only trigger would silently lose the existing
same-repo CI failure path. The hybrid preserves that path via
`workflow_run` (the trigger the current implementation already uses) and
adds `check_run` to extend coverage toward the origin classes that
`workflow_run` cannot see: cross-repo (org-ruleset) workflow checks and
third-party-GitHub-App checks.

**Honest statement of what the docs do and do not establish about
`check_run` delivery for the extended origins.** The cited docs page
describes the recursion guard in event-general terms ("the check suite
was created by GitHub Actions" / "its head SHA is associated with GitHub
Actions"). It does **not** state an explicit cross-repository exception.
An organization-ruleset workflow run against a PR in this repository is
still an Actions workflow run — its check suite is authored by GitHub
Actions, just in a different repository — and the guard's second clause
("head SHA associated with GitHub Actions") is sweeping enough that a
third-party check on a SHA that also runs same-repo Actions may be
suppressed as well. The design therefore treats cross-repo Actions and
third-party `check_run` delivery as an **empirical** question that must
be answered before any code lands, not an architectural certainty.
Decision 1a below specifies a scheduled-poll backstop that provides
working delivery for any origin where `check_run` events do **not** fire
for this subscription, so the design is implementable regardless of
which way the empirical answer breaks.

**Why `workflow_run` for same-repo stays.** It is the only event that
reliably fires for same-repo GitHub Actions failures. `workflows:` must
enumerate the covered workflow names (the schema requires a non-empty
list); the stub comment documents that operators must add new same-repo
workflows here as they are introduced. The allowlist applies throughout
the fix path, including the freshness guard and poller; `workflows:` is
the additional delivery subscription for same-repo Actions, not a
substitute for explicitly allowing their displayed check names.

**Why `check_run` for the other origins.** The `check_run.completed`
event fires for every check whose check suite was **not** created by
GitHub Actions, which covers third-party check providers and
cross-repository workflow checks delivered via org rulesets. The payload
includes `check_run.name` (needed for the allowlist filter),
`check_run.conclusion`, `check_run.head_sha`, and — when the check
originates from a workflow attached to a PR — `check_run.pull_requests[]`.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| `check_run` only, replacing `workflow_run` | Would silently drop same-repo Actions failures — GitHub's documented recursion guard prevents `check_run` activity whose check suite was created by GitHub Actions from triggering workflows. This was the design's prior position; the review correctly identified it as a regression against the existing passing path. |
| Keep `workflow_run` and extend `workflows:` with more names | Covers only same-repo workflows. Fundamentally cannot see org-ruleset or third-party checks (grooming note confirmed) — hence the hybrid. |
| `check_suite.completed` instead of `check_run.completed` | Fires per *suite*, not per check. Suites can group multiple checks with mixed conclusions, so the name-based allowlist cannot be applied per-check at the gate — all-or-nothing per suite is a worse fit. The agent can still fix multiple failures per run, so per-check granularity at the gate is the right level. |
| `pull_request_target` + poll for check status (as the *primary* trigger) | Adds an inherently racy polling loop and consumes workflow-minutes while waiting on every PR event. The hybrid delivery already carries the completion signal for same-repo Actions, and the scheduled polling *backstop* defined in Decision 1a is a bounded, well-defined fallback — using `pull_request_target` would collapse the event-driven and backstop paths into one lower-fidelity mechanism. |

**Impact on existing passing-run history.** `AGENTS.md` § "Reverting or
replacing code with a passing live-run history" requires runtime evidence
when replacing working code. The current `workflow_run` trigger has a
passing history for same-repo `CI` failures; the hybrid preserves that
exact delivery path for same-repo Actions and extends coverage via
`check_run` + the Decision 1a polling backstop for the origins the
current trigger demonstrably does not see. No historically-passing path
is being replaced.

### Decision 1a: Delivery backstop for suppressed origins — scheduled poll

**Decision.** Add a scheduled workflow
`.github/workflows/agent-fix-checks-poll.yml` that fires on a
`schedule:` cron (default every 15 min, overridable) and
`workflow_dispatch:` for manual triggering. The polling job lists every
**open PR authored by `mfrancza-developer-agent[bot]`** that does **not**
carry the `human-required` label (via `gh pr list --author
"mfrancza-developer-agent[bot]" --search "-label:human-required"`), calls
`gh pr checks --json name,bucket,state` for each, applies
`FIX_CHECKS_ALLOW` to the result, and — for every PR where at least one
allowed check is in a failing conclusion (`failure`, `timed_out`,
`action_required`) — invokes the same reusable workflow
(`agent-fix-checks-reusable.yml`) that the event-driven caller uses,
with the resolved PR number and the PR's current HEAD SHA passed as
`head-sha-at-trigger` so Decision 4c's guard sees HEAD-unchanged and
applies the "unrelated pending → don't wait, proceed to fix"
classification. The polling backstop does **not** veto on pending
checks; delegating pending classification to Decision 4c is required to
avoid the pending-veto bug described below. The per-PR concurrency group
from Decision 4a (`agent-fix-checks-pr-<N>`) and the entrypoint freshness
guard from Decision 4c handle deduplication between the polling backstop
and any event-driven run against the same PR; the backstop is **not** a
parallel code path for the fix itself.

**Why a backstop at all.** As Decision 1 makes explicit, the design does
not have architectural certainty that `check_run.completed` fires for
cross-repo (org-ruleset) Actions check origins, or for third-party
checks on an Actions-associated SHA. If delivery is suppressed for an
origin, event-driven coverage silently drops that origin without any
observable failure signal — the PR just sits red. A scheduled polling
backstop is a bounded, well-understood fallback that guarantees every
allowed failing check on an open agent PR reaches the fix pass
within one polling interval, independent of event delivery.

**Why `schedule:` + `workflow_dispatch`.** `schedule:` provides the
hands-off backstop. `workflow_dispatch:` provides a manual re-trigger
operators can use when they observe a red PR that the event-driven path
did not pick up (useful both for operational recovery and for the
empirical-validation exercise in Issue #659). Neither trigger subscribes
to `check_run` or `workflow_run`, so neither is affected by the
recursion guard.

**Why the backstop is safe to run even when `check_run` delivery works
fully.** The per-PR concurrency group and the Decision 4c freshness
guard already serialise and short-circuit duplicate agent passes. A
polling tick that finds nothing failing exits 0 inside the resolver /
guard without invoking the agent; a polling tick that finds a failure
the event-driven path already picked up is held at the concurrency group
and then short-circuited by the guard. Steady-state cost is therefore
one `gh pr list` + `gh pr checks` per open agent PR per polling
interval, with no agent invocations when nothing is failing.

**Why the backstop must not veto on pending checks (pending-veto bug).**
An earlier version of this decision had the backstop skip any PR with a
allowed pending check, on the premise that the next polling tick
would re-observe the same failure once the pending check reported. That
is wrong when the pending check never completes on its own — the typical
case being a third-party approval, deployment-gate, or manual-review
check that waits for human action and may remain pending indefinitely.
Under the earlier rule, a failing check A alongside an indefinitely
pending check B would veto every polling tick forever: A is never
dispatched because of B, and for the exact origins this backstop exists
to cover (where `check_run` delivery is suppressed), **the backstop is
the only automatic path to a fix**. Decision 4c's HEAD-based
classification already resolves this correctly for the HEAD-unchanged
case ("unrelated pending → don't wait, proceed to fix now"), so the
backstop delegates to it by passing `head-sha-at-trigger = current
HEAD`. The event-driven path works the same way: an event-driven run
whose HEAD matches trigger time also treats pending checks as unrelated
and proceeds. The polling-backstop pending-replacement case — where a
previous polling tick's fix push left stale replacement checks pending —
is still handled correctly: a later polling tick will see a different
HEAD than the one the in-flight run captured as `head-sha-at-trigger`,
and Decision 4c's bounded wait kicks in. Native per-PR concurrency
prevents the second poll's dispatch from starting the agent concurrently
with the first.

**Why the `human-required` label filter.**
`respond-to-checks.md` explicitly allows the agent to escalate an
unfixable failure (one it cannot resolve on its own) by applying the
`human-required` label, assigning a human, and posting a comment
explaining what input is needed, **without** producing a fix. In that
supported outcome the failing check stays terminal and HEAD does not
advance, so without an escalation-aware stop the backstop would
re-dispatch the agent every polling interval and the agent would
re-escalate every time (adding another assignment and another comment
each pass). The `human-required` label is the explicit signal "a human
is handling this"; both the polling backstop (via `gh pr list --search
"-label:human-required"`) and Decision 4c's entrypoint guard respect it
and skip the PR until the label is removed. The operator re-enables the
automatic fix pipeline by removing the label after the human has
unblocked whatever the agent escalated for; the next event-driven
`check_run.completed` / `workflow_run.completed` or the next polling
tick picks the failure back up. This also addresses the event-driven
analogue of the same bug: Decision 4c's guard applies the same label
check for event-triggered runs, so a human-required-labelled PR cannot
trigger a re-escalation via a late check-completion event either.

**Why repo-wide polling instead of per-event enqueue.** The backstop
exists specifically because events may not fire. Any mechanism that
depends on an event cannot fix the problem the events-may-not-fire
scenario creates. A time-based poll is the only mechanism that is
delivery-independent.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| No backstop; rely on empirical evidence that `check_run` fires for all origins | The empirical evidence does not yet exist. Shipping the design without a defined fallback would commit the implementation to an unverified assumption; if validation fails, every red cross-repo-Actions PR silently stalls until an operator notices. |
| Backstop as a separate ad-hoc Actions variable toggle | Operators would have to opt in, defeating the "guarantees coverage" property. A scheduled backstop that is always on is the safer default; operators who want to disable it can set the cron variable to a very long interval. |
| Backstop that re-dispatches `check_run` events via the API | GitHub does not expose a public API to synthesise `check_run` events to a subscription from an unrelated source. Even if it did, the dedup chain already handles duplicate runs; invoking the reusable directly is simpler. |
| Scheduled workflow that itself runs the agent, bypassing the reusable | Would duplicate the reusable's trust gate, concurrency semantics, and secret wiring. Calling the same reusable keeps a single code path for the fix itself. |

### Decision 2: PR resolution — payload first, fall back to SHA lookup

**Decision.** The `resolve-check-pr` activity accepts the event name and
branches on it:

- **`workflow_run` event:** read `workflow_run.pull_requests[0].number`
  and `workflow_run.head_sha` from the payload. If `pull_requests[]` is
  empty (common for cross-repo-triggered runs — but this trigger only
  subscribes to same-repo workflows, so it is rare), fall through to the
  SHA lookup below.
- **`check_run` event:** read `check_run.pull_requests[0].number` and
  `check_run.head_sha` from the payload. For cross-repo and third-party
  check origins, `pull_requests[]` is typically empty.
- **SHA fallback (both events):** call
  `GET /repos/{owner}/{repo}/commits/{head_sha}/pulls`
  (`octokit.rest.repos.listPullRequestsAssociatedWithCommit`) with the
  observed `head_sha`; use the first open PR whose head SHA matches.
- If no PR is resolved, emit `proceed=false` so the dependent reusable
  call is skipped.

The activity also emits `head_sha` so the reusable workflow can pass it
through to the container (used by the Decision 4c freshness guard).

Encapsulate the above in a new TypeScript activity
`.github/scripts/src/resolve-check-pr.ts` with a thin composite action
wrapper `.github/actions/resolve-check-pr/action.yml`, following the
established activity pattern (see `AGENTS.md` § "Workflow Activity
Conventions" and the `resolve-deployment` activity as the closest
exemplar — it already uses `listPullRequestsAssociatedWithCommit` for the
same mapping shape).

**Why the two-step resolution.** GitHub populates `pull_requests[]` on
`check_run` payloads for same-repo workflow checks, but typically leaves
it empty for cross-repo (org ruleset) workflow checks and third-party
checks. The SHA → PR lookup is a reliable fallback that works regardless
of check origin; it is the same pattern `agent-fix-deployment` already
uses for `deployment_status` events, which have the same cross-repo gap.

**Multi-PR edge case.** `listPullRequestsAssociatedWithCommit` returns an
array because a commit can be the head of more than one PR (e.g. the same
branch pushed to two PR heads). For the agent-authored branch model
(`agent/issue-N`) this is a very rare case. The resolver picks the first
open PR; if that PR is not agent-authored, the existing `filter-agent-pr`
trust gate in the reusable workflow will skip the run. The simpler
"pick first open PR" shape avoids a fan-out matrix for a case we have
never observed in practice.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Trust `check_run.pull_requests[0]` only | Misses the cross-repo and third-party cases that are the whole point of this issue. |
| Always query by SHA, ignore the payload field | Adds one extra API call per event even when the payload already has the answer. The branch here is cheap and the payload-first path saves API budget on the common same-repo case. |
| Matrix fan-out across every PR returned by the SHA query | Complexity for a case not observed; the trust gate already catches the "wrong PR" variant. If multi-PR becomes a real need, add fan-out in a follow-up without changing the event wiring. |

### Decision 3: Opt-in allowlist — repo Actions variable `FIX_CHECKS_ALLOW`

**Decision.** Add a Terraform variable `fix_checks_allow` (`list(string)`,
default `[]`) exposed via `github_actions_variable` as
`FIX_CHECKS_ALLOW`, mirroring `AGENT_ALLOWLIST` and `REVIEWER_MODELS`.
The caller stub consults it only on the `check_run` branch of the trigger.
The `workflow_run` branch is independently opt-in because its
`workflows:` list explicitly enumerates same-repo workflows. The `if:` on
the resolver job (see Decision 4 for the two-job structure):

```yaml
if: >
  (github.event_name == 'workflow_run' &&
   github.event.workflow_run.conclusion == 'failure') ||
  (github.event_name == 'check_run' &&
   (github.event.check_run.conclusion == 'failure' ||
    github.event.check_run.conclusion == 'timed_out' ||
    github.event.check_run.conclusion == 'action_required') &&
   vars.FIX_CHECKS_ALLOW != '' &&
   contains(fromJSON(vars.FIX_CHECKS_ALLOW), github.event.check_run.name))
```

**Operator-precedence note.** The three conclusion comparisons are
parenthesised as a single group before the `&&` with the allowlist
check. GitHub Actions expressions evaluate `&&` before `||`
(`https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#operators`),
so without the outer parens around the conclusion group the expression
would read as `failure || timed_out || (action_required && allowed)`.
That would bypass the allowlist for `failure` and `timed_out`, defeating
the opt-in safety boundary. The validation task includes explicit cases
for an *unlisted* check at each supported conclusion (`failure`,
`timed_out`, `action_required`) to catch regressions of this grouping.

The leading `vars.FIX_CHECKS_ALLOW != ''` guard prevents `fromJSON('')`
when Terraform has not yet provisioned the variable. An absent or empty
variable is deliberately **disabled**, not fail-open: no `check_run` or
polled check can start the agent until an operator adds its exact display
name to the JSON array.

**Why repo-wide (not per-PR).** The allowlist expresses operator policy
("this check is safe and useful for the agent to handle in this repo"),
not per-PR exceptions. A per-PR override would add surface for a case the
issue does not raise. If a per-PR exception is ever needed, a
`fix-checks:allow:*` label pattern is the natural extension.

**Why in the caller stub (not the reusable workflow).** The caller stub
owns the trigger wiring and the repo-specific variable bindings; the
reusable workflow is deliberately agnostic to how the PR was selected or
why. This matches `agent-fix-checks.yml` → `agent-fix-checks-reusable.yml`
today (`workflow_run` filter + concurrency live in the stub). External
consumers who adopt the reusable workflow write their own stub and bind
their own allowlist variable. The reusable workflow signature stays
minimal — a PR number plus the existing agent/image/helpers inputs.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Pass the allowlist as a reusable-workflow input | Pushes the variable binding into every caller's `with:` block for no reuse benefit. The filter is cheap at the stub level and keeps the reusable's input surface small. |
| Separate boolean Actions variables per allowed check | Does not scale; adding or removing an allow entry is a Terraform change plus a workflow change rather than a one-line tfvars edit. |
| CSV-encoded string instead of JSON | `fromJSON` is already in use for every other list-shaped Actions variable in this repo (`AGENT_ALLOWLIST`, `REVIEWER_MODELS`, `AUTO_TRIGGER_AGENTS`). Introducing a second convention adds parsing surface and operator confusion. |
| Workflow-name-based allow key (match `check_run.check_suite.app.slug` or workflow file name) | Third-party checks have no workflow file; the check name is the only identifier common to all three origin classes. |

### Decision 4: Deduplication — two-job stub + per-PR concurrency + post-lock freshness guard

**Decision.** The caller stub is split into **two jobs** so that
concurrency can key on the resolved PR number, and the entrypoint's
`action_fix_checks()` grows an explicit freshness/duplicate-work guard
so a queued run cannot start another full agent pass against work the
previous run has already fixed.

#### 4a. Two-job stub so concurrency can key on the resolved PR number

```yaml
jobs:
  resolve-pr:
    # Conclusion-whitelist + allowlist filter (see Decision 3's if:).
    runs-on: ubuntu-24.04
    outputs:
      pr_number: ${{ steps.resolve.outputs.pr_number }}
      proceed:   ${{ steps.resolve.outputs.proceed }}
      head_sha:  ${{ steps.resolve.outputs.head_sha }}
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
        with:
          persist-credentials: false
      - id: resolve
        uses: ./.github/actions/resolve-check-pr
        with:
          event_name: ${{ github.event_name }}
          # The activity reads either the check_run payload or the
          # workflow_run payload depending on event_name; see Decision 2.

  fix-checks:
    needs: resolve-pr
    if: needs.resolve-pr.outputs.proceed == 'true'
    concurrency:
      group: agent-fix-checks-pr-${{ needs.resolve-pr.outputs.pr_number }}
      cancel-in-progress: false
    uses: ./.github/workflows/agent-fix-checks-reusable.yml
    with:
      pr-number: ${{ fromJSON(needs.resolve-pr.outputs.pr_number) }}
      head-sha-at-trigger: ${{ needs.resolve-pr.outputs.head_sha }}
      # … existing agent-login / image / helpers-ref inputs …
```

**Why two jobs.** `concurrency:` on a workflow-level or job-level
declaration is evaluated **before** any steps run — the `steps` context
is not available in a `concurrency.group` expression (see
`https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability`).
The design's earlier version keyed the group on
`steps.resolve-pr.outputs.pr_number`, which would never resolve: the
expression would evaluate to the literal empty string and every event
would fall through to the `check_run.id` fallback, producing one group
per check — exactly the regression the requirements forbid.

With a dependent job pattern, the resolver job publishes `pr_number` as
a step output copied to a job output, and the dependent reusable call
reads it via the `needs` context, which **is** available inside
`concurrency.group`. The dependent job's `if:` also guards on
`needs.resolve-pr.outputs.proceed`, so events the resolver could not
map to a PR (nor an agent-authored PR, if the resolver filters) never
enter the group at all. No `check_run.id` fallback is required because
unresolvable events do not reach the dependent job.

This two-job pattern also solves the earlier draft's "pre-step inside a
`uses:` job" problem: a reusable-workflow caller job cannot run `steps:`
of its own, so the resolver has to live in its own non-reusable job.

#### 4b. Per-PR concurrency with `cancel-in-progress: false`

With `cancel-in-progress: false` GitHub Actions runs at most **one** job
per concurrency group concurrently and holds at most **one** pending in
the queue; a third incoming trigger cancels the pending (not the
in-progress) run and takes its slot. For N near-simultaneous check
failures on the same PR this caps the system at one in-flight + one
queued run.

#### 4c. Post-lock freshness guard inside `action_fix_checks()`

The native concurrency behaviour above is **necessary but not
sufficient** for requirement 3. Two real races remain:

1. **Already-fixed failures.** After the in-flight run pushes a fix
   and releases the concurrency slot, the queued run starts. The
   previous version of this design claimed the queued run would be a
   "near no-op" because the agent "finds none failing and exits," but
   `action_fix_checks()` in `docker/scripts/entrypoint.sh` (around the
   `run_agent "respond-to-checks.md" ...` call) invokes the agent
   unconditionally after `gh pr checks`, regardless of whether any
   checks are actually failing. Without a guard, the queued run spends
   a full agent pass on nothing.
2. **Pending replacement checks.** The in-flight run can push a fix and
   release the concurrency slot *before* the replacement checks on the
   new HEAD have reported — so the queued run (triggered by a check
   failure on the *previous* HEAD) can enter the container, observe
   failing checks on the old HEAD, and launch an agent pass that
   duplicates work the in-flight run already addressed. The guard must
   distinguish these *stale replacement* pending checks from *unrelated*
   pending checks (checks that are pending for reasons unrelated to the
   in-flight fix); otherwise exiting on any pending check creates a
   lost-wakeup bug where an unrelated pending check later reporting
   `success` strands the original failure (see the "lost-wakeup bug"
   note below).

**Guard.** `action_fix_checks()` grows a short preamble, run after
`gh pr checkout` and before `run_agent`. The guard reads the allowlist
from `FIX_CHECKS_ALLOW` (passed through to the container as an env var
by the reusable workflow — a one-line plumbing addition) and the
trigger-time HEAD SHA from `GITHUB_HEAD_SHA_AT_TRIGGER` (passed as an
env var via the new `head-sha-at-trigger` reusable-workflow input), and
distinguishes two classes of pending check so a pending-check completion
cannot permanently discard the failure that triggered the run:

- **`human-required` label short-circuit (first).** Call
  `gh pr view "$GITHUB_PR_NUMBER" --json labels --jq
  '.labels[].name'` and exit 0 without invoking the agent (and without
  entering the pending-check wait) if `human-required` is present. The
  `respond-to-checks.md` prompt explicitly permits the agent to escalate
  an unfixable failure by applying that label, assigning a human, and
  posting a comment without producing a fix. Without this
  short-circuit, every subsequent trigger (polling tick or late
  check-completion event) would spend another full agent pass
  re-escalating the same failure. Operators re-enable the fix pipeline
  for the PR by removing the `human-required` label after the human has
  unblocked whatever the agent escalated for; the next event-driven
  trigger or polling tick picks the failure back up. This check runs
  before the pending-check classification so an escalated PR with
  pending checks does not enter the bounded wait.
- **Snapshot.** Enumerate current PR checks via `gh pr checks
  "$GITHUB_PR_NUMBER" --json name,state,bucket --jq ...`. Apply the
  allowlist throughout: a check whose name does not appear in
  `FIX_CHECKS_ALLOW` is excluded from both the failing-set and the
  pending-set the guard considers.
- **Pending-check classification by HEAD SHA.** Compare the container's
  checked-out HEAD SHA to `GITHUB_HEAD_SHA_AT_TRIGGER`:
  - **HEAD changed since trigger** → allowed pending checks are
    *stale replacement* checks for the fix the in-flight run already
    pushed. Perform a bounded wait (default 15 min, overridable via
    `FIX_CHECKS_WAIT_SECONDS`) polling `gh pr checks` until every
    allowed check is terminal **or** the timeout fires, then
    re-evaluate.
  - **HEAD unchanged since trigger** → allowed pending checks are
    *unrelated* to the failure that triggered this run. Do **not** wait
    on them: their own `check_run.completed` (or
    `workflow_run.completed`) events are the valid re-triggers for a
    future `agent-fix-checks` run on whatever conclusion they report.
    Proceed to the final evaluation immediately so the failure that
    triggered *this* run is addressed now.
- **Final evaluation.** Re-run `gh pr checks` (post-wait if we waited)
  and apply the allowlist:
  - If any allowed check is in a failing conclusion (`failure`,
    `timed_out`, `action_required`), fall through to `run_agent`.
  - Otherwise, log the no-op and exit 0 without invoking the agent and
    without pushing. On the HEAD-changed branch this means the
    in-flight run's push resolved the failure; on the HEAD-unchanged
    branch this means another run already handled it between the
    trigger event and the lock acquisition.
- **Stale-HEAD escape hatch.** If HEAD has changed since trigger and
  the initial snapshot already shows no allowed failing *or*
  pending checks, exit 0 without entering the polling loop. The run
  was for an obsolete HEAD and the in-flight run has already pushed;
  there is nothing left to fix.

**Why the HEAD-based classification matters (lost-wakeup bug).** An
earlier draft of this guard exited unconditionally whenever *any*
pending check was observed. That created a lost-wakeup bug: if check A
had just failed and check B was unrelatedly pending, the guard would
exit; if B then reported `success`, Decision 3's `if:` rejects
`success`, so no further `agent-fix-checks` event would fire for A, and
A's failure would be permanently stranded. The HEAD-based split closes
this: *unrelated* pending checks (HEAD unchanged) do not block the
current run from addressing A, and *stale replacement* pending checks
(HEAD changed) are the ones we actually need to wait for because they
belong to the in-flight run's fix push.

**Why in the entrypoint, not in the workflow.** The guard needs to run
*after* the concurrency lock is acquired, inside the container, so it
reflects the state at the moment the agent would otherwise start — not
the state at trigger time. A workflow-level guard would re-introduce the
race the concurrency group exists to prevent.

**Scope note.** The guard changes the behavioural contract of
`action_fix_checks()` listed in requirement 6 ("no change to the
fix-checks agent action itself"). The requirement predates this review;
it was premised on the (incorrect) belief that the native concurrency
group was sufficient. The guard is the minimum change needed to actually
achieve requirement 3; the agent *prompt* is still unchanged, and the
contract that the agent fixes every failing check in one pass is
preserved. Validation (Issue #659) includes an explicit burst scenario
(two checks fail in close succession on the same PR) and asserts that
only one agent pass runs — not one in-flight plus one queued no-op —
plus a pending-check-succeeds regression scenario covering both HEAD
classifications (unrelated pending with HEAD unchanged, stale
replacement pending with HEAD changed) so the lost-wakeup path cannot
regress silently.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| `cancel-in-progress: true` | Cancels an in-flight fix pass when a second check fails, risking a partial write to the branch. The agent's work is cheap to re-run but non-trivial to abort cleanly; preferring queued runs over cancelled runs is strictly safer. |
| Rely on concurrency alone (prior draft) | Does not address the already-fixed-failures or pending-replacement-check races — the queued run still invokes the agent against stale or absent failures and may push against the same HEAD twice. |
| Exit 0 on **any** pending check (earlier guard draft) | Creates the lost-wakeup bug described above: an unrelated pending check that later reports `success` is rejected by the Decision 3 `if:`, stranding the real failure. The HEAD-based classification above distinguishes stale replacement (wait) from unrelated pending (don't wait). |
| Treat the agent's own `human-required` label as "already attempted; keep retrying" (ignore the label) | `respond-to-checks.md` lets the agent escalate an unfixable failure by applying `human-required`, assigning a human, and posting a comment without producing a fix. Ignoring the label would cause every polling tick and every late check-completion event to re-dispatch the agent against the same terminal failure and re-escalate — adding another assignment and another comment each pass — rather than yielding to the human the agent explicitly handed the problem to. The label-based short-circuit mirrors the convention in `AGENTS.md` (the label is the explicit "agent cannot proceed on its own" signal). |
| Store a per-PR "already attempted" ledger (git note / artifact / PR body marker) | Introduces stateful cross-run persistence for a signal GitHub already stores on the PR itself. The `human-required` label is observable via `gh pr view --json labels` with no extra storage, and the operator re-enable gesture (remove the label) is the same gesture that already closes any other agent escalation. |
| Bounded N-attempts retry counter | Still re-dispatches the agent at least N times for a failure that is known to require human input; the first attempt already applied `human-required`, so attempts 2…N just duplicate the escalation. Picking N adds a parameter with no principled default; the label-based short-circuit is a clean 0-or-1 contract instead. |
| A persistent "we already queued a run" ledger | Stateful cross-run persistence in a stateless workflow; the in-container guard already short-circuits duplicate work without a datastore. |
| Debounce window (e.g. "wait 60s before firing") | Adds latency to the user-visible feedback loop and would still miss checks that complete after the debounce; the guard addresses the root cause instead. |

### Decision 5: Trust gate — `filter-agent-pr` carries over unchanged

**Decision.** The reusable workflow continues to call the
`filter-agent-pr` composite action immediately after the helpers checkout,
with the resolved PR number as input. No change to that activity, no new
head-ref or branch-prefix heuristic.

**Why.** `filter-agent-pr` looks up the PR author via the GitHub REST API
and compares against the `agent-login` input. The lookup is independent
of which event delivered the PR number, so it works for both branches of
the hybrid trigger (`workflow_run` and `check_run`) without
modification. The grooming notes raise branch-prefix heuristics as an
alternative; the author-identity check is strictly stronger (a human can
push to an `agent/*` branch, but the PR author field is set at PR
creation and does not change on push).

The caller stub's resolve-PR **job** runs before the dependent
reusable-workflow call job is invoked (necessary — the reusable needs
the PR number as an input). If the resolver returns `proceed=false`
(either no PR, or any future resolver-side filter), the dependent job's
`if:` short-circuits and the reusable is never called; no token is
minted, no API key enters any step.

### Decision 6: Permissions and secrets stay as-is

**Decision.** The caller stub needs `pull-requests: read` (for the SHA →
PR lookup in the resolver) and `contents: read` (default). The reusable
workflow's existing permissions block is unchanged. No new secret, no new
App installation, no new allowlist entry.

Neither `workflow_run` nor `check_run` event delivery requires a scope
beyond the repository being configured for that event — GitHub
subscribes workflows to any event listed in `on:` without additional
permission grants.

## Out of scope

- **Changing the fix-checks agent prompt.** The `respond-to-checks.md`
  prompt is unchanged. The freshness/duplicate-work guard added in
  Decision 4c lives in `action_fix_checks()` (entrypoint shell), runs
  *before* the agent is invoked, and short-circuits when there is
  nothing allowed to fix on the current HEAD, when replacement
  checks are still pending, or when the PR already carries the
  `human-required` label the agent itself may have applied on a prior
  pass. The agent itself still fixes whatever `gh pr checks` reports
  when it is invoked.
- **Automatic removal of the `human-required` label.** Decision 4c's
  guard and the Decision 1a backstop both treat the label as a stop
  condition and never clear it on their own. Removing it is an explicit
  operator gesture that signals the human has unblocked whatever the
  agent escalated for; the next trigger (polling tick or
  check-completion event) picks the failure back up. Automating removal
  would re-create the re-escalation loop the stop condition exists to
  prevent.
- **Reacting to failing checks on human PRs.** The agent-authored trust
  gate is preserved (`filter-agent-pr`). Expanding to human PRs is a
  larger policy question outside this issue.
- **Per-PR allow overrides.** The allowlist is repo-wide. A
  `fix-checks:allow:<name>` label pattern could be added later if a real
  need emerges; this issue does not request it.
- **Workflow-name-based allow keys.** Decision 3 picks check-name
  matching because it is the only identifier common to all three check
  origin classes. Workflow-name matching would exclude third-party
  checks, defeating requirement 1.
- **Matrix fan-out over multiple PRs sharing a head SHA.** The resolver
  picks the first open PR. If the operational data later shows real
  multi-PR cases, a follow-up can add fan-out without changing the event
  wiring (Decision 2).
- **Dedup via a persistent ledger.** The two-job stub plus the Decision
  4c in-container freshness guard together handle the already-fixed /
  pending-replacement races without stateful cross-run persistence.
- **A standalone "ignore pending/success" filter at the stub level.**
  `check_run.completed` and `workflow_run.completed` do not fire for
  pending states, and the conclusion whitelist in Decision 3's `if:`
  already excludes `success`, `neutral`, `cancelled`, `stale`,
  `skipped`. Pending-check *replacement* (where a push has invalidated
  the previous check set and the new checks have not yet reported) is
  handled by the in-container freshness guard (Decision 4c), not by the
  stub `if:`.
- **Debounce/rate-limit controls.** Deferred until operational data
  shows the concurrency-group behavior alone is insufficient.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#656](https://github.com/mfrancza/agentic-development-workflow/issues/656) | Terraform: add `fix_checks_allow` variable (`list(string)`, default `[]`), expose as `FIX_CHECKS_ALLOW` Actions variable via `github_actions_variable` in `terraform/modules/agent-vars/`, update `terraform.tfvars.example` with an explicit check-name example and document that an empty list disables check-run/polling handling, extend `AGENTS.md`'s Terraform Actions-variable list to reference the new var | — |
| [#657](https://github.com/mfrancza/agentic-development-workflow/issues/657) | `resolve-check-pr` TypeScript activity + composite action: `.github/scripts/src/resolve-check-pr.ts` accepts `event_name` and branches between `check_run` and `workflow_run` payload shapes (both resolve via `pull_requests[0]` first, then `listPullRequestsAssociatedWithCommit(head_sha)`); outputs `pr_number`, `head_sha`, and `proceed`; `.github/actions/resolve-check-pr/action.yml` thin wrapper; vitest tests under `.github/scripts/test/` covering both event types and the fallback paths; follows the composite-action portability pattern (`${{ github.action_path }}/../../scripts`, Resolve-scripts-directory step) | — |
| [#658](https://github.com/mfrancza/agentic-development-workflow/issues/658) | Caller stub + reusable workflow rewiring using a **hybrid** trigger: `.github/workflows/agent-fix-checks.yml` subscribes to both explicit same-repo `workflow_run.workflows` and `check_run: [completed]`; split the stub into resolver + dependent reusable-call jobs keyed by `needs.resolve-pr.outputs.pr_number`; add the conclusion-whitelist + `FIX_CHECKS_ALLOW` opt-in filter on the resolver `if:` (including an empty/missing-variable fail-closed guard); extend the reusable workflow to accept `head-sha-at-trigger` and plumb `FIX_CHECKS_ALLOW` through to the container; use the pinned checkout SHA with `persist-credentials: false`; update operator documentation for the opt-in policy | Issue #656, Issue #657 |
| [#667](https://github.com/mfrancza/agentic-development-workflow/issues/667) | Entrypoint freshness / duplicate-work guard in `action_fix_checks()` (`docker/scripts/entrypoint.sh`): after `gh pr checkout` and before `run_agent`, short-circuit `human-required`, enumerate checks with the `FIX_CHECKS_ALLOW` allowlist applied throughout, classify allowed pending checks by `GITHUB_HEAD_SHA_AT_TRIGGER`, bounded-wait only stale replacements, and invoke the agent only when an allowed check remains failing. Read `FIX_CHECKS_ALLOW` and `GITHUB_HEAD_SHA_AT_TRIGGER` from env and cover the guard with shell tests. | Issue #658 |
| [#668](https://github.com/mfrancza/agentic-development-workflow/issues/668) | Scheduled polling backstop workflow `.github/workflows/agent-fix-checks-poll.yml`: schedule + manual dispatch; enumerate open agent PRs without `human-required`, apply `FIX_CHECKS_ALLOW`, and dispatch only PRs with an allowed failing check (even if allowed checks are pending). Use the shared concurrency group and freshness guard for dedup; document the opt-in operator knobs and the human-required re-enable gesture. | Issue #656, Issue #658, Issue #667 |
| [#659](https://github.com/mfrancza/agentic-development-workflow/issues/659) | End-to-end validation: prove an unlisted cross-repo/third-party check never dispatches (event-driven or polled); prove adding its exact display name to `FIX_CHECKS_ALLOW` enables each origin independently; prove selected same-repo workflows still require their `workflow_run.workflows` subscription; cover all three actionable conclusions, burst dedup, pending-check safety, polling dedup, human-PR exclusion, escalation stop/re-enable, and empirical `check_run` delivery coverage. | Issue #658, Issue #667, Issue #668 |

Issues #656 and #657 are independent of each other — one defines the
Actions variable contract (`FIX_CHECKS_ALLOW`, JSON array, default `[]`,
fail-closed when empty);
the other defines the composite action contract (inputs: `event_name`,
`token`, `repository`; outputs: `proceed`, `pr_number`, `head_sha`).
Issue #658 integrates both, wires the hybrid trigger, and restructures
the stub into the resolver + reusable-call job pair. The entrypoint
guard task (#667) depends on Issue #658 only for the
`FIX_CHECKS_ALLOW` env-var plumbing and the `head-sha-at-trigger`
input; the shell logic itself is independent. Issue #668 (polling
backstop) depends on Issue #656 (for the allowlist), Issue #658 (for
the reusable workflow's `head-sha-at-trigger` input and the per-PR
concurrency group), and Issue #667 (for the entrypoint freshness guard
that keeps event-driven and polled runs from duplicating work).
Issue #659 exercises the entire chain end-to-end — with each check
origin, allowlist exclusion and admission, the burst-dedup scenario, the
pending-check-succeeds regression, the polling-backstop dedup
regression, and an explicit record of empirical `check_run` delivery
coverage — and is blocked by all five implementation issues (#656,
#657, #658, #667, #668). The sub-issue bodies (#658, #659, #667, #668)
have been resynchronised with the revised design (hybrid trigger,
polling backstop, two-job stub, entrypoint plumbing,
independent-origin validation, pending-succeeds regression, backstop
dedup) so the issue-driven implementation pipeline is consistent with
this doc.

Dependencies are recorded natively on GitHub both via the parent /
sub-issue relationship on #627 (all six sub-issues are linked) and via
the issue-dependencies API's `blocked_by` edges (so
`.github/scripts/src/check-blockers.ts` and the `design.md` prompt's
"depends-on" discovery read the same graph the design doc declares).
The current native edge set is: #658 blocked by #656 and #657; #667
blocked by #658; #668 blocked by #656, #658, and #667; #659 blocked by
#658, #667, and #668.
