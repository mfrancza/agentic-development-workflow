# Design: Optionally require two approving reviews on developer-agent pull requests

**Issue:** [#628](https://github.com/mfrancza/agentic-development-workflow/issues/628)

## Summary

Add an opt-in setting that requires two approving reviews before a pull
request can merge, scoped to pull requests authored by the configured
developer agent. Pull requests from humans, the reviewer agent, or any other
bot continue to require only whatever the base `required_approving_review_count`
on the `main-protection` ruleset says (today: 1).

GitHub's branch-protection `required_approving_review_count` is per-branch,
not per-author, so a direct bump to 2 would raise the bar for every PR on
the default branch — the exact outcome the issue rules out. The design uses
the mechanism the issue's Notes section already identifies: a **required
status check** backed by a short GitHub Actions workflow. The check passes
immediately when the PR author is not the configured developer agent;
otherwise it passes only once two qualifying approvals exist (excluding the
developer agent's own review from the count). The check context is wired
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

The context name carries a **generation suffix**
(`require-two-developer-approvals-g${N}`) so that an ON → OFF → ON
cycle in which approvals change while the gate is OFF cannot reuse a
stale `success` check-run from the previous ON interval. Decision 7
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

Identity (the login of the developer agent) is sourced from a new
Terraform-managed Actions variable `DEVELOPER_BOT_LOGIN` so that external
adopters can point the gate at their own developer-agent App — consistent
with the direction already established by the `developer-author` reusable
input introduced in [#580](https://github.com/mfrancza/agentic-development-workflow/issues/580)
([`docs/design/resolve-conflicts-developer-author.md`](resolve-conflicts-developer-author.md)).

## Requirements as understood

From issue #628 and its grooming notes:

1. **Opt-in gate.** A new setting that is OFF by default. When OFF, no
   behavior anywhere in the repo changes — the base
   `required_approving_review_count = 1` on `main-protection` continues to
   govern every PR. When ON, developer-agent-authored PRs need two
   qualifying approvals.
2. **Scope by PR author.** The two-approvals rule applies only when the PR
   author is the configured developer agent. Human-authored PRs, reviewer
   agent-authored PRs, and PRs opened by any other bot are unaffected.
3. **Identity is configured, not hardcoded.** Match the same developer
   identity callers already configure elsewhere — `developer-author`
   (`app/<slug>` form, consumed by the resolve-conflicts reusable) and the
   corresponding `<slug>[bot]` login. Hardcoding `mfrancza-developer-agent[bot]`
   anywhere is disallowed, including in the gate workflow.
4. **Self-reviews don't count.** An `APPROVED` review by the developer
   agent itself does not count toward the two. Reviews by anyone else do
   count (subject to the detail in Decision 4).
5. **Mechanism must not raise the per-branch count.** The ruleset's
   `required_approving_review_count` stays at its current value (1). The
   two-approvals requirement is enforced through an added **required status
   check**, not through a global count bump.
6. **Non-matching PRs must pass instantly.** The required status check must
   produce `success` without delay (and without waiting for any approvals)
   whenever the PR author is not the configured developer agent, so that
   adding this check to the ruleset does not slow down or block human PRs
   or PRs from the reviewer agent / Copilot / other bots.
7. **Fail-loud configuration errors.** If the opt-in is ON but
   `DEVELOPER_BOT_LOGIN` is empty, the gate must not silently fail open
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
and the custom check additionally demands two non-self approvals when the
author matches. For a developer-agent PR with the opt-in ON, the effective
merge gate is therefore "≥1 write-access human approval AND ≥2 non-self
approvals" — which is the standard interpretation of "two human reviews
for agent code".

### Decision 2 — New Terraform-managed variables and Actions variables

**Decision.** Add two new Terraform variables and expose each as a
repository Actions variable, following the established pattern used by
`ADMIN_ASSIGNEES`, `CODE_REVIEWERS`, `AUTO_TRIGGER_AGENTS`, etc. in the
`agent-vars` module (see [`terraform/modules/agent-vars/README.md`](../../terraform/modules/agent-vars/README.md)).

```hcl
variable "developer_bot_login" {
  description = "GitHub App bot login of the developer agent in `<slug>[bot]` form (e.g. `mfrancza-developer-agent[bot]`). Exposed as the DEVELOPER_BOT_LOGIN Actions variable. Used by the two-approvals status-check workflow to identify developer-agent-authored PRs. Must be non-empty when require_two_developer_approvals is true; the workflow fails loudly otherwise. Related: the `developer-author` input on agent-resolve-conflicts-reusable.yml holds the same identity in `app/<slug>` search-qualifier form."
  type        = string
  default     = ""
}

variable "require_two_developer_approvals" {
  description = "When true, developer-agent-authored PRs require two qualifying approvals (excluding the agent's own review) before they can merge. Enforced via a required status check on main-protection — the base required_approving_review_count stays at 1 so human PRs and other-bot PRs are unaffected. Defaults to false (opt-in)."
  type        = bool
  default     = false
}

variable "require_two_developer_approvals_check_generation" {
  description = "Monotonic integer generation suffix for the required check context name. The composed context is `require-two-developer-approvals-g<N>` (ruleset + publisher workflow both reference it). Bump this on every ON → OFF → ON cycle so stale check-runs from a previous ON interval cannot satisfy the newly enforcing rule on an unchanged head SHA. See Decision 7 for the ON ↔ OFF reconciliation discussion. Starts at 1."
  type        = number
  default     = 1
}
```

All three variables are wired through `terraform/main.tf` →
`agent_vars` module → `github_actions_variable` resources named
`DEVELOPER_BOT_LOGIN`, `REQUIRE_TWO_DEVELOPER_APPROVALS`, and
`REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION`. The
branch-protection module gains a new input
`require_two_developer_approvals_check_context` (defaulted to the
composed context name defined by Decision 6, which embeds the
generation suffix) that is referenced only when the opt-in is on.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Reuse `developer-author` (which stores `app/<slug>`) and derive the login by stripping `app/` and appending `[bot]` | `developer-author` is a reusable-workflow input today, not a Terraform-managed Actions variable. The status-check workflow needs to resolve the identity at `pull_request` / `pull_request_review` event time where it cannot inherit a reusable input from an unrelated workflow. A new Actions variable is the natural fit. Terraform can still cross-check that `developer_bot_login` is consistent with the login form, but the two configuration surfaces remain independent so operators can rotate them separately. Grooming for #580 explicitly chose "explicit input over derivation" ([`docs/design/resolve-conflicts-developer-author.md`](resolve-conflicts-developer-author.md) Decision 1); the same reasoning applies here. |
| Add a boolean key inside an existing JSON Actions variable (e.g. a new `two_developer_approvals` key in `AUTO_TRIGGER_AGENTS`) | `AUTO_TRIGGER_AGENTS` is about applying `agent:*` labels at SDLC transitions — a different domain. Overloading it would make its contract less cohesive and complicate the `fromJSON(vars.AUTO_TRIGGER_AGENTS)` consumers in `agent-auto-trigger.yml`. A dedicated boolean is clearer. |
| Expose only a module-level input on the branch-protection module and skip the Actions variable | The workflow needs to know, independently of the ruleset, whether to compute the check result at all. Without the Actions variable, the workflow would run against every PR, make API calls, and emit either `success` or `failure` — but there would be nothing in the ruleset referencing it, so a `failure` would be ignored. That is wasteful and surprising. Having both the Actions variable (consumed by the workflow) and the module input (consumed by the ruleset) keeps the two sides in step and makes the opt-in reversible in a single `terraform apply`. |
| Hardcode `mfrancza-developer-agent[bot]` in the workflow (as `agent-pr-merged.yml`, `agent-respond-review.yml`, `agent-fix-checks.yml` do today) | Explicitly disallowed by the issue constraints. The hardcoded uses in those three workflows were considered-but-out-of-scope in [`docs/design/auto-review-author-gate.md`](auto-review-author-gate.md); this feature is the first use site added since that doc that **cannot** hardcode (per issue text), so it establishes `DEVELOPER_BOT_LOGIN` as the shared Actions variable the eventual follow-up conversion of those three sites can also use. |

### Decision 3 — Conditional required-check wiring in `branch-protection` module

**Decision.** Extend `terraform/modules/branch-protection/main.tf` so the
`main-protection` ruleset conditionally includes a `required_status_checks`
block referencing the two-approvals check context, controlled by a new
module input `require_two_developer_approvals` (bool, default `false`).
The base `required_approving_review_count` stays at the existing default
(1) and is not touched.

Sketch (final syntax to be settled by the implementer against the
`integrations/github` provider's current schema):

```hcl
# In terraform/modules/branch-protection/main.tf, within the existing
# `rules { ... }` block of github_repository_ruleset.main:

locals {
  # Compose the generation-suffixed context name unless the caller
  # explicitly overrode `require_two_developer_approvals_check_context`.
  # The default-null + coalesce pattern keeps the context name derived
  # from the generation variable, so a Terraform `generation` bump
  # flows through to the ruleset without a second override.
  require_two_developer_approvals_check_context_final = coalesce(
    var.require_two_developer_approvals_check_context,
    "require-two-developer-approvals-g${var.require_two_developer_approvals_check_generation}",
  )
}

dynamic "required_status_checks" {
  for_each = var.require_two_developer_approvals ? [1] : []
  content {
    strict_required_status_checks_policy = false
    required_check {
      context        = local.require_two_developer_approvals_check_context_final
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
      integration_id = var.require_two_developer_approvals_check_integration_id
    }
  }
}
```

New module variables:

```hcl
variable "require_two_developer_approvals" {
  description = "When true, add the two-approvals status check as a required check on main-protection, gating developer-agent PRs until two qualifying approvals exist. Defaults to false."
  type        = bool
  default     = false
}

variable "require_two_developer_approvals_check_context" {
  description = "Status-check context name produced by the two-approvals workflow. Only used when require_two_developer_approvals is true. Defaults to the generation-suffixed context published by this repo's require-two-developer-approvals-publisher.yml via the Checks API (see Decision 6 and Decision 7). Composed from the generation input: `require-two-developer-approvals-g<generation>`. Operators should normally let this default track the generation rather than override it."
  type        = string
  default     = null  # Composed from the generation variable; see locals in main.tf
}

variable "require_two_developer_approvals_check_generation" {
  description = "Numeric generation suffix for the check context name (mirrors the top-level variable of the same name; see Decision 7). Starts at 1 and increments on every ON → OFF → ON cycle to invalidate stale check-runs from the previous ON interval."
  type        = number
  default     = 1
}

variable "require_two_developer_approvals_check_integration_id" {
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

`terraform/main.tf` passes the top-level `var.require_two_developer_approvals`
through to the module. External adopters that use the published
`branch-protection` module can set it the same way.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Always include the required-check entry; let the workflow short-circuit with `success` when the opt-in is off | Would make the check context mandatory even when the feature is off, meaning every merge waits for the workflow to publish a result. Harmless when the workflow is healthy, but noisy if the workflow is broken or absent — the ruleset would block merges on a check nobody intentionally enabled. Conditional inclusion makes the "off" state truly zero-cost. |
| Hardcode the context name directly in `main.tf` instead of a module variable | Adopters forking the branch-protection module would have to patch the hardcode. A defaulted variable keeps the common case ergonomic and the override path open. |
| Use a separate ruleset scoped to the required status check only | Multiple rulesets on the same branch stack, but splitting across two rulesets makes the policy harder to reason about and audit. Keeping all branch rules in one ruleset mirrors the existing shape. |
| Enforce via `strict_required_status_checks_policy = true` (require the check to be from the latest head SHA) | Not needed and interacts awkwardly with `pull_request_review` events, which don't change the head SHA. The workflow handles staleness correctly on its own by always re-reading reviews from the API at run time. |

### Decision 4 — "Qualifying approval" semantics

**Decision.** The workflow groups reviews by reviewer login, keeps only
the **latest** review state per reviewer, and treats the review as
"qualifying" when **all** of the following hold:

1. State is `APPROVED` (not `COMMENTED`, `CHANGES_REQUESTED`, `DISMISSED`,
   or `PENDING`).
2. Reviewer login is **not** the configured `DEVELOPER_BOT_LOGIN`.

The check conclusion is `success` iff the count of qualifying approvals is
≥ 2. All other `APPROVED` reviews count — including from the reviewer
agent, from Copilot, and from any human reviewer (regardless of whether
GitHub itself would count the approval for the `required_approving_review_count`
rule).

**Rationale.** This matches the issue text verbatim: "A review written by
the developer agent itself does not count toward the two." The issue's
"Human authors, the reviewer agent, and any other bot are unchanged"
sentence refers to **PR authors**, not review authors — it carves out the
scope of the gate, not the counting rule. GitHub's own `required_approving_review_count = 1`
rule continues to insist on at least one write-access approval on top of
our custom check (see Decision 1), so a developer-agent PR with the opt-in
on can only merge with ≥1 write-access human approval AND ≥2 non-self
approvals. In practice this means a reviewer-agent approval alone cannot
satisfy both gates, which matches the existing [`docs/design/code-review-agent.md`](code-review-agent.md)
posture.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Exclude all bot approvals (any login ending in `[bot]`) from the count | Would make the reviewer agent's `APPROVE` not count toward the two. The reviewer agent's approval is already advisory for the base `required_approving_review_count = 1` rule (read-only Contents permission), so excluding it from our custom count too would make the practical merge gate "≥2 human approvals". Possibly desirable, but the issue text does not demand it and this design keeps the simpler, verbatim interpretation. If operators later want "≥2 **human** approvals", a follow-up can add an opt-in flag to exclude `[bot]` identities — strictly stricter than the shipping behavior. |
| Replicate GitHub's write-access rule exactly (count only approvals from users with write access on the repo) | Requires an extra API call per reviewer to resolve collaborator permissions, adds a failure mode, and still arrives at the same effective merge gate when combined with `required_approving_review_count = 1` (because that rule already enforces the write-access filter). Not worth the extra surface. |
| Count reviews in all states, not just `APPROVED` | Would conflate `COMMENTED` with approval and double-count stale `CHANGES_REQUESTED` reviews that were later superseded by an `APPROVED` review. GitHub's own count uses latest-per-reviewer `APPROVED`; mirroring that is the least surprising behavior. |

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
`pull-requests: read, checks: write`. These are honoured because the
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
`DEVELOPER_BOT_LOGIN` / `REQUIRE_TWO_DEVELOPER_APPROVALS` variable reads,
and the trusted-ref selection for `helpers-ref`. The reusable holds the
composite-action invocation and the four-step helper-checkout bootstrap
(AGENTS.md § "Reusable workflows: self-checkout for helper actions").
The computation is a TypeScript activity under `.github/scripts/src/`
wrapped as a composite action under `.github/actions/` (per AGENTS.md
§ "Workflow Activity Conventions").

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
Checks API (`POST /repos/{owner}/{repo}/check-runs`) with a `name`
composed from the generation suffix:
`require-two-developer-approvals-g${REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION}`.
When the opt-in is OFF, the preview context is
`require-two-developer-approvals-g${generation} (preview)` (see
Decision 7 for why the enforcing context is not published in OFF
mode). The ruleset's `required_status_checks` block references the
same composed enforcing context **and pins its `integration_id` to
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
`require_two_developer_approvals_check_integration_id` to that App's ID.
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
   under the enforcing context** (`require-two-developer-approvals`). It
   optionally publishes a diagnostic context named
   `require-two-developer-approvals (preview)` that reflects what the
   gate *would* say if enabled. The ruleset never lists the preview
   context as required, so the preview has no gating effect; its purpose
   is to let maintainers see what enabling the opt-in would do without
   affecting any merge decisions. The enforcing-context check-run from a
   prior OFF-mode run is **not** reused: see "Activation reconciliation"
   below.
2. **Opt-in ON, configuration valid.** The publisher computes the
   qualifying-approval count per Decision 4 and publishes
   `success` / `failure` on the enforcing context.
3. **Opt-in ON, `DEVELOPER_BOT_LOGIN` empty (misconfiguration).** The
   activity emits `::error::DEVELOPER_BOT_LOGIN must be set when
   REQUIRE_TWO_DEVELOPER_APPROVALS is true` and publishes `failure` on
   the enforcing context for every PR (not just dev-agent PRs), so the
   misconfiguration surfaces visibly rather than silently letting agent
   PRs through on a single approval or silently blocking only a subset
   of authors.

**Activation reconciliation across the full ON ↔ OFF cycle.**
Flipping `require_two_developer_approvals` from `false` to `true` in
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

To make activation safe across the full cycle, the design requires
two mechanisms working together: a **generation counter** that
decouples each ON interval from the previous one, and a mandatory
**backfill-before-enable** operator procedure. Both are documented in
[`terraform/modules/branch-protection/README.md`](../../terraform/modules/branch-protection/README.md)
and `docs/adopting.md`.

**Generation counter.** The context name published and required is
not a bare `require-two-developer-approvals` — it carries a numeric
generation suffix sourced from a new Terraform variable
`require_two_developer_approvals_check_generation` (integer, default
`1`). The composed context name is
`require-two-developer-approvals-g${generation}` (e.g.
`require-two-developer-approvals-g1`). The same variable is exposed
as the `REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION` Actions
variable that the publisher reads at run time, so Terraform and the
workflow stay in sync via a single source of truth.

Operators must bump the generation integer every time they
re-enable the gate after any OFF interval during which approvals,
PR authors, or `DEVELOPER_BOT_LOGIN` could have changed (operationally:
every ON transition after the first). Terraform's `terraform plan`
output will show the ruleset's required-check `context` field
changing, so the bump is visible in review. The ruleset now requires
`-g${N+1}` while the stale `success` check-run is under `-g${N}`;
rulesets evaluate per-exact-context-name, so the stale success is
ignored and the gate is fail-closed until the backfill repopulates
`-g${N+1}` on every open PR.

**Enable procedure (OFF → ON).**

1. In Terraform, bump
   `require_two_developer_approvals_check_generation` to a value
   never previously used, set
   `require_two_developer_approvals = true`, and `terraform apply`.
   The ruleset now requires a fresh generation's context that no PR
   currently has, so merges are blocked across all PRs
   fail-closed by construction.
2. Set `REQUIRE_TWO_DEVELOPER_APPROVALS = true` in the Actions-variable
   layer (either in the same `terraform apply` if the Actions variable
   is Terraform-managed via `agent-vars`, which it is in this repo; or
   as a follow-on step for adopters who manage the variable manually)
   and run the one-shot reconciliation workflow
   `require-two-developer-approvals-backfill.yml` (a trivial
   `workflow_dispatch`-only wrapper around the publisher activity that
   fans out across `gh pr list --state open --json number,headRefOid`)
   so the fresh-generation context is posted on every open PR with
   its current head SHA. Once that completes, the ruleset's
   required-check evaluation reflects the gate's intended semantics
   everywhere.

**Disable procedure (ON → OFF).** Set
`require_two_developer_approvals = false` and `terraform apply`. The
required-check entry is removed from the ruleset, so stale
enforcing-context check-runs on open PRs stop being evaluated and
cannot block merges. The publisher stops posting the enforcing
context going forward (per state 1 of Decision 7). No invalidation
pass is needed on disable because the next enable will carry a fresh
generation suffix anyway — the stale check-runs become orphans under
a context name the ruleset no longer references and will never
reference again.

**Why the generation counter is required even with the backfill
procedure.** An operator who follows only step 1 of the enable
procedure (ruleset flip without the backfill) would, under the
pre-generation design, nonetheless re-expose the ON → OFF → ON reuse
defect — because the stale `success` from the prior ON interval
remains the most-recent check-run under the fixed context name on
the unchanged head SHA. The generation counter removes that
possibility structurally: no amount of operator error on the backfill
step can resurrect a stale success under a context name the ruleset
is no longer looking at. The procedure then exists to make the
transition quick (post the fresh context now rather than waiting for
the next natural PR event) and smooth (operators see immediate green
on compliant PRs instead of fail-closed red).

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Publish `success` on the enforcing context when the opt-in is off | Was the original design; the OFF-mode success can satisfy the newly enforcing rule on an unchanged head SHA when the opt-in is flipped ON, allowing an already-open developer-agent PR to merge with fewer than two approvals. Replaced by "preview-context only in OFF mode" per the Decision above. |
| Skip the job entirely when the opt-in is off | The preview-context posting is a cheap signal that lets maintainers see what the gate would do if enabled, catching misconfiguration before activation. Keeping the publisher running also keeps the end-to-end wiring exercised. |
| Fail open (treat empty login as "no PRs match → always success") when the opt-in is on | Silently defeats the whole feature. Explicitly against the issue's intent. |
| Fail closed on only the dev-agent-author path when the login is empty | Insufficient: without `DEVELOPER_BOT_LOGIN` the publisher cannot tell which PRs are dev-agent-authored, so it cannot know which subset to block. Blocking every PR with `::error::` is the correct behaviour because the misconfiguration genuinely prevents the gate from working on *any* PR. |
| Enable in a single step (flip both Terraform and the Actions variable in the same `terraform apply`) | Also acceptable because the fail-closed posture holds between the two apply operations — Terraform sequences the ruleset change before the Actions-variable change within one apply only when the dependency graph requires it, and in this repo they are independent resources. The two-step document still recommends the backfill because the ruleset flip alone does not re-post anything on existing open PRs, so the backfill is where the operator confirms activation worked. |
| Keep a fixed context name and rely only on the operator-run backfill to invalidate prior ON-interval successes | Was the previous draft; the reviewer identified an ON → OFF → ON cycle where approvals change *while OFF* (so the prior success is still the most-recent check-run under the fixed context when the gate re-enables) and the stale success is reused. The generation counter in the Decision above removes this failure mode structurally: a bumped generation makes the previous success invisible to the ruleset's required-check lookup regardless of whether the operator remembers to run the backfill. The backfill then exists purely to make the transition green quickly, not to defend correctness. |
| Encode the generation in the ruleset `required_check` entry only (not in the context name) | GitHub rulesets evaluate check-runs by exact context name — there is no "generation" field on the `required_check` entry. Encoding the generation in the name itself is the only mechanism that makes prior check-runs invisible without requiring the operator to also invalidate them. |

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
concurrency:
  group: require-two-developer-approvals-pr-${{ github.event.workflow_run.pull_requests[0].number }}
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
has that SHA as its head**, the activity:

1. Resolves `candidatePrNumbers` by calling
   `GET /repos/{owner}/{repo}/commits/{liveHeadSha}/pulls` and
   filtering to PRs with `state == "open"` and
   `head.sha == liveHeadSha` (defensively re-checking per-PR because
   the commit-to-PR index can lag). The trigger-PR is included.
2. For each candidate PR, re-fetches the PR via
   `GET /repos/{owner}/{repo}/pulls/{number}` to read `user.login`
   (PR author) and the latest `pr.head.sha` (to drop any PR whose
   head has moved since step 1).
3. For each remaining candidate, applies the per-PR qualifying rule
   from Decision 4:
   - If PR author is **not** `DEVELOPER_BOT_LOGIN`, the per-PR
     outcome is `success` (Requirement 6).
   - If PR author **is** `DEVELOPER_BOT_LOGIN`, re-fetches reviews
     via `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, counts
     latest-per-reviewer `APPROVED` reviews excluding
     `DEVELOPER_BOT_LOGIN`, and the per-PR outcome is `success` iff
     count ≥ 2.
4. Publishes a single check-run for `liveHeadSha` under the generation
   context name with `conclusion = success` iff **every** candidate
   PR's per-PR outcome is `success` (strictest wins — if any dev-PR
   needs 2 and has fewer, the whole SHA is `failure`). The
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

- Calls `GET /repos/{owner}/{repo}/commits/{departingSha}/pulls`,
  filters to `state == "open"` with `head.sha == departingSha`, and
  **excludes the departing PR number** (which may or may not have
  already dropped out of the commit→PRs index; the explicit exclude
  is for correctness regardless).
- If the remaining-candidate set is empty, no republication is
  needed: the stale check-run on `departingSha` is now orphaned
  (no open PR has that SHA as head) and cannot block any merge.
- Otherwise, applies the Decision 8a strictest-wins intersection
  across the remaining candidates and publishes an updated
  check-run with `head_sha: departingSha` under the generation
  context name. The `output.summary` lists which PR left and which
  remain.

The live-head publication path (Decision 8 against `liveHeadSha`)
and the departed-SHA reconciliation path both run in the same
workflow invocation but as separate jobs so each can take its own
per-SHA concurrency lock. Both paths complete before the run exits.
If `liveHeadSha == departingSha` (which cannot happen for
`synchronize` but can happen defensively if the publisher is ever
invoked with no actual head change), the departing-SHA path is a
no-op because the departing PR is still at that SHA and the
exclude-rule would be unsafe; the activity detects this case and
skips the second path.

**Rationale.**

- Requirement 6 (non-dev-author PRs pass immediately) still holds for
  a non-dev PR whose head is not shared with any dev PR: the single
  candidate's outcome is `success` and the published conclusion is
  `success` with no delay.
- A non-dev PR that happens to share a SHA with an under-approved
  dev-agent PR will see its merge blocked until the dev PR is either
  approved to the required count, closed, or has its head advanced to
  a different SHA. This is the only correct outcome — the shared
  commit is the thing being merged, and the gate's purpose is to
  demand two approvals on that commit when any proposer is the dev
  agent. The non-dev PR author can advance their head by one no-op
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
- Two dev-agent PRs with different approval counts on the same SHA
  intersect to the lower approval count's outcome, which is
  consistent with "the SHA is only safe to merge when every proposer
  of this SHA has met the bar".

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Give each PR its own context name (e.g. `require-two-developer-approvals-g${N}-pr-${number}`) | GitHub rulesets require a literal context name on the `required_check` entry — there is no templating. One context per possible PR number is operationally impossible. |
| Publish per-PR check-runs with distinct names and have the ruleset accept any one matching a pattern | No "any of" matching exists in rulesets. Required checks are named individually. |
| Trust the per-PR concurrency group alone and ignore the SHA-sharing case | The reviewer's concrete scenario — a human-opened PR's `success` satisfying a shared-SHA dev-agent PR's enforcement — is a real merge-gate bypass. Not acceptable. |
| Only publish from the dev-agent-author PR when a conflict exists | Requires the publisher to know, from the non-dev PR's run, that a dev PR exists and defer to its publication order. The strictest-wins intersection in the Decision above achieves the same outcome symmetrically without ordering fragility. |
| Advance the gate's granularity from commit SHA to PR+SHA via a `details_url`/annotation hack | The ruleset's evaluation is still per-context-per-SHA. Metadata on the check-run does not change what the ruleset accepts. |
| Skip departed-SHA reconciliation and rely on the remaining PR to receive its own event eventually | Was the previous draft. A human PR left on a shared SHA after a dev-agent sibling closes has no event in the publisher's trigger set that is guaranteed to fire against it — the publisher subscribes to `pull_request_target` on the departing PR (which only produces events for *that* PR) and `workflow_run` from the notifier (which only fires on review submissions). With no further review activity or push on the remaining PR, its `failure` conclusion from the shared-with-under-approved-dev-PR era persists indefinitely. The departed-SHA reconciliation in the Decision above fixes this explicitly. |
| Trigger `pull_request_target` on `closed` but reconcile only on the next review submission against a sibling | Still asymmetric: a human PR that no longer has any new review activity (because its author considers it done and is waiting on the dev PR to resolve) stays blocked. Including `closed` in the trigger set and running the Decision 8a intersection on the departing SHA inside the same workflow run is a single-event, no-user-action fix. |

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
     current generation's enforcing context name, and
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
   PR that has one human approval under opt-in OFF, bump the
   generation counter, flip the opt-in ON, and run the backfill
   workflow. Merge must be blocked until a second non-self approval
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
   **without bumping the generation counter** and assert that the
   merge is unblocked — then redo the same sequence with the
   generation counter **bumped** on the second ON, assert that the
   merge is blocked until the second approval re-lands. This is the
   specific defect the generation counter prevents. (Covers
   Decision 7.)
9. **Opt-in on with empty login** — set the Actions variable to the
   opt-in on and leave `DEVELOPER_BOT_LOGIN` empty. Every PR (human,
   agent, bot) must see `::error::` and a `failure` conclusion.
   (Covers Decision 7.)
10. **Shared head SHA — human + developer** — open two PRs whose head
    branches point at the same commit SHA, one authored by a human
    and one by the developer agent with 0 qualifying approvals. The
    published check-run on the shared SHA must be `failure`; the
    human PR must be blocked from merging as long as the dev PR's
    requirement is unmet. (Covers Decision 8a.)
11. **Shared head SHA — two dev-agent PRs with different approval
    counts** — open two developer-agent PRs on the same head SHA, one
    with 2 qualifying approvals and one with 1. The published
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
14. **Departed-SHA reconciliation on close** — open two PRs on the
    same head SHA H1: a human-authored PR and an under-approved
    (0 approvals) developer-agent PR. The initial published
    check-run on H1 is `failure` per Decision 8a (test state).
    Close the developer-agent PR with no other activity on the
    human PR. After the `pull_request_target: closed` run completes,
    the republished check-run on H1 must be `success` (strictest-wins
    across the remaining human PR alone yields `success`), and the
    human PR must become mergeable. (Covers Decision 8a's
    departed-SHA reconciliation.)
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
16. **Standard counting cases** — the full matrix listed in Issue #662
    (0/1/2/3 non-self approvals, self-approval ignored, DISMISSED
    latest-per-reviewer, etc.).

### Decision 10 — Documentation surfaces

The following must be updated in the same PR as the implementation (per
AGENTS.md § "Keeping Documentation Current"):

- `AGENTS.md`:
  - Add `DEVELOPER_BOT_LOGIN`, `REQUIRE_TWO_DEVELOPER_APPROVALS`, and
    `REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION` to the
    "Terraform-managed … Actions variables" list in the documentation-update
    checklist.
  - Add a short bullet under § "Code Review Standards" → "Repo-specific
    security defaults" / "Branch-protection immutability" cross-referencing
    the new design doc and noting that lowering `require_two_developer_approvals`
    from `true` to `false` must be justified in the PR body (same pattern as
    "lowers `required_approving_review_count` below 1").
  - List the two new publisher workflows
    (`require-two-developer-approvals-publisher.yml`,
    `require-two-developer-approvals-notify.yml`,
    `require-two-developer-approvals-backfill.yml`) in the Repository Layout
    section.
- `terraform/modules/branch-protection/README.md`: document the four
  new module variables (`require_two_developer_approvals`,
  `require_two_developer_approvals_check_context`,
  `require_two_developer_approvals_check_integration_id`,
  `require_two_developer_approvals_check_generation`), the dynamic
  `required_status_checks` block, the generation-counter semantics
  from Decision 7 (bump on every ON → OFF → ON cycle), **and** the
  admin-bypass caveat described in the Interactions section (admins
  with `bypass_mode = "pull_request"` can bypass the two-approval
  check when merging a PR — this is explicit, documented, and
  auditable). Also document the two-step enable/disable procedure,
  the one-shot `require-two-developer-approvals-backfill.yml`
  workflow, the modified-notifier residual-risk discussion from
  Decision 5 (including the **honest** effective-merge-gate
  degradation to one approval under the attack — not two — so
  operators understand what the shipping posture actually
  guarantees), the shared head-SHA cross-PR behaviour from
  Decision 8a (so operators and reviewers are not surprised by a
  human-opened PR being blocked because it shares a commit SHA with
  an under-approved dev-agent PR), and the departed-SHA
  reconciliation behaviour (a human PR blocked by sharing a SHA
  with an under-approved dev-agent PR is auto-unblocked when the
  dev PR closes or advances to a new SHA, without any further
  activity on the human PR).
- `terraform/modules/agent-vars/README.md`: document the three new
  Actions variables (`DEVELOPER_BOT_LOGIN`,
  `REQUIRE_TWO_DEVELOPER_APPROVALS`,
  `REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION`) and the usage
  example.
- `terraform/terraform.tfvars.example`: show commented-out example values
  for `developer_bot_login`, `require_two_developer_approvals`, and
  `require_two_developer_approvals_check_generation`.
- `docs/adopting.md`: add a section for external adopters explaining
  the identity-configuration contract (set `developer_bot_login` to
  their own App's `<slug>[bot]`), the enable/disable + backfill
  procedure, the generation-counter bump requirement on re-enable,
  the override path for
  `require_two_developer_approvals_check_integration_id` when they
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
- **Hardcoded `mfrancza-developer-agent[bot]` sites in
  `agent-pr-merged.yml`, `agent-respond-review.yml`,
  `agent-fix-checks.yml`.** This feature introduces `DEVELOPER_BOT_LOGIN`
  as a shared source of truth. A follow-up could migrate those three
  hardcoded sites to the same variable, but that is explicitly out of
  scope here per Issue [#559](https://github.com/mfrancza/agentic-development-workflow/issues/559)'s
  design decision (see Decision 1 of [`docs/design/auto-review-author-gate.md`](auto-review-author-gate.md)).

## Out of scope

- **Migrating the three hardcoded `mfrancza-developer-agent[bot]` sites**
  in `agent-pr-merged.yml`, `agent-respond-review.yml`, and
  `agent-fix-checks.yml` to `DEVELOPER_BOT_LOGIN`. Deliberately deferred
  to a focused follow-up; see the cross-reference above.
- **A separate "require N approvals" generalisation** (e.g. configurable
  review count). The issue specifies two; a configurable count can be
  added later with no breaking changes.
- **Automatically dismissing the reviewer-agent's advisory `APPROVE`** when
  it isn't paired with a human approval. Out of scope — the status quo
  already correctly treats the reviewer agent's approval as non-blocking
  for `required_approving_review_count = 1`.
- **Replacing `developer-author` on `agent-resolve-conflicts-reusable.yml`
  with `DEVELOPER_BOT_LOGIN`.** Two configuration surfaces are
  maintained in parallel on purpose — one in the `app/<slug>` search-qualifier
  form and one in the `<slug>[bot]` login form. A consistency check could
  be added later via a Vitest static test that asserts
  `DEVELOPER_BOT_LOGIN` and `developer_author` resolve to the same App.
- **Covering review requirements for the designer agent, reviewer agent, or
  grooming agent authored PRs.** Only the designer agent realistically
  opens PRs under its own identity today, and the issue scope is explicitly
  the developer agent. If the scope expands, a sibling boolean (e.g.
  `require_two_designer_approvals`) can be added using the same mechanism.
- **Scheduled re-posting of the check on long-open PRs.** The event-driven
  triggers cover every state change that matters; a cron is unnecessary.
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
| [#661](https://github.com/mfrancza/agentic-development-workflow/issues/661) | Terraform: add `developer_bot_login`, `require_two_developer_approvals`, and `require_two_developer_approvals_check_generation` top-level variables; wire through `terraform/main.tf` to the `agent-vars` module (which exposes them as `DEVELOPER_BOT_LOGIN`, `REQUIRE_TWO_DEVELOPER_APPROVALS`, and `REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION` Actions variables) and to the `branch-protection` module. Extend `branch-protection` with the four new inputs (`require_two_developer_approvals`, `require_two_developer_approvals_check_context` defaulting to `null` and composed via the locals in Decision 3, `require_two_developer_approvals_check_integration_id` defaulted to 15368, and `require_two_developer_approvals_check_generation` defaulted to 1) and the dynamic `required_status_checks` block in the ruleset. Document the admin-bypass caveat, the generation-counter semantics, the shared-SHA cross-PR note, the modified-notifier residual risk, and the two-step enable/disable + backfill procedure in both module READMEs and `terraform.tfvars.example`. | — |
| [#662](https://github.com/mfrancza/agentic-development-workflow/issues/662) | TypeScript activity + composite action: implement `.github/scripts/src/check-two-developer-approvals.ts` and `.github/actions/check-two-developer-approvals/action.yml`. Activity reads inputs `developer-bot-login`, `require-two-developer-approvals`, `check-generation`, `pr-number`, `pr-author`, `event-head-sha`, `event-name`, `event-before-sha`, `repo`; fetches the PR and reviews via Octokit **inside** the serialization boundary (Decision 8), resolves all open PRs that share `liveHeadSha` and applies the strictest-wins intersection from Decision 8a, groups latest-per-reviewer per PR, counts qualifying approvals, and publishes the check conclusion via the Checks API against `liveHeadSha` under context `require-two-developer-approvals-g${generation}` (enforcing) or `require-two-developer-approvals-g${generation} (preview)` (opt-in off, per Decision 7). Always publishes against `liveHeadSha` even when it disagrees with the event SHA (Decision 8). On `pull_request_target: synchronize` and `pull_request_target: closed`, also runs the Decision 8a departed-SHA reconciliation against the departing SHA (`event-before-sha` for synchronize; `event-head-sha` of the closed PR for closed) and republishes the intersected check-run on that SHA under the per-SHA concurrency lock. Honours the draft-handling contract: skips the main path on draft PRs except when the triggering event is `ready_for_review`. Fails loudly per Decision 7. Unit tests cover the full matrix in Decision 9 that is unit-testable (counting, self-exclusion, DISMISSED, opt-in-off → preview context only, opt-in-on + empty login → `::error::` + failure, event-SHA ≠ live-SHA → publishes against live SHA, two-PR same-SHA strictest-wins intersection, departed-SHA reconciliation on closure and on synchronize, draft-to-ready reconciliation with unchanged head). | — |
| [#663](https://github.com/mfrancza/agentic-development-workflow/issues/663) | Workflows + reusables: add `require-two-developer-approvals-publisher.yml` (caller stub, triggered by `pull_request_target: [opened, reopened, synchronize, edited, ready_for_review, closed]` and `workflow_run`), `require-two-developer-approvals-notify.yml` (empty, zero-permission `pull_request_review` trigger), and the paired reusable with the four-step helper-checkout bootstrap. Also add `require-two-developer-approvals-backfill.yml` (`workflow_dispatch` only) that fans out across open PRs for the Decision 7 opt-in reconciliation. All stubs set the per-PR concurrency group with `cancel-in-progress: false` per Decision 8, and the publisher additionally takes a secondary per-head-SHA concurrency group per Decision 8a (both for the live-head publication and for the departed-SHA reconciliation sibling job, each in its own job because Actions supports one `concurrency` block per job). Publisher stubs read `vars.DEVELOPER_BOT_LOGIN`, `vars.REQUIRE_TWO_DEVELOPER_APPROVALS`, and `vars.REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION` and pass them to the reusable, which invokes the composite action from Issue #662. Publisher stubs pass `event-name` and `event-before-sha` (populated from `github.event.before` on `synchronize`; from `github.event.pull_request.head.sha` on `closed`) so the activity can run the departed-SHA reconciliation. Publisher stubs select the trusted `helpers-ref: ${{ github.sha }}` per Decision 5 on both legs (base-branch HEAD under both `pull_request_target` and `workflow_run`). | Issue #662 |
| [#664](https://github.com/mfrancza/agentic-development-workflow/issues/664) | Documentation: update `AGENTS.md` (new workflows in the Repository Layout note, new Actions variables in the doc-update checklist, branch-protection-immutability bullet, admin-bypass caveat cross-reference, honest modified-notifier degradation cross-reference) and `docs/adopting.md` (section for external adopters covering `developer_bot_login`, `require_two_developer_approvals_check_integration_id` override, the generation-counter bump requirement on re-enable, the shared-SHA cross-PR note, the departed-SHA reconciliation behaviour, the modified-notifier residual-risk discussion with the honest effective-gate-degradation statement, and the enable/disable + backfill procedure). | Issue #661, Issue #663 |
| [#665](https://github.com/mfrancza/agentic-development-workflow/issues/665) | End-to-end validation: execute every acceptance test in Decision 9 against a scratch repository configured per the Decision 10 docs, including the fork-PR publication case, the extended trust-anchor "PR modifies the gate" case (publisher + reusable + composite action + activity + notifier + spoof-publisher workflow all in one PR) with the honest 3a/3b assertions (authoritative-publisher correctness and the one-approval-under-attack effective-gate-degradation case), the integration_id binding case, the stale-event replacement (three-run interleaving) case, the OFF → ON → OFF → ON cycle with dismissal while OFF, the three same-SHA cross-PR cases, the draft-to-ready reconciliation case, and the two departed-SHA reconciliation cases (closure and synchronize). Also exercise the misconfiguration path (opt-in on + empty login). | Issues #661, #662, #663, #664 |

Issues #661 and #662 are independent and can proceed in parallel — the
contract (variable names `DEVELOPER_BOT_LOGIN`,
`REQUIRE_TWO_DEVELOPER_APPROVALS`, and
`REQUIRE_TWO_DEVELOPER_APPROVALS_CHECK_GENERATION`; enforcing
check-context name composed as
`require-two-developer-approvals-g${generation}`; preview context
name `require-two-developer-approvals-g${generation} (preview)`;
`integration_id = 15368`; activity input names) is established by
this document. Issue #663 depends on Issue #662 because the reusable
invokes the composite action from #662. Issue #664 can be drafted in
parallel but should land with #661 and #663 so docs and code ship
together per AGENTS.md § "Keeping Documentation Current". Issue #665
depends on everything.

Dependencies are recorded natively as GitHub blocked-by relationships on
the sub-issues.
