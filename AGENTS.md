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
4. On a submitted PR review, the `agent-respond-review` workflow runs `AGENT_ACTION=respond-review`, which addresses feedback and pushes updates. The workflow skips cleanly when the review is a bare approval — state `approved`, no body text, and no inline review comments — since there is nothing to respond to.
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
- `agent:review` — applied to a PR to request a review from the code review agent. (**Note:** the reviewer-agent workflow is not yet implemented; this label is reserved as a placeholder trigger until the workflow lands.)
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

## Code Review Standards

This section defines what a pull-request review — by either the reviewer agent or a human — must cover. It is the single source of truth for both audiences: the reviewer agent's prompt should link back here rather than duplicate the list, and human reviewers can use it as a checklist.

### Every review evaluates the PR against these dimensions

- **Adherence to the linked issue.** The PR is scoped to the requirements of the issue it claims to close (via `Closes #N`). Flag scope creep (unrelated changes bundled in), missing requirements, and acceptance-criteria gaps. If the issue is ambiguous, the PR description should say how the ambiguity was resolved.
- **Correctness.** Logic does what the PR claims. Consider edge cases, error handling, idempotency, and behaviour under concurrent runs. Verify that referenced APIs, CLI flags, environment variables, secrets, and Actions variables actually exist and behave as described.
- **Security.** No hardcoded credentials, no unsanitized user input flowing into shell, YAML, or Actions expression contexts, no privilege escalation, no unsafe network or git operations. See "Repo-specific security defaults" below for the concrete patterns this repo already relies on.
- **Style and conventions.** Matches the conventions in this file (see **Shell Script Conventions** above) and the style of surrounding code. New files follow the layout described in **Repository Layout**. Do not introduce a competing convention when an existing one already covers the case.
- **Test coverage.** New behaviour is exercised by tests where practical. For code that is hard to unit-test (workflow YAML, Terraform, container entrypoints), the PR description explains how the change was verified — e.g. a manual dry-run, a local `docker run` invocation, or a `terraform plan` excerpt.
- **Documentation.** `AGENTS.md` and `README.md` are updated in the same PR when the change alters agent configuration, triggers, labels, env vars, or setup — see **Keeping Documentation Current** below for the exact list.

### Repo-specific security defaults

The following patterns are already used across this repo. A review must flag any new code that omits them:

- **Allowlist gating on label senders.** Workflows triggered by `issues.labeled` or `pull_request.labeled` must gate on `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` — not on `github.repository_owner` (which is the org login in org repos, not a user) and not on the issue/PR author. GitHub has no per-label permission model, so the sender check is the only defence against an outside collaborator triggering an agent. See [`.github/workflows/agent-implement.yml`](.github/workflows/agent-implement.yml) for the canonical form.
- **Output-injection hygiene.** Any value derived from user-controlled input (issue labels, PR titles, comment bodies, issue titles) that is written to `GITHUB_OUTPUT` must be stripped of CR/LF first — `tr -d '\r\n'` is the pattern already in use (see the `model:` label resolver in `agent-implement.yml`). Untrusted content must never be interpolated directly into `run:` scripts via `${{ ... }}`; pass it through `env:` and reference `"$VAR"` inside the script so the shell — not the workflow expression engine — parses it.
- **Pinned action SHAs.** Third-party actions (including `actions/*` and `anthropics/*`) are pinned to a full 40-character commit SHA with an inline version comment (e.g. `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0`), never to a tag or branch. Local actions under `./.github/actions/` are referenced by path and do not need a SHA.
- **Least-privilege tokens.** Every workflow declares a top-level `permissions:` block scoped to the minimum needed (default to `contents: read`). Agent identities use short-lived installation tokens minted via [`.github/actions/agent-token`](.github/actions/agent-token/action.yml) from a GitHub App — not PATs, and not the default `GITHUB_TOKEN` — for any operation that acts as the agent. Checkouts pass `persist-credentials: false` so the minted token is the only credential in scope.
- **Fail-loud on ambiguous input.** When a workflow input can be malformed (e.g. more than one `model:*` label on a single issue), the workflow exits with `::error::` and a human-readable message rather than silently picking one value. Silent fallbacks hide bugs and make behaviour dependent on label ordering.
- **Bash safety in inline scripts.** Inline `run:` scripts start with `set -euo pipefail` and follow the **Shell Script Conventions** above. Scripts that depend on specific env vars should validate them with `${VAR:?message}` at the top of the relevant function or script (this pattern is used in `docker/scripts/entrypoint.sh`; inline workflow scripts that don't rely on caller-supplied vars don't need it). Multi-step scripts long enough to warrant it should be extracted into `docker/scripts/` or `.github/actions/` rather than inlined.
- **Branch-protection immutability.** Reviews reject changes that would weaken the `main-protection` ruleset in [`terraform/main.tf`](terraform/main.tf) — required approvals, linear history, no force-push, admin push block — unless the PR explicitly justifies the change. Agents must not be able to merge their own PRs or push directly to `main`.

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
