# Design: Optionally require two approving reviews on developer-agent pull requests

**Issue:** [#628](https://github.com/mfrancza/agentic-development-workflow/issues/628)

## Summary

Add an opt-in setting that requires a configurable number of approving
reviews before a pull request can merge, scoped to pull requests authored by
a configurable list of protected identities. Pull requests whose authors are
not in that list continue to require only whatever the base
`required_approving_review_count` on the `main-protection` ruleset says
(today: 1).

GitHub's branch-protection `required_approving_review_count` is per-branch,
not per-author, so a direct bump to 2 would raise the bar for every PR on
the default branch — the exact outcome the issue rules out. The design uses
the mechanism the issue's Notes section already identifies: a **required
status check** backed by a short GitHub Actions workflow. The check passes
immediately when the PR author is not in the configured protected-author
list; otherwise it passes only once the configured number of qualifying
approvals exist (excluding the PR author's own review from the count). The check context is wired
into the `main-protection` ruleset as a required check only when the opt-in
is enabled, so the default behavior of the repository is unchanged. The
required-check entry pins its `integration_id` to the GitHub Actions App
(public ID 15368) so another identity with check-publication permission
cannot satisfy the gate (Decision 6).

The computation is executed by a **publisher** workflow that runs under
`pull_request_target` (for pull-request-side events) and `workflow_run`
(for review-side events, chained through an empty, zero-permission
notifier workflow). This split, detailed in Decision 5, (a) always runs
trusted base-branch workflow code (not the attacker-controllable PR
head), and (b) carries a write-capable `GITHUB_TOKEN` so the Checks API
POST succeeds on fork-authored PRs — which the earlier `pull_request`
design would have silently blocked. Decision 5 also documents the
residual risk from a same-repository PR that edits the notifier (or
adds another workflow with `checks: write`) to post a spoofed
check-run under the GitHub Actions App ID, and the baseline-review +
PR-diff-visibility layers that bound that risk.

The context name is fixed (`require-two-developer-approvals`). An
ON → OFF → ON cycle in which approvals change while the gate is OFF
cannot leave a stale `success` check-run from the previous ON interval
in force: the backfill run on enable, and the reconcile sweep within one
interval, re-publish the current result on every open PR. Decision 7
covers the full ON ↔ OFF reconciliation. Decision 8 covers per-PR
serialization, re-fetch against the live head SHA, and the
three-run concurrency replacement case. Decision 8a covers the case
where two PRs share the same head commit SHA — the publisher
intersects the per-PR qualifying rule across all PRs on the SHA so
that one PR's `success` cannot borrow another PR's less-strict
outcome, and reconciles the departed SHA when a sibling PR
closes or advances to a new head so a human PR left on the old
SHA is unblocked without needing further activity on its own
branch.

The publisher's trigger set also includes `ready_for_review` (so
draft PRs that receive approvals and are then marked ready get a
guaranteed publication on their live head SHA, even with no
subsequent events) and `closed` (so the departed-SHA
reconciliation above fires when a sibling PR closes or merges).

Protected identities are sourced from a JSON-encoded Terraform-managed
Actions variable `PROTECTED_PR_AUTHOR_LOGINS`, and the threshold from
`REQUIRED_APPROVAL_COUNT`. The defaults preserve this issue's intended
posture: `["mfrancza-developer-agent[bot]"]` and `2`; adopters can use a
different developer-agent identity, protect additional identities, or choose
another positive threshold without changing workflow code.

## Requirements as understood

From issue #628 and its grooming notes:

1. **Opt-in gate.** A new setting that is OFF by default. When OFF, no
   behavior anywhere in the repo changes — the base
   `required_approving_review_count = 1` on `main-protection` continues to
   govern every PR. When ON, a PR whose author is in the protected-author
   list needs the configured number of qualifying approvals.
2. **Scope by PR author.** The gate applies only when the PR author's login
   is in the configured protected-author list. All other PR authors are
   unaffected.
3. **Configuration is not hardcoded.** The protected-author list is a
   JSON-encoded list of GitHub logins and the threshold is a positive integer;
   neither is embedded in the gate workflow.
4. **Self-reviews don't count.** An `APPROVED` review by the PR author does
   not count toward that PR's configured threshold. Reviews by anyone else do
   count (subject to the detail in Decision 4).
5. **Mechanism must not raise the per-branch count.** The ruleset's
   `required_approving_review_count` stays at its current value (1). The
   two-approvals requirement is enforced through an added **required status
   check**, not through a global count bump.
6. **Non-matching PRs must pass instantly.** The required status check must
   produce `success` without delay (and without waiting for any approvals)
   whenever the PR author is not in the protected-author list, so that
   adding this check to the ruleset does not slow down or block human PRs
   or PRs from the reviewer agent / Copilot / other bots.
7. **Fail-loud configuration errors.** If the opt-in is ON but
   `PROTECTED_PR_AUTHOR_LOGINS` is empty or invalid, or
   `REQUIRED_APPROVAL_COUNT` is not a positive integer, the gate must not silently fail open
   (which would let agent PRs merge with a single approval) and must not
   silently fail closed on human PRs (which would block all PRs). The
   workflow fails loudly with `::error::` so the misconfiguration surfaces
   as a check failure visible on every PR, not as a quiet behavioral
   regression.

### Ambiguity resolutions

The issue text is explicit about the PR-author side ("the developer agent's
own review does not count"). It is less explicit about the review-author
side. Decisions 4 and 5 below spell out these resolutions and cite the
grooming context that constrains each.

## Decisions

### Decision 1 — Enforce via a required status check, not a per-branch count bump

**Decision.** Implement the two-approvals requirement as a GitHub Actions
workflow that publishes a check conclusion for every PR; wire the check
context into the `main-protection` ruleset's `required_status_checks` rule
only when the opt-in is enabled. The base `required_approving_review_count`
on the ruleset is unchanged (stays at 1).

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Set `required_approving_review_count = 2` on the ruleset | Per-branch, not per-author. Raises the bar for every PR including human-authored ones — the exact outcome the issue excludes. |
| Create a second ruleset scoped to agent branches (e.g. `agent/*`, `design/*`) with `required_approving_review_count = 2` | GitHub rulesets are per-ref, not per-author. A human pushing a rescue commit onto `agent/issue-N` would be caught by the 2-approval rule even though they are not the configured developer agent. Also, [`docs/design/auto-review-author-gate.md`](auto-review-author-gate.md) explicitly moved away from branch-prefix as the sole gate for the same class of defect (missed enrollment / wrong scope). Branch-prefix is also easily bypassed by naming the branch differently. |
| CODEOWNERS requiring two reviewers for specific paths | CODEOWNERS is path-scoped, not author-scoped. It cannot express "require two approvals when the PR author is X". |
| A separate branch-protection "repository role" bypass trick | GitHub has no "require more approvals when author is identity X" primitive. The required-status-check mechanism is the only supported way to encode conditional-approval policy today, which is why the issue's Notes section already points at it. |
| Use a GitHub Deployment protection rule or Environment | Deployment protection rules gate deployments, not PR merges. |

The required-status-check approach also stacks cleanly with the existing
`required_approving_review_count = 1` rule: GitHub still demands at least
one write-access human approval (which the reviewer-agent app's advisory
`APPROVE` deliberately does not satisfy — see [`docs/design/code-review-agent.md`](code-review-agent.md)),
and the custom check additionally demands the configured number of non-self
approvals when the author is protected. With the defaults, a developer-agent
PR's effective merge gate remains "≥1 write-access human approval AND ≥2
non-self approvals".

### Decision 2 — New Terraform-managed variables and Actions variables

**Decision.** Add five new Terraform variables and expose each as a
repository Actions variable, following the established pattern used by
`ADMIN_ASSIGNEES`, `CODE_REVIEWERS`, `AUTO_TRIGGER_AGENTS`, etc. in the
`agent-vars` module (see [`terraform/modules/agent-vars/README.md`](../../terraform/modules/agent-vars/README.md)).

```hcl
variable "protected_pr_author_logins" {
  description = "GitHub login list whose PRs require the custom approval threshold, encoded for the Actions variable as JSON. Exposed as PROTECTED_PR_AUTHOR_LOGINS. Must be a non-empty JSON array of unique, non-empty strings when enable_protected_approval_gate is true. Defaults to the developer-agent bot login to preserve Issue #628's posture."
  type        = list(string)
  default     = ["mfrancza-developer-agent[bot]"]
  validation {
    condition     = length(var.protected_pr_author_logins) > 0 && alltrue([for login in var.protected_pr_author_logins : trimspace(login) != ""]) && length(distinct(var.protected_pr_author_logins)) == length(var.protected_pr_author_logins)
    error_message = "protected_pr_author_logins must be non-empty and contain unique, non-empty logins."
  }
}

variable "required_approval_count" {
  description = "Number of latest-per-reviewer non-self APPROVED reviews required for a protected PR. Exposed as REQUIRED_APPROVAL_COUNT. Must be a positive integer; defaults to 2."
  type        = number
  default     = 2
  validation {
    condition     = var.required_approval_count >= 1 && floor(var.required_approval_count) == var.required_approval_count
    error_message = "required_approval_count must be a positive integer."
  }
}

variable "enable_protected_approval_gate" {
  description = "When true, PRs authored by PROTECTED_PR_AUTHOR_LOGINS require REQUIRED_APPROVAL_COUNT qualifying approvals (excluding the PR author's own review) before they can merge. Enforced via a required status check on main-protection. Defaults to false (opt-in)."
  type        = bool
  default     = false
}

variable "enable_protected_approval_gate_reconcile_minutes" {
  description = "Minimum interval, in minutes, between sweeps of the Decision 8a pending-replacement safety-net workflow (`require-two-developer-approvals-reconcile.yml`). Exposed as the ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES Actions variable; sets the maximum staleness window for a shared-SHA block after the blocking dev-agent PR has moved on and the per-event cleanup was dropped by Actions concurrency pending-run replacement. Smaller values react faster but burn more Actions minutes. Defaults to 10, with a floor of 1 (the cron fires every minute). Implementation note: because `on.schedule.cron` is a build-time literal (GitHub Actions does not evaluate `${{ vars.X }}` inside it), the workflow commits to `cron: \"* * * * *\"` so every value of this variable from 1 upward is a real reduction in sweep latency. The activity's own early-exit guard queries this workflow's own recent completed runs via `GET /repos/{owner}/{repo}/actions/workflows/require-two-developer-approvals-reconcile.yml/runs?status=success&per_page=10`, excludes the current run by `GITHUB_RUN_ID`, and exits early when the most recent successful prior run completed less than `minutes` minutes ago. Values smaller than 1 are not useful; values up to any arbitrary ceiling are supported with no code change."
  type        = number
  default     = 10
}
```

All four variables are wired through `terraform/main.tf` →
`agent_vars` module → `github_actions_variable` resources named
`PROTECTED_PR_AUTHOR_LOGINS`, `REQUIRED_APPROVAL_COUNT`, `ENABLE_PROTECTED_APPROVAL_GATE`,
and `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`. The
branch-protection module gains a new input
`enable_protected_approval_gate_check_context` (defaulting to the
fixed context name `require-two-developer-approvals` defined by
Decision 6) that is referenced only when the opt-in is on.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Reuse `developer-author` (which stores one `app/<slug>`) | It cannot represent a configurable list, and it is a reusable-workflow input rather than an Actions variable available to this independent workflow. A JSON Actions variable is the natural fit. |
| Add a boolean key inside an existing JSON Actions variable (e.g. a new `two_developer_approvals` key in `AUTO_TRIGGER_AGENTS`) | `AUTO_TRIGGER_AGENTS` is about applying `agent:*` labels at SDLC transitions — a different domain. Overloading it would make its contract less cohesive and complicate the `fromJSON(vars.AUTO_TRIGGER_AGENTS)` consumers in `agent-auto-trigger.yml`. A dedicated boolean is clearer. |
| Expose only a module-level input on the branch-protection module and skip the Actions variable | The workflow needs to know, independently of the ruleset, whether to compute the check result at all. Without the Actions variable, the workflow would run against every PR, make API calls, and emit either `success` or `failure` — but there would be nothing in the ruleset referencing it, so a `failure` would be ignored. That is wasteful and surprising. Having both the Actions variable (consumed by the workflow) and the module input (consumed by the ruleset) keeps the two sides in step and makes the opt-in reversible in a single `terraform apply`. |
| Hardcode one protected identity or threshold in the workflow | It prevents adopters from protecting multiple identities or selecting their policy without editing trusted workflow code. |

### Decision 3 — Conditional required-check wiring in `branch-protection` module

**Decision.** Extend `terraform/modules/branch-protection/main.tf` so the
`main-protection` ruleset conditionally includes a `required_status_checks`
block referencing the two-approvals check context, controlled by a new
module input `enable_protected_approval_gate` (bool, default `false`).
The base `required_approving_review_count` stays at the existing default
(1) and is not touched.

Sketch (final syntax to be settled by the implementer against the
`integrations/github` provider's current schema):

```hcl
# In terraform/modules/branch-protection/main.tf, within the existing
# `rules { ... }` block of github_repository_ruleset.main:

locals {
  # Use the fixed context name unless the caller explicitly overrode
  # `enable_protected_approval_gate_check_context`.
  enable_protected_approval_gate_check_context_final = coalesce(
    var.enable_protected_approval_gate_check_context,
    "require-two-developer-approvals",
  )
}

dynamic "required_status_checks" {
  for_each = var.enable_protected_approval_gate ? [1] : []
  content {
    strict_required_status_checks_policy = false
    required_check {
      context        = local.enable_protected_approval_gate_check_context_final
      # integration_id MUST be set — leaving it unset does not default to
      # GitHub Actions; it leaves the required check's source unrestricted,
      # meaning any identity with status/check-publication permission on the
      # repo (another GitHub App, a classic PAT with repo:status, etc.) can
      # satisfy the required context without executing the gate workflow.
      # Pinning to the GitHub Actions App (public, well-known ID 15368) binds
      # the required context to the publisher we actually execute. See
      # GitHub Docs, "Available rules for rulesets > Require status checks
      # to pass" for the "specified source App vs. accept any source" split.
      # (See Decision 5's "Modified-notifier residual risk and defence-in-
      # depth" subsection for the residual spoofing concern this does
      # *not* defend against on its own.)
      integration_id = var.enable_protected_approval_gate_check_integration_id
    }
  }
}
```

New module variables:

```hcl
variable "enable_protected_approval_gate" {
  description = "When true, add the approvals status check as a required check on main-protection. The workflow gates only authors in PROTECTED_PR_AUTHOR_LOGINS until they meet REQUIRED_APPROVAL_COUNT. Defaults to false."
  type        = bool
  default     = false
}

variable "enable_protected_approval_gate_check_context" {
  description = "Status-check context name produced by the two-approvals workflow. Only used when enable_protected_approval_gate is true. Defaults to require-two-developer-approvals, the context published by this repo's require-two-developer-approvals-publisher.yml via the Checks API (see Decision 6 and Decision 7). Override only when publishing under a different name."
  type        = string
  default     = null  # Falls back to the fixed name; see locals in main.tf
}

variable "enable_protected_approval_gate_check_integration_id" {
  description = "Numeric App integration ID of the publisher that is allowed to satisfy the required check. Defaults to 15368 (the GitHub Actions App), matching the publisher workflow shipped with this repo. External adopters who publish from a different App (e.g. a self-hosted integration) must override this with their own App ID so the required-context binding stays tight; leaving it mismatched would silently prevent merges."
  type        = number
  default     = 15368
}
```

**Trust-boundary note.** Setting `integration_id` only restricts which
*App* is allowed to supply the required context; it does not by itself
ensure the Actions workflow run that produced the context executed
trusted (base-branch) code. The trust boundary of the publisher
execution is defined in Decision 5 (trigger model) and Decision 8
(serialization and head-SHA re-verification). Rulesets evaluate the
most-recent matching check-run on the head SHA, so a workflow run that
executed PR-controlled code and posted `conclusion = success` under the
expected integration_id would still satisfy the gate; the two layers
are complementary, not redundant.

`terraform/main.tf` passes the top-level `var.enable_protected_approval_gate`
through to the module. External adopters that use the published
`branch-protection` module can set it the same way.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Always include the required-check entry; let the workflow short-circuit with `success` when the opt-in is off | Would make the check context mandatory even when the feature is off, meaning every merge waits for the workflow to publish a result. Harmless when the workflow is healthy, but noisy if the workflow is broken or absent — the ruleset would block merges on a check nobody intentionally enabled. Conditional inclusion makes the "off" state truly zero-cost. |
| Hardcode the context name directly in `main.tf` instead of a module variable | Adopters forking the branch-protection module would have to patch the hardcode. A defaulted variable keeps the common case ergonomic and the override path open. |
| Use a separate ruleset scoped to the required status check only | Multiple rulesets on the same branch stack, but splitting across two rulesets makes the policy harder to reason about and audit. Keeping all branch rules in one ruleset mirrors the existing shape. |
| Enforce via `strict_required_status_checks_policy = true` (require the check to be from the latest head SHA) | Not needed and interacts awkwardly with `pull_request_review` events, which don't change the head SHA. The workflow handles staleness correctly on its own by always re-reading reviews from the API at run time. |

### Decision 4 — Configurable scope and "qualifying approval" semantics

**Decision.** The workflow groups reviews by reviewer login and keeps the
latest **opinionated** review state per reviewer: `APPROVED`,
`CHANGES_REQUESTED`, or `DISMISSED`. It ignores `COMMENTED` and `PENDING`
reviews when selecting that state, so a later non-opinionated review cannot
erase an earlier approval or request for changes. The selected review is
"qualifying" when **all** of the following hold:

1. Its selected opinionated state is `APPROVED` (not `CHANGES_REQUESTED` or
   `DISMISSED`).
2. Reviewer login is **not** the PR author's login.

The check conclusion is `success` iff the count of qualifying approvals is
at least `REQUIRED_APPROVAL_COUNT`. The custom threshold is evaluated only
when the PR author's login appears in `PROTECTED_PR_AUTHOR_LOGINS`; otherwise
the per-PR outcome is immediately `success`. All other `APPROVED` reviews count — including from the reviewer
agent, from Copilot, and from any human reviewer (regardless of whether
GitHub itself would count the approval for the `required_approving_review_count`
rule).

**Rationale.** The default list and threshold match the issue text, while
the configuration permits the same mechanism to protect more than one author
identity and to require another count. Excluding the PR author rather than a
single configured bot makes self-review exclusion correct for every protected
identity. The issue's
"Human authors, the reviewer agent, and any other bot are unchanged"
sentence refers to **PR authors**, not review authors — it carves out the
scope of the gate, not the counting rule. GitHub's own `required_approving_review_count = 1`
rule continues to insist on at least one write-access approval on top of
our custom check (see Decision 1), so a developer-agent PR with the opt-in
on can only merge with ≥1 write-access human approval AND the configured number of non-self
approvals. In practice this means a reviewer-agent approval alone cannot
satisfy both gates, which matches the existing [`docs/design/code-review-agent.md`](code-review-agent.md)
posture. This also matches GitHub's `latestOpinionatedReviews` semantics:
review comments communicate feedback without changing a reviewer's current
approval decision. It matters in this repository because the review matrix
can post more than one review from `mfrancza-reviewer-agent[bot]` on the same
SHA; a later `COMMENTED` result must not discard that login's earlier
`APPROVED` result.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Exclude all bot approvals (any login ending in `[bot]`) from the count | Would make the reviewer agent's `APPROVE` not count. The reviewer agent's approval is already advisory for the base `required_approving_review_count = 1` rule (read-only Contents permission), so excluding it from the custom count too would make the practical merge gate require the configured number of human approvals. This remains a possible future policy flag, but is distinct from configurable author scope and count. |
| Replicate GitHub's write-access rule exactly (count only approvals from users with write access on the repo) | Requires an extra API call per reviewer to resolve collaborator permissions, adds a failure mode, and still arrives at the same effective merge gate when combined with `required_approving_review_count = 1` (because that rule already enforces the write-access filter). Not worth the extra surface. |
| Let the chronologically latest review of any state replace the prior review | A later `COMMENTED` or `PENDING` review would erase an earlier `APPROVED` review from the same login. That differs from GitHub's opinionated-review semantics and breaks this repository's multi-reviewer-agent matrix. |

### Decision 5 — Trigger events, trust model, and workflow shape

**Decision.** Enforcement is split across **two workflows** so the publisher
always executes trusted base-branch code with a write-capable token, even
for pull requests from forks:

1. **Publisher** — `require-two-developer-approvals-publisher.yml`
   Triggered by `pull_request_target` (for the pull-request-side events)
   and by `workflow_run` (for the review-side events, chained through
   workflow 2). This is the workflow that actually calls the Checks API
   to publish the required-context conclusion.

2. **Review notifier** — `require-two-developer-approvals-notify.yml`
   Triggered by `pull_request_review`. Carries **zero permissions**, runs
   no application code (an empty job that always succeeds), and exists
   solely so that its completion fires a `workflow_run` event the
   publisher can react to under the trusted base-branch workflow
   definition.

```yaml
# require-two-developer-approvals-publisher.yml (trusted; runs base-branch code)
on:
  pull_request_target:
    # - opened/reopened/synchronize/edited: standard state transitions
    # - ready_for_review: draft → ready without a head change; the publisher
    #   skips drafts for cost reasons (see "Draft-handling contract" below)
    #   so this transition is the one guaranteed re-publication for the PR.
    # - closed: triggers the departed-SHA reconciliation in Decision 8a so
    #   that a sibling PR left on a shared head SHA gets its check-run
    #   recomputed when its sibling leaves (closed or merged).
    types: [opened, reopened, synchronize, edited, ready_for_review, closed]
  workflow_run:
    workflows: ["require-two-developer-approvals-notify"]
    types: [completed]
```

```yaml
# require-two-developer-approvals-notify.yml (untrusted; empty on purpose)
#
# IMPORTANT: `name:` is required here. GitHub's `on.workflow_run.workflows`
# filter matches the workflow's `name:` field; when `name:` is omitted,
# GitHub derives the workflow name from the relative path
# (`.github/workflows/require-two-developer-approvals-notify.yml`), which
# does NOT match the filename stem the publisher's filter uses. Without
# an explicit `name:` matching the filter string in the publisher sketch
# above (`workflows: ["require-two-developer-approvals-notify"]`), review
# `submitted` / `edited` / `dismissed` events would never start the
# publisher; a developer-agent PR would get the initial `failure` on
# `opened` and then stay failed forever even after two qualifying
# approvals landed. This repo already relies on the same discipline:
# `ci.yml` sets `name: CI` so `agent-fix-checks.yml` can filter
# `workflows: ["CI"]`. The publisher's filter string and this `name:`
# MUST stay in lockstep.
name: require-two-developer-approvals-notify

on:
  pull_request_review:
    types: [submitted, edited, dismissed]

permissions: {}
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'  # No app code. Existence of the completed run is the signal.
```

**Why two workflows (fork publication + trust anchor).**

- Under `pull_request` and `pull_request_review`, GitHub loads the
  workflow definition from the pull request's merge commit (GitHub Docs,
  "Events that trigger workflows > pull_request" and "pull_request_review";
  also "Securely using pull_request_target"). A same-repository PR that
  modifies either the workflow or any helper code it references could
  therefore rewrite the counting logic or make the activity publish
  `conclusion: success` unconditionally **before** that modification has
  been reviewed. Declaring `checks: write` on an untrusted event does not
  mitigate this — the attacker-controlled workflow definition inherits the
  declared permissions.
- Additionally, pull requests opened from forks receive a read-only
  `GITHUB_TOKEN` on `pull_request` / `pull_request_review` regardless of
  the `permissions:` block (GitHub Docs, "Events that trigger workflows >
  pull_request > Workflows in forked repositories"). The publisher's
  Checks API `POST` therefore cannot succeed on fork PRs under those
  events, which would leave the required context permanently unsatisfied
  on fork PRs and block the exact human PRs Requirement 6 says must stay
  unaffected.
- `pull_request_target` resolves both problems for the pull-request side:
  the workflow YAML and the composite action are loaded from the base
  branch (`github.sha` = base commit under this event), and the token is
  write-capable even on fork PRs.
- `pull_request_review` has no `_target` variant, so the standard mitigation
  is the `workflow_run` chaining pattern already used in
  [`agent-fix-checks.yml`](../../.github/workflows/agent-fix-checks.yml):
  an empty, zero-permission workflow (the "notifier") fires on the
  untrusted event; its completion delivers a `workflow_run` event, which
  always loads its workflow definition from the default branch and runs
  with the default-branch token. The notifier being empty means the
  attacker-controlled workflow definition executes nothing.

**Trusted helper-ref contract.**
- Under both `pull_request_target` and `workflow_run`, `github.sha` is
  the current base-branch (default-branch) HEAD of **this** repository:
  - `pull_request_target` — GitHub docs, "Events that trigger workflows
    > pull_request_target", state the workflow runs with the base commit
    checked out (`GITHUB_SHA = base-branch HEAD`).
  - `workflow_run` — GitHub docs, "Events that trigger workflows >
    workflow_run", explicitly state `GITHUB_SHA` for `workflow_run` is
    the **last commit on the default branch**, not the SHA of the
    originating run. (A previous draft of this document had the opposite
    claim — the reviewer corrected it.)
  Both legs of the publisher caller stub therefore pass
  `helpers-ref: ${{ github.sha }}`, matching the pattern established by
  [`agent-review.yml`](../../.github/workflows/agent-review.yml) and
  [`agent-fix-checks.yml`](../../.github/workflows/agent-fix-checks.yml).
  This selects a concrete commit SHA on the trusted base branch of the
  caller's repository.
- The alternative previously considered — passing
  `${{ github.event.workflow_run.head_repository.default_branch }}` —
  is **fork-controllable**. A fork can rename its own default branch to
  an arbitrary string, and that string is then resolved as a ref against
  the upstream helper repository. If a branch of the same name exists
  upstream (which a prior PR to the helpers repo could have created), the
  helper checkout pulls untrusted code; if the ref is absent, the
  checkout fails. Using the caller repo's `github.sha` instead avoids
  both failure modes because the value is derived from the upstream
  repo's own state, not from the fork payload.
- The published-reusable version pin for external callers remains the
  separate `helpers-ref` input described in
  [`docs/design/reusable-workflow-helper-resolution.md`](reusable-workflow-helper-resolution.md).
  External adopters pin to a tag or SHA of the helpers repo; the pattern
  above only applies when the caller is this repo.
- The notifier is intentionally stub-only; it does not take a
  `helpers-ref` input and performs no checkout, so there is no helper-ref
  concern on that path.

**Modified-notifier residual risk and defence-in-depth.**
Making the checked-in notifier empty does **not** make a PR-modified
notifier empty. Because `pull_request_review` loads workflow YAML from
the PR head commit, a same-repository PR can edit
`require-two-developer-approvals-notify.yml` to declare
`permissions: write-all` and add a `curl` step that POSTs a fake
`conclusion: success` check-run under the enforcing context name. Any
such run authenticates as the GitHub Actions App (integration_id 15368),
so the `integration_id` pin from Decision 6 does **not** reject it.
Equivalently, any other PR-controlled workflow in `.github/workflows/`
with `checks: write` can publish the same context. The design accepts
this specific attack class and relies on three layers of mitigation
documented together here:

1. **The baseline `required_approving_review_count = 1` rule is
   unaffected.** It still demands a write-access human approval before
   merge. An attacker who spoofs the enforcing-context `success` with a
   modified notifier cannot merge their PR with zero human approvals;
   the baseline rule is itself unspoofable from a workflow (it is
   evaluated by GitHub against actual review submissions, not against
   status checks). The effective merge gate under the attack is
   therefore **one** write-access human approval — the baseline — not
   two. This is a real degradation from the gate's intended semantics,
   which the shipping posture accepts.
2. **PR-visible blast radius (social mitigation, not an enforced
   gate).** Any attack of this shape requires editing a file under
   `.github/workflows/` (either
   `require-two-developer-approvals-notify.yml`, or any other
   workflow granting `checks: write`), which is highly visible in the
   PR diff and reviewable by the single human approver. The
   repository's existing `agent-review` posture already flags
   workflow edits for human attention. This is a **social** layer —
   it depends on the human reviewer catching the diff and refusing
   to approve. It is not an additional enforced merge condition and
   does not restore the "two approvals" guarantee at the GitHub
   policy layer; it only increases the likelihood that the single
   required human approver notices and rejects an attack of this
   shape. The reviewer correctly flagged the previous draft for
   implying otherwise.
3. **Trust-anchor acceptance test (Decision 9 item 3).** The acceptance
   test specifically edits the publisher workflow, the reusable, the
   composite action, the TypeScript activity, **and** the notifier (and
   additionally adds a spoof publisher workflow with `checks: write`)
   on the same PR. It asserts (3a) the authoritative publisher
   publishes the correct per-check-run conclusion based on real
   approvals, and (3b) the honest effective-merge-gate outcome
   under the attack: with one human approval, the attack can
   reduce the gate to the baseline (merge becomes possible with
   one approval); with zero human approvals, the baseline rule
   still blocks. The test does not assert an unconditional "two
   approvals required" because the shipping posture does not
   guarantee it.

**A stronger posture is possible but out of scope.** The only way to
reject spoofed check-runs structurally — not just by procedure plus
code review — is to publish the enforcing-context check-run from a
dedicated GitHub App whose private key is not available to any workflow
in `.github/workflows/`, and to pin `integration_id` to that App's ID
rather than to 15368. That would require provisioning a new App, a new
Terraform-managed App ID / private key pair, and a new publication
runtime outside Actions (or a self-hosted runner with scoped
credentials). The present design is explicit that the shipping posture
accepts the modified-notifier attack as a trade-off against that cost,
on the understanding that the baseline review rule still blocks a
zero-approvals merge and PR-diff visibility is the social layer that
makes the one-approval degradation observable. A dedicated publisher
App is listed in "Out of scope" and can be adopted later without
breaking the context name or ruleset shape.

**Maintainer confirmation required.** Shipping this design accepts
that under the modified-notifier attack the effective merge gate on
a dev-agent PR degrades from "two qualifying approvals" (the gate's
intended semantic) to "one write-access human approval" (the
baseline). That is a real reduction in the policy guarantee. The
`human-required` label on this PR captures the decision; a
maintainer must explicitly confirm that this degraded-under-attack
posture is acceptable to ship, or require the dedicated-publisher-App
structural fix listed in "Out of scope" to land first.

**Event-by-event rationale.**

- `pull_request_target: opened|reopened` — publish the initial check
  conclusion for a new PR (immediate success for non-dev-author PRs;
  initial `failure` for dev-author PRs with 0 approvals).
- `pull_request_target: synchronize` — recompute when new commits land.
  `dismiss_stale_reviews_on_push = true` (today's `main-protection` setting
  — see [`terraform/modules/branch-protection/main.tf`](../../terraform/modules/branch-protection/main.tf))
  automatically dismisses prior approvals on push; the publisher re-reads
  the latest states inside the serialization boundary defined by
  Decision 8 and reflects the new count. On `synchronize` the publisher
  **also** reads `github.event.before` as the departing head SHA and
  invokes the Decision 8a departed-SHA reconciliation so sibling PRs
  left on the old SHA get their check-run recomputed.
- `pull_request_target: edited` — defensive; cheap to handle and keeps the
  conclusion resilient to any PR metadata change we might key off later.
- `pull_request_target: ready_for_review` — fires when a PR transitions
  from draft to ready. GitHub exposes this as a distinct `pull_request`
  activity type (not covered by `edited`); without it a PR that received
  review activity while draft, or that was marked ready with no head
  change afterwards, would have no publication under the enforcing
  context until some unrelated later event — breaking Requirement 6 for
  non-dev-author PRs opened as drafts and leaving dev-agent PRs in a
  pending-forever state. On this event the publisher skips its usual
  draft-filter and publishes against the live head SHA per Decision 8.
- `pull_request_target: closed` — fires when a PR is closed or merged.
  The publisher does **not** post a conclusion for the closed PR itself
  (closed PRs cannot merge, so no gating applies); instead it invokes
  the Decision 8a departed-SHA reconciliation path against the closed
  PR's `pr.head.sha`, so any sibling PRs that still share that commit
  get their check-run recomputed without the closed PR's contribution.
- `workflow_run (require-two-developer-approvals-notify)` — fires after
  every `pull_request_review: submitted|edited|dismissed`. The publisher
  reads the triggering PR from `github.event.workflow_run.pull_requests[0]`
  (same shape agent-fix-checks already uses) and recomputes.

**Draft-handling contract.** For cost reasons the publisher's `if:`
guard skips the main publication path on draft PRs (drafts cannot
merge, so the gate's conclusion has no near-term effect). The
`ready_for_review` trigger above is the explicit reconciliation point
that guarantees a published conclusion exists for the live head SHA
by the time the PR is actually eligible to merge, regardless of what
events arrived while the PR was draft. The acceptance contract tests
this explicitly: a dev-agent PR opened as draft, approved twice while
draft, then marked ready with no further events, must have a
`success` check-run on its live head SHA by the time
`ready_for_review` finishes (Decision 9).

**Workflow permissions.** The publisher declares
`contents: read, pull-requests: read, checks: write`. `contents: read` is
required by the reusable's four-step helper-checkout bootstrap; declaring a
`permissions:` block without it clears the token's Contents permission and
makes that checkout fail. The remaining permissions are honoured because the
publisher runs under `pull_request_target` and `workflow_run`, both of
which issue a write-capable `GITHUB_TOKEN` even for fork-headed PRs. The
notifier declares `permissions: {}`.

**No PR head checkout anywhere.** The publisher reads only PR metadata
and review states via Octokit against the GitHub API; nothing from the
PR workspace is required. The composite action step list therefore
contains no `actions/checkout` with `ref:` pointing at a PR SHA (same
posture as `agent-review-reusable.yml`'s preflight job).

**Caller-stub + reusable split.** Both the publisher and the notifier
follow the repo's caller-stub + reusable pattern. The publisher caller
stub holds the triggers, the trust-model `if:` conditions (same-repo
guard isn't required because the publisher never checks out PR code —
but the `if:` filters the *main publication path* for draft PRs
(cost: drafts cannot merge, so the near-term gate conclusion has no
effect) and for closed PRs *that are not the subject of departed-SHA
reconciliation* (a `closed` event always runs so Decision 8a can
recompute sibling check-runs; a `synchronize` or `ready_for_review`
event always runs even on a draft because of the draft-handling
contract above), the
`PROTECTED_PR_AUTHOR_LOGINS` / `REQUIRED_APPROVAL_COUNT` /
`ENABLE_PROTECTED_APPROVAL_GATE` variable reads,
and the trusted-ref selection for `helpers-ref`. The reusable holds the
composite-action invocation and the four-step helper-checkout bootstrap
(AGENTS.md § "Reusable workflows: self-checkout for helper actions").
The computation is a TypeScript activity under `.github/scripts/src/`
wrapped as a composite action under `.github/actions/` (per AGENTS.md
§ "Workflow Activity Conventions").

The `workflow_run` leg of the publisher caller stub **also** carries
the `agent-fix-checks.yml`-style null guard on its job `if:` so the
reusable is never invoked with an empty `pr-number`:

```yaml
# publisher caller stub (workflow_run leg)
jobs:
  publish:
    if: github.event.workflow_run.pull_requests[0] != null
    uses: ./.github/workflows/require-two-developer-approvals-publisher-reusable.yml
    with:
      pr-number: ${{ github.event.workflow_run.pull_requests[0].number }}
      event-head-sha: ${{ github.event.workflow_run.pull_requests[0].head.sha }}
      helpers-ref: ${{ github.sha }}
```

`workflow_run.pull_requests` is empty when GitHub cannot associate the
triggering run with a PR — the documented case is fork-headed PRs — so
without this guard the reusable would be invoked with an empty
`pr-number` input and fail inside the activity. The pair of (null `if:`
guard, `|| github.event.workflow_run.id` fallback in the concurrency
key) is copied verbatim from `agent-fix-checks.yml` so adopters have a
single reference implementation to follow.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Trigger only on `pull_request` + `pull_request_review` with `checks: write` | Does not work for fork PRs (read-only token on those events — see rationale above) and does not establish a trusted execution anchor (both events run the PR-head workflow definition). Blocks Requirement 6 and lets same-repo PRs rewrite the gate. |
| Use `pull_request_target` for both the PR-side and the review-side events | `pull_request_target` has no `pull_request_review` sub-type; it does not fire on review submissions. Chaining through a notifier + `workflow_run` is the standard GitHub-sanctioned pattern. |
| Pin `helpers-ref` to a hardcoded repository branch name like `main` | Loses the single-source-of-truth property that `agent-review.yml` relies on and makes external adopters whose default branch is not `main` patch the stub. The caller repo's `github.sha` (default-branch HEAD under both `pull_request_target` and `workflow_run`) is already a trusted ref derived from upstream state, so no hardcoded branch name is needed. |
| Pass `${{ github.event.workflow_run.head_repository.default_branch }}` as `helpers-ref` | Fork-controllable: a fork can name its default branch anything, and that name is then resolved against the upstream helpers repo. If a same-named branch exists upstream (which an earlier PR to the helpers repo could have created), the publisher checks out untrusted code; if absent, the checkout fails. The caller repo's `github.sha` is derived from upstream repo state, not the fork payload, and avoids both failure modes. |
| Trigger only on `pull_request_review` (ignore pull-request events entirely) | Misses the initial state when a PR is opened or when new commits land before any reviews exist. The check stays in "no status" / pending indefinitely, which some GitHub UIs render as a merge block without context. |
| Trigger on `pull_request_review_thread` | Thread resolution does not change the approval count. Not relevant. |
| Omit `ready_for_review` from the trigger set | Previous draft did this. A dev-agent PR opened as draft that received approvals while draft and was then marked ready with no further events would stay without a published conclusion on its live head until some unrelated later event; a non-dev-author PR opened as draft would similarly stay without the Requirement 6 `success` publication until later. GitHub exposes `ready_for_review` as a distinct `pull_request` activity type — it is **not** covered by `edited`, `opened`, or `synchronize`. Included explicitly. |
| Omit `closed` from the trigger set | Previous draft did this. When a dev-agent PR closes while sharing a head SHA with a human PR (Decision 8a scenario), the human PR's check-run on the shared SHA remains at its old `failure` conclusion with no event available to recompute it. Including `closed` lets the publisher invoke the departed-SHA reconciliation subsection of Decision 8a and republish the shared-SHA check-run with the closed PR's contribution removed. |
| Trigger on `schedule` as a safety net | Not needed. The event triggers (including `ready_for_review` and `closed` above) cover every state change that matters; a cron rerun would recompute the same answer most of the time and add noise. |

### Decision 6 — Publish the check conclusion via the Checks API, with a stable context name bound to the GitHub Actions App

**Decision.** The activity publishes the check conclusion using the
Checks API (`POST /repos/{owner}/{repo}/check-runs`) with the fixed
`name` `require-two-developer-approvals`.
When the opt-in is OFF, the preview context is
`require-two-developer-approvals (preview)` (see
Decision 7 for why the enforcing context is not published in OFF
mode). The ruleset's `required_status_checks` block references the
same enforcing context **and pins its `integration_id` to
the GitHub Actions App (public ID 15368)** so only check-runs
produced by the publisher workflow can satisfy the required context
(see Decision 3 for the ruleset side and Decision 5 for the residual
risk the pin alone does not defend against). The workflow job itself
also pass/fails for debuggability, but it is the Checks API
conclusion the ruleset evaluates.

**Rationale.** Using an explicit Checks API call gives us:

- A stable check context name that is independent of the GitHub Actions
  job-naming convention (which concatenates workflow display name,
  reusable workflow name, and job id — and changes whenever those strings
  are reworded, breaking the ruleset reference). Status-check names
  listed in `required_status_checks` are matched literally; a mismatch is
  silently "pending forever", which is exactly the kind of failure mode
  AGENTS.md "Known traps" warns against.
- Explicit `conclusion: success | failure` with an `output.summary` field
  explaining the current approval tally and the configured identity, so
  the check surfaces diagnostic information directly in the PR UI
  (how many approvals we counted, which approvals were excluded as self-reviews).
- The `workflow_run`-chained publisher can still post against the PR's
  head SHA regardless of the triggering event, because the activity
  passes the resolved head SHA as the check-run's `head_sha` argument
  (`github.event.pull_request.head.sha` under `pull_request_target`;
  `github.event.workflow_run.pull_requests[0].head.sha` under
  `workflow_run`). The implementer must re-fetch and verify the head SHA
  from the API inside the serialization boundary before publishing (see
  Decision 8) so stale events do not overwrite a conclusion computed for
  a newer commit.

**Why `integration_id` must be pinned.**
Rulesets' `required_check` entries, when `integration_id` is omitted,
accept a check-run of the specified `context` name **from any source**
with permission to publish check-runs on the repo — not just from GitHub
Actions. GitHub's own ruleset documentation ("Available rules for
rulesets > Require status checks to pass") explicitly distinguishes a
specified-source App from accepting any source. Without this pin, any
other identity with status/check-publication permission on the
repository (a different GitHub App, a classic PAT with `repo:status`,
etc.) could POST a `conclusion: success` under the gate's context name
and bypass the workflow entirely. Pinning to 15368 binds the required
context to the publisher we actually execute. An external adopter whose
publisher runs under a different App must override
`enable_protected_approval_gate_check_integration_id` to that App's ID.
Decision 9 includes an acceptance test that posts the context from a
non-matching App and confirms the required check is **not** satisfied.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Rely on the job's pass/fail outcome as the required check context | Context name becomes "require-two-developer-approvals / check" where the parts come from the workflow name and job id as GitHub assembles them. Renaming either side silently breaks the ruleset reference. The Checks API approach decouples the published name from the YAML surface, and lets both the publisher and `workflow_run` paths produce the same context. |
| Omit `integration_id` on the required_check entry | Leaves the required context satisfiable by any identity with check-publication permission (see "Why `integration_id` must be pinned" above). |
| Use the Commit Statuses API (`POST /statuses/{sha}`) | Deprecated in favour of the Checks API for new integrations. Checks API is better integrated with the ruleset UI (shows per-check conclusions, logs, re-run button). |
| Publish once per workflow run but let GitHub infer success-on-missing-failure | Rulesets block merge until the named check is present with `conclusion = success`. "Infer success" is not an option; the check has to be posted. |

### Decision 7 — Fail-loud misconfiguration, fail-closed activation, and no cross-mode context reuse

**Decision.** The publisher distinguishes **three** operating states and
handles each with a specific publication posture:

1. **Opt-in OFF (default).** The publisher **does not publish anything
   under the enforcing context**
   (`require-two-developer-approvals`). It
   optionally publishes a diagnostic context named
   `require-two-developer-approvals (preview)` that
   reflects what the gate *would* say if enabled. The ruleset never lists
   the preview context as required, so the preview has no gating effect;
   its purpose is to let maintainers see what enabling the opt-in would do
   without affecting any merge decisions. The enforcing-context check-run
   from a prior OFF-mode run is **not** reused: see "Activation
   reconciliation" below.
2. **Opt-in ON, configuration valid.** The publisher computes the
   qualifying-approval count per Decision 4 and publishes
   `success` / `failure` on the enforcing context.
3. **Opt-in ON, invalid scope or threshold (misconfiguration).** If
   `PROTECTED_PR_AUTHOR_LOGINS` is empty, malformed JSON, or contains a
   duplicate/empty login, or `REQUIRED_APPROVAL_COUNT` is not a positive
   integer, the activity emits an error and publishes `failure` on the
   enforcing context for every PR. It cannot safely select the protected
   subset or compute its threshold, so failing every PR visibly is safer
   than silently letting protected PRs through.

**Activation reconciliation across the full ON ↔ OFF cycle.**
Flipping `enable_protected_approval_gate` from `false` to `true` in
Terraform (and the matching Actions-variable change) does not by itself
fire any of Decision 5's events on existing open PRs — the ruleset
change and the `vars.*` change are not PR events. Without extra
handling, an already-open developer-agent PR whose head SHA had not
changed could satisfy the newly enforcing context from (a) a stale
`success` check-run posted during an earlier ON interval and never
invalidated, (b) sheer absence of a matching check-run on an unchanged
head (fail-closed, which is desired), or (c) an updated-review state
that happened entirely while the gate was OFF.

Case (c) is the specific defect the reviewer identified for the
ON → OFF → ON cycle. Example: start ON with two qualifying approvals
and a published `success`; flip OFF; dismiss one approval while OFF
(the publisher updates only the preview context, as Decision 7
mandates); flip ON again without changing the head. The ruleset now
requires the enforcing context, and the pre-OFF `success` check-run
is still the most-recent one for that context on the unchanged head
SHA, so the ruleset accepts it even though the live approval state is
now 1-not-2.

To make activation safe across the full cycle, the enforcing context
keeps a **fixed name** and stale results are **replaced**, not hidden.
GitHub evaluates the most recent check-run with the required name on
the head SHA, so re-publishing the current evaluation under the same
name supersedes any earlier result. Two paths re-publish on every open
PR, documented in
[`terraform/modules/branch-protection/README.md`](../../terraform/modules/branch-protection/README.md)
and `docs/adopting.md`:

**Enable procedure (OFF → ON).**

1. Set `enable_protected_approval_gate = true` and `terraform apply`.
   This adds the required check to the ruleset and sets
   `ENABLE_PROTECTED_APPROVAL_GATE = true` (for adopters who manage the
   Actions variable manually, set it as a follow-on step).
2. Dispatch the one-shot reconciliation workflow
   `require-two-developer-approvals-backfill.yml` (a trivial
   `workflow_dispatch`-only wrapper around the publisher activity that
   fans out across `gh pr list --state open --json number,headRefOid`).
   It publishes the current evaluation under the enforcing context on
   every open PR's live head SHA. That overwrites any `success` left
   from an earlier ON interval (cases (a) and (c)) and posts a result on
   PRs that had none (case (b), fail-closed until then).

**Automatic catch-up.** If the operator skips step 2, the Decision 8a
reconcile sweep (`require-two-developer-approvals-reconcile.yml`)
re-publishes the enforcing context on every open PR once every
`ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` (default 10) while
the gate is ON. A stale `success` from a prior ON interval is therefore
exposed for at most one sweep interval after a re-enable, and the
backfill closes that window immediately. The first enable has no
exposure at all: OFF mode never publishes the enforcing context, so no
prior result exists.

**Disable procedure (ON → OFF).** Set
`enable_protected_approval_gate = false` and `terraform apply`. The
required-check entry is removed from the ruleset, so stale
enforcing-context check-runs on open PRs stop being evaluated and
cannot block merges. The publisher stops posting the enforcing
context going forward (per state 1 of Decision 7). No invalidation
pass is needed on disable: the next enable re-publishes current
results through the backfill and the reconcile sweep.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Publish `success` on the enforcing context when the opt-in is off | Was the original design; the OFF-mode success can satisfy the newly enforcing rule on an unchanged head SHA when the opt-in is flipped ON, allowing an already-open developer-agent PR to merge with fewer than two approvals. Replaced by "preview-context only in OFF mode" per the Decision above. |
| Skip the job entirely when the opt-in is off | The preview-context posting is a cheap signal that lets maintainers see what the gate would do if enabled, catching misconfiguration before activation. Keeping the publisher running also keeps the end-to-end wiring exercised. |
| Fail open (treat invalid scope as "no PRs match → always success") when the opt-in is on | Silently defeats the whole feature. |
| Fail closed on only the protected-author path when scope is invalid | Insufficient: without a valid list the publisher cannot tell which subset to block. Blocking every PR with an error is the correct behaviour because the misconfiguration prevents the gate from working on *any* PR. |
| Enable in a single step (flip both Terraform and the Actions variable in the same `terraform apply`) | Also acceptable because the fail-closed posture holds between the two apply operations — Terraform sequences the ruleset change before the Actions-variable change within one apply only when the dependency graph requires it, and in this repo they are independent resources. The two-step document still recommends the backfill because the ruleset flip alone does not re-post anything on existing open PRs, so the backfill is where the operator confirms activation worked. |
| Generation-suffixed context name (`require-two-developer-approvals-g<N>`) bumped on every re-enable | Was the design as first merged (#666), removed by #702. A bump made earlier check-runs invisible to the ruleset, but only if the operator remembered to bump on every re-enable, and the ruleset context and a separate `ENABLE_PROTECTED_APPROVAL_GATE_CHECK_GENERATION` Actions variable had to change in lockstep. Forgetting the bump reintroduced the stale-`success` defect; a ruleset/variable mismatch either blocked every protected PR or reintroduced it. The fixed name with backfill and the existing reconcile sweep gives the same protection with less configuration, and bounds the exposure to one reconcile interval when the backfill is skipped. |

### Decision 8 — Per-PR serialization and stale-write guard

**Decision.** The publisher serializes all check publications for a
given PR, and re-fetches review state and the current head SHA from the
GitHub API **inside** the serialization boundary before writing the
check-run. Writes that race are either queued (not cancelled) or
discarded if they would overwrite a conclusion computed from a newer
head SHA.

**Serialization mechanism.** Both the publisher caller stub and the
notifier caller stub set a `concurrency` block keyed on the PR number:

```yaml
# publisher (pull_request_target leg)
concurrency:
  group: require-two-developer-approvals-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

# publisher (workflow_run leg)
#
# `github.event.workflow_run.pull_requests` is EMPTY when GitHub cannot
# associate the triggering run with a PR — the documented case is
# fork-headed PRs (GitHub Docs, "Events that trigger workflows >
# workflow_run"), where `pull_requests` is omitted entirely. Without a
# fallback the group key collapses to `require-two-developer-approvals-pr-`
# for every fork-headed trigger, serializing unrelated events across all
# fork PRs. `agent-fix-checks.yml` already uses the correct shape — this
# sketch must copy both the `|| github.event.workflow_run.id` fallback in
# the group key AND the null guard on the job's `if:` condition so the
# reusable isn't invoked with an empty `pr-number`:
#
#     if: github.event.workflow_run.pull_requests[0] != null
#
# `[0]` is also only sufficient as a concurrency-key hint / starting
# point: Decision 8a already re-resolves the full candidate PR set from
# the authoritative paginated open-PR listing, so a case where two PRs
# share a head SHA is handled correctly in the activity even though
# `workflow_run.pull_requests[0]` only names one of them.
concurrency:
  group: require-two-developer-approvals-pr-${{ github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.id }}
  cancel-in-progress: false
```

`cancel-in-progress: false` is deliberate — cancelling an in-flight
publication is the specific failure mode flagged by the reviewer
(the race in which run A publishes success after run B has already
published failure, leaving the merge-gate inconsistent with the live
review state).

**Re-fetch and always-publish-against-live-head.** Before the Checks
API POST, the activity:

1. Re-fetches the PR via `GET /repos/{owner}/{repo}/pulls/{number}` and
   captures `pr.head.sha` as `liveHeadSha`. This value is the authority
   for both the counting target and the publication target — the event
   payload's head SHA is treated as advisory only.
2. Re-fetches reviews via `GET /repos/{owner}/{repo}/pulls/{number}/reviews`
   (paginated) and applies the Decision 4 counting rule to the latest
   per-reviewer `APPROVED` set as of `liveHeadSha`.
3. Publishes the check-run with `head_sha: liveHeadSha`, regardless of
   whether `liveHeadSha` agrees with the SHA the workflow was triggered
   on. If `liveHeadSha` differs from the event SHA, the activity logs
   the correction (which is useful for debugging stale-event delivery)
   but still publishes — the publication is for the live head, not the
   stale event. See the reconciliation discussion below for why "exit
   silently on mismatch" was rejected.

**Why always-publish-against-live-head is necessary (and why queueing
alone is not).** GitHub Actions concurrency with `cancel-in-progress:
false` serializes job *start* order within a group, but the
documented behaviour (GitHub Docs, "Control the concurrency of
workflows and jobs > Example: using concurrency and the default
behaviour") is that **at most one run is kept pending** per group; a
third event arriving while A is running and B is pending **replaces B
with the new event**, dropping B entirely. The three-run interleaving
the reviewer identified is therefore live:

- Run A triggered by event at head H1 — in progress.
- Run B triggered by event at head H2 (synchronize to new commit) —
  queued as pending.
- Run C triggered by a delayed webhook for an earlier state at head
  H1 — replaces pending B. B is discarded.
- A completes.
- C starts. C's event SHA is H1, which is stale (live head is now H2).

Under the earlier draft of Decision 8 ("exit 0, publish nothing on
head-SHA mismatch"), C would exit without publishing, and because B
was discarded by the replacement, **no run would ever publish for
H2** — the gate would stay in whatever state A left it. If A ran
against stale H1 state too, H2 could remain missing a required
check-run indefinitely, so the ruleset would block merge forever
(fail-closed, but surprising). If A happened to publish `success`
against H1 and the ruleset is lenient about `strict_required_status_checks_policy`
being `false` (which it is per Decision 3), the stale success could
in principle be inherited.

The corrected rule — **always publish against `liveHeadSha`, never
against the event SHA** — removes the dependency on "a newer event
is queued behind us". Each run reconciles the ruleset's expectation
against the live head itself, so a run started for H1 publishes for
whatever the head is at run time (H2 if a synchronize already landed,
or still H1 if not). Combined with `cancel-in-progress: false`, the
sequence of publications on a group is still monotonic in start
order, and the final publication of each group always matches the
final `pr.head.sha` at that run's start time.

A `synchronize` event is dispatched for every push to the PR branch
and always triggers a publisher run under `pull_request_target:
synchronize`, so after any head change at least one more publisher
run will begin and reconcile. The combination guarantees "eventually
the live head has a publication reflecting the live state", which is
the invariant the ruleset requires.

**Acceptance test for stale-event replacement.** Decision 9 item 5 is
extended to cover the three-run interleaving above: fire approve on
H1, push a new commit landing H2, then deliver a stale webhook for
H1 — assert that the final check-run on H2 reflects the real
post-synchronize approval state (i.e. 0 qualifying approvals, since
`dismiss_stale_reviews_on_push = true` wiped the H1 approval), with
no stale H2 result inherited from the pre-synchronize world.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| `cancel-in-progress: true` | Cancelling in-flight runs sounds like it serializes correctly, but it introduces the opposite race: the in-flight run (reading post-dismissal state) gets cancelled by the arrival of a stale event, which then publishes a stale success. The correct posture is queue-and-recompute, not cancel. |
| Rely on event ordering without re-fetch | Webhook delivery is not strictly ordered relative to review state transitions. Re-fetching from the API inside the boundary is the only way to be sure the published conclusion matches the live state. |
| On event-vs-live head SHA mismatch, exit 0 and publish nothing (previous draft) | Relies on "a newer event is already queued behind us", which GitHub's documented concurrency behaviour does not guarantee — a third event can replace the pending second, so no run ever runs for the live head. See the "Why always-publish-against-live-head is necessary" discussion above. The corrected rule publishes against `liveHeadSha` in all cases. |
| Use an external lock / Redis / etc. | Workflow-level concurrency plus API re-fetch is sufficient for a per-PR serialization boundary and introduces no new infrastructure. |

### Decision 8a — Cross-PR head-SHA sharing

**Decision.** The Checks API publishes check-runs keyed by
`(repository, head_sha, context_name)` — not by PR number — and the
ruleset evaluates per-head-SHA. Two or more open PRs can therefore
share a head commit SHA (e.g. two branches that both point at the
same commit; a human-opened PR and a dev-agent-opened PR each
proposing the same commit; a dev-agent reopen of a prior branch).
Per-PR concurrency groups (Decision 8) serialize writers *for the
same PR* but do not serialize two different PRs' publishers racing on
the same head SHA, and a `success` posted for a non-dev PR on a SHA
would otherwise satisfy the required-check lookup for a dev-agent PR
sharing that SHA with fewer than two approvals.

To make the published check-run on a head SHA reflect **the strictest
qualifying-approval requirement across every open PR that currently
has that SHA as its head**, the activity performs this lookup *inside the
per-SHA lock* and then:

1. Resolves `candidatePrNumbers` by paginating
   `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100` and
   filtering the authoritative open-PR listing to `head.sha ==
   liveHeadSha`. It deliberately does **not** use
   `GET /commits/{sha}/pulls`: that commit index can lag newly opened
   sibling PRs, and re-checking only returned rows cannot detect an
   omitted under-approved protected PR. The triggering PR is included
   only if it is still open and its re-fetched head is `liveHeadSha`.
   If the open-PR listing or pagination fails, the activity must fail
   closed: publish a `failure` conclusion for `liveHeadSha` with an
   error summary (unless the Checks API itself is unavailable, in which
   case fail the job loudly), and must never publish `success` from an
   incomplete candidate set.
2. For each candidate PR, re-fetches the PR via
   `GET /repos/{owner}/{repo}/pulls/{number}` to read `user.login`
   (PR author) and the latest `pr.head.sha` (to drop any PR whose
   head has moved since step 1).
3. For each remaining candidate, applies the per-PR qualifying rule
   from Decision 4:
   - If PR author is **not** in `PROTECTED_PR_AUTHOR_LOGINS`, the per-PR
     outcome is `success` (Requirement 6).
   - If PR author **is** in `PROTECTED_PR_AUTHOR_LOGINS`, re-fetches reviews
     via `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, counts
     latest-opinionated-per-reviewer `APPROVED` reviews excluding that PR's author,
     and the per-PR outcome is `success` iff count ≥
     `REQUIRED_APPROVAL_COUNT`.
4. Publishes a single check-run for `liveHeadSha` under the enforcing
   context name with `conclusion = success` iff **every** candidate
   PR's per-PR outcome is `success` (strictest wins — if any protected
   PR has fewer than its configured threshold, the whole SHA is `failure`). The
   `output.summary` lists the candidate PR numbers and each one's
   per-PR outcome so reviewers can see why the SHA was blocked.

The per-PR concurrency group from Decision 8 is extended on the
publisher side to **additionally** take a shared lock on the head SHA
via a secondary concurrency group
`require-two-developer-approvals-sha-${liveHeadSha}` on a dedicated
sibling job that runs the per-SHA publication; the per-PR job
computes and hands off, and the per-SHA job serializes publications
on the SHA. This prevents two different PRs' publishers from racing
on the same SHA. (Actions supports at most one `concurrency` block
per job, which is why this is split across two jobs rather than one.)

**Departed-SHA reconciliation.** When a PR leaves a shared SHA, the
remaining open candidate PRs on that SHA need their published
check-run recomputed with the departing PR's contribution removed —
otherwise a human PR left on a SHA that was previously
`failure`-blocked by a since-closed under-approved dev-agent PR would
stay blocked forever (no event in the previous trigger set fires on
the remaining PR). A `synchronize` push on the dev-agent PR to a new
head produces the equivalent problem: the dev-agent PR's own
publisher recomputes against its new head SHA per Decision 8, but
the old head SHA — still the human PR's head — gets no update.

The publisher therefore computes a **departing SHA set** per event
and runs the Decision 8a strictest-wins intersection a second time
against each departing SHA (with the departing PR filtered out):

1. **`pull_request_target: synchronize`** — the departing SHA is
   `github.event.before` (the PR's prior head commit; GitHub populates
   this field on every `synchronize` event). The departing PR number
   is `github.event.pull_request.number`.
2. **`pull_request_target: closed`** — the departing SHA is
   `github.event.pull_request.head.sha` at close time (which is the
   PR's current head, since no further pushes happen after close).
   The departing PR number is `github.event.pull_request.number`.
3. **`workflow_run`** and other triggers do not produce a departing
   SHA; reconciliation is only relevant to events where a PR
   genuinely leaves a SHA.

For each departing SHA, under the per-SHA concurrency lock
`require-two-developer-approvals-sha-${departingSha}` (a sibling job
to the live-head publication, so the same workflow run holds both
locks), the activity:

- Paginates `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100`,
  filters to `head.sha == departingSha`, and **excludes the departing
  PR number**. This uses the same authoritative open-PR source as the
  live-head path rather than the lag-prone commit→PR index; the explicit
  exclusion remains necessary whether or not the closed/moved PR has
  already disappeared from that listing. A listing failure follows the
  same fail-closed rule: publish `failure` on `departingSha` if possible
  and fail the job loudly; never publish `success` from a partial set.
- If the remaining-candidate set is empty, no republication is
  needed: the stale check-run on `departingSha` is now orphaned
  (no open PR has that SHA as head) and cannot block any merge.
- Otherwise, applies the Decision 8a strictest-wins intersection
  across the remaining candidates and publishes an updated
  check-run with `head_sha: departingSha` under the enforcing
  context name. The `output.summary` lists which PR left and which
  remain.

The live-head publication path (Decision 8 against `liveHeadSha`)
and the departed-SHA reconciliation path both run in the same
workflow invocation but as separate jobs so each can take its own
per-SHA concurrency lock. Both paths complete before the run exits.

The departing-SHA path is a no-op **only** when the departing PR is
still open with that SHA as its live head — i.e. the triggering
event did not actually move the PR off `departingSha`. Concretely,
the activity skips the second path iff **all** of the following hold:

- `liveHeadSha == departingSha` (the triggering PR's current head
  still matches the computed departing SHA), **and**
- the triggering PR's `state` is `open` (it has not been closed).

If the triggering event is `pull_request_target: closed`, the PR
has left the SHA permanently regardless of whether its last-known
`head.sha` equals the current `liveHeadSha` — closing a PR removes
its contribution to the shared-SHA strictest-wins intersection, so
reconciliation **must** run. The previous draft's unconditional
`liveHeadSha == departingSha` no-op was wrong for exactly this case:
a `closed` event on a dev-agent PR whose head never changed between
open and close would short-circuit the reconciliation, and the
human PR left on the shared SHA would stay blocked indefinitely.

**Departed-SHA cleanup must survive pending-run replacement.** The
inline per-event cleanup above is the fast path. It does not,
however, cover the pending-run replacement scenario documented in
Decision 8:

- Run A (triggered by some event on PR number N) — in progress.
- Run B (triggered by `pull_request_target: synchronize` on PR N
  moving H1 → H2) — queued as pending with `departingSha = H1`.
- Run C (triggered by a review event on PR N via the notifier →
  `workflow_run` chain) — replaces pending B. B is discarded
  entirely; its `departingSha = H1` computation never runs. C's
  trigger is `workflow_run`, which produces **no** departing SHA
  (see item 3 above).
- A completes. C runs, reconciles live H2 correctly, but never
  touches H1. The human PR still at H1 remains blocked indefinitely
  with no subsequent event guaranteed to fire on it.

To make reconciliation survive this (and the equivalent case where
`B` for a `closed` event is dropped by a later notifier-driven C),
the design adds a **periodic reconciliation sweep workflow**
`require-two-developer-approvals-reconcile.yml`:

- Triggered by `schedule: cron: "* * * * *"` (every minute — a
  build-time literal because `on.schedule.cron` does not evaluate
  `${{ vars.X }}`), **and** by `workflow_dispatch` for operator-
  initiated reconciliation. The sweep's effective interval is
  tunable via a Terraform-managed Actions variable
  `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` (default
  10 minutes) consumed by the activity's own early-exit guard:
  before doing any work, the activity calls
  `GET /repos/{owner}/{repo}/actions/workflows/require-two-developer-approvals-reconcile.yml/runs?status=success&per_page=10`,
  excludes the current run (identified by `GITHUB_RUN_ID`), and
  exits 0 immediately when the most recent prior successful run
  completed less than `minutes` ago. The committed `* * * * *` cron
  guarantees that smaller `minutes` values are a real reduction in
  sweep latency (down to a floor of 1 minute); larger values are
  honoured because the surplus cron fires early-exit cheaply.
  Choosing a per-minute cron with early-exit — rather than
  committing a specific `*/N * * * *` literal and treating the
  variable as a no-op below the committed N — is intentional: the
  reviewer correctly pointed out that under a committed `*/10 * * * *`,
  values below 10 would be silently ignored and the "smaller values
  react faster" promise would be false. The reconcile workflow must
  declare `permissions: { contents: read, actions: read, pull-requests:
  read, checks: write }`: `contents: read` is required by the reusable's
  helper-checkout bootstrap and `actions: read` is required for this runs
  lookup. If that
  lookup errors, the activity must **not** early-exit; it logs an error
  and continues with a full reconciliation. If an open-PR listing or
  check publication then fails, it follows the fail-closed publication
  rule above and fails the job loudly, rather than reporting a successful
  sweep that silently left a stale result in place.
- Takes its own repository-wide concurrency group
  `require-two-developer-approvals-reconcile` with
  `cancel-in-progress: false`, so it does not share concurrency
  with any per-PR publisher run and cannot be dropped by pending-run
  replacement there.
- Enumerates all open PRs via `gh pr list --state open --json
  number,headRefOid,author,isDraft`, resolves each to its live head
  SHA, and runs the Decision 8a strictest-wins intersection once
  per **unique** head SHA (deduplicated across PRs that share a
  SHA). This republishes the correct check-run on every live head
  — including human-PR heads orphaned by a dropped
  departing-SHA cleanup.
- The sweep's publication path is identical to the per-event
  publisher's live-head path (same activity, same Decision 8a
  intersection, same `head_sha` under the enforcing context),
  which guarantees semantic equivalence and avoids a second code
  path diverging over time.

The sweep is a **safety net**, not the primary mechanism. The
inline per-event departing-SHA cleanup still runs on every
non-replaced `synchronize` and `closed` event and provides sub-minute
reconciliation in the common case. The sweep's role is purely to
upper-bound reconciliation latency at the sweep interval when the
inline path was dropped. The effective sweep interval
(`ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`, floor 1,
default 10) therefore directly sets the maximum staleness window
for a shared-SHA block after the blocking dev-agent PR has moved
on; adopters can lower it (at the cost of more Actions minutes
spent on early-exit-no-op runs) by reducing the variable toward 1.

Alternatives for the pending-replacement fix — dispatching a
dedicated per-SHA cleanup workflow from inside the triggering
publisher run (via `gh workflow run` with the departing SHA as an
input), or widening the per-PR concurrency pending queue — are
rejected in the Alternatives table below with their reasons.

**Rationale.**

- Requirement 6 (non-dev-author PRs pass immediately) still holds for
  a non-dev PR whose head is not shared with any dev PR: the single
  candidate's outcome is `success` and the published conclusion is
  `success` with no delay.
- A non-protected PR that happens to share a SHA with an under-approved
  protected PR will see its merge blocked until that PR is either
  approved to the required count, closed, or has its head advanced to
  a different SHA. This is the only correct outcome — the shared
  commit is the thing being merged, and the gate's purpose is to
  demand the configured threshold on that commit when any protected
  proposer is present. The non-protected PR author can advance their head by one no-op
  commit to split the SHA if they need to unblock their own merge
  without approving the dev PR.
- When the departing path (close or synchronize to a new head) does
  happen on the dev-agent PR, the departed-SHA reconciliation
  described above republishes the shared-SHA check-run with the
  departing PR removed — so the human PR is unblocked promptly
  without needing any subsequent activity on its own branch. This
  is a specific lifecycle gap the reviewer identified in the
  previous draft (which had no `closed` trigger and only published
  against the live head on `synchronize`).
- An attacker cannot borrow a non-dev PR's `success` to merge a
  shared-SHA dev-agent PR with 0 approvals, because the shared-SHA
  publisher strictly intersects per-PR outcomes.
- Two protected PRs with different approval counts on the same SHA
  intersect to the lower approval count's outcome, which is
  consistent with "the SHA is only safe to merge when every proposer
  of this SHA has met the bar".

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Give each PR its own context name (e.g. `require-two-developer-approvals-pr-${number}`) | GitHub rulesets require a literal context name on the `required_check` entry — there is no templating. One context per possible PR number is operationally impossible. |
| Publish per-PR check-runs with distinct names and have the ruleset accept any one matching a pattern | No "any of" matching exists in rulesets. Required checks are named individually. |
| Trust the per-PR concurrency group alone and ignore the SHA-sharing case | The reviewer's concrete scenario — a human-opened PR's `success` satisfying a shared-SHA dev-agent PR's enforcement — is a real merge-gate bypass. Not acceptable. |
| Only publish from the dev-agent-author PR when a conflict exists | Requires the publisher to know, from the non-dev PR's run, that a dev PR exists and defer to its publication order. The strictest-wins intersection in the Decision above achieves the same outcome symmetrically without ordering fragility. |
| Advance the gate's granularity from commit SHA to PR+SHA via a `details_url`/annotation hack | The ruleset's evaluation is still per-context-per-SHA. Metadata on the check-run does not change what the ruleset accepts. |
| Skip departed-SHA reconciliation and rely on the remaining PR to receive its own event eventually | Was the previous draft. A human PR left on a shared SHA after a dev-agent sibling closes has no event in the publisher's trigger set that is guaranteed to fire against it — the publisher subscribes to `pull_request_target` on the departing PR (which only produces events for *that* PR) and `workflow_run` from the notifier (which only fires on review submissions). With no further review activity or push on the remaining PR, its `failure` conclusion from the shared-with-under-approved-dev-PR era persists indefinitely. The departed-SHA reconciliation in the Decision above fixes this explicitly. |
| Trigger `pull_request_target` on `closed` but reconcile only on the next review submission against a sibling | Still asymmetric: a human PR that no longer has any new review activity (because its author considers it done and is waiting on the dev PR to resolve) stays blocked. Including `closed` in the trigger set and running the Decision 8a intersection on the departing SHA inside the same workflow run is a single-event, no-user-action fix. |
| Unconditional `liveHeadSha == departingSha` no-op (previous draft) | Was the previous draft. The condition fires on `pull_request_target: closed` when the dev-agent PR's head never changed between open and close — because the PR's last-known `head.sha` still equals `liveHeadSha` at the moment the close event is processed. The reconciliation is then skipped and the human PR left on the shared SHA remains blocked forever. The Decision above restricts the no-op to the case where the triggering PR is **still open** at that SHA, so `closed` always reconciles even on unchanged heads. |
| Dispatch a dedicated per-SHA cleanup workflow from inside the triggering publisher run (via `gh workflow run` with the departing SHA) and let it run with its own repository-wide concurrency key | Does not survive the specific pending-replacement scenario the reviewer identified: if the triggering publisher run B is itself replaced in the pending queue by a later notifier-driven run C, B never starts and therefore never calls `gh workflow run` for the cleanup. The dispatch is only as reliable as the triggering run's own lifecycle, which Decision 8 already documents as subject to replacement. The scheduled sweep in the Decision above is independent of any single triggering run's lifecycle. |
| Widen the per-PR concurrency pending queue (e.g. by partitioning the concurrency group so synchronize and workflow_run do not share a queue) | GitHub Actions `concurrency.group` keys serialize all matching runs regardless of trigger, and splitting across groups re-opens the Decision 8 race (two publishers for the same PR writing non-monotonically). The sweep is a safer invariant layer that does not touch the per-PR serialization boundary. |
| Rely on an external scheduler (cron on a VM, a GitHub App worker, etc.) | Introduces new infrastructure. A scheduled Actions workflow is already available, costs no extra permissions, and the sweep's work is bounded by the number of open PRs — the same scope as the existing backfill workflow. |
| Commit the sweep cron to a specific `*/N * * * *` literal (e.g. `*/10 * * * *`) and treat the `_RECONCILE_MINUTES` variable as a tunable floor below that interval | Would make `_RECONCILE_MINUTES` values **smaller** than `N` silently no-op: the variable's "smaller values react faster" promise would be false below `N`. The reviewer correctly flagged this as a contract mismatch between the variable description, Decision 8a's "adopters can lower it", and the fact that `on.schedule.cron` is a build-time literal that cannot read `${{ vars.X }}`. Committing to `cron: "* * * * *"` + an activity-side early-exit guard (specified in Decision 8a) is the only shape where every value of the variable from 1 upward is a real interval. The surplus cron fires are cheap because the early-exit returns immediately. |

Decision 9 items 10–12 cover the three same-SHA acceptance cases.

### Decision 9 — Acceptance test contract

The implementer must land the following tests. They are called out here
because several of them cover failure modes identified only in review
and are easy to omit from a naive implementation. All must be covered
either as unit tests of the TypeScript activity (where feasible) or as
end-to-end validation on a scratch PR under Issue #665.

1. **Non-dev-author PR passes immediately** — a human-authored PR with
   zero approvals must receive `conclusion: success` on the enforcing
   context within the first publisher run. (Requirement 6.)
2. **Fork-authored PR publication succeeds** — a human-authored PR
   opened from a fork of the repository must have the enforcing-context
   `success` posted; the ruleset must not block it. This directly
   exercises the `pull_request_target` write-capable token path.
3. **Trust-anchor test (same-repo PR modifies the gate)** — open a
   same-repository PR whose diff **simultaneously** edits:
   - the publisher workflow (`require-two-developer-approvals-publisher.yml`),
   - the reusable it calls,
   - the composite action and the TypeScript activity (so that any
     non-base-branch execution path would publish unconditional
     `success`),
   - the notifier (`require-two-developer-approvals-notify.yml`) to
     escalate `permissions:` to `write-all` and add a `curl` step
     POSTing a spoofed `conclusion: success` check-run under the
     enforcing context name, and
   - adds a brand-new workflow in `.github/workflows/` that declares
     `checks: write` and attempts to POST the same spoofed success
     (covering the "another PR-controlled workflow under the same
     Actions App ID" variant).

   The test asserts two separate properties, each of which must hold:

   - **(3a) Authoritative publisher correctness.** The authoritative
     publisher workflow (base-branch definition, invoked via
     `pull_request_target` / `workflow_run`) must publish the
     per-check-run conclusion that reflects the PR's real qualifying
     approval count under the Decision 4 counting rule. This
     property is *not* degraded by the attack: the base-branch
     workflow definition is unmodified and the trust-anchor layers
     (base-branch YAML load; helpers-ref pinned to `github.sha`) hold.

   - **(3b) Effective merge gate under the accepted trade-off.** With
     the PR carrying **exactly one** write-access human approval
     (not zero and not two), the test must assert what the shipping
     posture actually guarantees:
     - **Without the attack applied**, the PR is **not** mergeable:
       the authoritative publisher publishes `failure` (1 < 2
       qualifying approvals), and the ruleset blocks merge even
       though the baseline `required_approving_review_count = 1`
       is satisfied. This is the gate working as designed.
     - **With the attack applied** (the modified notifier or the
       added spoof workflow successfully POSTs a `conclusion:
       success` check-run under the enforcing-context name and
       Actions App ID 15368), the enforcing-context lookup may
       resolve to the spoofed `success`, and the ruleset's
       required-check condition is satisfied. The baseline
       `required_approving_review_count = 1` rule is still
       satisfied by the single human approval. **The PR is
       therefore mergeable with one approval, not two.** This is
       the explicit degradation the "Modified-notifier residual
       risk and defence-in-depth" subsection in Decision 5
       documents.
     - In the zero-approvals variant, the baseline rule still
       blocks: the attack cannot reduce the effective merge gate
       below one write-access human approval.

   The test records both outcomes (gate working as designed; gate
   degraded to the baseline under the accepted attack) rather than
   asserting an unconditional "two approvals required" that the
   shipping posture does not actually guarantee. A previous draft of
   this item asserted the stronger property; the reviewer correctly
   pointed out that the baseline + PR-diff-visibility layers do not
   enforce a count of two, only a count of at least one.

   This test documents and bounds the residual risk discussed in
   Decision 5's "Modified-notifier residual risk and defence-in-depth"
   subsection. **Maintainer confirmation required** on the
   acceptance of this degradation (acceptable: ship with the
   degraded-under-attack posture, rely on PR-diff visibility of
   workflow edits as the social mitigation; not acceptable: do not
   ship until the dedicated-publisher-App structural fix listed in
   "Out of scope" is adopted). The `human-required` label applied
   to this PR captures the decision.
4. **Integration_id binding** — simulate an unrelated GitHub App
   posting a check-run of the gate's context name with `conclusion:
   success` on an under-approved developer-agent PR. The ruleset must
   still block merge. (Covers Decision 6.)
5. **Out-of-order publication / stale-event replacement** — two
   sub-cases, both on a developer-agent PR:
   - Fire an approve review and a dismiss review in rapid succession
     and assert the final check-run on the current head SHA is
     `failure` with no stale `success` observable at any point after
     the dismiss event is processed.
   - Fire approve on head H1, push a new commit landing head H2, then
     deliver a stale webhook for H1 while H1-run A is in flight.
     Assert that the final check-run on H2 reflects the real
     post-synchronize approval state (0 qualifying approvals, since
     `dismiss_stale_reviews_on_push = true` wiped the H1 approval),
     with no inherited stale H2 publication — specifically exercising
     the three-run interleaving where the pending H2 run has been
     replaced by the delayed H1 event (Decision 8).
6. **OFF → ON on an unchanged open PR** — with an open developer-agent
   PR that has one human approval under opt-in OFF, flip the opt-in
   ON, and run the backfill workflow. Merge must be blocked until a second non-self approval
   lands. (Covers Decision 7.)
7. **ON → OFF on an under-approved PR** — with an open developer-agent
   PR currently failing the gate under opt-in ON, flip the opt-in OFF.
   Merge must be allowed as soon as the baseline
   `required_approving_review_count = 1` is satisfied. (Covers
   Decision 7.)
8. **ON → OFF → ON cycle with dismissal while OFF** — start ON with
   two qualifying approvals on an open developer-agent PR (gate
   publishes `success`); flip OFF; dismiss one approval while OFF
   (publisher updates only the preview context); flip ON again
   **without running the backfill** and assert that the stale
   `success` is replaced by `failure` within one reconcile interval
   and the merge stays blocked until the second approval re-lands —
   then redo the same sequence running the backfill immediately after
   the second ON and assert the merge is blocked as soon as the
   backfill completes. (Covers Decision 7.)
9. **Opt-in on with invalid configuration** — set the opt-in on and test
   each invalid configuration: an empty protected-author list, malformed
   JSON, duplicate/empty list member, and a zero/non-integer threshold.
   Every PR must see an error and a `failure` conclusion. Also verify a
   list with two protected identities applies the same configured threshold
   to either author and that each author's own review is excluded only from
   that author's PR. (Covers Decisions 2, 4, and 7.)
10. **Shared head SHA — human + developer** — open two PRs whose head
    branches point at the same commit SHA, one authored by a human
    and one by the developer agent with 0 qualifying approvals. The
    published check-run on the shared SHA must be `failure`; the
    human PR must be blocked from merging as long as the dev PR's
    requirement is unmet. (Covers Decision 8a.)
11. **Shared head SHA — two protected PRs with different approval
    counts** — open two protected PRs on the same head SHA, one meeting
    the configured threshold and one one approval short. The published
    check-run on the shared SHA must be `failure` (the strictest wins)
    regardless of the order in which the two PRs' publishers run.
    (Covers Decision 8a.)
12. **Shared head SHA — ordering independence** — publish from the
    non-dev PR's publisher first, then the dev PR's publisher; and
    then the reverse. The final check-run on the SHA must be
    `failure` in both orderings. (Covers Decision 8a.)
13. **Draft → ready-for-review with unchanged head** — open a
    developer-agent PR as a draft, submit two qualifying approvals
    while the PR is still draft (notifier fires; publisher's
    draft-filter skips its main path), then mark the PR ready for
    review with no further commits and no subsequent review activity.
    After the `pull_request_target: ready_for_review` run completes,
    the enforcing-context check-run on the live head SHA must be
    `success`. Also test the mirror case: a non-dev-author draft PR
    with zero approvals, when marked ready, must receive the
    Requirement 6 `success` conclusion by the end of the
    `ready_for_review` run. (Covers Decision 5's draft-handling
    contract.)
14. **Departed-SHA reconciliation on close (unchanged head)** — open
    two PRs on the same head SHA H1: a human-authored PR and an
    under-approved (0 approvals) developer-agent PR. The initial
    published check-run on H1 is `failure` per Decision 8a (test
    state). Close the developer-agent PR **without pushing any new
    commits first** (so the dev-agent PR's `head.sha` at close time
    equals H1, and `liveHeadSha == departingSha` from the
    `pull_request_target: closed` event payload). This is the exact
    case the earlier draft's unconditional `liveHeadSha ==
    departingSha` no-op short-circuited. The test must assert the
    republished check-run on H1 is `success` after the `closed` run
    completes, and the human PR becomes mergeable with no further
    activity on its branch. (Covers the Decision 8a fix that restricts
    the no-op to PRs that are still open at the SHA.)
15. **Departed-SHA reconciliation on synchronize** — open two PRs on
    the same head SHA H1: a human-authored PR and an under-approved
    developer-agent PR. The initial published check-run on H1 is
    `failure`. Push a new commit to the developer-agent PR advancing
    it to H2 (`github.event.before = H1`, `github.event.after = H2`),
    with no activity on the human PR. After the
    `pull_request_target: synchronize` run completes, the republished
    check-run on H1 must be `success` (human PR alone, strictest-wins
    is `success`), and the check-run on H2 reflects the developer PR's
    post-synchronize state (0 qualifying approvals, since
    `dismiss_stale_reviews_on_push = true` wiped the pre-push approvals
    on the dev PR). The human PR must be mergeable without any
    subsequent activity on its own branch. (Covers Decision 8a's
    departed-SHA reconciliation on `synchronize`.)
16. **Departed-SHA reconciliation survives pending-run replacement**
    — open two PRs on the same head SHA H1: a human-authored PR and
    an under-approved developer-agent PR. The initial published
    check-run on H1 is `failure`. Then, simulating the Decision 8
    pending-replacement scenario on the dev-agent PR:
    - Hold run A (publisher for some prior event on PR N) in
      progress by blocking its activity call.
    - Fire `pull_request_target: synchronize` on the dev-agent PR
      moving H1 → H2. Run B is queued pending with `departingSha =
      H1`.
    - Fire a review event on the dev-agent PR (notifier →
      `workflow_run` → publisher run C). GitHub's concurrency
      replaces pending B with C, discarding B.
    - Release A. Observe that C runs and reconciles live H2
      correctly, but **never** processes `departingSha = H1`.
    - **With no further activity on either PR**, assert that
      within the sweep interval (default 10 minutes), the scheduled
      `require-two-developer-approvals-reconcile.yml` sweep
      republishes the check-run on H1 as `success` and the human PR
      becomes mergeable.

    The test must also assert the symmetric scenario where B is a
    `closed` event (rather than `synchronize`) and still gets
    dropped by a later notifier-driven C — the sweep must still
    reconcile H1 within its interval. (Covers Decision 8a's
    pending-replacement safety net.)
17. **Shared-SHA listing and sweep API failures fail closed** — simulate
    an under-approved protected PR that has only just joined a SHA and
    make the historical `GET /commits/{sha}/pulls` index omit it; the
    paginated open-PR listing must still find it and publish `failure`.
    Then inject failures in (a) an open-PR-list page and (b) the sweep's
    Actions-runs lookup. Case (a) must publish `failure` when possible
    and fail the job, never `success` from a partial candidate set; case
    (b) must log the lookup error and perform the full reconciliation
    rather than early-exiting. Verify the reconcile workflow grants
    `actions: read` so the normal lookup succeeds. (Covers Decision 8a.)
18. **Standard counting cases** — the full matrix listed in Issue #662
    (0/1/2/3 non-self approvals, self-approval ignored, `DISMISSED`
    latest opinionated review, etc.), including an `APPROVED` review followed
    by a `COMMENTED` review from the same login: the earlier approval must
    still count as one qualifying approval.

### Decision 10 — Documentation surfaces

The following must be updated in the same PR as the implementation (per
AGENTS.md § "Keeping Documentation Current"):

- `AGENTS.md`:
  - Add `PROTECTED_PR_AUTHOR_LOGINS`, `REQUIRED_APPROVAL_COUNT`, `ENABLE_PROTECTED_APPROVAL_GATE`,
    and `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` to the
    "Terraform-managed … Actions variables" list in the documentation-update
    checklist.
  - Add a short bullet under § "Code Review Standards" → "Repo-specific
    security defaults" / "Branch-protection immutability" cross-referencing
    the new design doc and noting that lowering `enable_protected_approval_gate`
    from `true` to `false` must be justified in the PR body (same pattern as
    "lowers `required_approving_review_count` below 1").
  - List the four new workflows
    (`require-two-developer-approvals-publisher.yml`,
    `require-two-developer-approvals-notify.yml`,
    `require-two-developer-approvals-backfill.yml`,
    `require-two-developer-approvals-reconcile.yml`) in the Repository
    Layout section.
- `terraform/modules/branch-protection/README.md`: document the three
  new module variables (`enable_protected_approval_gate`,
  `enable_protected_approval_gate_check_context`,
  `enable_protected_approval_gate_check_integration_id`), the dynamic
  `required_status_checks` block, the re-enable backfill step from
  Decision 7, **and** the
  admin-bypass caveat described in the Interactions section (admins
  with `bypass_mode = "pull_request"` can bypass the two-approval
  check when merging a PR — this is explicit, documented, and
  auditable). Also document the two-step enable/disable procedure,
  the one-shot `require-two-developer-approvals-backfill.yml`
  workflow, the periodic
  `require-two-developer-approvals-reconcile.yml` sweep workflow
  (committed `cron: "* * * * *"` + activity-side early-exit guard
  reading `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`;
  default 10 minutes, floor 1) and the fact
  that the sweep is a safety net for pending-run replacement rather
  than the primary mechanism — i.e. the maximum staleness window
  for a shared-SHA block after the blocking dev-agent PR has moved
  on, and the operator trade-off between staleness window and
  Actions minutes, the modified-notifier residual-risk discussion
  from Decision 5 (including the **honest** effective-merge-gate
  degradation to one approval under the attack — not two — so
  operators understand what the shipping posture actually
  guarantees), the shared head-SHA cross-PR behaviour from
  Decision 8a (so operators and reviewers are not surprised by a
  human-opened PR being blocked because it shares a commit SHA with
  an under-approved dev-agent PR), and the departed-SHA
  reconciliation behaviour (a human PR blocked by sharing a SHA
  with an under-approved dev-agent PR is auto-unblocked when the
  dev PR closes or advances to a new SHA, without any further
  activity on the human PR; also auto-unblocked within the sweep
  interval even if the per-event cleanup was dropped by
  pending-run replacement).
- `terraform/modules/agent-vars/README.md`: document the four new
  Actions variables (`PROTECTED_PR_AUTHOR_LOGINS`, `REQUIRED_APPROVAL_COUNT`,
  `ENABLE_PROTECTED_APPROVAL_GATE`, and
  `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`) and the usage
  example.
- `terraform/terraform.tfvars.example`: show commented-out example values
  for `protected_pr_author_logins`, `required_approval_count`, and
  `enable_protected_approval_gate`.
- `docs/adopting.md`: add a section for external adopters explaining
  the policy-configuration contract (set `protected_pr_author_logins` and
  `required_approval_count`), the enable/disable + backfill
  procedure (backfill after every re-enable),
  the override path for
  `enable_protected_approval_gate_check_integration_id` when they
  publish from a GitHub App other than GitHub Actions, the cross-PR
  shared-SHA note from Decision 8a (so adopters understand a
  human PR can be blocked by a shared commit with an under-approved
  dev-agent PR), the departed-SHA reconciliation behaviour (auto-
  unblock when the sibling dev-agent PR closes or advances head),
  and the honest effective-merge-gate degradation under the
  modified-notifier attack (one approval, not two) so adopters can
  decide whether to adopt the dedicated-publisher-App structural
  fix before enabling the gate in their environment.

## Interactions with existing design decisions

- **`required_approving_review_count = 1` is unchanged.** The two-approvals
  check layers on top of it. See Decision 1 for the composed gate.
- **`dismiss_stale_reviews_on_push = true` is unchanged.** When a dev-agent
  PR is updated with a new commit after approvals land, GitHub dismisses
  the stale approvals and the workflow correctly recomputes `failure` on
  the resulting `synchronize` event.
- **Admins' `bypass_mode = "pull_request"` is unchanged, and it covers
  the new required check too.** The previous draft of this section
  asserted that `bypass_mode = "pull_request"` bypasses only the
  `pull_request` rule and leaves required status checks enforced. That
  is **incorrect**. GitHub's ruleset documentation ("Creating rulesets
  for a repository" → "Granting bypass permissions") describes the
  bypass mode as scoping *how* an actor bypasses the ruleset (always
  vs. only when merging a pull request), not *which* rule types within
  the ruleset are bypassed. An actor with `pull_request`-mode bypass
  can bypass **the branch protections**, including the new
  required-check entry, when merging a PR. Because the two-approvals
  check is added to the same `main-protection` ruleset the admins
  already have `pull_request`-mode bypass on, the net effect is: a
  repository admin can merge a developer-agent PR with fewer than two
  qualifying approvals.
  - This is the auditable "resolve impasse without removing protection"
    posture described in
    [`terraform/modules/branch-protection/README.md`](../../terraform/modules/branch-protection/README.md),
    extended to the new check. The design accepts this on the grounds
    that (a) admin bypass is already the policy for the baseline
    `required_approving_review_count = 1` rule, and (b) the issue text
    does not call out admin bypass as a distinct target of the gate.
  - **Maintainer confirmation required.** If the intended policy is
    that admins must **not** be able to bypass the two-approval check
    (making it strictly stricter than the baseline review rule), the
    ruleset design has to change — the two-approval check would need to
    live in a separate ruleset with no `bypass_actors` entries, or the
    admin bypass actor would need to be removed/scoped. That is a
    maintainer decision; the `human-required` label applied to this PR
    is the vehicle for recording it. Until a maintainer confirms
    otherwise, this design doc is explicit that admins retain their
    existing bypass over all of `main-protection`'s rules.
- **Reviewer-agent approvals.** Count toward the two under Decision 4, but
  do not satisfy `required_approving_review_count = 1` (the reviewer App
  deliberately lacks write access — see [`docs/design/code-review-agent.md`](code-review-agent.md)).
  Net effect: a dev-agent PR with only the reviewer agent approving fails
  both gates; with the reviewer agent plus one write-access human
  approving, it satisfies both gates.

## Out of scope

- **Automatically dismissing the reviewer-agent's advisory `APPROVE`** when
  it isn't paired with a human approval. Out of scope — the status quo
  already correctly treats the reviewer agent's approval as non-blocking
  for `required_approving_review_count = 1`.
- **Scheduled re-posting of the check on long-open PRs *in the common
  case*.** Event-driven triggers cover every state change that matters
  in the normal path. The scheduled
  `require-two-developer-approvals-reconcile.yml` sweep (added by
  Decision 8a's pending-replacement safety net) runs for a different
  reason — it reconciles shared-SHA check-runs when a per-event
  departed-SHA cleanup was dropped by Actions' concurrency pending-run
  replacement — and only writes when a shared-SHA state has actually
  changed. It is not a general "re-run on a timer" pattern.
- **GitHub-side "required reviewer teams" or CODEOWNERS integration.** The
  gate operates purely on review counts.
- **Rulesets scoped to agent branches** (e.g. `agent/*`, `design/*`).
  Rejected in Decision 1.
- **A dedicated publisher GitHub App** (separate credentials, with
  its own `integration_id` pin) to structurally reject the spoofed
  check-run attack described in Decision 5's "Modified-notifier
  residual risk and defence-in-depth" subsection. Noted there as a
  future hardening; the shipping posture relies on the baseline
  review rule and PR-diff visibility. Adopting a dedicated App later
  does not break the context name or ruleset shape.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#661](https://github.com/mfrancza/agentic-development-workflow/issues/661) | Terraform: add `protected_pr_author_logins` (non-empty unique list), `required_approval_count` (positive integer), `enable_protected_approval_gate`, generation, and reconcile-interval variables; expose the first two as JSON `PROTECTED_PR_AUTHOR_LOGINS` and numeric `REQUIRED_APPROVAL_COUNT` Actions variables. Wire all values to the publisher, branch-protection module, examples, and operator documentation. | — |
| [#662](https://github.com/mfrancza/agentic-development-workflow/issues/662) | TypeScript activity + composite action: implement the approval check. Read `protected-pr-author-logins` and `required-approval-count` inputs, validate the JSON list and positive integer before making any author decision, and fail every PR visibly when invalid. For each protected PR, exclude its own author from latest-opinionated-per-reviewer `APPROVED` reviews and compare against the configured threshold; `COMMENTED` and `PENDING` reviews must not displace the latest `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED` state for that login. Non-protected PRs pass immediately. Resolve every shared-SHA candidate by paginating the authoritative open-PR listing (never the lag-prone commit→PR index); on a listing error publish failure when possible and fail loudly, never success from a partial set. Preserve the Decision 8/8a serialization, shared-SHA, departed-SHA, draft, and generation contracts. Unit tests cover two protected identities, custom thresholds, invalid JSON/list/count, API-error fail-closed behavior, author-specific self-exclusion, and `APPROVED` followed by `COMMENTED` from one login in addition to Decision 9. | — |
| [#663](https://github.com/mfrancza/agentic-development-workflow/issues/663) | Workflows + reusables: add the publisher, zero-permission named notifier, backfill, reconcile workflow, and paired reusable defined in Decisions 5, 7, 8, and 8a. Publisher stubs pass `vars.PROTECTED_PR_AUTHOR_LOGINS`, `vars.REQUIRED_APPROVAL_COUNT`, `vars.ENABLE_PROTECTED_APPROVAL_GATE`, and generation to the reusable. Because both publisher and reconcile invoke the reusable's helper-checkout bootstrap, each MUST grant `contents: read`; the publisher also grants `pull-requests: read` and `checks: write`, while reconcile grants `actions: read`, `pull-requests: read`, and `checks: write`. Preserve the documented trusted-ref, `workflow_run` null guard/fallback, per-PR/per-SHA concurrency, departed-SHA, and per-minute sweep contracts. An Actions-runs lookup failure logs and continues a full sweep rather than early-exiting. | Issue #662 |
| [#664](https://github.com/mfrancza/agentic-development-workflow/issues/664) | Documentation: update `AGENTS.md`, module READMEs, examples, and `docs/adopting.md` for `protected_pr_author_logins` / `PROTECTED_PR_AUTHOR_LOGINS` and `required_approval_count` / `REQUIRED_APPROVAL_COUNT`, including JSON format, threshold validation, and the existing activation, shared-SHA, bypass, and residual-risk contracts. | Issue #661, Issue #663 |
| [#665](https://github.com/mfrancza/agentic-development-workflow/issues/665) | End-to-end validation: execute Decision 9, including multiple protected authors, a non-default threshold, author-specific self-exclusion, and every invalid configuration path, alongside the fork, spoofing, concurrency, activation, shared-SHA, draft, and departed-SHA cases. | Issues #661, #662, #663, #664 |

Issues #661 and #662 are independent and can proceed in parallel — the
contract (variable names `PROTECTED_PR_AUTHOR_LOGINS`,
`REQUIRED_APPROVAL_COUNT`, and `ENABLE_PROTECTED_APPROVAL_GATE`;
enforcing check-context name `require-two-developer-approvals`;
preview context name `require-two-developer-approvals (preview)`;
`integration_id = 15368`; activity input names) is established by
this document. Issue #663 depends on Issue #662 because the reusable
invokes the composite action from #662. Issue #664 can be drafted in
parallel but should land with #661 and #663 so docs and code ship
together per AGENTS.md § "Keeping Documentation Current". Issue #665
depends on everything.

Dependencies are recorded natively as GitHub blocked-by relationships on
the sub-issues.
