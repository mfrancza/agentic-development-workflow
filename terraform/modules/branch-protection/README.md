# branch-protection module

Manages the `main-protection` repository ruleset that enforces required PR reviews and prevents direct pushes to the default branch.

**Policy summary:**

- Repository admins can bypass the review requirement when merging a PR, but **cannot push directly** to the default branch. This eliminates the "delete protection → merge → reapply" workaround while keeping the push protection intact.
- Linear history required (no merge commits).
- Deletion of the default branch is blocked.
- Stale-review dismissal on push is enabled.
- The optional protected-approval status check is disabled by default. Enabling it adds the `protected-approval-gate` check, pinned to the GitHub Actions App, without changing the normal required-review count.

## Usage

### Local path (same repo)

```hcl
module "branch_protection" {
  source                         = "./modules/branch-protection"
  repository                     = github_repository.this.name
  # enable_protected_approval_gate = true # opt-in; defaults to false
}
```

### Git source (external consumer)

```hcl
module "branch_protection" {
  source                         = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/branch-protection?ref=<tag>"
  repository                     = "<your-repo-name>"
  # enable_protected_approval_gate = true # opt-in; defaults to false
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
| `enable_protected_approval_gate` | `bool` | no | `false` | When enabled, requires the protected-approval check without changing `required_approving_review_count`. |
| `enable_protected_approval_gate_check_context` | `string` | no | `null` | Optional context override; defaults to `protected-approval-gate`. |
| `enable_protected_approval_gate_check_integration_id` | `number` | no | `15368` | Publisher App ID (GitHub Actions). |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `ruleset_id` | `number` | ID of the `main-protection` repository ruleset. |
| `ruleset_name` | `string` | Name of the `main-protection` repository ruleset. |

## Security note

This ruleset uses the modern `github_repository_ruleset` resource (not the legacy `github_branch_protection` resource). The `bypass_actors` block grants Repository Admins (role ID 5) `pull_request` bypass mode — meaning they can merge their own PRs without an independent review, but they cannot push directly to the protected branch. This design is intentional: it prevents agents from bypassing review while allowing maintainers to resolve impasses without removing protection entirely.

Reviews must flag any PR that weakens this ruleset (lowers `required_approving_review_count` below 1, adds a force-push bypass, or changes the admin bypass from `pull_request` to `always`).

When `enable_protected_approval_gate` is `true`, the ruleset requires `protected-approval-gate` from GitHub Actions (`integration_id = 15368`). This opt-in check supplements, rather than changes, the normal `required_approving_review_count` of `1`. For the full design see [`docs/design/protected-approval-gate.md`](../../../docs/design/protected-approval-gate.md) and [`docs/design/protected-approval-gate-job-check.md`](../../../docs/design/protected-approval-gate-job-check.md).

After enabling or re-enabling the gate, dispatch `protected-approval-gate-backfill.yml`. While the gate was OFF the publisher updated only the `(preview)` context, so an open PR whose head has not changed may still carry an enforcing-context `success` from the earlier ON interval. The backfill and the scheduled reconcile sweep trigger a publisher rerun for each open PR via `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`. The rerun re-executes the publisher under its original `pull_request_target` context, so the resulting `protected-approval-gate` job check attaches to the PR head SHA in the publisher's own check suite — clearing the merge box without a new commit.

**Pull requests with no prior publisher run.** The backfill can only rerun an existing publisher run. If a pull request was opened before the publisher workflow was deployed, there is no `pull_request_target` publisher run to rerun; the backfill skips it, leaving the PR fail-closed. Push a no-op commit on any such PR to trigger `pull_request_target: synchronize` and create the initial publisher run. PRs with only an OFF-mode preview run are not in this category — the preview run is a qualifying publisher run and the backfill reruns it, executing the enforcing job under the now-enabled gate.
