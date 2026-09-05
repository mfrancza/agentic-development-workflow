# agent-vars module

Manages the five GitHub Actions repository variables that configure agentic workflow behavior.

| Variable | Type | Purpose |
|----------|------|---------|
| `AGENT_ALLOWLIST` | JSON array | Usernames/bot identities permitted to trigger agent workflows. Workflow `if` conditions use `fromJSON(vars.AGENT_ALLOWLIST)`. |
| `DEFAULT_MODEL` | string | Repo-wide default model for all agent containers. Issue-driven workflows can override per-issue via `model:*` labels. |
| `ADMIN_ASSIGNEES` | JSON array | Usernames assigned to issues/PRs when the agent applies `human-required` and needs a human in the loop. |
| `CODE_REVIEWERS` | JSON array | Usernames requested as PR reviewers when the agent opens a PR and wants human sign-off. |
| `AUTO_TRIGGER_AGENTS` | JSON object | Per-stage gates (`groom`, `design`, `developer`, `review`) that auto-advance the SDLC pipeline without manual labeling. All default to `false` (opt-in). |

## Usage

### Local path (same repo)

```hcl
module "agent_vars" {
  source              = "./modules/agent-vars"
  repository          = github_repository.this.name
  agent_allowlist     = ["your-github-username", "<developer-agent-app-slug>[bot]"]
  default_model       = "sonnet"
  admin_assignees     = ["your-github-username"]
  code_reviewers      = ["your-github-username"]
  auto_trigger_agents = {
    groom     = false
    design    = false
    developer = false
    review    = false
  }
}
```

### Git source (external consumer)

```hcl
module "agent_vars" {
  source              = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/agent-vars?ref=<tag>"
  repository          = "<your-repo-name>"
  agent_allowlist     = ["your-github-username", "<developer-agent-app-slug>[bot]"]
  default_model       = "sonnet"
  admin_assignees     = ["your-github-username"]
  code_reviewers      = ["your-github-username"]
  auto_trigger_agents = {
    groom     = false
    design    = false
    developer = false
    review    = false
  }
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
| `agent_allowlist` | `list(string)` | yes | — | Usernames/bot identities permitted to trigger agent workflows. |
| `default_model` | `string` | no | `"sonnet"` | Repo-wide default model for agent containers. |
| `admin_assignees` | `list(string)` | no | `[]` | Usernames to assign to escalation issues/PRs. |
| `code_reviewers` | `list(string)` | no | `[]` | Usernames to request as PR reviewers. |
| `auto_trigger_agents` | `object({groom,design,developer,review: bool})` | no | all `false` | Per-stage auto-trigger gates. |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `agent_allowlist_variable_name` | `string` | Name of the `AGENT_ALLOWLIST` Actions variable (`"AGENT_ALLOWLIST"`). |
| `default_model_variable_name` | `string` | Name of the `DEFAULT_MODEL` Actions variable (`"DEFAULT_MODEL"`). |
| `admin_assignees_variable_name` | `string` | Name of the `ADMIN_ASSIGNEES` Actions variable (`"ADMIN_ASSIGNEES"`). |
| `code_reviewers_variable_name` | `string` | Name of the `CODE_REVIEWERS` Actions variable (`"CODE_REVIEWERS"`). |
| `auto_trigger_agents_variable_name` | `string` | Name of the `AUTO_TRIGGER_AGENTS` Actions variable (`"AUTO_TRIGGER_AGENTS"`). |

## Notes

- `AUTO_TRIGGER_AGENTS` must never be absent from the repository — the workflow guard `vars.AUTO_TRIGGER_AGENTS != ''` prevents `fromJSON('')` from throwing a runtime error. All gates default to `false` so behavior is unchanged unless you opt in.
- Include the developer-agent and reviewer-agent bot identities (e.g. `mfrancza-developer-agent[bot]`) in `agent_allowlist` so that agents can apply `agent:*` labels to route work to one another.
