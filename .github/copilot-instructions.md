# Copilot Instructions

## Project Overview

This repository builds a system for integrating AI coding agents into an issue-based software development lifecycle on GitHub. Agents have their own identities and isolated development environments, enabling human review policies and least-privilege access control.

See `requirements.md` for the full project specification and `AGENTS.md` for existing agent guidance.

## Repository Structure

```
├── AGENTS.md                         # AI agent guidance (conventions, workflow, constraints)
├── requirements.md                   # Project specification and MVP requirements
├── README.md                         # Project readme (minimal)
├── LICENSE                           # Apache 2.0
├── agents/
│   └── grooming/
│       └── label-criteria.json       # Label-indexed grooming criteria (used by groom prompt)
├── docker/
│   ├── Dockerfile                    # Developer agent container image (node:22-bookworm)
│   └── scripts/
│       ├── entrypoint.sh             # Container entrypoint — dispatches AGENT_ACTION
│       ├── git-askpass.sh            # GIT_ASKPASS helper for token-based auth
│       └── prompts/
│           ├── implement.md          # System prompt for issue implementation
│           ├── respond-to-checks.md  # System prompt for CI failure fixes
│           ├── respond-to-review.md  # System prompt for PR review responses
│           ├── fix-deployment.md     # System prompt for deployment failure fixes
│           └── groom.md              # System prompt for issue grooming (labels + notes)
├── terraform/
│   ├── main.tf                       # GitHub repo, branch protection ruleset
│   ├── variables.tf                  # Input variables (repo_owner, repo_name)
│   ├── outputs.tf                    # Output values
│   └── terraform.tfvars.example      # Example variable values
└── .github/
    ├── copilot-instructions.md       # This file
    └── workflows/
        ├── agent-implement.yml       # Triggers the developer agent on issue labeling
        ├── agent-fix-checks.yml      # Re-invokes the agent on workflow_run failures (fix-checks)
        ├── agent-respond-review.yml  # Re-invokes the agent on pull_request_review (respond-review)
        ├── agent-fix-deployment.yml  # Re-invokes the agent on deployment_status failures
        └── agent-groom.yml           # Runs the grooming agent on new issues
```

## MVP Workflow

1. User creates a GitHub issue; the grooming agent runs automatically (`AGENT_ACTION=groom`) to apply labels and add clarifying notes.
2. User assigns the issue to the developer agent.
3. A container runs with the issue as a parameter (`AGENT_ACTION=implement`).
4. The agent reads the issue, creates a branch (`agent/issue-{N}`), implements a solution, and opens a PR.
5. On CI failures, the agent is re-invoked with `AGENT_ACTION=fix-checks`.
6. On review comments, the agent is re-invoked with `AGENT_ACTION=respond-review`.
7. After merge, deployment failures trigger `AGENT_ACTION=fix-deployment`.

## Expected Deliverables (Not Yet Complete)

The project is still being built. Planned deliverables include:

- **Dockerfile** for the development agent container — **exists** at `docker/Dockerfile`
- **Terraform** for GitHub repo setup, branch protection rules, agent identities, and GitHub Actions triggers — **exists** at `terraform/` (repo and branch protection implemented; agent identities and full Actions trigger infrastructure not yet complete)
- **Local development guide** for running developer and code reviewer agents locally — **not yet created**

## Key Technologies

- **Shell scripting (Bash):** The entrypoint and helper scripts are POSIX-compatible Bash (`set -euo pipefail`). Follow this convention for any new scripts.
- **Docker:** The agent container is based on `node:22-bookworm` and installs `git`, `curl`, `jq`, `gh` (GitHub CLI), and `@anthropic-ai/claude-code`.
- **GitHub CLI (`gh`):** Used throughout for cloning, creating PRs, checking PR status, and posting comments. Always use `gh` for GitHub API operations.
- **Terraform:** Infrastructure-as-code for GitHub resources — exists at `terraform/`.

## Key Design Constraints

- Agents must have **separate GitHub identities** from the user (distinct credentials, limited permissions).
- Agent containers must be **isolated from user credentials**.
- All agent-human and agent-agent interaction happens via **GitHub issue/PR comments**.
- Branch protection must require **independent PR approval** and prevent agents from pushing directly to main.
- The entrypoint script requires these environment variables: `ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_REPO`, `AGENT_ACTION`.
- Additional variables per action: `GITHUB_ISSUE_NUMBER` (implement, fix-deployment), `GITHUB_PR_NUMBER` (fix-checks, respond-review), `GITHUB_RUN_ID` (fix-deployment).

## Development Guidance

### Working with the Docker Container

Build the image:
```sh
docker build -t dev-agent docker/
```

Run locally (example for implementing an issue):
```sh
docker run --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e GH_TOKEN="$GH_TOKEN" \
  -e GITHUB_REPO="owner/repo" \
  -e AGENT_ACTION="implement" \
  -e GITHUB_ISSUE_NUMBER="1" \
  dev-agent
```

### Shell Script Conventions

- All scripts use `#!/bin/bash` with `set -euo pipefail`.
- Logging uses the `log()` helper: `echo "[agent] $(date -Iseconds) $*"`.
- Git identity is set to `claude-dev-agent[bot]` inside the container.
- Authentication uses `GIT_ASKPASS` pointing to `git-askpass.sh` (token-based, no credentials on disk).
- Required env vars are validated with `${VAR:?message}` at the top of each function.

### Adding New Agent Actions

To add a new action:
1. Create a new prompt file in `docker/scripts/prompts/`.
2. Add an `action_<name>()` function in `docker/scripts/entrypoint.sh`.
3. Add the new case to the `case "$AGENT_ACTION"` dispatch block.
4. Document any new required environment variables.

### Adding Terraform

When extending the Terraform configuration:
- The `terraform/` directory manages the repository and branch protection via the GitHub provider.
- Target GitHub provider resources for repo setup, branch protection, and agent identities.
- Follow the constraints in `requirements.md` for branch protection rules.

### Applying Terraform

```sh
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill in repo_owner (and optionally repo_name)
terraform init
terraform import github_repository.this <repo_name>   # first time only
terraform plan
terraform apply
```

Authentication uses a GitHub PAT exported as `GITHUB_TOKEN` (needs `repo` scope for personal repos).

## Build and Test

There are currently **no automated tests or linters** in this repository. The CI pipeline (`agent-implement.yml`) triggers the developer agent on issue labeling. If you add tests or linters:
- Prefer standard tooling for the language/framework in use.
- Document how to run them in this file.
- Ensure the Docker image builds successfully: `docker build -t dev-agent docker/`

## Errors and Workarounds

- **No `.github/` directory existed initially.** It was created as part of adding this instructions file.
- **Shallow clone limitations:** The repository may be a shallow clone. If you need full history or other branches, run `git fetch --unshallow origin` before attempting operations that require full git history.

## Review Comment Handling

When responding to pull request reviews, mark any review thread comments that were previously created by Copilot (the `github-copilot[bot]` user or similar bot identities) as **resolved** after addressing them. Use the GitHub API via `gh api` to resolve review threads by their node ID.
