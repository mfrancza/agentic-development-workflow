# agent-vars module

Manages the GitHub Actions repository variables that configure agentic workflow behavior.

`agent_allowlist`, `admin_assignees`, and `code_reviewers` accept mixed lists:
each entry is either an individual GitHub login (including a bot such as
`mfrancza-developer-agent[bot]`) or an `<org>/<team-slug>` reference (for
example, `<your-github-org>/developers`). Team references must belong to the repository
owner's organization.

| Variable | Type | Purpose |
|----------|------|---------|
| `AGENT_ALLOWLIST` | JSON array | GitHub logins or `<org>/<team-slug>` references permitted to trigger agent workflows. The runtime gate reads this variable directly and resolves teams at trigger time; there is no cached `AGENT_ALLOWLIST_RESOLVED` companion variable. |
| `DEFAULT_MODEL` | string | Repo-wide default model for all agent containers. Issue-driven workflows can override per-issue via `model:*` labels. |
| `DESIGN_DEFAULT_MODEL` | string | Design-agent default model. When non-empty, `agent-design` workflows prefer this value over `DEFAULT_MODEL`. Empty string (the default) means "not configured — fall through to `DEFAULT_MODEL`"; the caller stub uses `vars.DESIGN_DEFAULT_MODEL \|\| vars.DEFAULT_MODEL` so the fallback is transparent. |
| `GROOM_DEFAULT_MODEL` | string | Grooming-agent default model. When non-empty, `agent-groom` workflows prefer this value over `DEFAULT_MODEL`. Empty string (the default) means "not configured — fall through to `DEFAULT_MODEL`"; the caller stub uses `vars.GROOM_DEFAULT_MODEL \|\| vars.DEFAULT_MODEL` so the fallback is transparent. It selects only the model the groomer runs on; the groomer's vendor anchors stay on `DEFAULT_MODEL` / `DESIGN_DEFAULT_MODEL`. |
| `MAX_REVIEW_ROUNDS` | string integer | Review-response reviewed-commit limit; defaults to `"8"`, with `"0"` disabling the numerical cap. |
| `ADMIN_ASSIGNEES` | JSON array | GitHub logins or `<org>/<team-slug>` references assigned to issues/PRs when the agent applies `human-required` and needs a human in the loop. |
| `CODE_REVIEWERS` | JSON array | GitHub logins or `<org>/<team-slug>` references requested as PR reviewers when the agent opens a PR and wants human sign-off. |
| `FIX_CHECKS_ALLOW` | JSON array | Raw Checks API `check_runs[].name` values allowed to trigger the fix-checks agent. Empty (`[]`) disables all fix-checks delivery. |
| `ENABLE_DEPENDABOT_ALERT_ISSUES` | string (`"true"` / `"false"`) | Opt-in for Dependabot alert issue scheduling; defaults to `"false"`. |
| `DEPENDABOT_ALERT_ISSUES_MAX_OPEN_PRS` | string integer | Scheduler admission capacity; defaults to `"3"`, and `"0"` pauses new admissions. |
| `PROTECTED_PR_AUTHOR_LOGINS` | JSON array | PR author logins subject to the protected approval threshold. Defaults to `["mfrancza-developer-agent[bot]"]`. |
| `PROTECTED_APPROVAL_REVIEWERS` | JSON array | Logins and `<org>/<team-slug>` references whose approvals count toward `REQUIRED_APPROVAL_COUNT`. Defaults to `[]`, meaning any reviewer other than the PR author counts. Team references need the allowlist-resolver App secrets. |
| `REQUIRED_APPROVAL_COUNT` | string integer | Required non-self approvals for protected PRs. Defaults to `"2"`. |
| `ENABLE_PROTECTED_APPROVAL_GATE` | string (`"true"` / `"false"`) | Enables the opt-in protected-approval gate. Defaults to `"false"`. |
| `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` | string integer | Selects a UTC scheduled reconciliation cadence of `"5"`, `"10"`, `"15"`, `"20"`, `"30"`, or `"60"`; defaults to `"10"`. See reconciliation migration below. |
| `AUTO_TRIGGER_AGENTS` | JSON object | Per-stage gates (`groom`, `design`, `developer`, `review`) that auto-advance the SDLC pipeline without manual labeling. All default to `false` (opt-in). |
| `REVIEWER_MODELS` | JSON array | Ordered list of model identifiers for the multi-reviewer feature. Empty array (`[]`) disables multi-reviewer. Workflow guards use `vars.REVIEWER_MODELS != ''` before `fromJSON`. |
| `REVIEW_MODEL_PAIRING` | JSON object | Reviewer model-pair preferences. When `enabled` is `true`, the agent-review workflow uses the configured `policy`, `preferred_vendors`, `explicit_map`, and `fallback_chain` to pick a reviewer model based on the authoring model recorded in the PR body. Explicit `model:review:*` / `model:*` labels on the PR take precedence. Defaults to `enabled = false` (fail-safe opt-in). Workflow guards use `vars.REVIEW_MODEL_PAIRING != ''` before `fromJSON`. See `docs/design/configurable-model-pair-preferences.md` for resolver semantics. |
| `PRE_COMMIT_CHECK_CMD` | string | Shell command run by the pre-commit checks backstop inside `PRE_COMMIT_SCRIPTS_DIR` (default `.github/scripts`) after a `.github/` change. The command is fully responsible for both setup (e.g. dependency installation) and the actual checks. Absent (the default, `count = 0`) disables the backstop — configure per-deployment to avoid baking repo-specific commands into the Docker image. Applies to `implement`, `fix-checks`, `respond-review`, and `fix-deployment`. |
| `PRE_COMMIT_SCRIPTS_DIR` | string | Directory path (relative to `WORK_DIR`) where the pre-commit check command runs. Absent (the default, `count = 0`) means the helper uses its built-in default of `.github/scripts`. Set to a non-empty path to override the default for repos whose scripts live elsewhere. Applies to the same four actions as `PRE_COMMIT_CHECK_CMD`. |
| `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST` | JSON array | GitHub logins whose open PRs are swept for merge conflicts in addition to the developer-agent's; the default `[]` preserves agent-only behavior, `["*"]` sweeps every author, and the expanded sweep excludes fork-headed PRs. |

## Usage

### Local path (same repo)

```hcl
module "agent_vars" {
  source              = "./modules/agent-vars"
  repository          = github_repository.this.name
  agent_allowlist     = ["your-github-username", "<developer-agent-app-slug>[bot]", "<your-github-org>/developers"]
  default_model       = "sonnet"
  # design_default_model = "opus"  # omit or leave "" to fall back to default_model
  # groom_default_model  = "haiku" # omit or leave "" to fall back to default_model
  # max_review_rounds    = 8       # default; use 0 for no numerical cap
  admin_assignees     = ["your-github-username", "<your-github-org>/maintainers"]
  code_reviewers      = ["your-github-username", "<your-github-org>/maintainers"]
  # enable_dependabot_alert_issues       = false
  # dependabot_alert_issues_max_open_prs = 3 # 0 pauses new admissions
  # fix_checks_allow = ["ci / Typecheck and test"] # raw Checks API check_runs[].name values; [] disables fix-checks
  # protected_pr_author_logins                       = ["<developer-agent-app-slug>[bot]"]
  # protected_approval_reviewers                     = ["<maintainer-login>", "<org>/<team-slug>"]
  # required_approval_count                          = 2
  # enable_protected_approval_gate                   = true
  # enable_protected_approval_gate_reconcile_minutes = 10
  auto_trigger_agents = {
    groom     = false
    design    = false
    developer = false
    review    = false
  }
  # reviewer_models = ["claude-sonnet-4-5", "gpt-6-astra"]  # omit or leave [] to disable multi-reviewer; use models from different providers for diversity
  # review_model_pairing = {
  #   enabled           = true
  #   policy            = "different-vendor-same-class"
  #   preferred_vendors = ["openai", "xai", "anthropic"]
  #   explicit_map      = {}
  #   fallback_chain    = ["default-model"]
  # }
  # pre_commit_check_cmd = "npm ci && npm run typecheck && npm test"  # omit or leave "" to disable the pre-commit checks backstop; command is fully responsible for setup + checks
  # pre_commit_scripts_dir = "tools/scripts"  # omit or leave "" to use the built-in default of .github/scripts
}
```

### Git source (external consumer)

```hcl
module "agent_vars" {
  source              = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/agent-vars?ref=<tag>"
  repository          = "<your-repo-name>"
  agent_allowlist     = ["your-github-username", "<developer-agent-app-slug>[bot]", "<your-github-org>/developers"]
  default_model       = "sonnet"
  # design_default_model = "opus"  # omit or leave "" to fall back to default_model
  # groom_default_model  = "haiku" # omit or leave "" to fall back to default_model
  # max_review_rounds    = 0       # no numerical cap; omit for the default 8
  admin_assignees     = ["your-github-username", "<your-github-org>/maintainers"]
  code_reviewers      = ["your-github-username", "<your-github-org>/maintainers"]
  # enable_dependabot_alert_issues       = false
  # dependabot_alert_issues_max_open_prs = 3 # 0 pauses new admissions
  # fix_checks_allow = ["ci / Typecheck and test"] # raw Checks API check_runs[].name values; [] disables fix-checks
  # protected_pr_author_logins                       = ["<developer-agent-app-slug>[bot]"]
  # protected_approval_reviewers                     = ["<maintainer-login>", "<org>/<team-slug>"]
  # required_approval_count                          = 2
  # enable_protected_approval_gate                   = true
  # enable_protected_approval_gate_reconcile_minutes = 10
  auto_trigger_agents = {
    groom     = false
    design    = false
    developer = false
    review    = false
  }
  # reviewer_models = ["claude-sonnet-4-5", "gpt-6-astra"]  # omit or leave [] to disable multi-reviewer; use models from different providers for diversity
  # review_model_pairing = {
  #   enabled           = true
  #   policy            = "different-vendor-same-class"
  #   preferred_vendors = ["openai", "xai", "anthropic"]
  #   explicit_map      = {}
  #   fallback_chain    = ["default-model"]
  # }
  # pre_commit_check_cmd = "npm ci && npm run typecheck && npm test"  # omit or leave "" to disable the pre-commit checks backstop; command is fully responsible for setup + checks
  # pre_commit_scripts_dir = "tools/scripts"  # omit or leave "" to use the built-in default of .github/scripts
}
```

## Required provider configuration

```hcl
terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

provider "github" {
  owner = "<your-github-org-or-user>"
  # token = var.github_token  # or set GITHUB_TOKEN env var
}
```

## Variables

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `repository` | `string` | yes | — | Name of the GitHub repository to manage Actions variables for. |
| `agent_allowlist` | `list(string)` | yes | — | GitHub logins (users or bots) or `<org>/<team-slug>` references permitted to trigger agent workflows. Runtime reads `AGENT_ALLOWLIST` directly; no cached companion variable exists. |
| `default_model` | `string` | no | `"sonnet"` | Repo-wide default model for agent containers. |
| `design_default_model` | `string` | no | `""` | Design-agent default model. When non-empty, `agent-design` uses this instead of `default_model`. Empty (the default) falls through to `default_model`. |
| `groom_default_model` | `string` | no | `""` | Grooming-agent default model. When non-empty, `agent-groom` uses this instead of `default_model`. Empty (the default) falls through to `default_model`. Does not change the groomer's vendor anchors. |
| `max_review_rounds` | `number` | no | `8` | Non-negative safe integer through `9007199254740991`; `0` disables the numerical cap. |
| `admin_assignees` | `list(string)` | no | `[]` | GitHub logins or `<org>/<team-slug>` references to assign to escalation issues/PRs. |
| `code_reviewers` | `list(string)` | no | `[]` | GitHub logins or `<org>/<team-slug>` references to request as PR reviewers. |
| `fix_checks_allow` | `list(string)` | no | `[]` | Raw Checks API `check_runs[].name` values allowed to trigger fix-checks. Empty disables all fix-checks delivery. |
| `enable_dependabot_alert_issues` | `bool` | no | `false` | Opt in to Dependabot alert issue scheduling after human approval. |
| `dependabot_alert_issues_max_open_prs` | `number` | no | `3` | Non-negative integer admission capacity; zero pauses new admissions. |
| `protected_pr_author_logins` | `list(string)` | no | developer-agent bot | Protected PR-author logins, encoded as JSON. |
| `protected_approval_reviewers` | `list(string)` | no | `[]` | Logins and `<org>/<team-slug>` references whose approvals count; empty counts any non-author reviewer. |
| `required_approval_count` | `number` | no | `2` | Non-self approvals required for a protected PR. |
| `enable_protected_approval_gate` | `bool` | no | `false` | Enables the protected-approval gate. |
| `enable_protected_approval_gate_reconcile_minutes` | `number` | no | `10` | UTC scheduled reconciliation cadence: 5, 10, 15, 20, 30, or 60 minutes. Manual dispatch bypasses the schedule selection. |
| `auto_trigger_agents` | `object({groom,design,developer,review: bool})` | no | all `false` | Per-stage auto-trigger gates. |
| `reviewer_models` | `list(string)` | no | `[]` | Ordered list of model identifiers for the multi-reviewer feature. Empty disables multi-reviewer. |
| `review_model_pairing` | `object({enabled,policy,preferred_vendors,explicit_map,fallback_chain})` | no | `enabled=false` | Reviewer model-pair preferences. See `docs/design/configurable-model-pair-preferences.md`. |
| `pre_commit_check_cmd` | `string` | no | `""` | Shell command for the pre-commit checks backstop. When non-empty, creates the `PRE_COMMIT_CHECK_CMD` Actions variable; empty (the default, `count = 0`) does not create the variable and the backstop skips checks for that deployment. |
| `pre_commit_scripts_dir` | `string` | no | `""` | Custom scripts directory for the pre-commit backstop. When non-empty, creates the `PRE_COMMIT_SCRIPTS_DIR` Actions variable overriding the helper's built-in default of `.github/scripts`; empty (the default, `count = 0`) does not create the variable and the helper uses its built-in default. |
| `resolve_conflicts_author_allowlist` | `list(string)` | no | `[]` | GitHub logins whose open PRs are swept for merge conflicts in addition to the developer-agent's; `["*"]` sweeps every author, and the expanded sweep excludes fork-headed PRs. Stored as the JSON-encoded `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST` Actions variable. |

## Reconciliation cadence and migration

The reconcile caller must forward `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` to the reusable sweep's `interval-minutes` input. An empty reusable input selects the default of `10`; unsupported non-empty strings are not rounded or defaulted. When the gate is enabled, only the scheduled event whose exact UTC cron string matches the selected cadence runs the sweep:

| Minutes | UTC cron string |
|---------|-----------------|
| 5 | `*/5 * * * *` |
| 10 (or empty input) | `*/10 * * * *` |
| 15 | `*/15 * * * *` |
| 20 | `*/20 * * * *` |
| 30 | `*/30 * * * *` |
| 60 | `0 * * * *` |

Scheduled events skip without allocating a runner when the gate is disabled or unset, or when their cron does not match. Manual reconcile dispatch and backfill bypass the gate and cadence checks, even for an unsupported interval. For manual-only operation, omit `schedule` from the caller and retain `workflow_dispatch`.

This is a breaking restriction: previously accepted integers such as `7` are no longer valid Terraform inputs. Change any unsupported value to a supported cadence before upgrading. Direct edits to the Actions variable bypass Terraform validation; unsupported or noncanonical strings cause scheduled events to skip without a diagnostic runner. If sweeps do not run, inspect the Actions variable and caller schedule.

Adopters must update the pinned reusable workflow and replace the caller's schedule block with all six exact entries above, together with the updated caller concurrency block partitioned by `github.event.schedule` (using a separate manual group and `cancel-in-progress: false`). Updating only the reusable is insufficient: an old caller with only the five-minute cron will not run the default ten-minute cadence. See `docs/design/gate-reconcile-runner-free-intervals.md` for the caller contract.

The cadence follows the UTC wall clock, replacing elapsed-time spacing between sweeps; it does not guarantee a minimum time between executions. GitHub may delay or drop scheduled events, and manual or overlapping sweeps can run close together.

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `agent_allowlist_variable_name` | `string` | Name of the `AGENT_ALLOWLIST` Actions variable (`"AGENT_ALLOWLIST"`). |
| `default_model_variable_name` | `string` | Name of the `DEFAULT_MODEL` Actions variable (`"DEFAULT_MODEL"`). |
| `design_default_model_variable_name` | `string \| null` | Name of the `DESIGN_DEFAULT_MODEL` Actions variable (`"DESIGN_DEFAULT_MODEL"`), or `null` when `design_default_model` is empty and the variable is not created. |
| `groom_default_model_variable_name` | `string \| null` | Name of the `GROOM_DEFAULT_MODEL` Actions variable (`"GROOM_DEFAULT_MODEL"`), or `null` when `groom_default_model` is empty and the variable is not created. |
| `admin_assignees_variable_name` | `string` | Name of the `ADMIN_ASSIGNEES` Actions variable (`"ADMIN_ASSIGNEES"`). |
| `code_reviewers_variable_name` | `string` | Name of the `CODE_REVIEWERS` Actions variable (`"CODE_REVIEWERS"`). |
| `fix_checks_allow_variable_name` | `string` | Name of the `FIX_CHECKS_ALLOW` Actions variable (`"FIX_CHECKS_ALLOW"`). |
| `enable_dependabot_alert_issues_variable_name` | `string` | Name of `ENABLE_DEPENDABOT_ALERT_ISSUES`. |
| `dependabot_alert_issues_max_open_prs_variable_name` | `string` | Name of `DEPENDABOT_ALERT_ISSUES_MAX_OPEN_PRS`. |
| `protected_pr_author_logins_variable_name` | `string` | Name of `PROTECTED_PR_AUTHOR_LOGINS`. |
| `protected_approval_reviewers_variable_name` | `string` | Name of `PROTECTED_APPROVAL_REVIEWERS`. |
| `required_approval_count_variable_name` | `string` | Name of `REQUIRED_APPROVAL_COUNT`. |
| `enable_protected_approval_gate_variable_name` | `string` | Name of `ENABLE_PROTECTED_APPROVAL_GATE`. |
| `enable_protected_approval_gate_reconcile_minutes_variable_name` | `string` | Name of `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`. |
| `auto_trigger_agents_variable_name` | `string` | Name of the `AUTO_TRIGGER_AGENTS` Actions variable (`"AUTO_TRIGGER_AGENTS"`). |
| `reviewer_models_variable_name` | `string` | Name of the `REVIEWER_MODELS` Actions variable (`"REVIEWER_MODELS"`). |
| `review_model_pairing_variable_name` | `string` | Name of the `REVIEW_MODEL_PAIRING` Actions variable (`"REVIEW_MODEL_PAIRING"`). |
| `pre_commit_check_cmd_variable_name` | `string \| null` | Name of the `PRE_COMMIT_CHECK_CMD` Actions variable (`"PRE_COMMIT_CHECK_CMD"`), or `null` when `pre_commit_check_cmd` is empty and the variable is not created. |
| `pre_commit_scripts_dir_variable_name` | `string \| null` | Name of the `PRE_COMMIT_SCRIPTS_DIR` Actions variable (`"PRE_COMMIT_SCRIPTS_DIR"`), or `null` when `pre_commit_scripts_dir` is empty and the variable is not created (the helper's built-in default of `.github/scripts` applies). |
| `resolve_conflicts_author_allowlist_variable_name` | `string` | Name of the `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST` Actions variable (`"RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST"`). |

## Notes

- Dependabot capacity reserves slots for admitted issues without a counted open PR; it is not a strict global PR cap. See the [operator contract](../../../README.md#dependabot-alert-issue-scheduling) for approvals, credentials, and rollback.

- `DESIGN_DEFAULT_MODEL` defaults to `""` (empty string). The caller stub expresses the fallback as `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL` — when empty, GitHub Actions evaluates the empty string as falsy and falls through to `DEFAULT_MODEL`, preserving existing behavior for repos that have not set this variable. Set it to any model identifier accepted by the agent `--model` flag to give the design stage its own model tier.
- `GROOM_DEFAULT_MODEL` defaults to `""` (empty string). The caller stub expresses the fallback as `vars.GROOM_DEFAULT_MODEL || vars.DEFAULT_MODEL` — when empty, GitHub Actions evaluates the empty string as falsy and falls through to `DEFAULT_MODEL`, preserving existing behavior for repos that have not set this variable. Set it to any model identifier accepted by the agent `--model` flag to give the grooming stage its own model tier. It does not affect label selection: the grooming workflow passes the downstream defaults into the container as the vendor anchors (`GROOM_IMPL_ANCHOR_MODEL` = `DEFAULT_MODEL`, `GROOM_DESIGN_ANCHOR_MODEL` = `DESIGN_DEFAULT_MODEL || DEFAULT_MODEL`).
- `AUTO_TRIGGER_AGENTS` must never be absent from the repository — the workflow guard `vars.AUTO_TRIGGER_AGENTS != ''` prevents `fromJSON('')` from throwing a runtime error. All gates default to `false` so behavior is unchanged unless you opt in.
- `REVIEWER_MODELS` defaults to `[]` (JSON-encoded empty array). Workflows guard with `vars.REVIEWER_MODELS != ''` before calling `fromJSON` — an absent variable evaluates to `''` and `fromJSON('')` would throw a runtime error; the guard fails closed (multi-reviewer disabled) instead. An empty list (`[]`) is the canonical signal that multi-reviewer is disabled.
- `FIX_CHECKS_ALLOW` defaults to `[]` (JSON-encoded empty array), which disables all fix-checks delivery. Its entries are raw Checks API `check_runs[].name` values — not workflow names or potentially decorated labels in the Checks tab. Discover names with `gh api repos/$OWNER/$REPO/commits/$SHA/check-runs --jq '.check_runs[].name'`.
- `MAX_REVIEW_ROUNDS` is stored as a decimal string. The planned response gate defaults a missing or whitespace-only variable to 8 and counts distinct commits reviewed by configured automated reviewers in the current epoch, not review submissions or response runs. Actionable feedback on the Nth reviewed commit pauses before another response; clean feedback does not escalate. See `docs/design/cap-review-response-rounds.md` for the integration contract.
- `agent_allowlist`, `admin_assignees`, and `code_reviewers` accept case-insensitively unique, non-empty GitHub logins and `<org>/<team-slug>` references. References must use the repository owner's organization; malformed values such as `a/b/c` are rejected.
- `AGENT_ALLOWLIST` is read directly by the in-reusable runtime gate, which resolves team references at trigger time. There is no `AGENT_ALLOWLIST_RESOLVED` Actions variable and no scheduled resolver, so team-membership changes apply to the next triggering event.
- Team references in `agent_allowlist` and `admin_assignees` require an allowlist-resolver GitHub App installed on the repository owner's organization with Members: read. Configure its `ALLOWLIST_RESOLVER_APP_ID` and `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` repository secrets. `code_reviewers` team references pass directly to GitHub's reviewer-request API and do not require those secrets.
- Include the developer-agent and reviewer-agent bot identities (e.g. `mfrancza-developer-agent[bot]`) as explicit `agent_allowlist` entries so that agents can apply `agent:*` labels to route work to one another.
- The protected-approval variables preserve existing behavior because `ENABLE_PROTECTED_APPROVAL_GATE` defaults to `"false"`. `PROTECTED_PR_AUTHOR_LOGINS` must be non-empty with unique, non-empty logins; both the approval count and reconciliation interval must be positive integers.
- `REVIEW_MODEL_PAIRING` defaults to `{"enabled":false,...}`. The `enabled = false` default is a fail-safe: a fresh repo behaves exactly as it did before the variable existed (pairing tier is dormant). Set `enabled = true` and choose a `policy` to opt in. Workflows must guard with `vars.REVIEW_MODEL_PAIRING != ''` before calling `fromJSON` — an absent variable evaluates to `''` and `fromJSON('')` would throw a runtime error. `fromJSON(vars.REVIEW_MODEL_PAIRING).enabled` is the primary gate that the agent-review workflow checks before entering the pairing tier.
- `PRE_COMMIT_CHECK_CMD` defaults to `""` (empty string), which means `count = 0` — the Actions variable is not created and the backstop is disabled for that deployment. When non-empty, the pre-commit checks helper runs the specified command inside `PRE_COMMIT_SCRIPTS_DIR` (default `.github/scripts`) whenever a `.github/` path is touched by one of the four branch-writing actions (`implement`, `fix-checks`, `respond-review`, `fix-deployment`). The command is fully responsible for all setup (e.g. dependency installation) and the actual checks. The push always proceeds regardless of the outcome (fail-open). Set this to the repo-specific command (e.g. `"npm ci && npm run typecheck && npm test"`) in `terraform.tfvars`; leave unset for repos that use a different or no check mechanism.
- `PRE_COMMIT_SCRIPTS_DIR` defaults to `""` (empty string), which means `count = 0` — the Actions variable is not created and the helper uses its built-in default of `.github/scripts`. Set this only when your scripts live in a different directory (e.g. `"tools/scripts"`). An absent `PRE_COMMIT_SCRIPTS_DIR` Actions variable is equivalent to `.github/scripts`; to disable checks entirely, leave `PRE_COMMIT_CHECK_CMD` unset instead.
