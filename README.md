# agentic-development-workflow

AI coding agents integrated into a GitHub issue-based development lifecycle. Each agent has its own GitHub identity, runs in an isolated container, and interacts via PR and issue comments.

See [requirements.md](requirements.md) for the MVP workflow and [AGENTS.md](AGENTS.md) for agent guidance.

## Setup

### 1. Create the agent GitHub Apps (one-time, manual)

Terraform cannot create GitHub Apps, so do this first in the GitHub UI under **Settings → Developer settings → GitHub Apps → New GitHub App**. Create two Apps:

**developer-agent**
- Repository permissions: Contents (R/W), Issues (R/W), Pull requests (R/W), Workflows (R/W), Metadata (R), Checks (R), Deployments (R)
- Subscribe to events: Issues, Pull request, Pull request review, Check run, Deployment status
- Webhook URL: not needed (workflow_dispatch is used)
- After creation: note the **App ID**, generate and download a **private key** (`.pem`), and install the App on this repository.

**reviewer-agent**
- Repository permissions: Contents (R), Issues (R/W), Pull requests (R/W), Metadata (R), Checks (R)
- Subscribe to events: Pull request, Pull request review, Issue comment
- After creation: note the App ID, download the private key, and install on this repository.

Capture the **App ID** and **installation ID** for each (the installation ID is in the URL after you install: `https://github.com/settings/installations/<INSTALLATION_ID>`).

### 2. Run Terraform

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your App IDs, installation IDs, and PEM contents.

export GITHUB_TOKEN=<a PAT with `repo` scope on your account>

terraform init
terraform import github_repository.this agentic-development-workflow
terraform plan
terraform apply
```

Terraform will:
- Codify repo settings (squash-merge only, delete branch on merge, etc.).
- Apply branch protection on `main` (PR review required, no force pushes, no direct pushes — agents must go through PRs).
- Scope each App installation to this repo only.
- Store App ID + private key as repo Actions secrets so workflows can mint installation tokens at runtime.

### 3. Build the developer agent container

See [docker/](docker/) for the agent runtime. GitHub Actions workflows (not yet built) will invoke this container per event.

## Status

MVP in progress. Built: developer agent container, agent guidance, Terraform for repo/identity setup. Pending: GitHub Actions workflows, reviewer agent container, local-run guide.
