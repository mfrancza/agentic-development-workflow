# agentic-development-workflow

AI coding agents integrated into a GitHub issue-based development lifecycle. Each agent has its own GitHub identity, runs in an isolated container, and interacts via PR and issue comments.

See [requirements.md](requirements.md) for the MVP workflow and [AGENTS.md](AGENTS.md) for agent guidance.

## Setup

### 1. Create the agent GitHub Apps (one-time, manual)

Terraform cannot create GitHub Apps, so do this first in the GitHub UI under **Settings → Developer settings → GitHub Apps → New GitHub App**. Create two Apps:

**developer-agent**
- Repository permissions: Contents (R/W), Issues (R/W), Pull requests (R/W), Workflows (R/W), Metadata (R), Checks (R), Deployments (R)
- Subscribe to events: Issues, Pull request, Pull request review, Check run, Deployment status
- Webhook: **uncheck "Active"** — the GitHub UI otherwise requires a Webhook URL, and this project uses `workflow_dispatch` rather than webhooks.
- After creation: note the **App ID** and generate + download a **private key** (`.pem`).

**reviewer-agent**
- Repository permissions: Contents (R), Issues (R/W), Pull requests (R/W), Metadata (R), Checks (R)
- Subscribe to events: Pull request, Pull request review, Issue comment
- Webhook: **uncheck "Active"** (same reason as above).
- After creation: note the App ID and download the private key.

Then install each App on this repository (sidebar → **Install App** → **Install** next to your username → **Only select repositories** → pick `agentic-development-workflow`). That per-repo selection is what scopes the App to this repo; Terraform deliberately does not manage App installations (the GitHub API endpoints for it reject OAuth user tokens, which is what `gh auth token` issues).

### 2. Run Terraform

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your repo owner/name.

export GITHUB_TOKEN=$(gh auth token)  # or any token with `repo` scope

terraform init

# Import the repo. The ID is the plain repo name — whatever you set for
# var.repo_name in terraform.tfvars (default: agentic-development-workflow).
terraform import github_repository.this "$(terraform console <<<'var.repo_name' | tr -d '"')"

terraform plan
terraform apply
```

Terraform will:
- Codify repo settings (squash-merge only, delete branch on merge, etc.).
- Apply branch protection on `main` (PR review required, no force pushes, no direct pushes — agents must go through PRs, admins included).
- Create the labels consumed by the agent workflows (`agent:developer`, `agent:groom`, `model:sonnet`/`opus`/`haiku`, and the grooming labels `question`/`bug`/`enhancement`/`dependency upgrade`/`do`/`plan`) so they show up in the GitHub label picker on issue creation.

If `terraform apply` errors with `422 already_exists` on a default GitHub label (`bug`, `enhancement`, `question` — these ship pre-created on new repos), import them and re-apply:

```bash
terraform import 'github_issue_label.automation["bug"]'         "$(terraform console <<<'var.repo_name' | tr -d '"'):bug"
terraform import 'github_issue_label.automation["enhancement"]' "$(terraform console <<<'var.repo_name' | tr -d '"'):enhancement"
terraform import 'github_issue_label.automation["question"]'    "$(terraform console <<<'var.repo_name' | tr -d '"'):question"
```

App private keys are deliberately **not** managed by Terraform — keeping them out of `terraform.tfstate` is the whole point. Set them as repo Actions secrets out of band (next step).

### 3. Set App credentials as Actions secrets

Run once after `terraform apply`, and again whenever you rotate a key:

```bash
gh secret set DEVELOPER_APP_ID         --body "<developer App ID>"
gh secret set DEVELOPER_APP_PRIVATE_KEY < ~/.config/agentic-agents/developer-agent.pem
gh secret set REVIEWER_APP_ID          --body "<reviewer App ID>"
gh secret set REVIEWER_APP_PRIVATE_KEY < ~/.config/agentic-agents/reviewer-agent.pem
```

Workflows (not yet built) will use these to mint short-lived installation tokens at runtime.

### 4. Build the developer agent container

See [docker/](docker/) for the agent runtime. GitHub Actions workflows (not yet built) will invoke this container per event.

## Status

MVP in progress. Built: developer agent container, agent guidance, Terraform for repo/identity setup. Pending: GitHub Actions workflows, reviewer agent container, local-run guide.
