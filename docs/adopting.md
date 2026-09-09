# Adopting the agentic-development-workflow components

This guide explains how an external repository adopts each published component
of the agentic-development-workflow — the Terraform modules that configure repo
settings and the reusable GitHub Actions workflows that drive the agent SDLC.

> **Source repo:** `mfrancza/agentic-development-workflow`
> **Component reference tag:** `@v0` (or a pinned exact tag — see [Version pinning](#version-pinning))

---

## Quick-start checklist

Complete these steps in order before wiring up any reusable workflows.

1. **Verify a release exists.** Check that at least one `v*` tag exists on the
   source repo (`gh api repos/mfrancza/agentic-development-workflow/tags --jq '.[].name'`).
   The published container images (`developer:v0`, `reviewer:v0`) and the
   reusable workflow refs (`@v0`) only resolve once a release tag has been
   pushed and the release-images workflow has published the images to GHCR.
2. **Create your repository** (public recommended — the security module requires
   Dependabot, and secret scanning/push protection from the `security_and_analysis`
   block require a public repo or a GitHub Advanced Security licence).
3. **Create the GitHub Apps.** Follow the [Manual GitHub App setup](#github-app-identities)
   steps below.  Note the **Client ID** (e.g. `Iv23.xxx`) for each App — this is
   distinct from the numeric App ID on the same settings page.
4. **Find your bot identities.** Each App's bot login is the App's name in
   lowercase with spaces replaced by hyphens, followed by `[bot]` — e.g. an App
   named `my-developer-agent` gets the login `my-developer-agent[bot]`. You must
   add these to `AGENT_ALLOWLIST` so agents can apply `agent:*` labels. The exact
   slug is shown in the first comment posted by the bot after installation.
5. **Install each App on your repository** (App settings → Install App).
6. **Set repository secrets** — see [Secrets](#secrets). You only need to set the
   LLM API keys for the providers you actually use; the agent container validates
   at runtime that the key for the selected model is present.
7. **Run Terraform.** Initialize and apply the modules you need. On a fresh
   repo, import the three GitHub-default labels first (see [Importing
   pre-existing labels](#importing-pre-existing-labels)).
8. **Add caller-stub workflow files** — copy the relevant stubs from
   [Reusable workflows](#reusable-workflows) below into `.github/workflows/`.
9. **Apply manual settings** — see [Manual repository settings](#manual-repository-settings)
   (fork-PR approval policy and interaction limit). Apply these after the repo is public.

---

## Table of contents

- [Quick-start checklist](#quick-start-checklist)
- [Choosing which components to adopt](#choosing-which-components-to-adopt)
- [Common prerequisites](#common-prerequisites)
- [Version pinning](#version-pinning)
- [Terraform modules](#terraform-modules)
  - [labels](#labels-module)
  - [agent-vars](#agent-vars-module)
  - [branch-protection](#branch-protection-module)
  - [actions-policy](#actions-policy-module)
  - [security](#security-module)
- [Reusable workflows](#reusable-workflows)
  - [agent-groom](#agent-groom-reusable-workflow)
  - [agent-design](#agent-design-reusable-workflow)
  - [agent-implement](#agent-implement-reusable-workflow)
  - [agent-review](#agent-review-reusable-workflow)
  - [agent-respond-review](#agent-respond-review-reusable-workflow)
  - [agent-fix-checks](#agent-fix-checks-reusable-workflow)
  - [agent-fix-deployment](#agent-fix-deployment-reusable-workflow)
  - [agent-resolve-conflicts](#agent-resolve-conflicts-reusable-workflow)
  - [agent-pr-merged](#agent-pr-merged-reusable-workflow)
  - [agent-auto-trigger](#agent-auto-trigger-reusable-workflow)
  - [ci](#ci-reusable-workflow)
  - [secret-scan](#secret-scan-reusable-workflow)
- [Manual repository settings](#manual-repository-settings)
- [Adoption gotchas and troubleshooting](#adoption-gotchas-and-troubleshooting)

---

## Choosing which components to adopt

Each component is independently adoptable. Pick the profile closest to your
needs and install only those pieces — you can always layer on more later.

### Labels-only

Install the labels that the workflow system reads (agent triggers, model
overrides, grooming labels, lifecycle labels) without wiring up any agents.
Useful for repos that manage their own workflow YAML but want a consistent
label taxonomy.

**Checklist:**

- [ ] [`labels` Terraform module](#labels-module)

---

### Grooming only

Classify incoming issues and surface clarifying questions via the grooming
agent. No implementation, review, or CI integration.

**Checklist:**

- [ ] [`labels` Terraform module](#labels-module)
- [ ] [`agent-vars` Terraform module](#agent-vars-module) (sets `AGENT_ALLOWLIST`, `DEFAULT_MODEL`)
- [ ] GitHub App: **developer-agent** (see [Common prerequisites](#common-prerequisites))
- [ ] Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`
- [ ] [`agent-groom` reusable workflow](#agent-groom-reusable-workflow)

---

### Review only

Add an AI reviewer that posts structured code reviews on pull requests and
resolves threads it marks addressed.

**Checklist:**

- [ ] [`labels` Terraform module](#labels-module)
- [ ] [`agent-vars` Terraform module](#agent-vars-module)
- [ ] GitHub App: **reviewer-agent** (see [Common prerequisites](#common-prerequisites))
- [ ] Secrets: `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`
- [ ] [`agent-review` reusable workflow](#agent-review-reusable-workflow)
- [ ] (Optional) [`agent-respond-review` reusable workflow](#agent-respond-review-reusable-workflow) — if you also use the developer agent and want it to respond to reviewer feedback

---

### Full pipeline

Issue → groom → (design →) implement → CI → review → respond → merge → deploy.
Every component.

**Checklist:**

- [ ] [`labels` Terraform module](#labels-module)
- [ ] [`agent-vars` Terraform module](#agent-vars-module)
- [ ] [`branch-protection` Terraform module](#branch-protection-module)
- [ ] [`actions-policy` Terraform module](#actions-policy-module)
- [ ] [`security` Terraform module](#security-module)
- [ ] GitHub Apps: **developer-agent** and **reviewer-agent** (see [Common prerequisites](#common-prerequisites))
- [ ] All secrets (see [Common prerequisites](#common-prerequisites))
- [ ] All reusable workflows (see [Reusable workflows](#reusable-workflows))
- [ ] [Manual repository settings](#manual-repository-settings)

---

## Common prerequisites

### GitHub App identities

Two GitHub App identities are required for the full pipeline (subsets need only
the App(s) relevant to their profile). Create them once in **Settings →
Developer settings → GitHub Apps → New GitHub App**.

**developer-agent**

- Repository permissions: Contents (R/W), Issues (R/W), Pull requests (R/W),
  Workflows (R/W), Metadata (R), Checks (R), Deployments (R)
- Subscribe to events: Issues, Pull request, Pull request review, Check run,
  Deployment status
- Webhook: **uncheck "Active"** — this project uses `workflow_dispatch` not
  webhooks.
- After creation: note the **Client ID** (`Iv23.xxx` string from the App's
  General settings — **not** the numeric App ID) and download a private key
  (`.pem`).
- Install the App on your repository: sidebar → **Install App** → **Install**
  next to your username → **Only select repositories** → pick your repo.

**reviewer-agent**

- Repository permissions: Contents (R), Issues (R/W), Pull requests (R/W),
  Metadata (R), Checks (R)
- Subscribe to events: Pull request, Pull request review, Issue comment
- Webhook: **uncheck "Active"**
- After creation: note the **Client ID** and download a private key.
- Install the App on your repository (same steps as above).

> **Note on the Client ID:** Despite the `_APP_ID` suffix used in secret
> names, these secrets hold the GitHub App **Client ID** (the `Iv23.xxx`
> string visible in the App's General settings) — not the numeric "App ID"
> shown on the same page. The Client ID is what
> `actions/create-github-app-token` expects as its `client-id` input.

### Secrets

Set these as repository Actions secrets (`gh secret set …` or the GitHub UI):

```bash
# Developer-agent (required for all developer-agent workflows)
gh secret set DEVELOPER_APP_ID          --body "<developer Client ID>"
gh secret set DEVELOPER_APP_PRIVATE_KEY < developer-agent.pem

# Reviewer-agent (required for agent-review)
gh secret set REVIEWER_APP_ID           --body "<reviewer Client ID>"
gh secret set REVIEWER_APP_PRIVATE_KEY  < reviewer-agent.pem

# LLM provider keys — set only the ones you use.
# The agent container validates at runtime that the key for the selected model
# is present, so unused providers do not need placeholder values.
gh secret set ANTHROPIC_API_KEY         --body "<key>"   # required for Anthropic models (Claude)
gh secret set OPENAI_API_KEY            --body "<key>"   # required for OpenAI models (e.g. o3, gpt-5)
gh secret set XAI_API_KEY              --body "<key>"   # required for xAI Grok models
```

> **Which keys do I need?** If your `DEFAULT_MODEL` is `sonnet`, `opus`, or `haiku`
> (or any `claude-*` model), set `ANTHROPIC_API_KEY` only. Set `OPENAI_API_KEY`
> only if you plan to use OpenAI models via `model:o3` labels, and `XAI_API_KEY`
> only for Grok models. The reusable workflows use `secrets: inherit`, so any
> secret not set in your repository is simply absent — the validation happens
> inside the container, not at workflow-dispatch time.

### Terraform provider config

All Terraform modules require the `integrations/github` provider:

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

provider "github" {
  owner = "<your-github-org-or-user>"
  # Authenticate via GITHUB_TOKEN env var (PAT with repo scope)
  # or: token = var.github_token
}
```

### Caller's `github_repository` resource

Modules accept the repository **name** (not the full `owner/name`) as input.
They operate against an existing repository; you own the `github_repository`
resource in your root module (or import it):

```bash
# Import before first apply if the repo already exists
terraform import github_repository.this "<your-repo-name>"
```

---

## Version pinning

Every release of this repo is tagged `v<major>.<minor>.<patch>` (e.g.
`v1.2.3`). A moving tag `v<major>` (e.g. `v1`) is force-updated to point at
the newest release within that major version. Three pinning options are
available:

| Pin | Example reference | Semantics |
|-----|-------------------|-----------|
| Major (recommended) | `@v0` / `?ref=v0` | Tracks patches and minor releases within `v0`; updated automatically on every non-breaking release. |
| Exact | `@v0.0.0` / `?ref=v0.0.0` | Fully reproducible; only update when you choose to. |
| SHA | `@<40-char-sha>` / `?ref=<sha>` | Maximally reproducible; opaque to humans but immune to tag moves. |

**Recommendation:** pin at the major tag (`@v0`) for day-to-day use. Drop to
an exact tag or SHA when you need reproducibility for auditing or when a
breaking major change lands that you are not yet ready to adopt.

Breaking changes (reusable workflow `inputs:`/`secrets:` contract, Terraform
required variables, composite action inputs) always bump the major version.
Backwards-compatible additions bump the minor version. Bug fixes and internal
refactors bump the patch version.

---

## Terraform modules

### `labels` module

**What it does.**  
Pre-provisions all GitHub issue labels consumed by the agentic workflows. Six
groups are managed: `agent:*` trigger labels (`agent:developer`, `agent:groom`,
`agent:design`, `agent:review`); `model:<name>` LLM-override labels covering
Anthropic, OpenAI, and xAI models in three tiers (tier aliases, generic series
tags, and pinned snapshot IDs); per-agent `model:<type>:<name>` overrides;
grooming classification labels (`question`, `bug`, `enhancement`,
`dependency upgrade`, `do`, `plan`); the `human-required` escalation label; and
lifecycle labels (`draft`, `blocked`). Installing this module is the first step
for any adoption profile because every other component reads these labels.

**Prerequisites.**

- A configured `github` provider (see [Common prerequisites](#common-prerequisites)).
- A `github_repository` resource (or imported state) for the target repository.

**Wiring snippet.**

```hcl
module "labels" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/labels?ref=v0"
  repository = github_repository.this.name
}
```

**Variables and outputs.** See [`terraform/modules/labels/README.md`](../terraform/modules/labels/README.md).

**Importing pre-existing labels.** GitHub creates `bug`, `enhancement`, and
`question` on new repos. The `labels` module manages those labels too, so **on
a fresh repository always import the three defaults before the first apply** to
avoid a 422 "already_exists" error:

```bash
REPO="your-repo-name"
terraform import 'module.labels.github_issue_label.automation["bug"]'         "${REPO}:bug"
terraform import 'module.labels.github_issue_label.automation["enhancement"]' "${REPO}:enhancement"
terraform import 'module.labels.github_issue_label.automation["question"]'    "${REPO}:question"
```

---

### `agent-vars` module

**What it does.**  
Creates the five GitHub Actions repository variables that configure all agent
workflow behavior: `AGENT_ALLOWLIST` (JSON array of GitHub usernames and bot
identities that may trigger agent workflows), `DEFAULT_MODEL` (repo-wide
default LLM for all agent containers), `ADMIN_ASSIGNEES` (JSON array of
usernames assigned to escalation issues), `CODE_REVIEWERS` (JSON array of
usernames requested as PR reviewers), and `AUTO_TRIGGER_AGENTS` (JSON object
with per-stage boolean gates: `groom`, `design`, `developer`, `review`). All
workflow `if:` conditions read from these variables, so they decouple runtime
behavior from the YAML.

**Prerequisites.**

- A configured `github` provider.
- A `github_repository` resource for the target repository.
- Include the developer-agent and reviewer-agent bot identities (e.g.
  `<app-slug>[bot]`) in `agent_allowlist` so agents can apply `agent:*` labels
  to hand off work.
- `AUTO_TRIGGER_AGENTS` must always be present in the repository. The guard
  `vars.AUTO_TRIGGER_AGENTS != ''` prevents `fromJSON('')` from throwing at
  runtime. All gates default to `false` — opt in explicitly.

**Wiring snippet.**

```hcl
module "agent_vars" {
  source              = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/agent-vars?ref=v0"
  repository          = github_repository.this.name
  agent_allowlist     = ["your-github-username", "<developer-agent-slug>[bot]", "<reviewer-agent-slug>[bot]"]
  default_model       = "sonnet"
  admin_assignees     = ["your-github-username"]
  code_reviewers      = ["your-github-username"]
  auto_trigger_agents = {
    groom     = false
    design    = false
    developer = false
    review    = false
  }
}
```

**Variables and outputs.** See [`terraform/modules/agent-vars/README.md`](../terraform/modules/agent-vars/README.md).

---

### `branch-protection` module

**What it does.**  
Creates a repository ruleset named `main-protection` that enforces required PR
reviews and prevents direct pushes to the default branch. The policy: one
required approving review (configurable); linear history required; deletion and
force-push blocked; stale reviews dismissed on push. Repository admins can
bypass the review requirement when merging a PR, but **cannot push directly** —
this eliminates the "delete protection → push → reapply" workaround while
letting maintainers resolve impasses without removing protection entirely.

**Prerequisites.**

- A configured `github` provider.
- A `github_repository` resource for the target repository.

**Wiring snippet.**

```hcl
module "branch_protection" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/branch-protection?ref=v0"
  repository = github_repository.this.name
  # required_approving_review_count = 1  # default
}
```

**Variables and outputs.** See [`terraform/modules/branch-protection/README.md`](../terraform/modules/branch-protection/README.md).

---

### `actions-policy` module

**What it does.**  
Configures the repository's GitHub Actions permitted-actions policy to
`"selected"` mode. By default it allows only GitHub-owned actions
(`actions/*`) and rejects verified-creator and third-party actions. Any
non-GitHub action used in a workflow must be added to `patterns_allowed` **and**
pinned to a full 40-character SHA in the workflow YAML — omitting the entry
causes a loud workflow failure, not a silent bypass.

**Prerequisites.**

- A configured `github` provider.
- A `github_repository` resource for the target repository.
- If any workflow calls a non-GitHub action (e.g. a third-party marketplace
  action), list it in `patterns_allowed`.

**Wiring snippet.**

```hcl
module "actions_policy" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/actions-policy?ref=v0"
  repository = github_repository.this.name
  # patterns_allowed = []   # add owner/repo patterns for any non-GitHub-owned actions
}
```

**Variables and outputs.** See [`terraform/modules/actions-policy/README.md`](../terraform/modules/actions-policy/README.md).

---

### `security` module

**What it does.**  
Enables Dependabot vulnerability alerts for the repository. This is
intentionally minimal — the module only manages `github_repository_vulnerability_alerts`.
Secret scanning and push protection live on the `github_repository` resource
itself (a `security_and_analysis` nested block) and must remain in the caller's
root module; copy the snippet from the module README into your
`github_repository` resource to enable them (requires a public repo or a GitHub
Advanced Security licence).

**Prerequisites.**

- A configured `github` provider.
- A `github_repository` resource for the target repository.

**Wiring snippet.**

```hcl
module "security" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/security?ref=v0"
  repository = github_repository.this.name
}
```

To also enable secret scanning and push protection, add to your
`github_repository` resource:

```hcl
resource "github_repository" "this" {
  # ... your other settings ...

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

**Variables and outputs.** See [`terraform/modules/security/README.md`](../terraform/modules/security/README.md).

---

## Reusable workflows

All reusable workflows are called via:

```yaml
uses: mfrancza/agentic-development-workflow/.github/workflows/<name>-reusable.yml@v0
```

Pass `image:` to pull the published agent container image from GHCR — this
skips a `docker build` step that the reusable workflow cannot perform without
the source `docker/` tree in the caller's workspace:

```
image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
image: ghcr.io/mfrancza/agentic-development-workflow/reviewer:v0
```

**Security note on allowlist gating.** Each reusable workflow performs
*operational* preflight checks (skip if a PR already exists, block on open
blockers, etc.) but performs **no sender-allowlist check**. The caller stub is
the security gate: add an `if:` condition that checks
`contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` before
the `uses:` line. The caller stubs in this repo's own `.github/workflows/`
directory are safe references for how to structure those conditions.

---

### `agent-groom` reusable workflow

**What it does.**  
Runs the grooming agent on a GitHub issue. The agent classifies the issue
(applies `bug`, `enhancement`, `question`, `do`, `plan`, or
`dependency upgrade` labels), asks clarifying questions if the issue is
ambiguous, and removes the `agent:groom` routing label on success. Model
selection follows the waterfall: `model:<type>:*` label → generic `model:*`
label → `default-model` input → `vars.DEFAULT_MODEL`.

**Prerequisites.**

- GitHub App: **developer-agent** installed on the repository.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- Actions variables: `AGENT_ALLOWLIST`, `DEFAULT_MODEL` (via `agent-vars`
  module or set manually).
- Labels: all labels managed by the `labels` module.

**Caller stub.**

```yaml
name: agent-groom

on:
  issues:
    types: [labeled]

permissions:
  contents: read

concurrency:
  group: agent-groom-issue-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  groom:
    if: >
      github.event.label.name == 'agent:groom' &&
      github.event.issue.state == 'open' &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-groom-reusable.yml@v0
    with:
      issue-number: ${{ github.event.issue.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
      default-model: ${{ vars.DEFAULT_MODEL }}
      admin-assignees: ${{ vars.ADMIN_ASSIGNEES }}
      logs-retention-days: 30
    secrets: inherit
```

**Trust considerations.** The reusable mints a short-lived developer-agent
installation token using `DEVELOPER_APP_ID` and `DEVELOPER_APP_PRIVATE_KEY`.
The token is scoped to your repository and expires after the workflow step that
uses it. The private key never leaves the runner environment (it is read into
memory by `actions/create-github-app-token` and discarded). The container
receives only the short-lived token, never the private key itself.

---

### `agent-design` reusable workflow

**What it does.**  
Two cooperating jobs in one reusable, activated by separate boolean flags:

- **`design` job** (`run-design: true`): Runs the designer agent on a complex
  issue. The agent produces a design document on a `design/issue-<N>` branch,
  opens a draft PR, and creates sub-issues labeled `draft`. Preflight checks
  skip if a design PR already exists and fail loudly if open blockers are
  found.

- **`undraft-sub-issues` job** (`run-undraft: true`): When a
  `design/issue-<N>` PR merges, removes the `draft` label from every
  sub-issue of the parent issue, unblocking them for implementation. This job
  deliberately has **no checkout step** (security decision: a merged PR that
  modifies `.github/actions/agent-token` could execute the modified code with
  the App private key in scope if a checkout were present).

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`. `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY` are required only for the `design` job.
- Actions variables: `AGENT_ALLOWLIST`, `DEFAULT_MODEL`.
- Labels: all labels from the `labels` module.

**Caller stub.**

```yaml
name: agent-design

on:
  issues:
    types: [labeled]
  pull_request:
    types: [closed]

permissions:
  contents: read

jobs:
  call-design:
    if: >
      github.event.label.name == 'agent:design' &&
      github.event.issue.state == 'open' &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)
    concurrency:
      group: agent-design-issue-${{ github.event.issue.number }}
      cancel-in-progress: false
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-design-reusable.yml@v0
    with:
      run-design: true
      issue-number: ${{ github.event.issue.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
      default-model: ${{ vars.DEFAULT_MODEL }}
      logs-retention-days: 30
    secrets: inherit

  call-undraft:
    if: >
      github.event.pull_request.merged == true &&
      startsWith(github.event.pull_request.head.ref, 'design/issue-') &&
      github.event.pull_request.head.repo.full_name == github.repository
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-design-reusable.yml@v0
    with:
      run-undraft: true
      pr-head-ref: ${{ github.event.pull_request.head.ref }}
      repo: ${{ github.repository }}
    secrets: inherit
```

**Trust considerations.** Same as `agent-groom`: short-lived token minted from
the App private key; key never enters the container. The `undraft-sub-issues`
path uses `actions/create-github-app-token` directly (pinned SHA, no checkout)
to avoid executing locally-checked-out code during a `pull_request.closed`
event — a permanently preserved security decision.

---

### `agent-implement` reusable workflow

**What it does.**  
Runs the developer agent to implement a GitHub issue. The agent creates an
`agent/issue-<N>` branch, implements the solution, and opens a pull request
with a `Closes #N` reference. Operational preflight checks skip if a PR
already exists for the branch, skip if the issue is labeled `draft`, and fail
loudly if open blockers are present. `CODE_REVIEWERS` (JSON array of usernames)
is forwarded to the container so the agent can request human review on the PR.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- Actions variables: `AGENT_ALLOWLIST`, `DEFAULT_MODEL`, `CODE_REVIEWERS`.
- Labels: all labels from the `labels` module.

**Caller stub.**

```yaml
name: agent-implement

on:
  issues:
    types: [labeled]

permissions:
  contents: read

concurrency:
  group: agent-implement-issue-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  implement:
    if: >
      github.event.label.name == 'agent:developer' &&
      github.event.issue.state == 'open' &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-implement-reusable.yml@v0
    with:
      issue-number: ${{ github.event.issue.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
      default-model: ${{ vars.DEFAULT_MODEL }}
      code-reviewers: ${{ vars.CODE_REVIEWERS }}
      logs-retention-days: 30
    secrets: inherit
```

**Trust considerations.** The developer-agent token has Contents (R/W) and
Workflows (R/W) to push branches and open PRs. The workflow runs on
`issues.labeled` (not `pull_request`), so PR-authored code does not execute
with write credentials in scope.

---

### `agent-review` reusable workflow

**What it does.**  
Runs the reviewer agent on a specific pull request. The reviewer agent reads
the PR diff and open review threads, posts a structured code review, and
records the GraphQL IDs of any threads it marks as addressed. The reusable
workflow then resolves those threads using the `GITHUB_TOKEN` (which has
`pull-requests: write`) — the reviewer App token is deliberately content
read-only so the container cannot commit or push.

**Prerequisites.**

- GitHub App: **reviewer-agent**.
- Secrets: `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- Actions variables: `AGENT_ALLOWLIST`, `DEFAULT_MODEL`.
- Labels: `agent:review` from the `labels` module.
- **The caller MUST use `pull_request_target`** (not `pull_request`). This
  ensures the workflow YAML and build context are always loaded from the base
  branch, never from the PR head, preventing a PR-authored Dockerfile or
  action from executing with the reviewer App private key in scope.

**Caller stub.**

```yaml
name: agent-review

on:
  pull_request_target:
    types: [labeled, synchronize]

permissions: {}

concurrency:
  group: agent-review-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  review:
    # Exclude fork-headed PRs on both event paths.
    if: >
      github.event.pull_request.state == 'open' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      (
        (github.event.action == 'labeled' &&
         github.event.label.name == 'agent:review' &&
         contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)) ||
        (github.event.action == 'synchronize' &&
         contains(github.event.pull_request.labels.*.name, 'agent:review'))
      )
    permissions:
      contents: write
      pull-requests: write
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-review-reusable.yml@v0
    with:
      pr-number: ${{ github.event.pull_request.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/reviewer:v0
      default-model: ${{ vars.DEFAULT_MODEL }}
      logs-retention-days: 30
    secrets: inherit
```

**Trust considerations.** The reviewer App token has Contents (R) only — the
agent cannot push, create branches, or merge. Thread resolution uses the
caller's `GITHUB_TOKEN` (never passed into the container). The mandatory
`pull_request_target` trigger and the same-repo
(`head.repo.full_name == github.repository`) guard together prevent fork PR
authors from running the reviewer agent with secrets in scope. Fork
contributors can request review by asking a repo member to open a same-repo
branch from the fork's changes.

---

### `agent-respond-review` reusable workflow

**What it does.**  
Responds to a submitted pull request review by running the developer agent to
address feedback and push updated commits. The reusable first checks whether
there is actionable feedback (skips on closed/merged PRs, on approvals with
zero unresolved threads, and on bare approvals with no body and no inline
comments) before spending an Anthropic API call.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- Actions variables: `AGENT_ALLOWLIST`.

**Caller stub.**

```yaml
name: agent-respond-review

on:
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: agent-respond-review-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  respond-review:
    # Gate on PR author (developer-agent bot) AND review author (trusted actor).
    # Adjust the PR-author login to match your developer-agent App slug.
    if: >
      github.event.pull_request.user.login == '<developer-agent-slug>[bot]' &&
      (
        contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.review.user.login) ||
        github.event.review.user.login == '<reviewer-agent-slug>[bot]'
      )
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-respond-review-reusable.yml@v0
    with:
      pr-number: ${{ github.event.pull_request.number }}
      review-state: ${{ github.event.review.state }}
      review-body: ${{ github.event.review.body }}
      review-id: ${{ github.event.review.id }}
      repo-name: ${{ github.event.repository.name }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
    secrets: inherit
```

> **Adapt the `if:` condition.** Replace `<developer-agent-slug>[bot]` and
> `<reviewer-agent-slug>[bot]` with your actual App slugs. The review-author
> gate prevents outside actors from driving prompt injection against the
> developer agent on public repos.

**Trust considerations.** The developer-agent token has Contents (R/W) and
Workflows (R/W) to push the response commits. The review body and inline
comments are attacker-controlled text that flows into a Claude prompt; the
review-author gate limits the prompt injection surface to actors you trust.

---

### `agent-fix-checks` reusable workflow

**What it does.**  
Responds to a CI failure on a developer-agent–authored PR by re-invoking the
developer agent with `AGENT_ACTION=fix-checks`. The reusable first verifies
that the PR is authored by the developer-agent bot — it never runs for
human-authored PRs. The CI workflow name that triggers this must be listed in
the caller's `workflow_run.workflows:` filter.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- A CI workflow named (for example) `"CI"` in your repository. The name must
  match the `workflows:` list in the caller stub.

**Caller stub.**

```yaml
name: agent-fix-checks

on:
  workflow_run:
    workflows: ["CI"]   # must match your CI workflow's `name:` field exactly
    types: [completed]

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: agent-fix-checks-pr-${{ github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.id }}
  cancel-in-progress: false

jobs:
  fix-checks:
    if: >
      github.event.workflow_run.conclusion == 'failure' &&
      github.event.workflow_run.pull_requests[0] != null
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-fix-checks-reusable.yml@v0
    with:
      pr-number: ${{ github.event.workflow_run.pull_requests[0].number }}
      agent-login: <developer-agent-slug>[bot]
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
    secrets: inherit
```

> **Adapt `agent-login`** to your developer-agent App's bot login (e.g.
> `acme-developer-agent[bot]`). The reusable uses this login to filter PRs —
> it only runs for PRs authored by the developer-agent bot.

**Trust considerations.** This workflow runs on `workflow_run` (not
`pull_request`), so it has access to secrets regardless of fork origin.
The developer-agent bot–author filter is the critical security gate — it
prevents a PR author from spending Anthropic credits by forcing CI failures.

---

### `agent-fix-deployment` reusable workflow

**What it does.**  
Responds to a deployment failure by resolving the failed deployment SHA to the
originating issue number (parsed from the merged PR's `Closes #N` reference),
then running the developer agent with `AGENT_ACTION=fix-deployment`. The
reusable skips cleanly if the SHA cannot be mapped to a PR containing a
`Closes #N` reference.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- A deployment pipeline that emits `deployment_status` events (any GitHub
  deployment — GitHub Actions environments, third-party integrations, etc.).

**Caller stub.**

```yaml
name: agent-fix-deployment

on:
  deployment_status:

permissions:
  contents: read
  actions: read
  pull-requests: read

concurrency:
  group: agent-fix-deployment-${{ github.event.deployment.sha }}
  cancel-in-progress: false

jobs:
  fix-deployment:
    if: >
      github.event.deployment_status.state == 'failure' ||
      github.event.deployment_status.state == 'error'
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-fix-deployment-reusable.yml@v0
    with:
      deployment-sha: ${{ github.event.deployment.sha }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
    secrets: inherit
```

**Trust considerations.** The reusable requires `actions: read` (to list
workflow runs) and `pull-requests: read` (to find the PR that produced the
deployment). The developer-agent token has Contents (R/W) and Workflows (R/W)
to open a fix-up PR. Deployment status events are not user-triggered, so
there is no prompt injection surface analogous to review comments.

---

### `agent-resolve-conflicts` reusable workflow

**What it does.**  
Finds all open developer-agent PRs in a `CONFLICTING` mergeability state and
resolves them in parallel matrix jobs. If a specific `pr-number` is provided
(via `workflow_dispatch`), skips the enumeration and resolves only that PR.
If the agent cannot resolve a conflict confidently, it aborts, applies
`human-required`, and posts a comment naming the conflicting files.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- Actions variables: `AGENT_ALLOWLIST` (identifies the developer-agent bot
  identity used to find PRs authored by the agent).

**Caller stub.**

```yaml
name: agent-resolve-conflicts

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to resolve (skips conflict enumeration)'
        required: false

permissions:
  contents: read
  pull-requests: read

jobs:
  resolve-conflicts:
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-resolve-conflicts-reusable.yml@v0
    with:
      pr-number: ${{ inputs.pr_number || '' }}
      escalation-assignee: ${{ github.repository_owner }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
    secrets: inherit
```

**Trust considerations.** The developer-agent token has Contents (R/W) and
Workflows (R/W) to push resolution commits. The workflow triggers on `push` to
`main` (a trusted branch) and on `workflow_dispatch` (also trusted), so
untrusted PR code is never in scope.

---

### `agent-pr-merged` reusable workflow

**What it does.**  
When a developer-agent PR is merged or closed, removes the `agent:developer`
label from the linked issue (extracted from the PR body's `Closes #N`
reference). This prevents the routing label from accumulating on closed issues
and prevents `auto-trigger` from re-firing if someone re-opens the issue
without re-applying the label. The reusable also handles the case where the
label is already absent (benign no-op) vs. a real API failure (fails loudly).

This reusable has **no checkout step** (a permanent security decision): on
`pull_request.closed`, a merged PR modifying `.github/actions/agent-token`
could execute the modified composite action with `DEVELOPER_APP_PRIVATE_KEY`
in scope if a checkout were present.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`.

**Caller stub.**

```yaml
name: agent-pr-merged

on:
  pull_request:
    types: [closed]

permissions:
  contents: read

concurrency:
  group: agent-pr-merged-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  extract-issue-number:
    # Only act on PRs authored by the developer-agent bot.
    # Adjust the login to match your App's bot identity.
    if: github.event.pull_request.user.login == '<developer-agent-slug>[bot]'
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    outputs:
      proceed: ${{ steps.lookup.outputs.proceed }}
      issue_number: ${{ steps.lookup.outputs.issue_number }}
    steps:
      - name: Extract linked issue number from PR body
        id: lookup
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: |
          set -euo pipefail
          ISSUE_NUM="$(printf '%s' "$PR_BODY" | grep -oiE 'closes #[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
          if [ -z "${ISSUE_NUM:-}" ]; then
            echo "proceed=false" >> "$GITHUB_OUTPUT"
          else
            ISSUE_NUM="$(printf '%s' "$ISSUE_NUM" | tr -d '\r\n')"
            echo "proceed=true" >> "$GITHUB_OUTPUT"
            echo "issue_number=${ISSUE_NUM}" >> "$GITHUB_OUTPUT"
          fi

  remove-developer-label:
    needs: extract-issue-number
    if: needs.extract-issue-number.outputs.proceed == 'true'
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-pr-merged-reusable.yml@v0
    with:
      issue-number: ${{ needs.extract-issue-number.outputs.issue_number }}
    secrets: inherit
```

> **Adapt the `if:` condition.** Replace `<developer-agent-slug>[bot]` with
> your developer-agent App's bot login. The issue-number extraction must happen
> in the caller (not the reusable) because `github.event.pull_request.body` is
> only available to the calling workflow — reusable workflows receive the
> `workflow_call` event, not the original `pull_request` event.

**Trust considerations.** The developer-agent token has only Issues (R/W) — it
removes the label and nothing else. The no-checkout design means no
PR-authored code can influence this step.

---

### `agent-auto-trigger` reusable workflow

**What it does.**  
Applies the next-stage `agent:*` label at each SDLC transition, gated on the
per-stage boolean switches in `vars.AUTO_TRIGGER_AGENTS`. Six transitions are
supported (all opt-in, all default to `false`):

| Transition | Trigger | Action |
|---|---|---|
| `auto-groom` | `issues.opened` | Applies `agent:groom` |
| `auto-design` | `issues.labeled` (`plan`) | Applies `agent:design` |
| `auto-developer-do` | `issues.labeled` (`do`) | Applies `agent:developer` (or `blocked` if open blockers) |
| `auto-developer-undraft` | `issues.unlabeled` (`draft`) | Applies `agent:developer` (or `blocked`) |
| `auto-review` | `pull_request.opened` on `agent/…` or `design/…` | Applies `agent:review` |
| `auto-developer-unblock` | `issues.closed` | Applies `agent:developer` on newly-unblocked downstream issues |

No agent container runs in this workflow — each job only mints an App token
and applies a label.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`.
- Actions variables: `AGENT_ALLOWLIST`, `AUTO_TRIGGER_AGENTS` (managed by the
  `agent-vars` module). `AUTO_TRIGGER_AGENTS` must always be present (even if
  all gates are `false`) to avoid `fromJSON('')` runtime errors.

**Caller stub.**

```yaml
name: agent-auto-trigger

on:
  issues:
    types: [opened, labeled, unlabeled, closed]
  pull_request:
    types: [opened]

permissions:
  contents: read

jobs:
  auto-groom:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'opened' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).groom == true &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login) &&
      !contains(github.event.issue.labels.*.name, 'draft')
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@v0
    with:
      transition: auto-groom
      issue-number: ${{ github.event.issue.number }}
    secrets: inherit

  auto-design:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'labeled' &&
      github.event.label.name == 'plan' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).design == true &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@v0
    with:
      transition: auto-design
      issue-number: ${{ github.event.issue.number }}
    secrets: inherit

  auto-developer-do:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'labeled' &&
      github.event.label.name == 'do' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login) &&
      !contains(github.event.issue.labels.*.name, 'draft')
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@v0
    with:
      transition: auto-developer-do
      issue-number: ${{ github.event.issue.number }}
    secrets: inherit

  auto-developer-undraft:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'unlabeled' &&
      github.event.label.name == 'draft' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@v0
    with:
      transition: auto-developer-undraft
      issue-number: ${{ github.event.issue.number }}
    secrets: inherit

  auto-review:
    if: >
      github.event_name == 'pull_request' &&
      github.event.action == 'opened' &&
      (startsWith(github.event.pull_request.head.ref, 'agent/') ||
       startsWith(github.event.pull_request.head.ref, 'design/')) &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).review == true
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@v0
    with:
      transition: auto-review
      pr-number: ${{ github.event.pull_request.number }}
    secrets: inherit

  auto-developer-unblock:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'closed' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true &&
      contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@v0
    with:
      transition: auto-developer-unblock
      issue-number: ${{ github.event.issue.number }}
    secrets: inherit
```

**Trust considerations.** Each transition mints a short-lived developer-agent
token solely to write labels — no container is run, no code is compiled.
The `auto-review` transition deliberately has no checkout step (the
`agent-auto-trigger-reusable.yml` uses `actions/create-github-app-token`
directly) to avoid executing locally-checked-out composite actions with the
private key in scope on `pull_request.opened` events.

---

### `ci` reusable workflow

**What it does.**  
Runs the CI gate for the `.github/scripts/` TypeScript package that backs all
composite actions: `npm ci`, `npm run typecheck` (`tsc --noEmit`), and
`npm test` (vitest). Also lints composite action `action.yml` files for
input-key hygiene (no dashes in `INPUT_*` env keys; no template expressions
in descriptions) and smoke-tests each TypeScript entry point for module
resolution errors. If you copy the `.github/scripts/` package and composite
actions into your repo, adopt this reusable to keep the package's CI healthy.

**Prerequisites.** None beyond a configured repository. No secrets required.

**Caller stub.**

```yaml
name: CI

on:
  pull_request:

permissions:
  contents: read

jobs:
  ci:
    uses: mfrancza/agentic-development-workflow/.github/workflows/ci-reusable.yml@v0
```

**Trust considerations.** No secrets are used; the workflow only reads
repository contents.

---

### `secret-scan` reusable workflow

**What it does.**  
Full-history secret scan using [gitleaks](https://github.com/gitleaks/gitleaks).
Checks out the full git history (`fetch-depth: 0`), downloads and SHA-256-verifies
a pinned gitleaks release, and runs `gitleaks git --log-opts="--all"` across all
refs. The JSON report is uploaded as an artifact for audit. Known false positives
can be silenced by adding fingerprints to a `.gitleaksignore` file at the repo
root.

**Prerequisites.** None beyond a configured repository. No secrets required.

**Caller stub.**

```yaml
name: secret-scan

on:
  push:
    branches: ['**']
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Weekly, Mondays at 06:00 UTC
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: secret-scan-${{ github.workflow }}-${{ github.ref_name }}-${{ github.event_name }}
  cancel-in-progress: true

jobs:
  scan:
    uses: mfrancza/agentic-development-workflow/.github/workflows/secret-scan-reusable.yml@v0
    # Optional: override the gitleaks version and its SHA-256 checksum
    # with:
    #   gitleaks-version: '8.28.0'
    #   gitleaks-sha256: 'a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb'
```

**Trust considerations.** No secrets are used. The gitleaks binary is
SHA-256-verified before execution to prevent tampered releases from entering CI.

---

## Manual repository settings

The following settings cannot be managed by Terraform and must be applied
manually by a maintainer with admin credentials. These are the same settings
documented in `AGENTS.md` for this repo; consumer repos must apply them
independently.

### Fork-PR approval policy

GitHub does not expose the fork-PR approval endpoint via the Terraform
`integrations/github` provider (as of v6). Set this in the GitHub UI after
the repository is public:

> **Settings → Actions → General → Fork pull request workflows from outside
> collaborators → "Require approval for all outside collaborators"** (the
> strictest option)

This ensures that workflow runs triggered by fork PRs from users without write
access require explicit maintainer approval before running — preventing
untrusted code from executing with secrets in scope.

### Interaction limit

Restrict who can open issues and PRs to collaborators only. On a public repo,
apply using the GitHub API:

```bash
gh api -X PUT repos/<owner>/<repo>/interaction-limits \
  -f limit=collaborators_only \
  -f expiry=six_months
```

This setting expires after six months; re-apply it before expiry. On this
source repo the renewal is tracked by a reminder-issue workflow; for your repo,
set a calendar reminder or create a similar automation.

> Both settings are intentionally outside Terraform because: (a) no
> `administration:write` token is held by any identity in the Actions
> environment, and (b) applying them prematurely on a private repo can cause
> errors or no-ops. Apply them at or after the time you make the repository
> public.

---

## Adoption gotchas and troubleshooting

Issues discovered during end-to-end adoption testing. Each entry describes
a symptom, the root cause, and the fix.

### Images and workflow refs not found

**Symptom:** `docker pull` fails with "manifest unknown" or `uses:
mfrancza/agentic-development-workflow/...@v0` fails with "ref not found".

**Cause:** The `v0` and `v0.x.x` tags on the source repo have not been created
yet, or the container images have not been published to GHCR for that tag.
The `release` workflow (triggered manually by the maintainer via
`workflow_dispatch`) creates the tags; the `release-images` workflow publishes
the container images automatically when a `v*` tag is pushed.

**Fix:** Check whether a release tag exists:
```bash
gh api repos/mfrancza/agentic-development-workflow/tags --jq '.[].name'
```
If no tags are listed, a release has not been created yet. Contact the source
repo maintainer or pin to a commit SHA instead.

If tags exist but `docker pull` still returns "manifest unknown", the
`release-images` workflow may not have fired automatically — see the next
gotcha.

---

### release-images workflow does not fire after release.yml dispatch

**Symptom:** Tags `v<M>.<m>.<p>` and `v<M>` exist on the source repo (confirmed
via `gh api repos/mfrancza/agentic-development-workflow/tags --jq '.[].name'`)
but the four container images (`developer:v<M>.<m>.<p>`, `developer:v<M>`,
`reviewer:v<M>.<m>.<p>`, `reviewer:v<M>`) do not exist on GHCR — `docker pull`
returns "manifest unknown" and `gh run list --workflow release-images.yml` shows
zero runs for the tag.

**Cause:** `release.yml` pushes the version and moving-major tags using
`secrets.GITHUB_TOKEN`. GitHub intentionally does not trigger subsequent
workflow runs from events sourced by `GITHUB_TOKEN` (to prevent infinite
loops). The `push: tags: 'v*'` trigger in `release-images.yml` therefore
never fires when `release.yml` is the one pushing the tags.

This was observed at the initial v0.0.0 release (2026-09-07, issue #454).

**Fix:** Manually dispatch `release-images.yml` using its `workflow_dispatch`
trigger (which accepts an optional `tag` input for exactly this scenario):

```bash
gh workflow run release-images.yml \
  --repo mfrancza/agentic-development-workflow \
  -f tag=v<M>.<m>.<p>
```

Or use the Actions UI: Actions → release-images → Run workflow → enter the
version tag (e.g. `v0.0.0`).

After the run completes, verify unauthenticated pullability for all four tags
(see [GHCR image pull fails in workflow](#ghcr-image-pull-fails-in-workflow) for the visibility-flip fix if packages land as private).

---

### Agent:groom / agent:developer workflow skips silently

**Symptom:** You apply the `agent:groom` or `agent:developer` label but no
workflow run appears (or runs appear as skipped with no error message).

**Cause A — Sender not in allowlist.** The workflow gates on
`contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)`. If the
label was applied by a user whose login is not in `AGENT_ALLOWLIST`, the job
skips silently.

**Fix A:** Add the labeler's GitHub login to `agent_allowlist` in Terraform and
re-apply.

**Cause B — Bot identity missing from allowlist.** If you enable
`auto_trigger_agents.groom = true`, the auto-trigger workflow applies the label
using the developer-agent bot identity (e.g.
`my-developer-agent[bot]`). If that bot identity is not in `AGENT_ALLOWLIST`,
the downstream groom workflow silently skips.

**Fix B:** Add the bot identity to `agent_allowlist`. Finding the exact slug:
look at the first comment posted by the bot after App installation — the login
shown there (e.g. `my-developer-agent[bot]`) is what to add.

---

### Terraform apply fails with 422 "already_exists" on labels

**Symptom:** `terraform apply` errors with a 422 response for `bug`,
`enhancement`, or `question` labels.

**Cause:** GitHub pre-creates these three labels on every new repository. The
Terraform `labels` module tries to create them again and fails.

**Fix:** Import the pre-existing labels before the first apply:
```bash
REPO="your-repo-name"
terraform import 'module.labels.github_issue_label.automation["bug"]'         "${REPO}:bug"
terraform import 'module.labels.github_issue_label.automation["enhancement"]' "${REPO}:enhancement"
terraform import 'module.labels.github_issue_label.automation["question"]'    "${REPO}:question"
```
Then re-run `terraform apply`.

---

### App Client ID vs. App ID confusion

**Symptom:** `actions/create-github-app-token` fails with "could not parse
private key" or "client_id is invalid".

**Cause:** The `DEVELOPER_APP_ID` and `REVIEWER_APP_ID` secrets must contain
the **Client ID** (the `Iv23.xxx` string shown in the App's General settings
page), not the numeric **App ID** shown just above it. These are two different
identifiers on the same settings page.

**Fix:** In your GitHub App settings (Settings → Developer settings → GitHub
Apps → your app → General), copy the value labeled **Client ID** (format:
`Iv23.XXXXXXXXXXXXXXXX`) into the secret — not the six-to-eight-digit numeric
App ID.

---

### Secret scanning / push protection Terraform errors on private repos

**Symptom:** `terraform apply` fails with a 422 error when setting
`secret_scanning.status = "enabled"` or
`secret_scanning_push_protection.status = "enabled"`.

**Cause:** GitHub rejects these settings for private repositories that do not
have GitHub Advanced Security (GHAS). Both features are free only on public
repos.

**Fix:** Either make the repository public before running Terraform, or omit the
`security_and_analysis` block from your `github_repository` resource until the
repo is public. The `security` Terraform module (Dependabot alerts) is safe to
apply on private repos.

---

### GHCR image pull fails in workflow

**Symptom:** `docker pull ghcr.io/mfrancza/agentic-development-workflow/developer:v0`
fails with a 401 or 403 error in the workflow runner.

**Cause:** The image may not be publicly visible. Container images pushed from
a public GitHub repository are public by default, but they can be set to private
via the Packages settings page.

**Fix:** Verify the image is public: navigate to
`https://github.com/mfrancza/agentic-development-workflow/pkgs/container/agentic-development-workflow%2Fdeveloper`
and check the visibility setting. If the source repo is public and the image was
published by the `release-images` workflow, no authentication is needed to pull it.

---

### Helper actions not found when calling a reusable workflow from an external repo

**Symptom:** A job that calls one of the reusable workflows fails early with an
error like:

```
Error: Can't find 'action.yml', 'action.yaml' or 'Dockerfile' under
'./.github/actions/agent-token'. Did you forget to run actions/checkout?
```

or a similar "action not found" message referring to a path under `.github/actions/`.

**Cause:** The v0.0.0 release of the reusable workflows used workspace-relative
action paths (`uses: ./.github/actions/<name>`). When a caller repo invokes a
reusable workflow, GitHub populates `$GITHUB_WORKSPACE` with the **caller's**
repository — not this repo. A workspace-relative reference therefore resolves
against the caller's tree, which does not contain this repo's `.github/actions/`
directory, so every composite-action step fails with "action not found".

This was the root cause reported in issue
[#498](https://github.com/mfrancza/agentic-development-workflow/issues/498) and
fixed in the v0.0.1 patch release. (See
[`docs/design/reusable-workflow-helper-resolution.md`](design/reusable-workflow-helper-resolution.md)
for the full analysis and the chosen fix: each reusable now self-checks out its
own helper actions into a `_agentic-workflow/` subdirectory before any composite
action step runs, keyed to `job.workflow_sha` so the helper version is
always consistent with the reusable workflow version the caller pinned to.)

**Fix:**

- If you pinned to an exact tag, upgrade from `@v0.0.0` to `@v0.0.1` (or `@v0`
  to track future patches automatically). Both the reusable workflow ref and the
  `image:` input should be updated together:

  ```yaml
  uses: mfrancza/agentic-development-workflow/.github/workflows/agent-implement-reusable.yml@v0
  with:
    image: ghcr.io/mfrancza/agentic-development-workflow/developer:v0
  ```

- If you are already on `@v0` (the moving major tag) and you first adopted
  before 2026-09-08, force a re-run — the `v0` tag now points at the v0.0.1
  SHA, so the next workflow run automatically picks up the fix.

**Verification after fixing:** Open a test issue on your consumer repo and apply
`agent:developer`. The workflow should:

1. Complete the "Check out upstream helper actions" step with no error.
2. Mint a developer-agent token (the `agent-token` composite action runs
   successfully).
3. Pass all preflight steps (find-existing-pr, check-draft-label, check-blockers).
4. Run the agent container and open a PR on `agent/issue-<N>`.
5. Upload an `agent-logs-implement-issue-<N>-…` artifact (visible in the
   workflow run's Summary page even on failure, because the upload step uses
   `if: always()`).

If step 1 still fails after upgrading, check that your `uses:` line references
the reusable workflow file (not the caller stub file), and that the `@` ref
resolves to a tag or SHA that exists on the source repo.

---

### `agent-respond-review` stub placeholders

**Symptom:** The `agent-respond-review` caller stub in this guide contains
`<developer-agent-slug>[bot]` and `<reviewer-agent-slug>[bot]` as literal
placeholder text.

**Cause:** These must be replaced with your actual App slugs before the workflow
functions. They cannot be read from Actions variables because they gate the
workflow itself (before any variable lookup).

**Fix:** Replace `<developer-agent-slug>[bot]` and `<reviewer-agent-slug>[bot]`
with the actual bot logins for your Apps (e.g. `my-developer-agent[bot]` and
`my-reviewer-agent[bot]`). The bot login appears in the first comment a bot posts
after installation, or can be confirmed by checking the App's page on GitHub.

---

### `agent-fix-checks` stub placeholder

**Symptom:** The `agent-fix-checks` caller stub contains `<developer-agent-slug>[bot]`
as a literal placeholder.

**Fix:** Replace with your developer-agent App's bot login, the same value used
in the `agent-respond-review` stub.

---

### `terraform-ci-reusable.yml` is not available for external adoption in v0

`terraform-ci-reusable.yml` is **consumer-only** — it is not part of the
externally published surface for v0.  The workflow's `plan` and `apply` jobs
depend on paths specific to this repository's layout (`terraform/`,
`.github/actions/`, `.tool-versions`) and target this repository's dedicated
Terraform GitHub App.  Attempting to call it from an external repository will
fail at the composite-action resolution step.

External repositories that need Terraform CI should copy the workflow and its
helper composite actions directly, or build a bespoke CI workflow.

See [docs/design/reusable-workflow-helper-resolution.md](design/reusable-workflow-helper-resolution.md)
Decision 6 for the rationale.  This restriction may be revisited in a future
release if external demand emerges.
