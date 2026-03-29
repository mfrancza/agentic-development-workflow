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
└── docker/
    ├── Dockerfile                    # Developer agent container image (node:22-bookworm)
    └── scripts/
        ├── entrypoint.sh             # Container entrypoint — dispatches AGENT_ACTION
        ├── git-askpass.sh            # GIT_ASKPASS helper for token-based auth
        └── prompts/
            ├── implement.md          # System prompt for issue implementation
            ├── respond-to-checks.md  # System prompt for CI failure fixes
            ├── respond-to-review.md  # System prompt for PR review responses
            └── fix-deployment.md     # System prompt for deployment failure fixes
```

## MVP Workflow

1. User creates a GitHub issue and assigns it to the developer agent.
2. A container runs with the issue as a parameter (`AGENT_ACTION=implement`).
3. The agent reads the issue, creates a branch (`agent/issue-{N}`), implements a solution, and opens a PR.
4. On CI failures, the agent is re-invoked with `AGENT_ACTION=fix-checks`.
5. On review comments, the agent is re-invoked with `AGENT_ACTION=respond-review`.
6. After merge, deployment failures trigger `AGENT_ACTION=fix-deployment`.

## Expected Deliverables (Not Yet Complete)

The project is still being built. Planned deliverables include:

- **Dockerfile** for the development agent container — **exists** at `docker/Dockerfile`
- **Terraform** for GitHub repo setup, branch protection rules, agent identities, and GitHub Actions triggers — **not yet created**
- **Local development guide** for running developer and code reviewer agents locally — **not yet created**

## Key Technologies

- **Shell scripting (Bash):** The entrypoint and helper scripts are POSIX-compatible Bash (`set -euo pipefail`). Follow this convention for any new scripts.
- **Docker:** The agent container is based on `node:22-bookworm` and installs `git`, `curl`, `jq`, `gh` (GitHub CLI), and `@anthropic-ai/claude-code`.
- **GitHub CLI (`gh`):** Used throughout for cloning, creating PRs, checking PR status, and posting comments. Always use `gh` for GitHub API operations.
- **Terraform (planned):** Infrastructure-as-code for GitHub resources.

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

When creating Terraform configurations:
- Place them in a new top-level `terraform/` directory.
- Target GitHub provider resources for repo setup, branch protection, and agent identities.
- Follow the constraints in `requirements.md` for branch protection rules.

## Build and Test

There are currently **no automated tests, linters, or CI pipelines** in this repository. If you add any:
- Prefer standard tooling for the language/framework in use.
- Document how to run them in this file.
- Ensure the Docker image builds successfully: `docker build -t dev-agent docker/`

## Errors and Workarounds

- **No `.github/` directory existed initially.** It was created as part of adding this instructions file.
- **No CI/CD workflows exist yet.** GitHub Actions workflows for triggering agent containers on issue assignment are a planned deliverable. When adding them, place workflow files in `.github/workflows/`.
- **Shallow clone limitations:** The repository may be a shallow clone. If you need full history or other branches, run `git fetch --unshallow origin` before attempting operations that require full git history.
