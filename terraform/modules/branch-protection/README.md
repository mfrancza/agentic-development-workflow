# branch-protection module

Manages the `main-protection` repository ruleset that enforces required PR reviews and prevents direct pushes to the default branch.

**Policy summary:**

- Repository admins can bypass the review requirement when merging a PR, but **cannot push directly** to the default branch. This eliminates the "delete protection → merge → reapply" workaround while keeping the push protection intact.
- Linear history required (no merge commits).
- Deletion of the default branch is blocked.
- Stale-review dismissal on push is enabled.

## Usage

### Local path (same repo)

```hcl
module "branch_protection" {
  source     = "./modules/branch-protection"
  repository = github_repository.this.name
}
```

### Git source (external consumer)

```hcl
module "branch_protection" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/branch-protection?ref=<tag>"
  repository = "<your-repo-name>"
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
| `repository` | `string` | yes | — | Name of the GitHub repository to protect. |
| `required_approving_review_count` | `number` | no | `1` | Number of required approving reviews before a PR can be merged. |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `ruleset_id` | `number` | ID of the `main-protection` repository ruleset. |
| `ruleset_name` | `string` | Name of the `main-protection` repository ruleset. |

## Security note

This ruleset uses the modern `github_repository_ruleset` resource (not the legacy `github_branch_protection` resource). The `bypass_actors` block grants Repository Admins (role ID 5) `pull_request` bypass mode — meaning they can merge their own PRs without an independent review, but they cannot push directly to the protected branch. This design is intentional: it prevents agents from bypassing review while allowing maintainers to resolve impasses without removing protection entirely.

Reviews must flag any PR that weakens this ruleset (lowers `required_approving_review_count` below 1, adds a force-push bypass, or changes the admin bypass from `pull_request` to `always`).
