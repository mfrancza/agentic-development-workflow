# security module

Enables Dependabot vulnerability alerts for a GitHub repository.

This module manages `github_repository_vulnerability_alerts`, which activates GitHub's Dependabot alerts for known vulnerabilities in dependencies.

## What this module does NOT manage

The `security_and_analysis` block (secret scanning and push protection) **cannot be moved into a module** because it is a nested block on the caller's `github_repository` resource — it must stay there. Copy the snippet below into your `github_repository` resource to enable it:

```hcl
resource "github_repository" "this" {
  # ... other settings ...

  # Enable secret scanning and push protection (requires public repo or GHAS licence).
  # Config state 2 of the public flip (docs/design/public-visibility-flip.md,
  # Decision 2): only applicable once the repo is public. GitHub rejects these
  # settings on a private non-GHAS repo, and the provider sends this PATCH
  # before any visibility change — so this block must merge and apply strictly
  # after the state-1 apply that flips visibility.
  security_and_analysis {
    secret_scanning {
      status = "enabled"
    }
    secret_scanning_push_protection {
      status = "enabled"
    }
  }
}
```

Both features are free on public repositories and run independently of any external secret-scanning workflow.

## Usage

### Local path (same repo)

```hcl
module "security" {
  source     = "./modules/security"
  repository = github_repository.this.name
}
```

### Git source (external consumer)

```hcl
module "security" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/security?ref=<tag>"
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
| `repository` | `string` | yes | — | Name of the GitHub repository to enable vulnerability alerts for. |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `repository` | `string` | Name of the repository that has vulnerability alerts enabled. |
