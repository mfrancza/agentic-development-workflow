# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

This project builds a system for integrating coding agents into an issue-based software development lifecycle using GitHub. Agents have their own identities and isolated development environments, enabling human review policies and least-privilege access control.

See [`requirements.md`](requirements.md) for the full project specification and [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for a detailed repository structure map.

## Repository Layout

```
├── AGENTS.md                         # This file — conventions and workflow for AI agents
├── README.md                         # Setup and operator guide
├── CONTRIBUTING.md                   # PR workflow and branch-protection notes
├── requirements.md                   # Project specification / MVP requirements
├── agents/
│   └── grooming/
│       └── label-criteria.json       # Label definitions used by the grooming agent
├── docker/
│   ├── Dockerfile                    # Developer agent container image (node:22-bookworm)
│   └── scripts/
│       ├── entrypoint.sh             # Container entrypoint — dispatches AGENT_ACTION
│       ├── git-askpass.sh            # Token-based git credential helper
│       └── prompts/                  # One system prompt per AGENT_ACTION
├── terraform/                        # Repo settings, branch-protection ruleset, Actions vars
└── .github/
    ├── copilot-instructions.md       # Detailed onboarding for AI coding tools
    └── workflows/                    # One workflow per AGENT_ACTION
```

## MVP Workflow

1. User opens a GitHub issue. Applying the `agent:groom` label runs the grooming agent (`AGENT_ACTION=groom`), which adds classification labels and clarifying notes based on [`agents/grooming/label-criteria.json`](agents/grooming/label-criteria.json).
2. Applying the `agent:developer` label triggers the developer agent (`AGENT_ACTION=implement`), which creates the `agent/issue-{N}` branch, writes a solution, and opens a PR.
3. On CI failures against an agent-authored PR, the `agent-fix-checks` workflow re-invokes the container with `AGENT_ACTION=fix-checks`. **Note:** `agent-fix-checks.yml` is currently wired to `on.workflow_run.workflows: ["CI"]`; it will not fire until a workflow named `CI` exists in the repo (the entry is a placeholder — update the workflow list or add a `CI` workflow when CI lands).
4. On a submitted PR review, the `agent-respond-review` workflow runs `AGENT_ACTION=respond-review`, which addresses feedback and pushes updates.
5. Deployment failures trigger `AGENT_ACTION=fix-deployment` via the `deployment_status` event (regardless of merge state — the workflow skips unless it can map the failing deployment SHA to a PR containing `Closes #N`), which opens a fix-up PR.

Every workflow builds the container from [`docker/`](docker/) and mints a short-lived installation token from the `developer-agent` GitHub App.

## Agent Actions

The container is a single image dispatched by `AGENT_ACTION`. Required environment variables:

| Action            | Required vars (in addition to `ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_REPO`) |
|-------------------|-------------------------------------------------------------------------------|
| `implement`       | `GITHUB_ISSUE_NUMBER`                                                         |
| `groom`           | `GITHUB_ISSUE_NUMBER`                                                         |
| `fix-checks`      | `GITHUB_PR_NUMBER`                                                            |
| `respond-review`  | `GITHUB_PR_NUMBER`                                                            |
| `fix-deployment`  | `GITHUB_ISSUE_NUMBER`, `GITHUB_RUN_ID`                                        |

Optional: `CLAUDE_MODEL` (default `sonnet`), `CLAUDE_MAX_TURNS` (default `100`).

## Labels

- `agent:groom` — triggers the grooming agent on the issue.
- `agent:developer` — triggers the developer agent to implement the issue.
- `agent:review` — applied to a PR to request a review from the code review agent.
- `model:<name>` (e.g. `model:opus`, `model:haiku`, `model:sonnet`) — overrides the repo-wide default Claude model for `agent-implement`, `agent-groom`, and `agent-fix-deployment` runs on that issue. At most one `model:*` label is allowed per issue; workflows fail loudly if more than one is present. Other workflows always use `vars.DEFAULT_CLAUDE_MODEL`.
- Classification labels applied by the grooming agent (`question`, `bug`, `enhancement`, `dependency upgrade`, `do`, `plan`) — defined in `agents/grooming/label-criteria.json`.

Only usernames (and agent bot identities like `<developer-agent-app-slug>[bot]`) in the Terraform-managed `AGENT_ALLOWLIST` Actions variable can trigger `agent:groom`, `agent:developer`, or `agent:review`. The agent bots are included in the allowlist so that agents can apply `agent:*` labels to route work to one another (e.g. the developer agent applying `agent:review` on its own PR).

## Expected Deliverables

- **Developer agent container** — implemented at [`docker/`](docker/).
- **Terraform** for repo settings, branch protection, and per-workflow config — implemented at [`terraform/`](terraform/). Agent App identities are configured out of band (see README).
- **GitHub Actions workflows** for each agent action — implemented at [`.github/workflows/`](.github/workflows/).
- **Local development guide** for running the developer and reviewer agents locally — not yet written.

## Claude Code Identity

Inside workflow runs, `GH_TOKEN` is minted from the `developer-agent` GitHub App installation and injected into the container. Do not hardcode PATs or user tokens.

When running the container locally, pass your own `GH_TOKEN` (see [README.md](README.md) for the `docker run` invocation).

## Key Design Constraints

- Agents must have separate GitHub identities from the user (distinct credentials, limited permissions).
- Agent containers must be isolated from user credentials — the entrypoint sets `GIT_ASKPASS`/`GIT_TERMINAL_PROMPT=0` and only sees the injected `GH_TOKEN`.
- All agent-human and agent-agent interaction happens via GitHub issue/PR comments.
- Branch protection must require independent PR approval and prevent agents (and admins) from pushing directly to `main`. Enforced by the `main-protection` ruleset in [`terraform/main.tf`](terraform/main.tf).

## Shell Script Conventions

- All scripts use `#!/bin/bash` with `set -euo pipefail`.
- Logging uses the `log()` helper in `entrypoint.sh` (`echo "[agent] $(date -Iseconds) $*"`).
- Git identity inside the container is `claude-dev-agent[bot]`.
- Required env vars are validated with `${VAR:?message}` at the top of each function.

## Adding a New Agent Action

1. Add a prompt file in `docker/scripts/prompts/`.
2. Add an `action_<name>()` function in `docker/scripts/entrypoint.sh` and a matching case in the dispatcher.
3. Add a workflow in `.github/workflows/` that builds the image and runs the container with the new `AGENT_ACTION`.
4. Document the new action (env vars, trigger, labels) here in AGENTS.md and — if it affects setup — in README.md.

## Keeping Documentation Current

**Whenever you make a change that affects how agents are configured, triggered, or run, update the docs in the same PR.** Documentation drift makes onboarding painful and makes agent runs unpredictable.

At minimum, before opening a PR, check whether your change alters any of the following. If it does, update `AGENTS.md`, and update `README.md` too when the change is user-visible for someone setting up the repo:

- The set of `AGENT_ACTION` values, their env vars, or their trigger events.
- Workflow files under `.github/workflows/` (triggers, gating conditions, secrets, env vars passed to the container).
- Labels that gate or configure agent behaviour (`agent:*`, `model:*`, grooming labels).
- Terraform variables, resources, or Actions variables (`AGENT_ALLOWLIST`, `DEFAULT_CLAUDE_MODEL`, branch-protection rules).
- Required GitHub App permissions or repo Actions secrets.
- The repository layout section above (new top-level directories or removed files).
- The `docker/` image (base image, installed tools, or entrypoint contract).

If you touch `agents/grooming/label-criteria.json`, also refresh the label list in the **Labels** section above.

When in doubt, err on the side of updating the docs — a stale AGENTS.md is worse than a slightly-too-detailed one.
