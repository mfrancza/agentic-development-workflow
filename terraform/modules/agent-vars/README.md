# agent-vars module

Manages the GitHub Actions repository variables that configure agentic workflow behavior.

| Variable | Type | Purpose |
|----------|------|---------|
| `AGENT_ALLOWLIST` | JSON array | Individual GitHub logins (users or bots) and/or `org/team-slug` references permitted to trigger agent workflows. The in-reusable runtime gate reads this variable directly and resolves teams at trigger time; there is no cached companion variable. |
| `DEFAULT_MODEL` | string | Repo-wide default model for all agent containers. Issue-driven workflows can override per-issue via `model:*` labels. |
| `DESIGN_DEFAULT_MODEL` | string | Design-agent default model. When non-empty, `agent-design` workflows prefer this value over `DEFAULT_MODEL`. Empty string (the default) means "not configured — fall through to `DEFAULT_MODEL`"; the caller stub uses `vars.DESIGN_DEFAULT_MODEL \|\| vars.DEFAULT_MODEL` so the fallback is transparent. |
| `ADMIN_ASSIGNEES` | JSON array | Individual GitHub logins (users or bots) and/or `org/team-slug` references assigned to issues/PRs when the agent applies `human-required` and needs a human in the loop. |
| `CODE_REVIEWERS` | JSON array | Individual GitHub logins (users or bots) and/or `org/team-slug` references requested as PR reviewers when the agent opens a PR and wants human sign-off. |
| `PROTECTED_PR_AUTHOR_LOGINS` | JSON array | PR author logins subject to the protected approval threshold. Defaults to `["mfrancza-developer-agent[bot]"]`. |
| `REQUIRED_APPROVAL_COUNT` | string integer | Required non-self approvals for protected PRs. Defaults to `"2"`. |
| `ENABLE_PROTECTED_APPROVAL_GATE` | string (`"true"` / `"false"`) | Enables the opt-in protected-approval gate. Defaults to `"false"`. |
| `ENABLE_PROTECTED_APPROVAL_GATE_CHECK_GENERATION` | string integer | Generation suffix for the required check context. Defaults to `"1"`. |
| `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` | string integer | Minimum interval for reconciliation sweeps. Defaults to `"10"`. |
| `AUTO_TRIGGER_AGENTS` | JSON object | Per-stage gates (`groom`, `design`, `developer`, `review`) that auto-advance the SDLC pipeline without manual labeling. All default to `false` (opt-in). |
| `REVIEWER_MODELS` | JSON array | Ordered list of model identifiers for the multi-reviewer feature. Empty array (`[]`) disables multi-reviewer. Workflow guards use `vars.REVIEWER_MODELS != ''` before `fromJSON`. |
| `REVIEW_MODEL_PAIRING` | JSON object | Reviewer model-pair preferences. When `enabled` is `true`, the agent-review workflow uses the configured `policy`, `preferred_vendors`, `explicit_map`, and `fallback_chain` to pick a reviewer model based on the authoring model recorded in the PR body. Explicit `model:review:*` / `model:*` labels on the PR take precedence. Defaults to `enabled = false` (fail-safe opt-in). Workflow guards use `vars.REVIEW_MODEL_PAIRING != ''` before `fromJSON`. See `docs/design/configurable-model-pair-preferences.md` for resolver semantics. |

## Usage

### Local path (same repo)

```hcl
module "agent_vars" {
  source              = "./modules/agent-vars"
  repository          = github_repository.this.name
  agent_allowlist     = ["your-github-username", "<developer-agent-app-slug>[bot]", "Brale-xyz/dev"]
  default_model       = "sonnet"
  # design_default_model = "opus"  # omit or leave "" to fall back to default_model
  admin_assignees     = ["your-github-username", "Brale-xyz/dev"]
  code_reviewers      = ["your-github-username", "Brale-xyz/dev"]
  # protected_pr_author_logins                       = ["<developer-agent-app-slug>[bot]"]
  # required_approval_count                          = 2
  # enable_protected_approval_gate                   = true
  # enable_protected_approval_gate_check_generation  = 1
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
}
```

### Git source (external consumer)

```hcl
module "agent_vars" {
  source              = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/agent-vars?ref=<tag>"
  repository          = "<your-repo-name>"
  agent_allowlist     = ["your-github-username", "<developer-agent-app-slug>[bot]", "Brale-xyz/dev"]
  default_model       = "sonnet"
  # design_default_model = "opus"  # omit or leave "" to fall back to default_model
  admin_assignees     = ["your-github-username", "Brale-xyz/dev"]
  code_reviewers      = ["your-github-username", "Brale-xyz/dev"]
  # protected_pr_author_logins                       = ["<developer-agent-app-slug>[bot]"]
  # required_approval_count                          = 2
  # enable_protected_approval_gate                   = true
  # enable_protected_approval_gate_check_generation  = 1
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
| `agent_allowlist` | `list(string)` | yes | — | Individual GitHub logins (users or bots) and/or `org/team-slug` references permitted to trigger agent workflows. The in-reusable runtime gate reads `AGENT_ALLOWLIST` directly and resolves teams at trigger time; no cached companion variable exists. |
| `default_model` | `string` | no | `"sonnet"` | Repo-wide default model for agent containers. |
| `design_default_model` | `string` | no | `""` | Design-agent default model. When non-empty, `agent-design` uses this instead of `default_model`. Empty (the default) falls through to `default_model`. |
| `admin_assignees` | `list(string)` | no | `[]` | Individual GitHub logins (users or bots) and/or `org/team-slug` references to assign to escalation issues/PRs. |
| `code_reviewers` | `list(string)` | no | `[]` | Individual GitHub logins (users or bots) and/or `org/team-slug` references to request as PR reviewers. |
| `protected_pr_author_logins` | `list(string)` | no | developer-agent bot | Protected PR-author logins, encoded as JSON. |
| `required_approval_count` | `number` | no | `2` | Non-self approvals required for a protected PR. |
| `enable_protected_approval_gate` | `bool` | no | `false` | Enables the protected-approval gate. |
| `enable_protected_approval_gate_check_generation` | `number` | no | `1` | Required-check context generation. |
| `enable_protected_approval_gate_reconcile_minutes` | `number` | no | `10` | Reconciliation-sweep interval in minutes. |
| `auto_trigger_agents` | `object({groom,design,developer,review: bool})` | no | all `false` | Per-stage auto-trigger gates. |
| `reviewer_models` | `list(string)` | no | `[]` | Ordered list of model identifiers for the multi-reviewer feature. Empty disables multi-reviewer. |
| `review_model_pairing` | `object({enabled,policy,preferred_vendors,explicit_map,fallback_chain})` | no | `enabled=false` | Reviewer model-pair preferences. See `docs/design/configurable-model-pair-preferences.md`. |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `agent_allowlist_variable_name` | `string` | Name of the `AGENT_ALLOWLIST` Actions variable (`"AGENT_ALLOWLIST"`). |
| `default_model_variable_name` | `string` | Name of the `DEFAULT_MODEL` Actions variable (`"DEFAULT_MODEL"`). |
| `design_default_model_variable_name` | `string` | Name of the `DESIGN_DEFAULT_MODEL` Actions variable (`"DESIGN_DEFAULT_MODEL"`). |
| `admin_assignees_variable_name` | `string` | Name of the `ADMIN_ASSIGNEES` Actions variable (`"ADMIN_ASSIGNEES"`). |
| `code_reviewers_variable_name` | `string` | Name of the `CODE_REVIEWERS` Actions variable (`"CODE_REVIEWERS"`). |
| `protected_pr_author_logins_variable_name` | `string` | Name of `PROTECTED_PR_AUTHOR_LOGINS`. |
| `required_approval_count_variable_name` | `string` | Name of `REQUIRED_APPROVAL_COUNT`. |
| `enable_protected_approval_gate_variable_name` | `string` | Name of `ENABLE_PROTECTED_APPROVAL_GATE`. |
| `enable_protected_approval_gate_check_generation_variable_name` | `string` | Name of `ENABLE_PROTECTED_APPROVAL_GATE_CHECK_GENERATION`. |
| `enable_protected_approval_gate_reconcile_minutes_variable_name` | `string` | Name of `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`. |
| `auto_trigger_agents_variable_name` | `string` | Name of the `AUTO_TRIGGER_AGENTS` Actions variable (`"AUTO_TRIGGER_AGENTS"`). |
| `reviewer_models_variable_name` | `string` | Name of the `REVIEWER_MODELS` Actions variable (`"REVIEWER_MODELS"`). |
| `review_model_pairing_variable_name` | `string` | Name of the `REVIEW_MODEL_PAIRING` Actions variable (`"REVIEW_MODEL_PAIRING"`). |

## Notes

- `DESIGN_DEFAULT_MODEL` defaults to `""` (empty string). The caller stub expresses the fallback as `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL` — when empty, GitHub Actions evaluates the empty string as falsy and falls through to `DEFAULT_MODEL`, preserving existing behavior for repos that have not set this variable. Set it to any model identifier accepted by the agent `--model` flag to give the design stage its own model tier.
- `AUTO_TRIGGER_AGENTS` must never be absent from the repository — the workflow guard `vars.AUTO_TRIGGER_AGENTS != ''` prevents `fromJSON('')` from throwing a runtime error. All gates default to `false` so behavior is unchanged unless you opt in.
- `REVIEWER_MODELS` defaults to `[]` (JSON-encoded empty array). Workflows guard with `vars.REVIEWER_MODELS != ''` before calling `fromJSON` — an absent variable evaluates to `''` and `fromJSON('')` would throw a runtime error; the guard fails closed (multi-reviewer disabled) instead. An empty list (`[]`) is the canonical signal that multi-reviewer is disabled.
- `agent_allowlist`, `admin_assignees`, and `code_reviewers` accept mixed lists of individual GitHub logins (users or bots) and `org/team-slug` references. Entries must be non-empty and contain at most one `/`.
- `AGENT_ALLOWLIST` is read directly by the in-reusable runtime gate, which resolves team references at trigger time. There is no `AGENT_ALLOWLIST_RESOLVED` companion variable, scheduled resolver, or Terraform team-members data source.
- Include the developer-agent and reviewer-agent bot identities (e.g. `mfrancza-developer-agent[bot]`) as explicit `agent_allowlist` entries so that agents can apply `agent:*` labels to route work to one another.
- The protected-approval variables preserve existing behavior because `ENABLE_PROTECTED_APPROVAL_GATE` defaults to `"false"`. `PROTECTED_PR_AUTHOR_LOGINS` must be non-empty with unique, non-empty logins; both the approval count and reconciliation interval must be positive integers.
- `REVIEW_MODEL_PAIRING` defaults to `{"enabled":false,...}`. The `enabled = false` default is a fail-safe: a fresh repo behaves exactly as it did before the variable existed (pairing tier is dormant). Set `enabled = true` and choose a `policy` to opt in. Workflows must guard with `vars.REVIEW_MODEL_PAIRING != ''` before calling `fromJSON` — an absent variable evaluates to `''` and `fromJSON('')` would throw a runtime error. `fromJSON(vars.REVIEW_MODEL_PAIRING).enabled` is the primary gate that the agent-review workflow checks before entering the pairing tier.
