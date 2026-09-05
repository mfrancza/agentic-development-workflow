# labels module

Manages all GitHub issue labels consumed by the agentic development workflow.

Pre-provisions six groups of labels in the target repository:

- **`agent:*` trigger labels** — routing labels that cause workflow dispatch (`agent:developer`, `agent:groom`, `agent:design`, `agent:review`).
- **`model:<name>` overrides** — issue-level model selection, covering Anthropic (Claude), OpenAI, and xAI (Grok) models in three tiers: tier aliases (`sonnet`/`opus`/`haiku`), generic series tags, and pinned snapshot IDs.
- **`model:<agent-type>:<name>` per-agent overrides** — take precedence over generic `model:*` labels for a specific agent type.
- **Grooming labels** — applied by the grooming agent based on issue complexity (`question`, `bug`, `enhancement`, `dependency upgrade`, `do`, `plan`).
- **Workflow labels** — `human-required` signals escalation to a human actor.
- **Lifecycle labels** — `draft` (scoped by an unmerged design) and `blocked` (deferred pending blocker closure).

## Usage

### Local path (same repo)

```hcl
module "labels" {
  source     = "./modules/labels"
  repository = github_repository.this.name
}
```

### Git source (external consumer)

```hcl
module "labels" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/labels?ref=<tag>"
  repository = "<your-repo-name>"
}
```

## Required provider configuration

The caller must configure the `integrations/github` provider. The module inherits it automatically when used as a child module.

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
| `repository` | `string` | yes | — | Name of the GitHub repository to manage labels for. |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `label_names` | `set(string)` | Set of all managed label names. |

## Importing pre-existing labels

GitHub creates `bug`, `enhancement`, and `question` labels by default on new repos. If `terraform apply` fails with a 422 "already_exists" error for any of those, import them first:

```bash
terraform import 'module.labels.github_issue_label.automation["bug"]' <repo_name>:bug
terraform import 'module.labels.github_issue_label.automation["enhancement"]' <repo_name>:enhancement
terraform import 'module.labels.github_issue_label.automation["question"]' <repo_name>:question
```
