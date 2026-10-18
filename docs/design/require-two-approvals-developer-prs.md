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
design would have silently blocked.

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
```

Both variables are wired through `terraform/main.tf` → `agent_vars` module
→ `github_actions_variable` resources named `DEVELOPER_BOT_LOGIN` and
`REQUIRE_TWO_DEVELOPER_APPROVALS`. The branch-protection module gains a
new input `require_two_developer_approvals_check_context` (defaulted to
the stable check-context name defined by Decision 6) that is referenced
only when the opt-in is on.

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

dynamic "required_status_checks" {
  for_each = var.require_two_developer_approvals ? [1] : []
  content {
    strict_required_status_checks_policy = false
    required_check {
      context        = var.require_two_developer_approvals_check_context
      # integration_id MUST be set — leaving it unset does not default to
      # GitHub Actions; it leaves the required check's source unrestricted,
      # meaning any identity with status/check-publication permission on the
      # repo (another GitHub App, a classic PAT with repo:status, etc.) can
      # satisfy the required context without executing the gate workflow.
      # Pinning to the GitHub Actions App (public, well-known ID 15368) binds
      # the required context to the publisher we actually execute. See
      # GitHub Docs, "Available rules for rulesets > Require status checks
      # to pass" for the "specified source App vs. accept any source" split.
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
  description = "Status-check context name produced by the two-approvals workflow. Only used when require_two_developer_approvals is true. Defaults to the stable context published by this repo's require-two-developer-approvals-publisher.yml via the Checks API (see Decision 6)."
  type        = string
  default     = "require-two-developer-approvals"
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
    types: [opened, reopened, synchronize, edited]
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
- Under `pull_request_target`, `github.sha` already equals the base-branch
  HEAD, so the caller stub can safely pass `helpers-ref: ${{ github.sha }}`
  for the four-step helper-checkout bootstrap (same guarantee the
  existing [`agent-review.yml`](../../.github/workflows/agent-review.yml)
  stub relies on).
- Under `workflow_run`, `github.sha` is the SHA that triggered the
  originating workflow (the notifier's run), which for `pull_request_review`
  events is the PR head SHA — **not** a trusted ref. The publisher's
  caller stub therefore MUST NOT pass `${{ github.sha }}` as
  `helpers-ref`. It instead passes
  `${{ github.event.workflow_run.head_repository.default_branch }}` and
  the reusable resolves that ref to a concrete commit SHA inside the
  trusted job before any helper code runs. The implementer must include
  a dedicated acceptance test (see Decision 9) in which the PR itself
  modifies the publisher workflow and/or the composite action; the
  gate's behaviour must be unchanged by that modification.
- The notifier is intentionally stub-only; it does not take a
  `helpers-ref` input and performs no checkout, so there is no helper-ref
  concern on that path.

**Event-by-event rationale.**

- `pull_request_target: opened|reopened` — publish the initial check
  conclusion for a new PR (immediate success for non-dev-author PRs;
  initial `failure` for dev-author PRs with 0 approvals).
- `pull_request_target: synchronize` — recompute when new commits land.
  `dismiss_stale_reviews_on_push = true` (today's `main-protection` setting
  — see [`terraform/modules/branch-protection/main.tf`](../../terraform/modules/branch-protection/main.tf))
  automatically dismisses prior approvals on push; the publisher re-reads
  the latest states inside the serialization boundary defined by
  Decision 8 and reflects the new count.
- `pull_request_target: edited` — defensive; cheap to handle and keeps the
  conclusion resilient to any PR metadata change we might key off later.
- `workflow_run (require-two-developer-approvals-notify)` — fires after
  every `pull_request_review: submitted|edited|dismissed`. The publisher
  reads the triggering PR from `github.event.workflow_run.pull_requests[0]`
  (same shape agent-fix-checks already uses) and recomputes.

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
but the `if:` still filters out closed/draft PRs for cost reasons), the
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
| Pin `helpers-ref` to a hardcoded repository branch name like `main` | Loses the single-source-of-truth property that `agent-review.yml` relies on and makes external adopters whose default branch is not `main` patch the stub. Using the `workflow_run` payload's `default_branch` field keeps the stub portable. |
| Trigger only on `pull_request_review` (ignore pull-request events entirely) | Misses the initial state when a PR is opened or when new commits land before any reviews exist. The check stays in "no status" / pending indefinitely, which some GitHub UIs render as a merge block without context. |
| Trigger on `pull_request_review_thread` | Thread resolution does not change the approval count. Not relevant. |
| Trigger on `schedule` as a safety net | Not needed. The event triggers cover every state change that matters; a cron rerun would recompute the same answer most of the time and add noise. |

### Decision 6 — Publish the check conclusion via the Checks API, with a stable context name bound to the GitHub Actions App

**Decision.** The activity publishes the check conclusion using the
Checks API (`POST /repos/{owner}/{repo}/check-runs`) with a stable `name`
of `require-two-developer-approvals`. The ruleset's `required_status_checks`
block references that context **and pins its `integration_id` to the
GitHub Actions App (public ID 15368)** so only check-runs produced by the
publisher workflow can satisfy the required context (see Decision 3).
The workflow job itself also pass/fails for debuggability, but it is the
Checks API conclusion the ruleset evaluates.

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

**Activation reconciliation (OFF → ON on existing PRs).**
Flipping `require_two_developer_approvals` from `false` to `true` in
Terraform (and the matching Actions-variable change) does not by itself
fire any of Decision 5's events on existing open PRs — the ruleset
change and the `vars.*` change are not PR events. Without extra
handling, an already-open developer-agent PR whose head SHA had not
changed could satisfy the newly enforcing context from (a) a stale
`success` check-run posted while the gate was OFF, or (b) sheer absence
of a matching check-run on a head SHA that pre-dates the activation.
Because Decision 7 above prohibits (a) by never publishing the
enforcing context in OFF mode, (b) is the remaining concern — a
missing check-run means the ruleset blocks until one is posted, which
is the fail-closed posture we want.

To ensure the fail-closed posture holds in practice, enablement is a
**two-step** operator procedure, documented in both
[`terraform/modules/branch-protection/README.md`](../../terraform/modules/branch-protection/README.md)
and `docs/adopting.md`:

1. Flip `require_two_developer_approvals = true` in Terraform and
   `terraform apply` **before** flipping the Actions variable. The
   ruleset now requires a context that no PR currently has, so merges
   are blocked across all PRs — fail-closed by construction.
2. Set `REQUIRE_TWO_DEVELOPER_APPROVALS = true` in the Actions-variable
   layer (either in the same `terraform apply` if the Actions variable
   is Terraform-managed via `agent-vars`, which it is in this repo; or
   as a follow-on step for adopters who manage the variable manually)
   and run the one-shot reconciliation workflow
   `require-two-developer-approvals-backfill.yml` (a trivial
   `workflow_dispatch`-only wrapper around the publisher activity that
   fans out across `gh pr list --state open --json number,headRefOid`)
   so the enforcing context is posted on every open PR with its
   current head SHA. Once that completes, the ruleset's required-check
   evaluation reflects the gate's intended semantics everywhere.

Disabling (ON → OFF) is the inverse and is safe without a backfill:
after `terraform apply` removes the required-check entry, the stale
enforcing-context check-runs on open PRs are no longer evaluated by
the ruleset, so they do not block merges even if they were `failure`.
The publisher stops posting them going forward.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Publish `success` on the enforcing context when the opt-in is off | Was the original design; the OFF-mode success can satisfy the newly enforcing rule on an unchanged head SHA when the opt-in is flipped ON, allowing an already-open developer-agent PR to merge with fewer than two approvals. Replaced by "preview-context only in OFF mode" per the Decision above. |
| Skip the job entirely when the opt-in is off | The preview-context posting is a cheap signal that lets maintainers see what the gate would do if enabled, catching misconfiguration before activation. Keeping the publisher running also keeps the end-to-end wiring exercised. |
| Fail open (treat empty login as "no PRs match → always success") when the opt-in is on | Silently defeats the whole feature. Explicitly against the issue's intent. |
| Fail closed on only the dev-agent-author path when the login is empty | Insufficient: without `DEVELOPER_BOT_LOGIN` the publisher cannot tell which PRs are dev-agent-authored, so it cannot know which subset to block. Blocking every PR with `::error::` is the correct behaviour because the misconfiguration genuinely prevents the gate from working on *any* PR. |
| Enable in a single step (flip both Terraform and the Actions variable in the same `terraform apply`) | Also acceptable because the fail-closed posture holds between the two apply operations — Terraform sequences the ruleset change before the Actions-variable change within one apply only when the dependency graph requires it, and in this repo they are independent resources. The two-step document still recommends the backfill because the ruleset flip alone does not re-post anything on existing open PRs, so the backfill is where the operator confirms activation worked. |

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

**Re-fetch and head-SHA verification inside the boundary.** Before the
Checks API POST, the activity:

1. Re-fetches the PR via `GET /repos/{owner}/{repo}/pulls/{number}` and
   captures `pr.head.sha` as `verifiedHeadSha`. If this disagrees with
   the head SHA the workflow was triggered on (`event.pull_request.head.sha`
   or `event.workflow_run.pull_requests[0].head.sha`), the activity
   logs the mismatch, exits 0, and publishes nothing — a newer event is
   already queued behind this run on the same concurrency group and
   will publish the correct conclusion.
2. Re-fetches reviews via `GET /repos/{owner}/{repo}/pulls/{number}/reviews`
   (paginated) and applies the Decision 4 counting rule to the latest
   per-reviewer `APPROVED` set.
3. Posts the check-run with `head_sha: verifiedHeadSha`. Rulesets
   evaluate check-runs against the current head SHA, so a check-run
   written for a stale head SHA cannot overwrite the enforcement
   decision for the newer head.

**Why re-fetch is necessary even with `cancel-in-progress: false`.**
GitHub Actions concurrency serializes job start order within a group,
but the event payloads delivered to each run are snapshots from when
the event fired. If run A was triggered by review #1 and run B by
review #2 (where #2 dismissed #1), and they are queued in A→B order,
A's event payload still contains the pre-dismissal state. Re-fetching
inside the boundary ensures the publication reflects the current
server-side state, not the event-payload state. The head-SHA check
additionally guards against the case where the ordering above is
inverted (B observed by Actions before A due to webhook delivery
jitter) — the stale A run detects it is behind and publishes nothing.

**Acceptance test for out-of-order publication.** Decision 9 includes
a specific test case in which two review events are fired in rapid
succession (approve, then dismiss) and the final check-run on the head
SHA reflects the post-dismissal state, with no intermediate stale
`success` left behind.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| `cancel-in-progress: true` | Cancelling in-flight runs sounds like it serializes correctly, but it introduces the opposite race: the in-flight run (reading post-dismissal state) gets cancelled by the arrival of a stale event, which then publishes a stale success. The correct posture is queue-and-recompute, not cancel. |
| Rely on event ordering without re-fetch | Webhook delivery is not strictly ordered relative to review state transitions. Re-fetching from the API inside the boundary is the only way to be sure the published conclusion matches the live state. |
| Use an external lock / Redis / etc. | Workflow-level concurrency plus API re-fetch is sufficient for a per-PR serialization boundary and introduces no new infrastructure. |

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
   same-repository PR whose diff edits the publisher workflow, the
   reusable, the composite action, and the TypeScript activity to
   publish unconditional `success`. The gate's conclusion on that PR
   must still reflect its real approval count. This proves the
   base-branch execution path is in force.
4. **Integration_id binding** — simulate an unrelated GitHub App
   posting a check-run of the gate's context name with `conclusion:
   success` on an under-approved developer-agent PR. The ruleset must
   still block merge. (Covers Decision 6.)
5. **Out-of-order publication** — fire an approve review and a
   dismiss review in rapid succession on a developer-agent PR; the
   final check-run on the current head SHA must be `failure`, with no
   stale `success` observable at any point after the dismiss event is
   processed. (Covers Decision 8.)
6. **OFF → ON on an unchanged open PR** — with an open developer-agent
   PR that has one human approval under opt-in OFF, flip the opt-in ON
   and run the backfill workflow. Merge must be blocked until a second
   non-self approval lands. (Covers Decision 7.)
7. **ON → OFF on an under-approved PR** — with an open developer-agent
   PR currently failing the gate under opt-in ON, flip the opt-in OFF.
   Merge must be allowed as soon as the baseline
   `required_approving_review_count = 1` is satisfied. (Covers
   Decision 7.)
8. **Opt-in on with empty login** — set the Actions variable to the
   opt-in on and leave `DEVELOPER_BOT_LOGIN` empty. Every PR (human,
   agent, bot) must see `::error::` and a `failure` conclusion.
   (Covers Decision 7.)
9. **Standard counting cases** — the full matrix listed in Issue #662
   (0/1/2/3 non-self approvals, self-approval ignored, DISMISSED
   latest-per-reviewer, etc.).

### Decision 10 — Documentation surfaces

The following must be updated in the same PR as the implementation (per
AGENTS.md § "Keeping Documentation Current"):

- `AGENTS.md`:
  - Add `DEVELOPER_BOT_LOGIN` and `REQUIRE_TWO_DEVELOPER_APPROVALS` to the
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
- `terraform/modules/branch-protection/README.md`: document the three new
  module variables (`require_two_developer_approvals`,
  `require_two_developer_approvals_check_context`,
  `require_two_developer_approvals_check_integration_id`), the dynamic
  `required_status_checks` block, **and** the admin-bypass caveat
  described in the Interactions section (admins with `bypass_mode =
  "pull_request"` can bypass the two-approval check when merging a PR —
  this is explicit, documented, and auditable). Also document the
  two-step enable/disable procedure and the one-shot
  `require-two-developer-approvals-backfill.yml` workflow.
- `terraform/modules/agent-vars/README.md`: document the two new Actions
  variables and the usage example.
- `terraform/terraform.tfvars.example`: show commented-out example values
  for `developer_bot_login` and `require_two_developer_approvals`.
- `docs/adopting.md`: add a section for external adopters explaining
  the identity-configuration contract (set `developer_bot_login` to
  their own App's `<slug>[bot]`), the enable/disable + backfill
  procedure, and the override path for
  `require_two_developer_approvals_check_integration_id` when they
  publish from a GitHub App other than GitHub Actions.

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

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#661](https://github.com/mfrancza/agentic-development-workflow/issues/661) | Terraform: add `developer_bot_login` and `require_two_developer_approvals` top-level variables; wire through `terraform/main.tf` to the `agent-vars` module (which exposes them as `DEVELOPER_BOT_LOGIN` and `REQUIRE_TWO_DEVELOPER_APPROVALS` Actions variables) and to the `branch-protection` module. Extend `branch-protection` with the three new inputs (`require_two_developer_approvals`, `require_two_developer_approvals_check_context`, `require_two_developer_approvals_check_integration_id` — the last defaulted to 15368 per Decision 3) and the dynamic `required_status_checks` block in the ruleset. Document the admin-bypass caveat and the two-step enable/disable + backfill procedure in both module READMEs and `terraform.tfvars.example`. | — |
| [#662](https://github.com/mfrancza/agentic-development-workflow/issues/662) | TypeScript activity + composite action: implement `.github/scripts/src/check-two-developer-approvals.ts` and `.github/actions/check-two-developer-approvals/action.yml`. Activity reads inputs `developer-bot-login`, `require-two-developer-approvals`, `pr-number`, `pr-author`, `event-head-sha`, `repo`; fetches the PR and reviews via Octokit **inside** the serialization boundary (Decision 8), verifies head-SHA agreement before publishing, groups latest-per-reviewer, counts qualifying approvals, and publishes the check conclusion via the Checks API with context `require-two-developer-approvals` (enforcing) or `require-two-developer-approvals (preview)` (opt-in off, per Decision 7). Fails loudly per Decision 7. Unit tests cover the full matrix in Decision 9 that is unit-testable (counting, self-exclusion, DISMISSED, opt-in-off → preview context only, opt-in-on + empty login → `::error::` + failure, head-SHA mismatch → no publication). | — |
| [#663](https://github.com/mfrancza/agentic-development-workflow/issues/663) | Workflows + reusables: add `require-two-developer-approvals-publisher.yml` (caller stub, triggered by `pull_request_target` and `workflow_run`), `require-two-developer-approvals-notify.yml` (empty, zero-permission `pull_request_review` trigger), and the paired reusable with the four-step helper-checkout bootstrap. Also add `require-two-developer-approvals-backfill.yml` (`workflow_dispatch` only) that fans out across open PRs for the Decision 7 opt-in reconciliation. All stubs set the per-PR concurrency group with `cancel-in-progress: false` per Decision 8. Publisher stubs read `vars.DEVELOPER_BOT_LOGIN` and `vars.REQUIRE_TWO_DEVELOPER_APPROVALS` and pass them to the reusable, which invokes the composite action from Issue #662. Publisher stubs select the trusted `helpers-ref` per Decision 5. | Issue #662 |
| [#664](https://github.com/mfrancza/agentic-development-workflow/issues/664) | Documentation: update `AGENTS.md` (new workflows in the Repository Layout note, new Actions variables in the doc-update checklist, branch-protection-immutability bullet, admin-bypass caveat cross-reference) and `docs/adopting.md` (section for external adopters covering `developer_bot_login`, `require_two_developer_approvals_check_integration_id` override, and the enable/disable + backfill procedure). | Issue #661, Issue #663 |
| [#665](https://github.com/mfrancza/agentic-development-workflow/issues/665) | End-to-end validation: execute every acceptance test in Decision 9 against a scratch repository configured per the Decision 10 docs, including the fork-PR publication case, the trust-anchor "PR modifies the gate" case, the integration_id binding case, the out-of-order publication case, and the OFF→ON / ON→OFF transitions on existing open PRs. Also exercise the misconfiguration path (opt-in on + empty login). | Issues #661, #662, #663, #664 |

Issues #661 and #662 are independent and can proceed in parallel — the
contract (variable names `DEVELOPER_BOT_LOGIN` and `REQUIRE_TWO_DEVELOPER_APPROVALS`;
enforcing check-context name `require-two-developer-approvals`;
preview context name `require-two-developer-approvals (preview)`;
`integration_id = 15368`; activity input names) is established by this
document. Issue #663 depends on Issue #662 because the reusable invokes
the composite action from #662. Issue #664 can be drafted in parallel
but should land with #661 and #663 so docs and code ship together per
AGENTS.md § "Keeping Documentation Current". Issue #665 depends on
everything.

Dependencies are recorded natively as GitHub blocked-by relationships on
the sub-issues.
