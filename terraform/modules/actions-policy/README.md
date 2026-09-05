# actions-policy module

Restricts which GitHub Actions are permitted to run in a repository.

The default configuration allows **only GitHub-owned actions** (`actions/*`) — `github_owned_allowed = true`, `verified_allowed = false`, `patterns_allowed = []`. This covers all workflows in this repo, which use `actions/checkout`, `actions/setup-node`, and similar GitHub-owned actions plus local composite actions referenced by path (which are not subject to the `allowed_actions` policy).

## Usage

### Local path (same repo)

```hcl
module "actions_policy" {
  source     = "./modules/actions-policy"
  repository = github_repository.this.name
  # defaults: github_owned_allowed=true, verified_allowed=false, patterns_allowed=[]
}
```

### Git source (external consumer)

```hcl
module "actions_policy" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/actions-policy?ref=<tag>"
  repository = "<your-repo-name>"
}
```

### Adding a non-GitHub action

If a workflow needs to use an action outside `actions/*`, add it to `patterns_allowed` **and** pin it to a full 40-character SHA in the workflow YAML. Without the pattern, GitHub blocks the run with an opaque "action not allowed" error.

```hcl
module "actions_policy" {
  source           = "./modules/actions-policy"
  repository       = github_repository.this.name
  patterns_allowed = ["anthropics/claude-code-action"]
}
```

```yaml
# In the workflow YAML:
- uses: anthropics/claude-code-action@<40-char-SHA>  # vX.Y.Z
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
| `repository` | `string` | yes | — | Name of the GitHub repository to configure. |
| `github_owned_allowed` | `bool` | no | `true` | Allow all `actions/*` actions. |
| `verified_allowed` | `bool` | no | `false` | Allow verified-creator actions. Keep `false` unless needed — the verified list is broad and GitHub-managed. |
| `patterns_allowed` | `list(string)` | no | `[]` | `owner/repo` patterns for non-GitHub-owned actions to permit. Each must be SHA-pinned in the workflow YAML. |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `allowed_actions` | `string` | The `allowed_actions` mode applied (`"selected"`). |
| `patterns_allowed` | `set(string)` | The set of explicitly allowed non-GitHub-owned action patterns. |
