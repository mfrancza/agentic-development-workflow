# Design: Fix-checks on any failing PR check, with a configurable ignore list

**Issue:** [#627](https://github.com/mfrancza/agentic-development-workflow/issues/627)

## Summary

Replace the `workflow_run` trigger on `agent-fix-checks.yml` with a
`check_run.completed` trigger so the developer agent reacts to **any** failing
check reported against an agent-authored PR — same-repo workflows other than
the single historical `CI` name, workflows defined in another repository
(e.g. organization rulesets), and third-party checks (e.g. Code Climate).
Introduce a repo-wide `FIX_CHECKS_IGNORE` Actions variable (JSON array of
check names, default `[]`) that the caller stub consults to suppress specific
noisy or non-actionable checks. Preserve the existing agent-authored trust
gate and keep per-PR deduplication via the concurrency group that is already
in place.

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

1. **Trigger covers every failing check on an agent-authored PR.** Same-repo
   workflow jobs, cross-repo (org ruleset) workflow checks, and third-party
   checks must all start the agent — unless the check name appears in the
   caller-configured ignore list. The agent-authored trust gate is
   preserved: a failing check on a human PR must not start the agent.
2. **Caller-configured ignore list by check name.** The ignore list is
   names of **checks** (e.g. `"CodeQL"`, `"Lint"`), not workflow file
   names, because third-party checks have no workflow file at all. An empty
   list ignores nothing. The default is empty. Callers set the list via a
   repository Actions variable without editing the reusable workflow —
   matching the `AUTO_TRIGGER_AGENTS` / `AGENT_ALLOWLIST` pattern already
   used in this repo.
3. **One PR with several failing checks produces one run (not one per
   check).** When `N` checks fail on the same PR in quick succession, the
   agent runs at most once concurrently for that PR, and the agent (which
   already fetches the full `gh pr checks` state inside the container)
   addresses every failing check in a single pass.
4. **Ignored checks and still-pending checks do not start a run.** A later
   failure of a non-ignored, non-pending check does start one.
5. **The caller stub documents how to set the ignore list.** External
   consumers who reference the reusable workflow write their own thin
   caller stubs; the stub comments and the design doc are the single
   authoritative references for the variable name, format, and defaults.
6. **No change to the fix-checks agent action itself.** The container
   entrypoint already enumerates every failing check with `gh pr checks`
   (see `action_fix_checks()` in `docker/scripts/entrypoint.sh`) and fixes
   whatever it finds. The agent's view of the PR is independent of which
   check triggered the workflow. This is the behavioral contract that
   makes requirement 3 work.

### Clarifying resolutions

- **Which GitHub check conclusions count as "failing"?** The GitHub
  checks API documents several terminal conclusions: `success`, `failure`,
  `neutral`, `cancelled`, `timed_out`, `action_required`, `stale`,
  `skipped`. The issue says "failing check". This design treats
  `failure`, `timed_out`, and `action_required` as the actionable set —
  these are the conclusions GitHub treats as blocking a required-check
  policy. `cancelled`, `skipped`, `stale`, and `neutral` are not failures
  and must not start the agent.
- **Which check names does the ignore list match against?** The
  `check_run` event payload's `check_run.name` field. For a GitHub Actions
  job this is the job name as displayed in the PR check list (not the
  workflow file name, and not the workflow `name:` key). Document this
  explicitly in the stub comment so operators look at the PR's "Checks"
  tab rather than at `.github/workflows/*.yml` to find the right string.

## Design

### Decision 1: Trigger — `check_run.completed`, replacing `workflow_run`

**Decision.** `agent-fix-checks.yml` subscribes to `check_run: [completed]`
and removes the `workflow_run` trigger entirely.

**Why.** The `check_run.completed` event fires for every check regardless
of origin — same-repo workflow jobs (one event per job), workflows defined
in another repository (org ruleset), and third-party check providers. It
is the only single event that satisfies requirement 1 without a
polling-based hybrid. The payload includes `check_run.name` (needed for the
ignore-list filter), `check_run.conclusion`, `check_run.head_sha`, and —
when the check originates from a workflow attached to a PR —
`check_run.pull_requests[]`. Each GitHub Actions **job** emits its own
`check_run`, so the existing `CI` workflow's jobs each produce one event
on completion; the current `workflow_run` behavior is subsumed.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Keep `workflow_run` and extend `workflows:` with more names | Only covers same-repo workflows. Fundamentally cannot see org-ruleset or third-party checks (grooming note confirmed). |
| `check_suite.completed` instead of `check_run.completed` | Fires per *suite*, not per check. Suites can group multiple checks with mixed conclusions, so the name-based ignore list cannot be applied per-check at the gate — all-or-nothing per suite is a worse fit. The agent can still fix multiple failures per run, so per-check granularity at the gate is the right level. |
| `pull_request_target` + poll for check status | Adds an inherently racy polling loop and consumes workflow-minutes while waiting. The `check_run` event already carries the completion signal; polling re-derives it. |
| Both `workflow_run` and `check_run` for backward compatibility | Double-fires on every same-repo job (one event each) and complicates the dedup story for no gain. `check_run` fully subsumes `workflow_run` for this use case. |

**Impact on existing passing-run history.** `AGENTS.md` § "Reverting or
replacing code with a passing live-run history" requires runtime evidence
when replacing working code. The runtime evidence here is in the issue
itself: the current `workflow_run` trigger has a passing history **only
for same-repo `CI` failures**, and demonstrably does not fire for the
check classes the issue enumerates (cross-repo and third-party). The
replacement extends coverage, does not revert the behaviour that has
passed historically; same-repo failures still start the agent, now via
`check_run` instead of `workflow_run`. The caller stub comment captures
this reasoning.

### Decision 2: PR resolution — payload first, fall back to SHA lookup

**Decision.** Resolve the PR number for a `check_run` event by:

1. If `check_run.pull_requests[]` is non-empty, use the first entry's
   `number`.
2. Else, call
   `GET /repos/{owner}/{repo}/commits/{head_sha}/pulls`
   (`octokit.rest.repos.listPullRequestsAssociatedWithCommit`) with
   `check_run.head_sha`; use the first open PR whose head SHA matches.
3. If no PR is resolved, skip cleanly (`proceed=false`, log and exit).

Encapsulate steps 1–3 in a new TypeScript activity
`.github/scripts/src/resolve-check-pr.ts` with a thin composite action
wrapper `.github/actions/resolve-check-pr/action.yml`, following the
established activity pattern (see `AGENTS.md` § "Workflow Activity
Conventions" and the `resolve-deployment` activity as the closest
exemplar — it already uses `listPullRequestsAssociatedWithCommit` for the
same mapping shape).

**Why the two-step resolution.** GitHub populates
`check_run.pull_requests[]` for same-repo workflow checks, but typically
leaves it empty for cross-repo (org ruleset) workflow checks and
third-party checks. The SHA → PR lookup is a reliable fallback that works
regardless of check origin; it is the same pattern `agent-fix-deployment`
already uses for `deployment_status` events, which have the same
cross-repo gap.

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

### Decision 3: Ignore list — repo Actions variable `FIX_CHECKS_IGNORE`

**Decision.** Add a Terraform variable `fix_checks_ignore` (`list(string)`,
default `[]`) exposed via `github_actions_variable` as
`FIX_CHECKS_IGNORE`, mirroring `AGENT_ALLOWLIST` and `REVIEWER_MODELS`
exactly. The caller stub consults it in its job-level `if:`:

```yaml
if: >
  github.event.check_run.conclusion == 'failure' ||
  github.event.check_run.conclusion == 'timed_out' ||
  github.event.check_run.conclusion == 'action_required'
  &&
  (vars.FIX_CHECKS_IGNORE == '' ||
   !contains(fromJSON(vars.FIX_CHECKS_IGNORE), github.event.check_run.name))
```

The leading `vars.FIX_CHECKS_IGNORE == ''` guard matches the established
pattern (see `AUTO_TRIGGER_AGENTS` design, Decision 1 in
`docs/design/auto-trigger-agents.md`): if the variable has not yet been
provisioned by Terraform, `vars.FIX_CHECKS_IGNORE` evaluates to the empty
string and `fromJSON('')` would throw. The empty guard short-circuits to
"nothing is ignored" — the issue's stated default — rather than failing
the workflow or silently suppressing every check.

**Why repo-wide (not per-PR).** The ignore list expresses operator policy
("this check is noisy or non-actionable in this repo"), not per-PR
exceptions. A per-PR override would add surface for a case the issue does
not raise. If a per-PR exception is ever needed, a `fix-checks:ignore:*`
label pattern is the natural extension.

**Why in the caller stub (not the reusable workflow).** The caller stub
owns the trigger wiring and the repo-specific variable bindings; the
reusable workflow is deliberately agnostic to how the PR was selected or
why. This matches `agent-fix-checks.yml` → `agent-fix-checks-reusable.yml`
today (`workflow_run` filter + concurrency live in the stub). External
consumers who adopt the reusable workflow write their own stub and bind
their own ignore-list variable. The reusable workflow signature stays
minimal — a PR number plus the existing agent/image/helpers inputs.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Pass the ignore list as a reusable-workflow input | Pushes the variable binding into every caller's `with:` block for no reuse benefit. The filter is cheap at the stub level and keeps the reusable's input surface small. |
| Separate boolean Actions variables per ignored check | Does not scale; adding or removing an ignore is a Terraform change plus a workflow change rather than a one-line tfvars edit. |
| CSV-encoded string instead of JSON | `fromJSON` is already in use for every other list-shaped Actions variable in this repo (`AGENT_ALLOWLIST`, `REVIEWER_MODELS`, `AUTO_TRIGGER_AGENTS`). Introducing a second convention adds parsing surface and operator confusion. |
| Workflow-name-based ignore (match `check_run.check_suite.app.slug` or workflow file name) | The issue is explicit: ignore list is check **names**. Third-party checks have no workflow file; the check name is the only identifier common to all three origin classes. |

### Decision 4: Deduplication — reuse the existing per-PR concurrency group

**Decision.** Keep the existing concurrency pattern on the caller stub:

```yaml
concurrency:
  group: agent-fix-checks-pr-${{ steps.resolve-pr.outputs.pr_number || github.event.check_run.id }}
  cancel-in-progress: false
```

The fallback key changes from `workflow_run.id` to `check_run.id` (same
pattern — a stable per-event identifier so PR-less events do not collide
on a shared group name).

**Why `cancel-in-progress: false`.** With `cancel-in-progress: false`
GitHub Actions runs at most **one** job per concurrency group concurrently
and holds at most **one** pending in the queue; a third incoming trigger
cancels the pending (not the in-progress) run and takes its slot. For N
near-simultaneous check failures on the same PR this naturally caps the
system at one in-flight + one queued run — satisfying requirement 3 ("one
run, not one run per check") without introducing a stateful dedup layer.

The agent inside the container is the second half of the dedup: when it
runs, it inspects *all* currently failing checks on the PR via
`gh pr checks` and addresses every one in a single pass (existing
behaviour in `action_fix_checks()`). A queued run that fires after an
in-flight run has already fixed everything is a near no-op — it enumerates
the checks, finds none failing, and exits.

**Concurrency-group identifier choice.** The group is keyed on the
resolved PR number (not the `check_run.id`) so that two different checks
failing on the same PR fall into the same group. Using
`check_run.id` would key every single check completion into its own group
and produce one run per check — the regression the requirements forbid.
The `check_run.id` fallback appears only when PR resolution fails, so two
PR-less events never collide.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| `cancel-in-progress: true` | Cancels an in-flight fix pass when a second check fails, risking a partial write to the branch. The agent's work is cheap to re-run but non-trivial to abort cleanly; preferring queued runs over cancelled runs is strictly safer. |
| A persistent "we already queued a run" ledger | Stateful cross-run persistence in a stateless workflow; solves no problem the native concurrency group does not already solve. |
| Debounce window (e.g. "wait 60s before firing") | Adds latency to the user-visible feedback loop; the concurrency group already serializes without an explicit delay. |

### Decision 5: Trust gate — `filter-agent-pr` carries over unchanged

**Decision.** The reusable workflow continues to call the
`filter-agent-pr` composite action immediately after the helpers checkout,
with the resolved PR number as input. No change to that activity, no new
head-ref or branch-prefix heuristic.

**Why.** `filter-agent-pr` looks up the PR author via the GitHub REST API
and compares against the `agent-login` input. The lookup is independent
of which event delivered the PR number, so it ports from `workflow_run`
to `check_run` without modification. The grooming notes raise
branch-prefix heuristics as an alternative; the author-identity check is
strictly stronger (a human can push to an `agent/*` branch, but the PR
author field is set at PR creation and does not change on push).

The caller stub's resolve-PR step runs before the reusable workflow is
invoked (necessary — the reusable needs the PR number as an input). If
the resolver returns no PR, the stub skips entirely and the reusable is
never called; no token is minted, no API key enters any step.

### Decision 6: Permissions and secrets stay as-is

**Decision.** The caller stub needs `pull-requests: read` (for the SHA →
PR lookup in the resolver) and `contents: read` (default). The reusable
workflow's existing permissions block is unchanged. No new secret, no new
App installation, no new allowlist entry.

The `check_run` event delivery to the workflow does not itself require a
scope beyond the repository being configured for that event — GitHub
subscribes workflows to any event listed in `on:` without additional
permission grants.

## Out of scope

- **Changing the fix-checks agent action.** `action_fix_checks()` in
  `docker/scripts/entrypoint.sh` already enumerates every failing check
  via `gh pr checks` and does not care which check triggered the run.
  Requirement 3 (one run per PR) is satisfied by the concurrency group
  plus this existing behavior; no entrypoint change is in scope.
- **Reacting to failing checks on human PRs.** The agent-authored trust
  gate is preserved (`filter-agent-pr`). Expanding to human PRs is a
  larger policy question outside this issue.
- **Per-PR ignore overrides.** The ignore list is repo-wide. A
  `fix-checks:ignore:<name>` label pattern could be added later if a real
  need emerges; this issue does not request it.
- **Workflow-name-based ignore keys.** Decision 3 picks check-name
  matching because it is the only identifier common to all three check
  origin classes. Workflow-name matching would exclude third-party
  checks, defeating requirement 1.
- **Matrix fan-out over multiple PRs sharing a head SHA.** The resolver
  picks the first open PR. If the operational data later shows real
  multi-PR cases, a follow-up can add fan-out without changing the event
  wiring (Decision 2).
- **Dedup via a persistent ledger.** The native concurrency group already
  provides one-in-flight + one-queued semantics (Decision 4). A stateful
  ledger adds no capability.
- **A standalone "ignore pending/success" filter.** `check_run.completed`
  does not fire for pending checks, and the conclusion whitelist in
  Decision 3's `if:` already excludes `success`, `neutral`, `cancelled`,
  `stale`, `skipped`. No additional filter needed.
- **Debounce/rate-limit controls.** Deferred until operational data
  shows the concurrency-group behavior alone is insufficient.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#656](https://github.com/mfrancza/agentic-development-workflow/issues/656) | Terraform: add `fix_checks_ignore` variable (`list(string)`, default `[]`), expose as `FIX_CHECKS_IGNORE` Actions variable via `github_actions_variable` in `terraform/modules/agent-vars/`, update `terraform.tfvars.example` with a documented example entry, extend `AGENTS.md`'s Terraform Actions-variable list to reference the new var | — |
| [#657](https://github.com/mfrancza/agentic-development-workflow/issues/657) | `resolve-check-pr` TypeScript activity + composite action: `.github/scripts/src/resolve-check-pr.ts` resolves PR number from `check_run` payload (prefer `pull_requests[]`, fall back to `listPullRequestsAssociatedWithCommit(head_sha)`); `.github/actions/resolve-check-pr/action.yml` thin wrapper; vitest tests under `.github/scripts/test/`; follows the composite-action portability pattern (`${{ github.action_path }}/../../scripts`, Resolve-scripts-directory step) | — |
| [#658](https://github.com/mfrancza/agentic-development-workflow/issues/658) | Caller stub + reusable workflow rewiring: switch `.github/workflows/agent-fix-checks.yml` from `workflow_run` to `check_run: [completed]`; add the conclusion whitelist + `FIX_CHECKS_IGNORE` filter in the job `if:`; call `resolve-check-pr` in a pre-step and pass the resolved PR number to the reusable; update the concurrency group to key on the resolved PR number with `check_run.id` as the PR-less fallback; update `.github/workflows/agent-fix-checks-reusable.yml` comment to describe the new trigger surface (signature unchanged — still takes `pr-number`); update `AGENTS.md` MVP Workflow step 4 and `README.md` as needed to describe the new trigger and the ignore-list variable | Issue #656, Issue #657 |
| [#659](https://github.com/mfrancza/agentic-development-workflow/issues/659) | End-to-end validation: on a disposable agent-authored PR, demonstrate (1) a failing same-repo workflow job *other than* a job in `CI` starts fix-checks; (2) a failing check reported by a workflow defined in another repository (e.g. a test organization ruleset, or a synthesized third-party check via the Checks API) starts fix-checks; (3) adding that check's name to `FIX_CHECKS_IGNORE` suppresses the next run; (4) with two different checks failing on the same PR in close succession, only one fix pass runs concurrently and a single queued run follows; (5) a failing check on a human-authored PR does *not* start fix-checks | Issue #658 |

Issues #656 and #657 are independent of each other — one defines the
Actions variable contract (`FIX_CHECKS_IGNORE`, JSON array, default `[]`);
the other defines the composite action contract (inputs: `token`,
`repository`, `head-sha`, `payload-pr-numbers`; outputs: `proceed`,
`pr_number`). Issue #658 integrates both and rewires the trigger. Issue
numbered 659 exercises the entire chain on a real PR.

Dependencies will be recorded natively as GitHub blocked-by
relationships on the sub-issues.
