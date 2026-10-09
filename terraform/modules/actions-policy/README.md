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

The policy is evaluated in the consuming repository against the full `uses:` string of every call. Reusable workflows from this repository are **not** GitHub-owned, so an external consumer must allow-list them explicitly, in GitHub's reusable-workflow form `OWNER/REPO/.github/workflows/FILE.yml@REF`. A bare `owner/repo` entry matches nothing and every caller stub fails at startup with zero jobs. One wildcard entry covers all of them at the ref you pin:

```hcl
module "actions_policy" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/actions-policy?ref=<tag>"
  repository = "<your-repo-name>"
  patterns_allowed = [
    "mfrancza/agentic-development-workflow/.github/workflows/*@v0", # or *@v0.1.0 / *@<sha> for exact pins
  ]
}
```

The reusables themselves call only GitHub-owned `actions/*` actions plus this repository's local composite actions (which are checked out into the caller's workspace and referenced by path, so they are not subject to the policy). No other entries are needed on their account.

### Adding a non-GitHub action

If a workflow needs to use an action outside `actions/*`, add it to `patterns_allowed` **with its ref** and pin it to the same full 40-character SHA in the workflow YAML. GitHub matches the whole `owner/repo@ref` string, so an entry without `@<sha>` matches nothing. Without a matching pattern, GitHub blocks the run with an opaque "is not allowed to be used in" error.

```hcl
module "actions_policy" {
  source           = "./modules/actions-policy"
  repository       = github_repository.this.name
  patterns_allowed = ["anthropics/claude-code-action@<40-char-SHA>"]
}
```

```yaml
# In the workflow YAML (same SHA as the pattern):
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
| `patterns_allowed` | `list(string)` | no | `[]` | Full-string patterns for non-GitHub-owned actions (`owner/repo@<sha>`) and external reusable workflows (`OWNER/REPO/.github/workflows/FILE.yml@REF`, wildcards allowed) to permit. A bare `owner/repo` matches nothing. |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `allowed_actions` | `string` | The `allowed_actions` mode applied (`"selected"`). |
| `patterns_allowed` | `set(string)` | The set of explicitly allowed non-GitHub-owned action patterns. |
