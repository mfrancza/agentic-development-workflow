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
├── .gitleaksignore                   # Fingerprint allowlist for the secret-scan CI job
├── agents/
│   └── grooming/
│       └── label-criteria.json       # Label definitions used by the grooming agent
├── docker/
│   ├── Dockerfile                    # Developer agent container image (node:22-bookworm)
│   ├── scripts/
│   │   ├── entrypoint.sh             # Container entrypoint — dispatches AGENT_ACTION
│   │   ├── git-askpass.sh            # Token-based git credential helper
│   │   └── prompts/                  # One system prompt per AGENT_ACTION
│   └── reviewer/                     # Reviewer agent image — separate from the developer image
│       ├── Dockerfile                # Same base recipe as docker/Dockerfile (node + gh + Claude Code + Codex CLI + Grok Build CLI)
│       ├── entrypoint.sh             # Review-only entrypoint (no AGENT_ACTION dispatch; no push/commit code)
│       └── prompts/                  # Reviewer system prompt(s)
├── terraform/                        # Repo settings, branch-protection ruleset, Actions vars
└── .github/
    ├── copilot-instructions.md       # Detailed onboarding for AI coding tools
    ├── actions/                      # Local composite actions (referenced by path, no SHA needed)
    │   └── agent-token/              # Mints a short-lived App installation token
    ├── scripts/                      # Shared TypeScript package for workflow activities
    │   ├── package.json              # deps: @actions/core, @actions/github; dev: typescript, tsx, vitest
    │   ├── tsconfig.json             # strict: true
    │   ├── src/                      # One entry file per activity; lib/ for shared helpers
    │   └── test/                     # Vitest unit tests (one file per activity)
    └── workflows/                    # One workflow per AGENT_ACTION, plus ci.yml
```

## MVP Workflow

1. User opens a GitHub issue. Applying the `agent:groom` label runs the grooming agent (`AGENT_ACTION=groom`), which adds classification labels and clarifying notes based on [`agents/grooming/label-criteria.json`](agents/grooming/label-criteria.json). The `agent:groom` label is automatically removed on success so the run is not repeated; re-apply it to re-groom. On failure the label is left in place so the issue can be re-triggered without manual re-labeling.
2. For issues labeled `plan` by the grooming agent, applying the `agent:design` label runs the designer agent (`AGENT_ACTION=design`), which creates the `design/issue-{N}` branch, writes a design document in `docs/design/`, creates draft sub-issues with dependencies, and opens a PR. Sub-issues are labeled `draft` until the design PR merges. When the `design/issue-{N}` PR merges, `agent-design.yml` automatically removes the `draft` label from all sub-issues of the parent issue and removes the `agent:design` label from the parent issue. The workflow fails loudly (with a list of blocking issue numbers and titles) if the issue has any open blockers at the time the label is applied.
3. Applying the `agent:developer` label triggers the developer agent (`AGENT_ACTION=implement`), which creates the `agent/issue-{N}` branch, writes a solution, and opens a PR. The workflow skips with a log line if the issue is labeled `draft` (see the `draft` label description in **Labels**). The workflow fails loudly (with a list of blocking issue numbers and titles) if the issue has any open blockers at the time the label is applied. When the developer-agent's PR is closed (merged or abandoned), `agent-pr-merged.yml` automatically removes the `agent:developer` label from the issue.
4. On CI failures against an agent-authored PR, the `agent-fix-checks` workflow re-invokes the container with `AGENT_ACTION=fix-checks`. The `agent-fix-checks.yml` workflow triggers on `workflow_run` for the `CI` workflow (`.github/workflows/ci.yml`), which runs `tsc --noEmit` and `vitest run` on every pull request.
5. On a submitted PR review, the `agent-respond-review` workflow runs `AGENT_ACTION=respond-review`, which
   addresses feedback and pushes updates. The workflow skips cleanly when there is nothing to respond to.
   The `check-reviewer-feedback` activity applies the following checks in order:
   - **PR not open** (guard): if the PR is already closed or merged at the time the activity runs, skip
     immediately — a review on a closed or merged PR never needs a response. This eliminates a race
     condition where a human approves and merges within seconds, the head branch is auto-deleted, and the
     container would otherwise fail at checkout. On API error the check fails open and proceeds to the
     feedback checks below.
   - **Non-approval states** (changes_requested, commented, …) always proceed.
   - **Zero unresolved PR review threads** (primary check for approved reviews): threads are the ground
     truth for outstanding feedback; body text and inline comments on an approval are advisory when nothing
     remains open, so this check comes first and covers summary-carrying clean approvals too.
   - **Bare approval** (no body text, no inline review comments): fallback used when the unresolved-thread
     query fails, to skip when there is provably nothing to respond to.

   The unresolved-thread and bare-approval checks have distinct error behaviors: a GraphQL error on the
   primary check falls through to the bare-approval fallback (which may still skip) rather than proceeding
   immediately; an inline-comment API error on the fallback check fails open so the workflow proceeds
   rather than silently suppress a response.
6. A push to `main` that makes one or more open developer-agent PRs conflicted triggers the `agent-resolve-conflicts` workflow (`AGENT_ACTION=resolve-conflicts`). The workflow enumerates open PRs authored by the developer agent, polls each PR's `mergeable` field until GitHub finishes computing it, and runs the developer container once per conflicted PR. Each conflicted PR is resolved in its own parallel matrix job; a per-PR concurrency group (`agent-resolve-conflicts-pr-<N>`, `cancel-in-progress: false`) ensures a subsequent push to `main` does not cancel an already-running resolution, and `fail-fast: false` ensures a failed resolution for one PR does not abort the others. The container attempts a semantic merge (Claude resolves the conflict markers), verifies no markers remain, and pushes the merge commit. If the agent exits unexpectedly or verification fails, the merge is aborted, the `human-required` label is applied (and the configured `ESCALATION_ASSIGNEE` assigned), and a PR comment describes which files need manual attention. PRs already carrying `human-required` are skipped. `workflow_dispatch` with a `pr_number` input is available as a manual backstop; when provided, enumeration is skipped and only that PR is resolved.
7. Deployment failures trigger `AGENT_ACTION=fix-deployment` via the `deployment_status` event (regardless of merge state — the workflow skips unless it can map the failing deployment SHA to a PR containing `Closes #N`), which opens a fix-up PR.

The developer workflows build the container from [`docker/`](docker/) and mint a short-lived installation token from the `developer-agent` GitHub App. The **reviewer image** is built from [`docker/reviewer/`](docker/reviewer/) and uses the `reviewer-agent` App identity (see the reviewer image section below). The `agent-review` workflow triggers it when the `agent:review` label is applied to a PR.

- `.github/workflows/agent-auto-trigger.yml` — applies the next-stage `agent:*` label at each SDLC transition (issue opened, classification label applied, design PR merged, agent PR opened) using a minted developer-agent token. No agent container runs; downstream workflows do the actual work. Each gate is controlled by a key in `vars.AUTO_TRIGGER_AGENTS` (see **Auto-trigger gates** under **Labels**).

## Agent Actions

The developer container is a single image dispatched by `AGENT_ACTION`. Required environment variables:

| Action            | Required vars (in addition to the provider API key, `GH_TOKEN`, `GITHUB_REPO`) |
|-------------------|--------------------------------------------------------------------------------|
| `implement`       | `GITHUB_ISSUE_NUMBER`                                                          |
| `groom`           | `GITHUB_ISSUE_NUMBER`                                                          |
| `design`          | `GITHUB_ISSUE_NUMBER`                                                          |
| `fix-checks`        | `GITHUB_PR_NUMBER`                                                           |
| `resolve-conflicts` | `GITHUB_PR_NUMBER`                                                           |
| `respond-review`    | `GITHUB_PR_NUMBER`                                                           |
| `fix-deployment`    | `GITHUB_ISSUE_NUMBER`, `GITHUB_RUN_ID`                                       |

Provider/key mapping: `ANTHROPIC_API_KEY` for Anthropic models — the tier aliases `model:sonnet`/`model:opus`/`model:haiku` (unqualified — resolve to the latest snapshot of each series, kept as-is for backwards compatibility), any generic series tag beginning with `claude-` (e.g. `model:claude-sonnet-4-5`, `model:claude-3-5-haiku-latest`), and any pinned snapshot ID (e.g. `model:claude-sonnet-4-5-20250929`); `OPENAI_API_KEY` for OpenAI models (e.g. `model:o3`); `XAI_API_KEY` for xAI Grok models (e.g. `model:grok-code-fast-1`). The entrypoint infers the provider from the resolved model name — any name starting with `claude-`, plus the three tier aliases, routes to Anthropic — and validates that the corresponding key is set.

Optional: `AGENT_MODEL` (default `sonnet`), `AGENT_MAX_TURNS` (default `100`), `ESCALATION_ASSIGNEE` (GitHub username to assign when `resolve-conflicts` applies the `human-required` label; omit to label without assigning), `ADMIN_ASSIGNEES` (JSON-encoded list of GitHub usernames sourced from the Terraform-managed `ADMIN_ASSIGNEES` Actions variable — e.g. `["alice","bob"]`; passed to the grooming container by `agent-groom.yml`; assigned by the groom agent when it applies the `human-required` label to an issue; default empty string — label is applied without assigning anyone), `CODE_REVIEWERS` (JSON-encoded list of GitHub usernames sourced from the Terraform-managed `CODE_REVIEWERS` Actions variable — e.g. `["alice","bob"]`; passed to the developer container by `agent-implement.yml`; requested as PR reviewers when the implement agent determines human review is warranted; default empty string — review is not requested from anyone).

The **reviewer image** at [`docker/reviewer/`](docker/reviewer/) does not use `AGENT_ACTION` — it performs exactly one action (review a PR) and dispatches nothing else. Required env: the provider API key for the resolved model (`ANTHROPIC_API_KEY` for Anthropic models, `OPENAI_API_KEY` for OpenAI models, `XAI_API_KEY` for xAI Grok models — same conditional key validation as the developer image), `GH_TOKEN`, `GITHUB_REPO`, `GITHUB_PR_NUMBER`; optional `AGENT_MODEL` / `AGENT_MAX_TURNS` (same defaults as the developer image so `model:*` labels behave identically) and `RESOLVE_THREADS_FILE` (path where the container records GraphQL IDs of review threads whose findings are addressed — the `resolveReviewThread` mutation requires Contents: write, which the reviewer App deliberately lacks, so `agent-review.yml` mounts this file and resolves the recorded threads with the workflow `GITHUB_TOKEN` after the container exits). The reviewer image deliberately ships no `git-askpass.sh` and has no `git commit` / `git push` code paths — the no-write guarantee is structural (image) as well as token-scoped (Contents: read on the reviewer App); see [`docs/design/reviewer-container.md`](docs/design/reviewer-container.md) decision 3. The agent posts the review via `gh api` and the entrypoint verifies afterwards that a review by the reviewer app exists on the PR head SHA — exiting non-zero otherwise (decision 1).

## Labels

- `agent:groom` — triggers the grooming agent on the issue. On success, the label is automatically removed from the issue so the grooming run is not repeated; to re-groom an issue, re-apply the label. If the run fails the label is intentionally left in place so the issue can be re-triggered without manual re-labeling.
- `agent:design` — triggers the designer agent (`AGENT_ACTION=design`) to write a design document on a `design/issue-{N}` branch, open a PR, and create sub-issues labeled `draft` with dependency tracking. Intended for issues the groomer classifies as `plan`. When a `design/issue-{N}` PR merges, `agent-design.yml` automatically removes the `draft` label from all sub-issues of the parent issue (unblocking the developer agent for each one) and removes the `agent:design` label from the parent issue to signal that design is complete. If the design PR is closed without merging, the label stays on the parent issue, signaling the design is incomplete.
- `agent:developer` — triggers the developer agent to implement the issue. When the developer-agent's PR is closed (merged or abandoned), `agent-pr-merged.yml` automatically removes the label from the issue so the iterative loop is not re-triggered; to re-run the developer agent, re-apply the label.
- `agent:review` — applied to a PR to request a review from the code review agent. Triggers `agent-review.yml`, which builds `docker/reviewer/` and runs the reviewer container with the `reviewer-agent` App identity.
  - Re-review fires automatically on every subsequent push (`synchronize` event) while the label remains on the PR — no re-labeling is needed.
  - **Known limitation:** GitHub suppresses `pull_request` and `pull_request_review` events while a PR has merge conflicts; remove and re-apply `agent:review` after resolving conflicts to restart the re-review loop.
  - **Fork-headed PRs are excluded from both the `labeled` and `synchronize` trigger paths.** Even though the workflow uses `pull_request_target` (so trusted base-branch code runs), the attacker-controlled diff still reaches Claude on every push, making the secrets-exposure window real; the job-level `if:` therefore requires `github.event.pull_request.head.repo.full_name == github.repository` for both event types. Applying `agent:review` to a fork PR will silently skip the job with no feedback.
  - Fork contributors who need a review should ask a repo member to cherry-pick their changes onto a new same-repo branch, open a PR from that branch into the base repo, and then apply `agent:review` to that same-repo PR.
  - Model selection follows the same `model:*` label logic as issue-driven runs: if a `model:*` label is present on the PR, that model is used; if none is present, `vars.DEFAULT_MODEL` is used; if more than one `model:*` label is present, the workflow fails loudly.
- `model:<name>` (e.g. `model:opus`, `model:haiku`, `model:sonnet`, `model:claude-sonnet-4-5`, `model:claude-sonnet-4-5-20250929`, `model:o3`) — overrides the repo-wide default model for a run. Applies to issue-driven runs (`agent-implement`, `agent-groom`, `agent-design`, `agent-fix-deployment`) when placed on the issue, and to PR-review runs (`agent-review`) when placed on the PR. At most one `model:*` label is allowed at each resolution tier; workflows fail loudly if more than one is present at the same tier. Anthropic labels come in three flavors: (1) **tier aliases** — `model:sonnet` / `model:opus` / `model:haiku`, unqualified names that resolve to the latest snapshot of each series (kept as-is for backwards compatibility, and the labels the grooming agent applies); (2) **generic series tags** — `model:claude-<family>-<major>-<minor>` (e.g. `model:claude-sonnet-4-5`, `model:claude-3-5-haiku-latest`) that pin to a named series but float across snapshots within it; (3) **pinned snapshot IDs** — `model:claude-<family>-<major>-<minor>-YYYYMMDD` (e.g. `model:claude-sonnet-4-5-20250929`) for reproducible runs. Terraform pre-provisions the tier aliases plus the currently active generic and pinned labels; the entrypoint accepts any `claude-*` model ID, so an ad-hoc pinned label that is not pre-provisioned still routes correctly at runtime. The grooming agent selects and applies a `model:*` label based on the complexity of the issue (mechanical → `model:haiku`, typical implementation → `model:sonnet`, design-heavy / cross-cutting / under-specified → `model:opus`) — always one of the three tier aliases, never a generic series tag or a pinned snapshot — but it will not add or change one if a `model:*` label is already present.
- `model:<agent-type>:<name>` (e.g. `model:developer:opus`, `model:groom:haiku`, `model:design:sonnet`, `model:review:haiku`) — per-agent model override. When an issue carries both a per-agent label and a generic `model:*` label, the per-agent label wins; the generic label is ignored for that run. Resolution waterfall for issue-driven workflows: (1) check for `model:<agent-type>:*` labels — if exactly one matches, use that model; (2) fall back to generic `model:*` labels (matched by `^model:[^:]+$`, which excludes per-agent labels with a second colon); (3) fall back to `vars.DEFAULT_MODEL`. Fail loudly if more than one label matches at either tier. Terraform pre-provisions tier-alias per-agent labels (`haiku`/`sonnet`/`opus`) for four agent types: `developer` (used by `agent-implement` and `agent-fix-deployment`), `groom` (used by `agent-groom`), `design` (used by `agent-design`), and `review` (`model:review:haiku/sonnet/opus` pre-provisioned in the label picker; current PR-based workflows use single-tier `model:*` resolution and ignore per-agent labels).
- Classification labels applied by the grooming agent (`question`, `bug`, `enhancement`, `dependency upgrade`, `do`, `plan`) — defined in `agents/grooming/label-criteria.json`.
- `human-required` — marks issues and PRs that need a human in the loop (security, permissions, deployments, billing, legal/compliance, branch-protection or agent-identity changes, or any agent escalation point). Agents apply this label to their own issues/PRs when they hit an escalation point and **also** assign the issue/PR to the relevant human actor; humans may apply it too. Not mutually exclusive with other labels. The criteria are documented in `agents/grooming/label-criteria.json` so the grooming agent can apply it automatically, and each developer-agent prompt in `docker/scripts/prompts/` explains when to apply it during that action.
- `blocked` — applied by the auto-trigger when it detects open blockers on an issue eligible for `agent:developer` (at the `issues.labeled do` and `issues.unlabeled draft` transitions); signals that `agent:developer` was withheld and the un-block cascade (`auto-developer-unblock` job, triggered by `issues.closed`) will apply it once all blockers close. A human may also apply this label manually as a "hold for later" marker — the auto-trigger and cascade treat it identically regardless of origin. The blocker checks use `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` and `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocking`; both endpoints are covered by the developer-agent App's existing Issues (R/W) scope.
- `draft` — applied by the designer agent to sub-issues it creates. Means the issue is scoped by an unmerged design document; do not start implementation until the design PR merges and this label is removed. When the design PR merges the `agent-design.yml` workflow automatically removes this label from all sub-issues of the parent issue. `agent-implement.yml` enforces this by skipping with a log line if the issue still carries the label.

Only usernames (and agent bot identities like `<developer-agent-app-slug>[bot]`) in the Terraform-managed `AGENT_ALLOWLIST` Actions variable can trigger `agent:groom`, `agent:developer`, `agent:review`, or `agent:design`. The agent bots are included in the allowlist so that agents can apply `agent:*` labels to route work to one another (e.g. the developer agent applying `agent:review` on its own PR).

### Auto-trigger gates (`AUTO_TRIGGER_AGENTS`)

The Terraform-managed `AUTO_TRIGGER_AGENTS` Actions variable (a JSON object) controls whether each `agent:*` label is applied automatically at the natural upstream signal, advancing the SDLC pipeline without manual labeling. All four gates default to `false` (opt-in); the operator flips a key to `true` in `terraform.tfvars` and runs `terraform apply` to enable that stage. See [`docs/design/auto-trigger-agents.md`](docs/design/auto-trigger-agents.md) for the full design rationale.

| Key | Upstream signal | Label applied | Draft guard? |
|-----|-----------------|---------------|--------------|
| `groom` | `issues.opened` (sender must be in `AGENT_ALLOWLIST`) | `agent:groom` | Yes — skipped if the issue already carries `draft`; design sub-issues are fully scoped by construction and must not be re-groomed |
| `design` | `issues.labeled` where label is `plan` (sender must be in `AGENT_ALLOWLIST`) | `agent:design` | No |
| `developer` | `issues.labeled` where label is `do` (sender must be in `AGENT_ALLOWLIST`) | `agent:developer`; applies `blocked` instead when open blockers are detected¹ | Yes — skipped if the issue carries `draft`; the un-draft transition owns the hand-off for design sub-issues |
| `developer` | `issues.unlabeled` where label is `draft` (sender must be in `AGENT_ALLOWLIST`) | `agent:developer`; applies `blocked` instead when open blockers are detected¹ | N/A — draft is being removed; this transition _is_ the un-draft path |
| `developer` | `issues.closed` (sender must be in `AGENT_ALLOWLIST`) | `agent:developer` on each newly-unblocked issue (also removes `blocked`) | N/A — cascade fires on blocker closure; each candidate must carry `blocked`, be open, have no `agent:developer` label, have no open `agent/issue-{N}` PR, and have all remaining blockers closed |
| `review` | `pull_request.opened` on a branch whose name starts with `agent/` or `design/` (same-repo PRs only) | `agent:review` | N/A |

¹ When blockers are open, the transition applies `blocked` (instead of `agent:developer`) to record the deferred state without consuming the one-shot `labeled` event. The `auto-developer-unblock` cascade job (triggered by `issues.closed`) removes `blocked` and applies `agent:developer` once all blockers close. Blocker checks call `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` (preflight and deferral gate) and `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocking` (cascade fan-out); both are covered by the developer-agent App's existing Issues (R/W) scope.

- **Troubleshooting silent skips.** If an auto-applied `agent:*` label does not start the downstream workflow (the run shows `skipped` with no error), check that the developer-agent bot identity (e.g. `mfrancza-developer-agent[bot]`) is present in `AGENT_ALLOWLIST` — a missing entry causes the auto-trigger job to succeed and apply the label while every downstream agent workflow silently skips.

## Expected Deliverables

- **Developer agent container** — implemented at [`docker/`](docker/).
- **Terraform** for repo settings, branch protection, and per-workflow config — implemented at [`terraform/`](terraform/). Agent App identities are configured out of band (see README).
- **GitHub Actions workflows** for each agent action — implemented at [`.github/workflows/`](.github/workflows/).
- **Local development guide** for running the developer and reviewer agents locally — see the [Reproduce this yourself](README.md#reproduce-this-yourself) section of [README.md](README.md).

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

## Workflow Activity Conventions

Complex workflow logic is extracted from inline `run:` blocks into **TypeScript activities** — source files under `.github/scripts/src/`. Each activity is exposed as a thin composite action under `.github/actions/<activity>/action.yml` and run from source via `npx --no-install tsx`. All activity sources, dependencies, and unit tests live in a single shared npm package at `.github/scripts/`.

### Package layout

```
.github/scripts/
  package.json            # deps: @actions/core, @actions/github; dev: typescript, tsx, vitest
  package-lock.json       # lockfile — all installs must be deterministic
  tsconfig.json           # strict: true
  vitest.config.ts        # test include pattern and passWithNoTests
  src/<activity>.ts       # one entry file per activity (thin: read inputs → call logic → set outputs)
  src/lib/*.ts            # shared helpers (Octokit setup, label parsing, pagination, …)
  test/<activity>.test.ts # vitest unit tests; Octokit mocked at module boundary
.github/actions/<activity>/
  action.yml              # composite wrapper: setup-node → npm ci → npx --no-install tsx src/<activity>.ts
```

### Writing an activity

- Entry files (`src/<activity>.ts`) stay thin: read inputs with `core.getInput()`, call a pure function defined in the same file or in `src/lib/`, then publish results with `core.setOutput()`. Keep all branching logic in the pure function so it is unit-testable without IO.
- Use `@actions/github`'s Octokit client for all GitHub API calls — **not** `gh`. This is a scoped exception to the repo-wide `gh` convention (see [`.github/copilot-instructions.md`](.github/copilot-instructions.md) Key Technologies). It applies only to workflow-executed activities in `.github/scripts/`; container scripts and shell steps that remain in workflow YAML continue using `gh`.
- Read action inputs as environment variables via `core.getInput()`; publish results with `core.setOutput()`. Skip/proceed decisions use string outputs (`skip=true|false`, `proceed=true|false`) to keep `if:` conditions in consuming workflows unchanged in form.
- The output-injection security rule still applies inside activities: values flow action-input → `process.env` → `core.setOutput()` with no shell interpolation. `@actions/core` writes `GITHUB_OUTPUT` with delimiter-safe encoding, so manual CR/LF stripping is unnecessary within activities. Shell steps that still write user-controlled values to `GITHUB_OUTPUT` keep the `tr -d '\r\n'` stripping (see **Repo-specific security defaults**).

### Shell-vs-TypeScript threshold

A `run:` block moves to a TypeScript activity when it contains **any** of: API-response parsing (`--jq`), conditional branching, pagination, or an error-handling policy (fail-open/fail-closed distinctions). A `run:` block stays shell when it is a single command or a linear sequence of commands with no parsing or branching (e.g. `docker build`, `docker run`). Repetition alone does not force TypeScript — repeated but individually trivial steps become a composite action in plain YAML + shell.

**Permanent security exceptions** — the following `run:` blocks deliberately perform no workspace code execution and must **never** be migrated to `.github/scripts/`:

- `undraft-sub-issues` job in `agent-design.yml` — runs on `pull_request.closed`; executing workspace code here would allow a merged PR to route script changes past `DEVELOPER_APP_PRIVATE_KEY`.
- All steps in `agent-pr-merged.yml` — also runs on `pull_request: closed` and performs no checkout at all; migrating its logic would require introducing a checkout and reopening the same path.

### CI

The [`.github/workflows/ci.yml`](.github/workflows/ci.yml) workflow (name: `CI`) runs on every pull request and executes `npm ci`, `tsc --noEmit`, and `vitest run` inside `.github/scripts`. This workflow being named `CI` is what activates the `agent-fix-checks` feedback loop — `agent-fix-checks.yml` triggers on `workflow_run` for a workflow named `CI`.

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

- **Allowlist gating on label senders.** Workflows triggered by `issues.labeled`, `issues.unlabeled`, or `pull_request.labeled` must gate on `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` — not on `github.repository_owner` (which is the org login in org repos, not a user) and not on the issue/PR author. GitHub has no per-label permission model, so the sender check is the only defence against an outside collaborator triggering an agent by adding or removing a label. See [`.github/workflows/agent-implement.yml`](.github/workflows/agent-implement.yml) for the canonical form.
- **Allowlist gating on review authors.** Workflows triggered by `pull_request_review: submitted` must also gate on the review author, not just the PR author. On a public repo any GitHub user can submit a review on any PR, and the review body plus inline comments are attacker-controlled text that flows into the agent prompt with a contents-write installation token and an Anthropic API key. Require `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.review.user.login)` OR an explicit match against a known reviewer bot identity — in this repo that is `mfrancza-reviewer-agent[bot]` (the reviewer agent) and `Copilot` (the login Copilot reviews carry in the `pull_request_review` event payload; the REST API renders the same reviews as `copilot-pull-request-reviewer[bot]`, and that form plus `github-copilot[bot]` are kept in the gate defensively in case GitHub changes the payload representation). See [`.github/workflows/agent-respond-review.yml`](.github/workflows/agent-respond-review.yml) for the canonical form.
- **Output-injection hygiene.** Any value derived from user-controlled input (issue labels, PR titles, comment bodies, issue titles) that is written to `GITHUB_OUTPUT` must be stripped of CR/LF first — `tr -d '\r\n'` is the pattern already in use (see the `model:` label resolver in `agent-implement.yml`). Untrusted content must never be interpolated directly into `run:` scripts via `${{ ... }}`; pass it through `env:` and reference `"$VAR"` inside the script so the shell — not the workflow expression engine — parses it.
- **Pinned action SHAs.** Third-party actions (including `actions/*` and `anthropics/*`) are pinned to a full 40-character commit SHA with an inline version comment (e.g. `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0`), never to a tag or branch. Local actions under `./.github/actions/` are referenced by path and do not need a SHA.
  - Adding a non-GitHub-owned action (anything outside `actions/*`) requires **two** coordinated changes: (1) pin the SHA in the workflow YAML as above, and (2) add the `owner/repo` pattern to `patterns_allowed` inside the `allowed_actions_config` block of the `github_actions_repository_permissions.this` resource in [`terraform/main.tf`](terraform/main.tf). Without step 2 the action is blocked at runtime with an opaque "action not allowed" error. `github_owned_allowed = true` covers all `actions/*` actions, so step 2 is only needed for actions outside that namespace (e.g. `anthropics/claude-code-action`).
- **Least-privilege tokens.** Every workflow declares a top-level `permissions:` block scoped to the minimum needed (default to `contents: read`). Agent identities use short-lived installation tokens minted via [`.github/actions/agent-token`](.github/actions/agent-token/action.yml) from a GitHub App — not PATs, and not the default `GITHUB_TOKEN` — for any operation that acts as the agent. Checkouts pass `persist-credentials: false` so the minted token is the only credential in scope. Exception: a mechanical workflow step may use the workflow `GITHUB_TOKEN` when the operation requires a scope an agent token deliberately lacks (e.g. resolving review threads needs Contents: write, which the reviewer App must not have), provided the `GITHUB_TOKEN` never enters an agent container and the step treats agent-produced input as untrusted.
- **Fail-loud on ambiguous input.** When a workflow input can be malformed (e.g. more than one `model:*` label on a single issue), the workflow exits with `::error::` and a human-readable message rather than silently picking one value. Silent fallbacks hide bugs and make behaviour dependent on label ordering.
- **Bash safety in inline scripts.** Inline `run:` scripts start with `set -euo pipefail` and follow the **Shell Script Conventions** above. Scripts that depend on specific env vars should validate them with `${VAR:?message}` at the top of the relevant function or script (this pattern is used in `docker/scripts/entrypoint.sh`; inline workflow scripts that don't rely on caller-supplied vars don't need it). Multi-step scripts long enough to warrant it should be extracted into `docker/scripts/` or `.github/actions/` rather than inlined.
- **Branch-protection immutability.** Reviews reject changes that would weaken the `main-protection` ruleset in [`terraform/main.tf`](terraform/main.tf) — required approvals, linear history, no force-push, admin push block — unless the PR explicitly justifies the change. Agents must not be able to merge their own PRs or push directly to `main`.
- **History-wide secret scanning.** The [`.github/workflows/secret-scan.yml`](.github/workflows/secret-scan.yml) workflow runs `gitleaks git --log-opts="--all"` on every push, every PR against `main`, weekly on cron, and on manual dispatch. It scans the entire reachable commit graph (checkout uses `fetch-depth: 0`), not just the diff. Known false positives (documentation placeholders in historical commits) are silenced by fingerprint in [`.gitleaksignore`](.gitleaksignore) — never by broad path or regex allowlists, which would also hide real secrets in the same file. Adding a fingerprint requires a comment explaining why the finding is not a real secret.
- **(Post-flip) GitHub-native secret scanning + push protection.** Both are enabled via the `security_and_analysis` block in [`terraform/main.tf`](terraform/main.tf). Secret scanning posts alerts for secrets detected anywhere in the full commit history; push protection blocks pushes that contain detected secret patterns before they enter the history. Both features are free on public repos and run independently of the gitleaks workflow (different detection engine; useful overlap). A review must flag any PR that removes or downgrades these settings.
- **(Post-flip) `allowed_actions = "selected"`, GitHub-owned only.** `github_actions_repository_permissions` in `terraform/main.tf` restricts allowed Actions to `github_owned_allowed = true` with `verified_allowed = false` and an empty `patterns_allowed`. Workflows in this repo use `actions/*` actions and local actions under `./.github/actions/` (referenced by path; local actions are not subject to the `allowed_actions` policy), so the policy has zero configured-pattern surface outside of GitHub-owned actions. A workflow that adds a non-GitHub, non-local action must also extend `patterns_allowed` with a full-SHA pin (same SHA-pin convention as the rest of this repo) — omitting the entry causes a loud workflow failure, which is the intended signal. Reviews must flag workflows that skip this update.
- **(Post-flip) Fork-PR approval policy: all external contributors.** Workflow runs triggered by fork PRs from external contributors (users without write access) require explicit approval before running; the policy is set to `all_external_contributors` via Settings → Actions → General or Terraform (see issue [#185](https://github.com/mfrancza/agentic-development-workflow/issues/185)). This is defence-in-depth: the agent workflows already gate on head-repo identity and AGENT_ALLOWLIST membership at the job level, so the approval gate is an additional layer. A review must flag any change that weakens this policy.
- **(Post-flip) Interaction limit: `collaborators_only`, manually renewed.** Non-collaborators cannot open issues or PRs. The limit is applied by the maintainer at flip time using the command in [`docs/design/public-visibility-flip.md`](docs/design/public-visibility-flip.md#flip-day-runbook) and renewed every six months via the reminder-issue workflow ([#176](https://github.com/mfrancza/agentic-development-workflow/issues/176)). No identity in Actions holds `administration:write`, so renewal is a manual step — automated renewal is out of scope. A review must flag any PR that removes the interaction-limit documentation or weakens the renewal process.

## Adding a New Agent Action

1. Add a prompt file in `docker/scripts/prompts/`.
2. Add an `action_<name>()` function in `docker/scripts/entrypoint.sh` and a matching case in the dispatcher.
3. Add a workflow in `.github/workflows/` that calls the [`.github/actions/run-agent`](.github/actions/run-agent/action.yml) composite action with the new `AGENT_ACTION` and the appropriate issue/PR/run identifiers.
4. Document the new action (env vars, trigger, labels) here in AGENTS.md and — if it affects setup — in README.md.

## Manual repository settings

The following settings must be applied manually by a maintainer with admin
credentials at flip time — each for a different reason (see the decision
entries in
[`docs/design/public-visibility-flip.md`](docs/design/public-visibility-flip.md)
for details). See the same doc for the required sequencing.

- **Fork-PR approval policy.** The `integrations/github` Terraform provider
  (v6.12.1; constraint `~> 6.2`) does not expose the
  `fork-pr-approval` endpoint (Decision 4 branch (b)). Set this in
  the GitHub UI after the repo is public: Settings → Actions → General →
  "Fork pull request workflows from outside collaborators" → select
  **"Require approval for all outside collaborators"** (the strictest of the
  three options). See the [flip-day runbook](docs/design/public-visibility-flip.md#flip-day-runbook) for the required sequencing.
- **Interaction limit.** No identity holds `administration:write` in Actions,
  so `collaborators_only` is set manually via:
  ```
  gh api -X PUT repos/mfrancza/agentic-development-workflow/interaction-limits \
    -f limit=collaborators_only \
    -f expiry=six_months
  ```
  The [#176 reminder-issue workflow](https://github.com/mfrancza/agentic-development-workflow/issues/176)
  handles renewal reminders. This call must be made after the repo is public
  (see the [flip-day runbook](docs/design/public-visibility-flip.md#flip-day-runbook) for sequencing).

## Debugging

### Container logs and session transcripts

Every agent container run produces two items inside `/home/agent/logs/`:

- `container.log` — merged stdout/stderr of the run (all `log()` lines from the entrypoint, output from `gh`/`git` and other tools, and the final Claude response text).
- `session/` — a copy of `~/.claude/projects/**/*.jsonl` (Claude Code session transcripts), one JSONL file per session, containing every turn, tool call, tool result, and model response with timestamps.

The entrypoint writes `container.log` via a `tee` redirect installed at the top of the script — so even env-validation failure messages are captured — and copies session files in a trap-EXIT handler so they survive all exit paths (normal completion, `set -e` abort, SIGTERM).
An OOM kill (SIGKILL) bypasses the trap; whatever `tee` has already written to the bind-mount is the only artifact that survives that scenario.

**In CI**, the workflow pre-creates the host directory and the logs directory is uploaded as a GitHub Actions artifact after the container exits (`if: always()`, so it uploads on both success and failure).
Artifact names encode the workflow context (e.g. `agent-logs-implement-issue-42-run-<run_id>-<attempt>`); retention is 30 days.
Download an artifact with:

```bash
gh run download <run-id> --name <artifact-name>
```

The bind-mount and upload steps are present in all eight agent-container workflows: `agent-implement.yml`, `agent-groom.yml`, `agent-design.yml`, `agent-fix-checks.yml`, `agent-fix-deployment.yml`, `agent-resolve-conflicts.yml`, `agent-respond-review.yml`, and `agent-review.yml`.

**Redaction:** the entrypoint runs a `sed` pass over every file in `/home/agent/logs/` before the workflow reads the mount, replacing the literal values of `GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `XAI_API_KEY` with `***REDACTED-GH_TOKEN***`, `***REDACTED-ANTHROPIC_API_KEY***`, `***REDACTED-OPENAI_API_KEY***`, and `***REDACTED-XAI_API_KEY***` respectively.
The substitution runs inside the container; the token values never appear in a workflow-side shell command, and the redacted directory is what `actions/upload-artifact` stores and retains.

**Local runs:** add `-v "$PWD/logs:/home/agent/logs"` to the `docker run` invocation to get the same artifacts on disk (see [README.md](README.md#4-build-the-developer-agent-container)).

## Keeping Documentation Current

**Whenever you make a change that affects how agents are configured, triggered, or run, update the docs in the same PR.** Documentation drift makes onboarding painful and makes agent runs unpredictable.

At minimum, before opening a PR, check whether your change alters any of the following. If it does, update `AGENTS.md`, and update `README.md` too when the change is user-visible for someone setting up the repo:

- The set of `AGENT_ACTION` values, their env vars, or their trigger events.
- Workflow files under `.github/workflows/` (triggers, gating conditions, secrets, env vars passed to the container). Also update the doc when adding or removing an entry in [`.gitleaksignore`](.gitleaksignore) — an allowlisted fingerprint is a review-relevant deviation, not silent config.
- Labels that gate or configure agent behaviour (`agent:*`, `model:*`, grooming labels).
- Terraform variables, resources, or Actions variables (`AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, `CODE_REVIEWERS`, `DEFAULT_MODEL`, `AUTO_TRIGGER_AGENTS`, branch-protection rules).
- Required GitHub App permissions or repo Actions secrets.
- The repository layout section above (new top-level directories or removed files).
- The `docker/` image (base image, installed tools, or entrypoint contract).

If you touch `agents/grooming/label-criteria.json`, also refresh the label list in the **Labels** section above.

When in doubt, err on the side of updating the docs — a stale AGENTS.md is worse than a slightly-too-detailed one.

### Merge-friendly documentation

`AGENTS.md` and `README.md` are edited by many concurrent agent PRs, so write them to merge cleanly:

- **No implementation-status notes in prose.** Do not write "(**Note:** X is not yet implemented; lands in issue #N)" next to a feature description. Describe the target behavior and let the linked issue track status — status notes go stale the moment a parallel PR ships the feature, and pruning them is a recurring merge-conflict source. (Same principle as design docs: a merged doc describes the accepted state.) Existing status notes are being removed opportunistically; do not add new ones.
- **Prefer bullets over numbered lists** anywhere a step might later be inserted — renumbering turns a one-line insertion into a whole-list conflict.
- **One fact per line.** Keep list items self-contained; do not reflow neighboring lines when editing one item.
- **Add at a stable position.** When list order carries no meaning, append or keep the list alphabetized instead of inserting mid-list.
- **Search for an existing entry before adding one.** Parallel PRs have produced duplicate bullets for the same label; extend the existing entry instead of adding a twin.
