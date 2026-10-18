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
is enabled, so the default behavior of the repository is unchanged.

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
      context = var.require_two_developer_approvals_check_context
      # integration_id omitted → GitHub Actions check (default integration)
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
  description = "Status-check context name produced by the two-approvals workflow (job-id form, e.g. 'require-two-developer-approvals / check'). Only used when require_two_developer_approvals is true. Defaults to the context published by this repo's require-two-developer-approvals.yml workflow."
  type        = string
  default     = "require-two-developer-approvals / check"
}
```

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

### Decision 5 — Trigger events and workflow shape

**Decision.** The workflow listens on exactly the events whose outcome can
change the required status check conclusion:

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, edited]
  pull_request_review:
    types: [submitted, edited, dismissed]
```

- `pull_request: opened|reopened` — publish the initial check conclusion
  for a new PR (immediate success for non-dev-author PRs; initial failure
  for dev-author PRs with 0 approvals).
- `pull_request: synchronize` — recompute when new commits land. If
  `dismiss_stale_reviews_on_push = true` (today's `main-protection` setting
  — see [`terraform/modules/branch-protection/main.tf`](../../terraform/modules/branch-protection/main.tf)),
  GitHub automatically converts prior approvals to `DISMISSED` on push; the
  workflow re-reads the latest states and reflects the new count.
- `pull_request: edited` — the PR author can be changed via title/body
  edits in principle (not in practice), but `edited` is cheap and makes
  the check conclusion resilient to any PR metadata change we might
  encode-around later.
- `pull_request_review: submitted|edited|dismissed` — recompute whenever
  the approval set changes.

Workflow permissions: `pull-requests: read`, `checks: write` (to publish
the check conclusion via the Checks API — see Decision 6 for why Checks
API instead of job pass/fail). Uses the workflow `GITHUB_TOKEN`; no App
token minting needed. Runs under `pull_request` (not `pull_request_target`)
because no secrets or App credentials are needed and the computation
reads only PR metadata and review states — nothing from the PR head
checkout. **No checkout of the PR head is performed.**

The workflow follows the repo's reusable + caller-stub split
([`agent-respond-review.yml`](../../.github/workflows/agent-respond-review.yml) /
`agent-respond-review-reusable.yml` pattern): a thin caller stub holds
the triggers and the `DEVELOPER_BOT_LOGIN` / `REQUIRE_TWO_DEVELOPER_APPROVALS`
variable reads, and a reusable workflow holds the composite-action
invocation and the four-step helper-checkout bootstrap (see AGENTS.md
§ "Reusable workflows: self-checkout for helper actions"). The computation
itself is a TypeScript activity under `.github/scripts/src/` wrapped as a
composite action under `.github/actions/` (per AGENTS.md § "Workflow
Activity Conventions" — the activity has branching, API-response parsing,
and pagination, so the shell-vs-TypeScript threshold applies).

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Trigger only on `pull_request_review` | Misses the initial state when a PR is opened or when new commits land before any reviews exist. The check would stay in "no status" / pending indefinitely for a brand-new PR, which some GitHub UIs render as a merge block without context. |
| Trigger on `pull_request_review_thread` | Thread resolution does not change the approval count. Not relevant. |
| Trigger on `schedule` as a safety net | Not needed. The state only changes on PR / review events; a cron rerun would recompute the same answer most of the time and add noise. |
| `pull_request_target` + checkout of base + Checks API | Needless: the activity does not read any workspace files; it only hits the GitHub API with the workflow token. Avoiding `pull_request_target` sidesteps the entire fork-PR trust-boundary cliff. |

### Decision 6 — Publish the check conclusion via the Checks API, with a stable context name

**Decision.** The activity publishes the check conclusion using the
Checks API (`POST /repos/{owner}/{repo}/check-runs`) with a stable `name`
of `require-two-developer-approvals / check`. The workflow job itself
also pass/fails for debuggability, but it is the Checks API conclusion
that the ruleset's `required_status_checks` block references.

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
- `pull_request_review` as a trigger — jobs triggered on
  `pull_request_review` cannot post status via the "run finished" check-run
  that GitHub automatically creates for pull_request events, because
  that run is scoped to the triggering event; a direct Checks API call
  is the straightforward way to publish a check against the PR's head
  SHA regardless of trigger.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Rely on the job's pass/fail outcome as the required check context | Context name becomes "require-two-developer-approvals / check" where the parts come from the workflow name and job id as GitHub assembles them. Renaming either side silently breaks the ruleset reference. The Checks API approach decouples the published name from the YAML surface. |
| Use the Commit Statuses API (`POST /statuses/{sha}`) | Deprecated in favour of the Checks API for new integrations. Checks API is better integrated with the ruleset UI (shows per-check conclusions, logs, re-run button). |
| Publish once per workflow run but let GitHub infer success-on-missing-failure | Rulesets block merge until the named check is present with `conclusion = success`. "Infer success" is not an option; the check has to be posted. |

### Decision 7 — Fail-loud when the opt-in is on but `DEVELOPER_BOT_LOGIN` is empty

**Decision.** If the workflow runs with
`REQUIRE_TWO_DEVELOPER_APPROVALS = true` but `DEVELOPER_BOT_LOGIN` is
empty, the activity emits `::error::DEVELOPER_BOT_LOGIN must be set when
REQUIRE_TWO_DEVELOPER_APPROVALS is true` and publishes a `failure`
check conclusion, so the misconfiguration surfaces loudly on every PR
rather than quietly letting agent PRs through on a single approval or
quietly blocking human PRs.

When the opt-in is OFF (the default), the workflow still publishes a
`success` conclusion on every PR immediately. This way the check context
exists in the PR UI (useful for Terraform plan previews that may
reference it) but has no gating effect because the ruleset doesn't list
it as required.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Skip the job when the opt-in is off | The check would never be published, leaving the PR UI with no visible signal. Also, if an operator flips the opt-in in Terraform but forgets to re-run the workflow on existing open PRs, those PRs would hit a "pending-forever" required check. Publishing `success` cheaply on every run keeps the operator path smooth. |
| Fail open (treat empty login as "no PRs match → always success") when the opt-in is on | Silently defeats the whole feature. Explicitly against the issue's intent. |
| Fail closed on every PR (block everyone) when the opt-in is on and the login is empty | Over-reach. The two-approvals rule is scoped to developer-agent PRs; blocking all PRs would punish unrelated authors. Fail-loud with `::error::` on both the author-matched and the author-unmatched paths is the correct middle ground: human PRs get a visible failure explaining why, and the operator fixes the config. |

### Decision 8 — Documentation surfaces

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
- `terraform/modules/branch-protection/README.md`: document the two new
  module variables and the dynamic `required_status_checks` block.
- `terraform/modules/agent-vars/README.md`: document the two new Actions
  variables and the usage example.
- `terraform/terraform.tfvars.example`: show commented-out example values
  for `developer_bot_login` and `require_two_developer_approvals`.
- `docs/adopting.md`: add a section for external adopters explaining the
  identity-configuration contract (set `developer_bot_login` to their own
  App's `<slug>[bot]`; verify the check context name matches their
  workflow name if they renamed the caller stub).

## Interactions with existing design decisions

- **`required_approving_review_count = 1` is unchanged.** The two-approvals
  check layers on top of it. See Decision 1 for the composed gate.
- **`dismiss_stale_reviews_on_push = true` is unchanged.** When a dev-agent
  PR is updated with a new commit after approvals land, GitHub dismisses
  the stale approvals and the workflow correctly recomputes `failure` on
  the resulting `synchronize` event.
- **Admins' `bypass_mode = "pull_request"` is unchanged.** Repository
  admins can still bypass the review requirement when merging a PR.
  Required status checks produced via a required check rule are **not**
  bypassed by `bypass_mode = "pull_request"` — only the `pull_request`
  rule itself is bypassed. This is a non-issue in practice (admins bypassing
  on an agent PR is exactly the "resolve impasse without removing
  protection" workflow called out in [`terraform/modules/branch-protection/README.md`](../../terraform/modules/branch-protection/README.md)),
  but worth stating so the design is auditable.
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
| [#661](https://github.com/mfrancza/agentic-development-workflow/issues/661) | Terraform: add `developer_bot_login` and `require_two_developer_approvals` top-level variables; wire through `terraform/main.tf` to the `agent-vars` module (which exposes them as `DEVELOPER_BOT_LOGIN` and `REQUIRE_TWO_DEVELOPER_APPROVALS` Actions variables) and to the `branch-protection` module. Extend `branch-protection` with the `require_two_developer_approvals` and `require_two_developer_approvals_check_context` inputs and the dynamic `required_status_checks` block in the ruleset. Update both module READMEs and `terraform.tfvars.example`. | — |
| [#662](https://github.com/mfrancza/agentic-development-workflow/issues/662) | TypeScript activity + composite action: implement `.github/scripts/src/check-two-developer-approvals.ts` and `.github/actions/check-two-developer-approvals/action.yml`. Activity reads inputs `developer-bot-login`, `require-two-developer-approvals`, `pr-number`, `pr-author`, `head-sha`, `repo`; fetches reviews via Octokit; groups latest-per-reviewer; counts qualifying approvals; publishes the check conclusion via the Checks API with context `require-two-developer-approvals / check` and a human-readable summary. Fails loudly per Decision 7. Unit tests cover: non-dev-author → success, dev-author with 0/1/2/3 non-self approvals, dev-author with self-approval ignored, `DISMISSED` latest-per-reviewer semantics, opt-in-off → success, opt-in-on-and-login-empty → failure with `::error::`. | — |
| [#663](https://github.com/mfrancza/agentic-development-workflow/issues/663) | Workflow + reusable: add `.github/workflows/require-two-developer-approvals.yml` (caller stub) and `.github/workflows/require-two-developer-approvals-reusable.yml` (reusable, with the four-step helper-checkout bootstrap). Triggers per Decision 5. Permissions `pull-requests: read`, `checks: write`. Caller stub reads `vars.DEVELOPER_BOT_LOGIN` and `vars.REQUIRE_TWO_DEVELOPER_APPROVALS` and passes them to the reusable, which invokes the composite action from Issue #662. | Issue #662 |
| [#664](https://github.com/mfrancza/agentic-development-workflow/issues/664) | Documentation: update `AGENTS.md` (new workflow in the Repository Layout note, new Actions variables in the doc-update checklist, branch-protection-immutability bullet) and `docs/adopting.md` (section for external adopters explaining how to set `developer_bot_login` to their own App). | Issue #661, Issue #663 |
| [#665](https://github.com/mfrancza/agentic-development-workflow/issues/665) | End-to-end validation: with `require_two_developer_approvals = true` and `developer_bot_login = "mfrancza-developer-agent[bot]"`, confirm that (a) a human-authored PR passes the check immediately with zero approvals, (b) a developer-agent PR fails the check with 0 approvals, (c) a developer-agent PR fails with only the developer-agent self-approval, (d) a developer-agent PR fails with 1 non-self approval, (e) a developer-agent PR passes with 2 non-self approvals, (f) a `DISMISSED` review correctly stops counting, and (g) flipping `require_two_developer_approvals` back to `false` restores the baseline (merge allowed on 1 human approval for an agent PR). Also confirm the misconfiguration path (opt-in on + empty login) surfaces `::error::` and `failure`. | Issues #661, #662, #663, #664 |

Issues #661 and #662 are independent and can proceed in parallel — the
contract (variable names `DEVELOPER_BOT_LOGIN` and `REQUIRE_TWO_DEVELOPER_APPROVALS`;
check-context name `require-two-developer-approvals / check`; activity
input names) is established by this document. Issue #663 depends on
Issue #662 because the reusable invokes the composite action from #662.
Issue #664 can be drafted in parallel but should land with #661 and #663
so docs and code ship together per AGENTS.md § "Keeping Documentation
Current". Issue #665 depends on everything.

Dependencies are recorded natively as GitHub blocked-by relationships on
the sub-issues.
