# Adopting the agentic-development-workflow components

This guide explains how an external repository adopts each published component
of the agentic-development-workflow — the Terraform modules that configure repo
settings and the reusable GitHub Actions workflows that drive the agent SDLC.

> **Source repo:** `mfrancza/agentic-development-workflow`
> **Component reference tag:** an exact release tag, shown as `@vX.Y.Z` in this guide (see [Version pinning](#version-pinning))

---

## Quick-start checklist

Complete these steps in order before wiring up any reusable workflows.

1. **Verify a release exists.** Check that at least one `v*` tag exists on the
   source repo (`gh api repos/mfrancza/agentic-development-workflow/tags --jq '.[].name'`).
   Pick the release you will pin (see [Version pinning](#version-pinning)). Its
   container images (`developer:vX.Y.Z`, `reviewer:vX.Y.Z`) and reusable
   workflow refs (`@vX.Y.Z`) only resolve once that tag has been pushed and the
   release-images workflow has published its images to GHCR.
2. **Create your repository** (public recommended — the security module requires
   Dependabot, and secret scanning/push protection from the `security_and_analysis`
   block require a public repo or a GitHub Advanced Security licence).
3. **Create the GitHub Apps.** Follow the [Manual GitHub App setup](#github-app-identities)
   steps below. Note the **Client ID** (e.g. `Iv23.xxx`) for each App — this is
   distinct from the numeric App ID on the same settings page.
4. **Find your bot identities.** Each App's bot login is the App's name in
   lowercase with spaces replaced by hyphens, followed by `[bot]` — e.g. an App
   named `my-developer-agent` gets the login `my-developer-agent[bot]`. You must
   add these to `AGENT_ALLOWLIST` so agents can apply `agent:*` labels. The exact
   slug is shown in the first comment posted by the bot after installation.
5. **Install each App.** Install developer-agent and reviewer-agent on your repository; install allowlist-resolver on the repository-owning organization when you use team references.
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
  - [Protected approval gate (Terraform)](#protected-approval-gate-terraform)
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
  - [protected-approval-gate](#protected-approval-gate-reusable-workflows)
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
- [ ] GitHub App: **allowlist-resolver** when `AGENT_ALLOWLIST` or `ADMIN_ASSIGNEES` contains an `org/team-slug` reference
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
- [ ] GitHub App: **allowlist-resolver** when `AGENT_ALLOWLIST` contains an `org/team-slug` reference
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
- [ ] GitHub App: **allowlist-resolver** when any agent user list contains an `org/team-slug` reference
- [ ] All secrets (see [Common prerequisites](#common-prerequisites))
- [ ] All reusable workflows (see [Reusable workflows](#reusable-workflows))
- [ ] [Manual repository settings](#manual-repository-settings)

---

## Common prerequisites

### GitHub App identities

Two GitHub App identities are required for the full pipeline (subsets need only
the App(s) relevant to their profile). Add the optional `allowlist-resolver`
App when any agent user list uses a team reference. Create them once in **Settings →
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

**allowlist-resolver** (required only for `org/team-slug` references)

- Organization permissions: Members (R)
- Repository permissions: Metadata (R)
- Subscribe to events: none
- Webhook: **uncheck "Active"**
- Install the App on the organization that owns the repository.
- After creation: note the **Client ID** and download a private key.

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

# Allowlist resolver (required only when an agent user list uses org/team-slug)
gh secret set ALLOWLIST_RESOLVER_APP_ID          --body "<allowlist-resolver Client ID>"
gh secret set ALLOWLIST_RESOLVER_APP_PRIVATE_KEY < allowlist-resolver.pem

# LLM provider keys — set only the ones you use.
# The agent container validates at runtime that the key for the selected model
# is present, so unused providers do not need placeholder values.
gh secret set ANTHROPIC_API_KEY         --body "<key>"   # required for Anthropic models (Claude)
gh secret set OPENAI_API_KEY            --body "<key>"   # required for OpenAI models (e.g. o3, gpt-5)
gh secret set XAI_API_KEY              --body "<key>"   # required for xAI Grok models
```

> **Which keys do I need?** These reusable workflows live in the `mfrancza`
> organization. If your repository is in a **different organization** (or is a
> personal-account repo), `secrets: inherit` does not propagate any secrets
> across the org boundary — the reusable will fail immediately with:
>
> ```
> Secret DEVELOPER_APP_ID is required, but not provided while calling
> ```
>
> The caller stubs in this guide therefore use an explicit `secrets:` block that
> names every secret by name, which works for both same-org and cross-org callers:
>
> ```yaml
> secrets:
>   DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
>   DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
>   ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
>   OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
>   XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
>   ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
>   ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
> ```
>
> **Do not replace the explicit `secrets:` blocks with `secrets: inherit`** — it
> will break for any caller outside the `mfrancza` org.
>
> **Which provider keys do you actually need to set?** Only the key for the
> provider(s) you use. If your `DEFAULT_MODEL` is `sonnet`, `opus`, or `haiku`
> (or any `claude-*` model), set `ANTHROPIC_API_KEY` only. Set `OPENAI_API_KEY`
> only for OpenAI models and `XAI_API_KEY` only for Grok models. The explicit
> `secrets:` block still names all three keys, but
> `${{ secrets.OPENAI_API_KEY }}` evaluates to an empty string when the secret
> is unset — the reusable declares those keys `required: false`, the
> `run-agent` action forwards only the selected model's key into the container
> (the other two never enter the agent's environment), and the container
> validates that the key it received is present.
> Per-reusable required/optional splits are listed in the **Prerequisites**
> section of each reusable below.

**Secrets inventory per reusable** (source of truth: each reusable's own `secrets:` block)

| Reusable                                     | Required secrets                                                | Optional secrets                                                  |
| -------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `agent-auto-trigger-reusable.yml`            | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `agent-design-reusable.yml`                  | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `agent-fix-checks-reusable.yml`              | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`              |
| `agent-fix-deployment-reusable.yml`          | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`              |
| `agent-groom-reusable.yml`                   | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `agent-implement-reusable.yml`               | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `agent-pr-merged-reusable.yml`               | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | —                                                                 |
| `agent-resolve-conflicts-reusable.yml`       | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`              |
| `agent-respond-review-reusable.yml`          | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`                 | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `agent-review-reusable.yml`                  | `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`                   | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `ci-reusable.yml`                            | —                                                               | —                                                                 |
| `protected-approval-gate-reusable.yml`       | —                                                               | `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `protected-approval-gate-sweep-reusable.yml` | —                                                               | `ALLOWLIST_RESOLVER_APP_ID`, `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` |
| `secret-scan-reusable.yml`                   | —                                                               | —                                                                 |
| `terraform-ci-reusable.yml`                  | `TERRAFORM_APP_ID`, `TERRAFORM_APP_PRIVATE_KEY`, `TF_API_TOKEN` | —                                                                 |
| `test-helper-ref-reusable.yml`               | —                                                               | —                                                                 |

> **Note:** `terraform-ci-reusable.yml` is consumer-only for this repo and is not
> part of the externally published adoption surface in v0 — see the
> [adoption gotcha](#terraform-ci-reusable-yml-is-not-available-for-external-adoption-in-v0).

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
`v0.2.1`), and the moving tag `v<major>` (e.g. `v0`) is force-updated to point
at the newest release within that major version. **Pin an exact release tag**
so you upgrade when you choose to, not when a release is published:

| Pin                   | Example reference                 | Semantics                                                                                                                                  |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact (recommended)   | `@v0.2.1` / `?ref=v0.2.1`         | Fixed until you change it. Upgrade by changing the tag in your stubs, `helpers-ref`, image tags and Terraform `?ref=` together.              |
| Major (not advised)   | `@v0` / `?ref=v0`                 | Follows every new release automatically. Before `v1.0.0` that includes breaking changes (see **Pre-1.0 stability**), so a release can break your workflows without warning. |
| SHA                   | `@<40-char-sha>` / `?ref=<sha>`   | Maximally reproducible; opaque to humans but immune to tag moves.                                                                          |

**Examples in this guide use `vX.Y.Z`.** Replace it everywhere with the release
you are adopting, for example `v0.2.1`: in every `uses:` line, every
`helpers-ref:`, every image tag (`ghcr.io/…/developer:vX.Y.Z`) and every
Terraform `?ref=`. To upgrade, read that release's notes for any stub changes,
then change all of them to the new tag in one commit.

**Allow the whole repository in your actions policy, not one version.** Use
wildcard patterns (`…/.github/workflows/*@*` and `…/.github/actions/*@*`; see
the [`actions-policy` module](#actions-policy-module)) so changing your pinned
version never needs a policy change. The wildcard also covers the nested
workflow that `agent-review-reusable.yml` calls at a fixed release of its own.

**`helpers-ref` must match the pinned version.** The reusable workflows accept
a required `helpers-ref` input that must be set to the same selector used in
the `uses:` line. If you pin with `@v0.2.1`, pass `helpers-ref: v0.2.1`; if you
pin with a SHA, pass the same SHA. Mismatched selectors are caught at runtime
before any helper action loads.

Breaking changes (reusable workflow `inputs:`/`secrets:` contract, Terraform
required variables, composite action inputs) always bump the major version.
Backwards-compatible additions bump the minor version. Bug fixes and internal
refactors bump the patch version.

> **Pre-1.0 stability.** That contract applies from `v1.0.0` onward. While the
> project is on `v0.x.y` it is a feedback release: a breaking change to a
> reusable's `inputs:`/`secrets:` contract may land on a **minor** bump (for
> example `v0.1.x` → `v0.2.0`), and the moving `v0` tag picks it up. Each
> such change is called out in the release notes with the stub lines to add.
> This is why an exact tag is the recommended pin.
> See [`docs/design/initial-release.md`](design/initial-release.md), Decision 6.

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
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/labels?ref=vX.Y.Z"
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
workflow behavior: `AGENT_ALLOWLIST` (JSON array of GitHub logins, bot
identities, and same-organization `org/team-slug` references that may trigger
agent workflows), `DEFAULT_MODEL` (repo-wide default LLM for all agent
containers), `ADMIN_ASSIGNEES` (JSON array of GitHub logins or
same-organization `org/team-slug` references assigned to escalation issues),
`CODE_REVIEWERS` (JSON array of GitHub logins or `org/team-slug` references
requested as PR reviewers), and `AUTO_TRIGGER_AGENTS` (JSON object
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
- Team references in `AGENT_ALLOWLIST` are resolved at each triggering event.
- Team references in `ADMIN_ASSIGNEES` are expanded by the groom workflow.
- Team references in `CODE_REVIEWERS` pass through to GitHub for native team review requests.
- Team references require the optional `allowlist-resolver` App credential pair
  (`ALLOWLIST_RESOLVER_APP_ID` and `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY`) with
  organization Members: Read access.
- Without those secrets, allowlist-gated workflows fail closed for team entries.
- Without those secrets, grooming still assigns explicit logins and warns that team entries were skipped.

**Wiring snippet.**

```hcl
module "agent_vars" {
  source              = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/agent-vars?ref=vX.Y.Z"
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
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/branch-protection?ref=vX.Y.Z"
  repository = github_repository.this.name
  # required_approving_review_count = 1  # default
}
```

**Variables and outputs.** See [`terraform/modules/branch-protection/README.md`](../terraform/modules/branch-protection/README.md).

---

### Protected approval gate (Terraform)

The protected-approval gate is opt-in. In your root module's
`terraform.tfvars`, configure the developer App's **login** and enable the
gate:

```hcl
protected_pr_author_logins     = ["<your-developer-app-slug>[bot]"]
enable_protected_approval_gate = true
```

Wire these root-module variables through to both the `agent-vars` and
`branch-protection` modules, as this repository's [`terraform/main.tf`](../terraform/main.tf)
does. The default threshold is two non-self approvals; set
`required_approval_count` if your policy needs a different threshold.

With these modules, setting `enable_protected_approval_gate = true` changes
the `ENABLE_PROTECTED_APPROVAL_GATE` Actions variable and adds the required
`protected-approval-gate` status check from GitHub Actions
(`integration_id = 15368`) in one apply. Dispatch
`protected-approval-gate-backfill.yml` immediately afterwards; open PRs
without a current result remain blocked until it finishes. See
[protected-approval-gate reusable workflows](#protected-approval-gate-reusable-workflows)
for the caller stubs and the enable, disable, and re-enable procedures.

`protected_pr_author_logins` uses the GitHub login form
`<slug>[bot]`. It is distinct from the `app/<slug>` search-qualifier form of
the `developer-author` input in
[`agent-resolve-conflicts-reusable.yml`](../.github/workflows/agent-resolve-conflicts-reusable.yml).
Keep both configuration surfaces aligned for the same developer App. See
[`docs/design/protected-approval-gate.md`](design/protected-approval-gate.md)
for the rationale and scope boundary.

---

### `actions-policy` module

**What it does.**  
Configures the repository's GitHub Actions permitted-actions policy to
`"selected"` mode. By default it allows only GitHub-owned actions
(`actions/*`) and rejects verified-creator and third-party actions. Any
non-GitHub action used in a workflow must be added to `patterns_allowed` **and**
pinned to a full 40-character SHA in the workflow YAML — omitting the entry
causes a loud workflow failure, not a silent bypass.

**The reusable workflows from this repository count as non-GitHub-owned.**
The policy is evaluated in _your_ repository against the full `uses:` string
of every call, and a reusable workflow in another owner's repository is only
permitted if a pattern matches it. The `patterns_allowed` entry must therefore
be in GitHub's reusable-workflow form,
`OWNER/REPO/.github/workflows/FILE.yml@REF`, not `owner/repo`: a bare
`mfrancza/agentic-development-workflow` entry matches nothing, and every
caller stub fails at startup with zero jobs. The wiring snippet below
allow-lists this repository's reusable workflows and composite actions at
**any** ref (`@*`), so upgrading your pinned release never needs a policy
change. Two calls depend on that wildcard even though they aren't in your
stubs: `agent-review-reusable.yml` calls its internal
`agent-review-worker-reusable.yml` at a fixed release of this repository, and
the `agent-fix-checks` stubs (event-driven and polling) call this repository's
`resolve-check-pr` and `find-failing-agent-prs` composite actions directly.
The reusables otherwise only call GitHub-owned `actions/*` actions.

**Prerequisites.**

- A configured `github` provider.
- A `github_repository` resource for the target repository.
- An entry in `patterns_allowed` matching the `uses:` string of the reusable
  workflows you call (see the wiring snippet).
- If any of your own workflows call a non-GitHub action (e.g. a third-party
  marketplace action), list it in `patterns_allowed` as `owner/repo@<sha>`.

**Wiring snippet.**

```hcl
module "actions_policy" {
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/actions-policy?ref=vX.Y.Z"
  repository = github_repository.this.name
  patterns_allowed = [
    # Required: this repository's reusable workflows at any ref, so the
    # release you pin in your stubs can change without a policy change.
    # GitHub matches the full OWNER/REPO/PATH/FILE@REF string, so owner/repo
    # alone does not work.
    "mfrancza/agentic-development-workflow/.github/workflows/*@*",
    # Required for the agent-fix-checks stubs, which call this repository's
    # composite actions directly.
    "mfrancza/agentic-development-workflow/.github/actions/*@*",
    # Add any non-GitHub-owned action your own workflows use, as owner/repo@<sha>.
  ]
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
  source     = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/security?ref=vX.Y.Z"
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
uses: mfrancza/agentic-development-workflow/.github/workflows/<name>-reusable.yml@vX.Y.Z
```

Pass `image:` to pull the published agent container image from GHCR — this
skips a `docker build` step that the reusable workflow cannot perform without
the source `docker/` tree in the caller's workspace:

```
image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
image: ghcr.io/mfrancza/agentic-development-workflow/reviewer:vX.Y.Z
```

**Security note on allowlist gating.** The reusable's first authorization step
owns membership authorization and runs before its work job enters the shared
concurrency group. The gate receives a `principal` appropriate to the event:
label-driven callers pass the event sender, while `agent-respond-review` passes
the review author. The `agent-review` `synchronize` path and the
`agent-auto-trigger` `auto-review` transition set `skip-gate: true`; their
same-repository and agent-authorship checks are the policy boundary. The
review-response gate additionally supplies `additional-trusted-logins` for the
known reviewer bots. Caller stubs retain only event, label, and trust-model
predicates; they must not retain caller-side
`contains(fromJSON(vars.AGENT_ALLOWLIST), ...)` checks or workflow/job
`concurrency:` blocks for these gated workflows.

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

jobs:
  groom:
    if: >
      github.event.label.name == 'agent:groom'
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-groom-reusable.yml@vX.Y.Z
    with:
      issue-number: ${{ github.event.issue.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      default-model: ${{ vars.DEFAULT_MODEL }}
      admin-assignees: ${{ vars.ADMIN_ASSIGNEES }}
      logs-retention-days: 30
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
      issue-state: ${{ github.event.issue.state }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
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
- Actions variables: `AGENT_ALLOWLIST`, `DEFAULT_MODEL`. Optional: `DESIGN_DEFAULT_MODEL` (when set, the design workflow prefers it over `DEFAULT_MODEL`; leave unset or empty to inherit `DEFAULT_MODEL`).
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
      github.event.label.name == 'agent:design'
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-design-reusable.yml@vX.Y.Z
    with:
      run-design: true
      issue-number: ${{ github.event.issue.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      default-model: ${{ vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL }}
      logs-retention-days: 30
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
      issue-state: ${{ github.event.issue.state }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}

  call-undraft:
    if: >
      github.event.pull_request.head.repo.full_name == github.repository
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-design-reusable.yml@vX.Y.Z
    with:
      run-undraft: true
      pr-head-ref: ${{ github.event.pull_request.head.ref }}
      repo: ${{ github.repository }}
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
      pr-merged: ${{ github.event.pull_request.merged }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
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

jobs:
  implement:
    if: >
      github.event.label.name == 'agent:developer'
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-implement-reusable.yml@vX.Y.Z
    with:
      issue-number: ${{ github.event.issue.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      default-model: ${{ vars.DEFAULT_MODEL }}
      code-reviewers: ${{ vars.CODE_REVIEWERS }}
      logs-retention-days: 30
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
      issue-state: ${{ github.event.issue.state }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
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

jobs:
  review:
    # Exclude fork-headed PRs on both event paths.
    if: >
      github.event.pull_request.head.repo.full_name == github.repository &&
      (
        (github.event.action == 'labeled' &&
         github.event.label.name == 'agent:review') ||
        (github.event.action == 'synchronize' &&
         contains(github.event.pull_request.labels.*.name, 'agent:review'))
      )
    permissions:
      contents: write
      pull-requests: write
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-review-reusable.yml@vX.Y.Z
    with:
      pr-number: ${{ github.event.pull_request.number }}
      repo: ${{ github.repository }}
      image: ghcr.io/mfrancza/agentic-development-workflow/reviewer:vX.Y.Z
      default-model: ${{ vars.DEFAULT_MODEL }}
      reviewer-models: ${{ vars.REVIEWER_MODELS }}
      logs-retention-days: 30
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
      event-action: ${{ github.event.action }}
      pr-state: ${{ github.event.pull_request.state }}
    secrets:
      REVIEWER_APP_ID: ${{ secrets.REVIEWER_APP_ID }}
      REVIEWER_APP_PRIVATE_KEY: ${{ secrets.REVIEWER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
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
comments) before spending an Anthropic API call. It also skips any review
whose author is the PR author: the developer agent's own thread replies are
materialised by GitHub as `COMMENTED` reviews, and without this guard each
reply re-triggers the workflow in an unbounded loop (see
[`docs/design/respond-review-self-trigger-guard.md`](design/respond-review-self-trigger-guard.md)).

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- Actions variables: `AGENT_ALLOWLIST`.
- The `review-author` and `pr-author` inputs are **required** (since v0.1.0).
  Pass them straight from the event payload as shown in the stub; the reusable
  compares them to implement the self-review guard and fails loudly if either
  is missing rather than silently running without the guard.

**Caller stub.**

```yaml
name: agent-respond-review

on:
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: read

jobs:
  respond-review:
    # Gate on the PR author (developer-agent bot).
    # Adjust the PR-author login to match your developer-agent App slug.
    # The second line excludes reviews authored by the PR author itself: the
    # developer agent can be trusted, so without it the agent's own
    # thread replies would re-trigger this workflow indefinitely.
    if: >
      github.event.pull_request.user.login == '<developer-agent-slug>[bot]' &&
      github.event.review.user.login != github.event.pull_request.user.login
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-respond-review-reusable.yml@vX.Y.Z
    with:
      pr-number: ${{ github.event.pull_request.number }}
      review-state: ${{ github.event.review.state }}
      review-body: ${{ github.event.review.body }}
      review-id: ${{ github.event.review.id }}
      review-author: ${{ github.event.review.user.login }}
      pr-author: ${{ github.event.pull_request.user.login }}
      repo-name: ${{ github.event.repository.name }}
      head-sha: ${{ github.event.pull_request.head.sha }}
      review-commit-id: ${{ github.event.review.commit_id }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      helpers-ref: vX.Y.Z
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
```

> **Adapt the `if:` condition.** Replace `<developer-agent-slug>[bot]` with
> your actual App slug. Keep the `review.user.login != pull_request.user.login`
> line and the `review-author` / `pr-author` inputs exactly as shown: together
> they are the two layers of the self-trigger guard. The reusable authorizes
> `review-author` against `AGENT_ALLOWLIST` before it enters its per-PR lock.

**Trust considerations.** The developer-agent token has Contents (R/W) and
Workflows (R/W) to push the response commits. The review body and inline
comments are attacker-controlled text that flows into a Claude prompt; the
reusable's review-author gate limits the prompt injection surface to actors
you trust.

---

### `agent-fix-checks` reusable workflow

**What it does.**  
Responds to an allowed actionable check failure on a developer-agent–authored
PR by re-invoking the developer agent with `AGENT_ACTION=fix-checks`. The
reusable first verifies that the PR is authored by the developer-agent bot —
it never runs for human-authored PRs. The caller resolves both same-repository
Actions failures and eligible other check origins before calling the reusable.

**Prerequisites.**

- GitHub App: **developer-agent**.
- Secrets: `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`.
- A `FIX_CHECKS_ALLOW` Actions variable containing a non-empty JSON array of
  raw Checks API `check_runs[].name` values. `[]` disables all fix-checks
  handling, including same-repository `workflow_run` deliveries. Discover
  names with `gh api repos/$OWNER/$REPO/commits/$SHA/check-runs --jq
  '.check_runs[].name'`; do not use a workflow name or a decorated Checks-tab
  label.
- Same-repository workflow names (for example, `"CI"`) listed in the caller's
  `workflow_run.workflows:` filter. This is a delivery subscription, not an
  allowlist substitute.
- An actions-policy entry for this repository's composite actions
  (`mfrancza/agentic-development-workflow/.github/actions/*@*`), because the
  stubs call `resolve-check-pr` and `find-failing-agent-prs` directly. See the
  [`actions-policy` module](#actions-policy-module).

**Caller stub.**

```yaml
name: agent-fix-checks

on:
  workflow_run:
    workflows: ["CI"] # must match your CI workflow's `name:` field exactly
    types: [completed]
  check_run:
    types: [completed]

permissions:
  contents: read
  checks: read
  pull-requests: read

jobs:
  resolve-pr:
    if: >
      vars.FIX_CHECKS_ALLOW != '' &&
      ((github.event_name == 'workflow_run' &&
        (github.event.workflow_run.conclusion == 'failure' ||
         github.event.workflow_run.conclusion == 'timed_out' ||
         github.event.workflow_run.conclusion == 'action_required')) ||
       (github.event_name == 'check_run' &&
        (github.event.check_run.conclusion == 'failure' ||
         github.event.check_run.conclusion == 'timed_out' ||
         github.event.check_run.conclusion == 'action_required')))
    runs-on: ubuntu-24.04
    outputs:
      pr_number: ${{ steps.resolve.outputs.pr_number }}
      proceed: ${{ steps.resolve.outputs.proceed }}
      head_sha: ${{ steps.resolve.outputs.head_sha }}
    steps:
      - id: resolve
        uses: mfrancza/agentic-development-workflow/.github/actions/resolve-check-pr@vX.Y.Z
        with:
          event-name: ${{ github.event_name }}
          token: ${{ github.token }}
          repository: ${{ github.repository }}
          allowed-checks: ${{ vars.FIX_CHECKS_ALLOW }}

  fix-checks:
    needs: resolve-pr
    if: needs.resolve-pr.outputs.proceed == 'true'
    concurrency:
      group: agent-fix-checks-pr-${{ needs.resolve-pr.outputs.pr_number }}
      cancel-in-progress: false
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-fix-checks-reusable.yml@vX.Y.Z
    with:
      pr-number: ${{ fromJSON(needs.resolve-pr.outputs.pr_number) }}
      head-sha-at-trigger: ${{ needs.resolve-pr.outputs.head_sha }}
      agent-login: <developer-agent-slug>[bot]
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      helpers-ref: vX.Y.Z
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
```

> **Adapt `agent-login`** to your developer-agent App's bot login (e.g.
> `acme-developer-agent[bot]`). The reusable uses this login to filter PRs —
> it only runs for PRs authored by the developer-agent bot. Keep the
> `fromJSON(...)` on `pr-number`: job outputs are strings and the reusable's
> `pr-number` input is a number.

**Optional polling backstop.** GitHub does not always deliver `check_run`
events, for example for some third-party check origins. A scheduled poller
catches allowed failing checks the event-driven workflow missed. It applies
the same `FIX_CHECKS_ALLOW` allowlist, so an empty or missing allowlist
dispatches nothing, and it shares the event-driven workflow's per-PR
concurrency group, so a poll and a check event never run the agent on the
same PR at once.

```yaml
name: agent-fix-checks-poll

on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

permissions:
  contents: read
  checks: read
  pull-requests: read

jobs:
  find-failing-agent-prs:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    outputs:
      prs: ${{ steps.find.outputs.prs }}
    steps:
      - name: Find agent PRs with allowed failing checks
        id: find
        uses: mfrancza/agentic-development-workflow/.github/actions/find-failing-agent-prs@vX.Y.Z
        with:
          token: ${{ github.token }}
          repository: ${{ github.repository }}
          author: <developer-agent-slug>[bot]
          allowed-checks: ${{ vars.FIX_CHECKS_ALLOW }}

  fix-checks:
    needs: find-failing-agent-prs
    if: needs.find-failing-agent-prs.outputs.prs != '[]'
    strategy:
      fail-fast: false
      matrix:
        pr: ${{ fromJSON(needs.find-failing-agent-prs.outputs.prs) }}
    concurrency:
      group: agent-fix-checks-pr-${{ matrix.pr.number }}
      cancel-in-progress: false
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-fix-checks-reusable.yml@vX.Y.Z
    with:
      pr-number: ${{ matrix.pr.number }}
      head-sha-at-trigger: ${{ matrix.pr.head_sha }}
      agent-login: <developer-agent-slug>[bot]
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      helpers-ref: vX.Y.Z
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
```

Set `author` and `agent-login` to the same developer-agent bot login as the
event-driven stub. Like the event-driven stub, it calls one of this
repository's composite actions directly, so your actions policy needs the
`mfrancza/agentic-development-workflow/.github/actions/*@*` entry (see the
[`actions-policy` module](#actions-policy-module) wiring snippet).

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
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-fix-deployment-reusable.yml@vX.Y.Z
    with:
      deployment-sha: ${{ github.event.deployment.sha }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      helpers-ref: vX.Y.Z
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
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
- The `developer-author` input must be set to `app/<developer-app-slug>` — the
  GitHub App slug in the `app/` prefix form used by the PR author filter (for
  example, `app/my-developer-agent`). This value is used to enumerate open PRs
  authored by the developer agent. When `pr-number` is provided via
  `workflow_dispatch`, enumeration is skipped and this value is not used.

**Caller stub.**

```yaml
name: agent-resolve-conflicts

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "PR number to resolve (skips conflict enumeration)"
        required: false

permissions:
  contents: read
  pull-requests: read

jobs:
  resolve-conflicts:
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-resolve-conflicts-reusable.yml@vX.Y.Z
    with:
      pr-number: ${{ inputs.pr_number || '' }}
      developer-author: app/<developer-app-slug>
      escalation-assignee: ${{ github.repository_owner }}
      image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
      helpers-ref: vX.Y.Z
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
```

> **Adapt `developer-author`** to your developer-agent App's GitHub App slug in
> `app/<slug>` form — for example, `app/my-developer-agent`. The reusable uses
> this value to list open PRs authored by the developer agent during enumeration.
> When `pr-number` is provided via `workflow_dispatch`, enumeration is skipped
> and this input is not used.

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

jobs:
  remove-developer-label:
    # Only act on PRs authored by the developer-agent bot.
    # Adjust the login to match your App's bot identity.
    if: github.event.pull_request.user.login == '<developer-agent-slug>[bot]'
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-pr-merged-reusable.yml@vX.Y.Z
    with:
      pr-number: ${{ github.event.pull_request.number }}
      pr-body: ${{ github.event.pull_request.body }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
```

> **Adapt the `if:` condition.** Replace `<developer-agent-slug>[bot]` with
> your developer-agent App's bot login. The reusable extracts the issue number
> from the explicit `pr-body` input because `github.event.pull_request.body` is
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

| Transition               | Trigger                                                                                                                | Action                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `auto-groom`             | `issues.opened`                                                                                                        | Applies `agent:groom`                                          |
| `auto-design`            | `issues.labeled` (`plan`)                                                                                              | Applies `agent:design`                                         |
| `auto-developer-do`      | `issues.labeled` (`do`)                                                                                                | Applies `agent:developer` (or `blocked` if open blockers)      |
| `auto-developer-undraft` | `issues.unlabeled` (`draft`)                                                                                           | Applies `agent:developer` (or `blocked`)                       |
| `auto-review`            | `pull_request.opened` on `agent/…` or `design/…` branch, or authored by `<developer-agent-slug>[bot]` (same-repo only) | Applies `agent:review`                                         |
| `auto-developer-unblock` | `issues.closed`                                                                                                        | Applies `agent:developer` on newly-unblocked downstream issues |

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
      !contains(github.event.issue.labels.*.name, 'draft')
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@vX.Y.Z
    with:
      transition: auto-groom
      issue-number: ${{ github.event.issue.number }}
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}

  auto-design:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'labeled' &&
      github.event.label.name == 'plan' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).design == true
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@vX.Y.Z
    with:
      transition: auto-design
      issue-number: ${{ github.event.issue.number }}
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}

  auto-developer-do:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'labeled' &&
      github.event.label.name == 'do' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true &&
      !contains(github.event.issue.labels.*.name, 'draft')
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@vX.Y.Z
    with:
      transition: auto-developer-do
      issue-number: ${{ github.event.issue.number }}
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}

  auto-developer-undraft:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'unlabeled' &&
      github.event.label.name == 'draft' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@vX.Y.Z
    with:
      transition: auto-developer-undraft
      issue-number: ${{ github.event.issue.number }}
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}

  auto-review:
    if: >
      github.event_name == 'pull_request' &&
      github.event.action == 'opened' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      (startsWith(github.event.pull_request.head.ref, 'agent/') ||
       startsWith(github.event.pull_request.head.ref, 'design/') ||
       github.event.pull_request.user.login == '<developer-agent-slug>[bot]') &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).review == true
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@vX.Y.Z
    with:
      transition: auto-review
      pr-number: ${{ github.event.pull_request.number }}
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}

  auto-developer-unblock:
    if: >
      github.event_name == 'issues' &&
      github.event.action == 'closed' &&
      vars.AUTO_TRIGGER_AGENTS != '' &&
      fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true
    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-auto-trigger-reusable.yml@vX.Y.Z
    with:
      transition: auto-developer-unblock
      issue-number: ${{ github.event.issue.number }}
      helpers-ref: vX.Y.Z
      sender-login: ${{ github.event.sender.login }}
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
```

> **Adapt the `auto-review` `if:` condition.** Replace `<developer-agent-slug>[bot]`
> with your developer-agent App's bot login (e.g. `my-developer-agent[bot]`). The
> developer-agent login predicate enrolls PRs opened by the bot regardless of branch
> prefix (e.g. `validate/*`, `test/*`); without it, auto-review silently skips those
> PRs when `AUTO_TRIGGER_AGENTS.review = true`. The head-repo guard sitting outside
> the `(…)` OR block ensures fork PRs are excluded even if the bot login matches.

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
    uses: mfrancza/agentic-development-workflow/.github/workflows/ci-reusable.yml@vX.Y.Z
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
    branches: ["**"]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1" # Weekly, Mondays at 06:00 UTC
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: secret-scan-${{ github.workflow }}-${{ github.ref_name }}-${{ github.event_name }}
  cancel-in-progress: true

jobs:
  scan:
    uses: mfrancza/agentic-development-workflow/.github/workflows/secret-scan-reusable.yml@vX.Y.Z
    # Optional: override the gitleaks version and its SHA-256 checksum
    # with:
    #   gitleaks-version: '8.28.0'
    #   gitleaks-sha256: 'a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb'
```

**Trust considerations.** No secrets are used. The gitleaks binary is
SHA-256-verified before execution to prevent tampered releases from entering CI.

---

### `protected-approval-gate` reusable workflows

**What it does.**  
An opt-in required status check that blocks merging a pull request authored
by a protected login (for example your developer-agent App,
`<your-developer-app-slug>[bot]`) until it has `REQUIRED_APPROVAL_COUNT`
approvals from someone other than its author. Pull requests from other authors
pass immediately. Two reusable workflows implement it:

- `protected-approval-gate-reusable.yml` evaluates one pull request. Your
  publisher calls it on pull request and review events.
- `protected-approval-gate-sweep-reusable.yml` re-evaluates every open pull
  request. Your backfill and reconcile workflows call it.

Both publish the result through the Checks API under the name
`protected-approval-gate` while the gate is enabled, and
`protected-approval-gate (preview)` while it is disabled. The preview check
shows what the gate would decide and is never required.

**Prerequisites.**

- Actions variables (via the `agent-vars` module or set manually):
  `PROTECTED_PR_AUTHOR_LOGINS` (JSON array of logins, for example
  `["<your-developer-app-slug>[bot]"]`), `REQUIRED_APPROVAL_COUNT` (for
  example `2`), `ENABLE_PROTECTED_APPROVAL_GATE` (`true` or `false`), and
  optionally `PROTECTED_APPROVAL_REVIEWERS` (see **Which approvals count**
  below) and `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` (default `10`).
- Secrets: none, unless `PROTECTED_APPROVAL_REVIEWERS` contains a team
  reference. Then the `ALLOWLIST_RESOLVER_APP_ID` and
  `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` secrets of an `allowlist-resolver`
  GitHub App are required (see below). Everything else uses the workflow
  `GITHUB_TOKEN`.
- All four caller workflows below. The backfill and reconcile are what keep
  results current after the gate is re-enabled, so do not skip them.

**Caller stubs.**

The publisher runs on `pull_request_target` and on completion of the notifier,
so it always executes trusted base-branch code and can publish results for fork
pull requests. Do not run it on `pull_request` or `pull_request_review`: those
events load workflow YAML from the pull request and cannot publish Checks API
results for forks. The notifier executes nothing; its completion is the signal
the publisher listens for. Its `name:` must exactly match the publisher's
`workflow_run.workflows` filter.

`.github/workflows/protected-approval-gate-publisher.yml`:

```yaml
name: protected-approval-gate-publisher

on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited, ready_for_review, closed]
  workflow_run:
    workflows: ["protected-approval-gate-notify"]
    types: [completed]

permissions:
  contents: read
  pull-requests: read
  checks: write

concurrency:
  group: protected-approval-gate-pr-${{ github.event.pull_request.number || github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.id }}
  cancel-in-progress: false

jobs:
  check-protected-approvals:
    if: github.event_name != 'workflow_run' || github.event.workflow_run.pull_requests[0] != null
    uses: mfrancza/agentic-development-workflow/.github/workflows/protected-approval-gate-reusable.yml@vX.Y.Z
    secrets:
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
    with:
      protected-pr-author-logins: ${{ vars.PROTECTED_PR_AUTHOR_LOGINS }}
      required-approval-count: ${{ vars.REQUIRED_APPROVAL_COUNT }}
      enabled: ${{ vars.ENABLE_PROTECTED_APPROVAL_GATE }}
      qualifying-reviewers: ${{ vars.PROTECTED_APPROVAL_REVIEWERS }}
      pr-number: ${{ github.event.pull_request.number || github.event.workflow_run.pull_requests[0].number }}
      head-sha: ${{ github.event.pull_request.head.sha || github.event.workflow_run.pull_requests[0].head.sha }}
      repo: ${{ github.repository }}
      helpers-ref: vX.Y.Z
      departed-sha: ${{ github.event.action == 'synchronize' && github.event.before || github.event.action == 'closed' && github.event.pull_request.head.sha || '' }}
      departed-pr-number: ${{ (github.event.action == 'synchronize' || github.event.action == 'closed') && github.event.pull_request.number || 0 }}
```

`departed-sha` and `departed-pr-number` re-evaluate the commit a pull request
just left (after a push or close), so another open pull request sharing that
commit does not keep a result computed for the departed one.

`.github/workflows/protected-approval-gate-notify.yml`:

```yaml
name: protected-approval-gate-notify

on:
  pull_request_review:
    types: [submitted, edited, dismissed]

permissions: {}

concurrency:
  group: protected-approval-gate-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  notify:
    runs-on: ubuntu-24.04
    steps:
      - run: 'true'
```

`.github/workflows/protected-approval-gate-backfill.yml` (dispatch it by hand
after enabling the gate):

```yaml
name: protected-approval-gate-backfill

on:
  workflow_dispatch:

permissions:
  contents: read
  actions: read
  pull-requests: read
  checks: write

jobs:
  sweep:
    uses: mfrancza/agentic-development-workflow/.github/workflows/protected-approval-gate-sweep-reusable.yml@vX.Y.Z
    secrets:
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
    with:
      protected-pr-author-logins: ${{ vars.PROTECTED_PR_AUTHOR_LOGINS }}
      required-approval-count: ${{ vars.REQUIRED_APPROVAL_COUNT }}
      enabled: ${{ vars.ENABLE_PROTECTED_APPROVAL_GATE }}
      qualifying-reviewers: ${{ vars.PROTECTED_APPROVAL_REVIEWERS }}
      repo: ${{ github.repository }}
      helpers-ref: vX.Y.Z
```

`.github/workflows/protected-approval-gate-reconcile.yml` (scheduled safety
net). The cron uses GitHub's shortest supported interval, every 5 minutes,
because schedules cannot read Actions variables; the sweep skips runs that
come sooner than
`ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` after the last successful
one:

```yaml
name: protected-approval-gate-reconcile

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

permissions:
  contents: read
  actions: read
  pull-requests: read
  checks: write

concurrency:
  group: protected-approval-gate-reconcile
  cancel-in-progress: false

jobs:
  sweep:
    uses: mfrancza/agentic-development-workflow/.github/workflows/protected-approval-gate-sweep-reusable.yml@vX.Y.Z
    secrets:
      ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}
      ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}
    with:
      protected-pr-author-logins: ${{ vars.PROTECTED_PR_AUTHOR_LOGINS }}
      required-approval-count: ${{ vars.REQUIRED_APPROVAL_COUNT }}
      enabled: ${{ vars.ENABLE_PROTECTED_APPROVAL_GATE }}
      qualifying-reviewers: ${{ vars.PROTECTED_APPROVAL_REVIEWERS }}
      repo: ${{ github.repository }}
      helpers-ref: vX.Y.Z
      interval-minutes: ${{ vars.ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES }}
```

**Which approvals count.** By default (`PROTECTED_APPROVAL_REVIEWERS` empty
or unset), the latest approval from **any** reviewer other than the PR author
counts toward `REQUIRED_APPROVAL_COUNT`. Your branch protection's own
required-review rule still demands approval from someone with write access,
but on a public repository any GitHub account can submit an approving review,
so the remaining approvals could come from anyone. Set
`PROTECTED_APPROVAL_REVIEWERS` to a JSON array of the reviewers you trust:

```json
["<maintainer-login>", "<reviewer-app-slug>[bot]", "<your-org>/<team-slug>"]
```

- Only approvals from listed logins, or from members of listed teams, then
  count. The PR author never counts, even if listed.
- Bot reviewers count only if listed by login (for example
  `<reviewer-app-slug>[bot]`).
- Team references must belong to the organization that owns the repository.
  Expanding them needs organization **Members: Read**, which `GITHUB_TOKEN`
  does not have, so create an `allowlist-resolver` GitHub App with only
  `Organization permissions → Members: Read` and `Repository permissions →
  Metadata: Read`, install it on the organization, and store its client ID
  and private key as `ALLOWLIST_RESOLVER_APP_ID` and
  `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY`. A list of logins only needs no App.
- If a team reference cannot be resolved (missing secrets, unknown team, or a
  team from another organization), protected PRs fail the check with the
  reason in the check summary rather than counting every reviewer. PRs from
  unprotected authors are unaffected.

**Enabling the gate.**

Publishing and enforcing are separate. Setting `ENABLE_PROTECTED_APPROVAL_GATE`
to `true` makes the workflows publish the `protected-approval-gate` check, but
**nothing is enforced until your branch protection rules require that check**.
Until then the check is informational only.

Enable in this order:

- Set `ENABLE_PROTECTED_APPROVAL_GATE` to `true`, with
  `PROTECTED_PR_AUTHOR_LOGINS` and `REQUIRED_APPROVAL_COUNT` set.
- Dispatch `protected-approval-gate-backfill` and wait for it to finish, so
  every open pull request has a current result.
- Require the `protected-approval-gate` status check on your default branch,
  with **GitHub Actions** as its source:
  - **With this project's `branch-protection` Terraform module:** set
    `enable_protected_approval_gate = true` (it also sets the Actions variable
    through `agent-vars`) and apply. The module pins the check's source to
    GitHub Actions (`integration_id = 15368`). Because the variable and the
    rule change in one apply, dispatch the backfill immediately afterwards;
    open pull requests without a current result stay blocked until it
    finishes.
  - **With a repository or organization ruleset:** edit the ruleset that
    targets your default branch, enable **Require status checks to pass**, add
    the check `protected-approval-gate`, and select **GitHub Actions** as its
    source.
  - **With classic branch protection:** edit the rule for your default branch,
    enable **Require status checks to pass before merging**, add
    `protected-approval-gate`, and select **GitHub Actions** as its source.

The source matters: if the required check accepts any source, anyone with
write access can satisfy it by posting a commit status named
`protected-approval-gate`.

**Disabling the gate.** Remove the required check from your branch protection
rules first, then set `ENABLE_PROTECTED_APPROVAL_GATE` to `false`. In the other
order, the workflows stop publishing `protected-approval-gate` (only the
`(preview)` check is posted) while the rule still requires it, so every pull
request to the branch is blocked. With the Terraform modules, setting
`enable_protected_approval_gate = false` changes both in one apply.

**Re-enabling the gate.** Follow the enabling steps again. While the gate was
disabled, only the preview check was updated, so an open pull request whose
head has not changed can still carry an enforcing result from the earlier
enabled period. The backfill replaces it, and the reconcile sweep replaces it
within `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES` if the backfill is
skipped.

**Limitations.** Merge queues are not supported. The publisher does not run on
`merge_group` events, so requiring `protected-approval-gate` on a branch that
uses a merge queue stalls entries waiting for a check that is never posted.

**Trust considerations.** The publisher and sweep run trusted base-branch code
and never check out pull request content. The required check's GitHub Actions
source restricts who can satisfy it, but any workflow in your repository with
`checks: write` could post a check under the same name; see the residual-risk
discussion in
[`docs/design/protected-approval-gate.md`](design/protected-approval-gate.md)
(Decision 5).

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

**Cause A — Sender not in allowlist.** The reusable workflow checks the
labeler's login against `AGENT_ALLOWLIST` before it acquires its work lock. If
the labeler is not authorized, the run is denied by that gate.

**Fix A:** Add the labeler's GitHub login to `agent_allowlist` in Terraform and
re-apply.

**Cause B — Bot identity missing from allowlist.** If you enable
`auto_trigger_agents.groom = true`, the auto-trigger workflow applies the label
using the developer-agent bot identity (e.g.
`my-developer-agent[bot]`). If that bot identity is not in `AGENT_ALLOWLIST`,
the downstream groom workflow is denied by its allowlist gate.

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
for the full analysis.) Each reusable now self-checks out its own helper actions
into a `_agentic-workflow/` subdirectory before any composite action step runs.
The helper version is pinned via the required `helpers-ref` workflow input — pass
the same tag or SHA you use in the `uses:` line (e.g. `helpers-ref: v0.2.1`
alongside `uses: ...@v0.2.1`). See [`docs/design/helper-checkout-job-workflow-sha-context.md`](design/helper-checkout-job-workflow-sha-context.md)
for the full design and `AGENTS.md` § "Reusable workflows: self-checkout for helper
actions" for the canonical pattern.

**Fix:**

- Upgrade to an exact tag of `v0.0.2` or later. Add `helpers-ref:` matching
  the same version selector you use in the `uses:` line:

  ```yaml
  uses: mfrancza/agentic-development-workflow/.github/workflows/agent-implement-reusable.yml@vX.Y.Z
  with:
    image: ghcr.io/mfrancza/agentic-development-workflow/developer:vX.Y.Z
    helpers-ref: vX.Y.Z
  ```

- If you are on the moving major tag (`@v0`) and adopted before the
  `helpers-ref` input was added, add `helpers-ref: v0` to the `with:` block of
  every affected caller stub, or switch to an exact tag as recommended in
  [Version pinning](#version-pinning).

**Verification after fixing:** Open a test issue on your consumer repo and apply
`agent:developer`. The workflow should:

1. Validate `helpers-ref`, resolve it to a commit SHA, and complete the "Check
   out upstream helper actions" step with no error. The step log should show the
   resolved SHA and a HEAD-equality confirmation.
2. Mint a developer-agent token (the `agent-token` composite action runs
   successfully).
3. Pass all preflight steps (find-existing-pr, check-draft-label, check-blockers).
4. Run the agent container and open a PR on `agent/issue-<N>`.
5. Upload an `agent-logs-implement-issue-<N>-…` artifact (visible in the
   workflow run's Summary page even on failure, because the upload step uses
   `if: always()`).

If step 1 still fails after upgrading, confirm that: (a) `helpers-ref:` is present
in the `with:` block, (b) the ref resolves to a tag or SHA that exists on the
source repo, and (c) your `uses:` line references the reusable workflow file
(not the caller stub file).

---

### Reusable workflow call fails at startup: "is not allowed to be used in"

**Symptom:** Every caller stub that `uses:` a reusable workflow from this
repository fails immediately with no jobs, and the run's error reads like:

```
mfrancza/agentic-development-workflow/.github/workflows/agent-groom-reusable.yml@v0
is not allowed to be used in <your-org>/<your-repo>. Actions in this workflow
must be: within a repository owned by <your-org>, created by GitHub, or matching
the following: ...
```

**Cause:** Your repository's Actions permissions are in `selected` mode (the
`actions-policy` module sets this) and the allow list has no pattern matching
the reusable-workflow `uses:` string. GitHub matches the **full** string in the
form `OWNER/REPO/.github/workflows/FILE.yml@REF`. An entry of
`mfrancza/agentic-development-workflow` (an earlier version of this guide's
wiring snippet suggested "owner/repo patterns") matches nothing.

**Fix:** Allow this repository's reusable workflows and composite actions at
any ref, then apply:

```hcl
patterns_allowed = [
  "mfrancza/agentic-development-workflow/.github/workflows/*@*",
  "mfrancza/agentic-development-workflow/.github/actions/*@*",
]
```

Use `@*`, not your pinned tag: `agent-review-reusable.yml` calls its internal
worker workflow at a fixed release of this repository, which a pattern for your
own tag doesn't match. Without Terraform, the same list lives under
_Settings → Actions → General → Allow specified actions and reusable
workflows_.

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

### `agent-respond-review` fails at startup: `Required input 'review-author' not provided`

**Symptom:** After the `v0` tag advanced to `v0.1.0` or later, every
`agent-respond-review` run fails immediately at workflow validation with an
error naming `review-author` or `pr-author` as a required input that was not
provided. No job runs.

**Cause:** `v0.1.0` added two required inputs, `review-author` and
`pr-author`, to `agent-respond-review-reusable.yml` for the self-trigger guard.
A caller stub copied from this guide before that release does not pass them.

**Fix:** Add the two lines to the `with:` block of your caller stub and, if
missing, the author-inequality line to the `if:` condition:

<!-- prettier-ignore -->
```yaml
    with:
      review-author: ${{ github.event.review.user.login }}
      pr-author: ${{ github.event.pull_request.user.login }}
```

The full current stub is in the
[`agent-respond-review` section](#agent-respond-review-reusable-workflow).

---

### `agent-fix-checks` stub placeholder

**Symptom:** The `agent-fix-checks` caller stub contains `<developer-agent-slug>[bot]`
as a literal placeholder.

**Fix:** Replace with your developer-agent App's bot login, the same value used
in the `agent-respond-review` stub.

---

### `agent-resolve-conflicts` stub placeholder

**Symptom:** The `agent-resolve-conflicts` caller stub contains
`app/<developer-app-slug>` as a literal placeholder for the `developer-author`
input.

**Fix:** Replace `app/<developer-app-slug>` with your developer-agent App's slug
in `app/` prefix form — for example, `app/my-developer-agent`. This value is
passed to the PR author filter that enumerates open developer-agent PRs. The App
slug is the App's name in lowercase with spaces replaced by hyphens (the same
base slug used for the `<slug>[bot]` login, without the `[bot]` suffix). When
`pr-number` is provided via `workflow_dispatch`, the developer-author value is
not used and can be left as-is for that run.

---

### `agent-auto-trigger` stub placeholder

**Symptom:** The `agent-auto-trigger` caller stub's `auto-review` job contains
`<developer-agent-slug>[bot]` as a literal placeholder in the `if:` condition.
With `AUTO_TRIGGER_AGENTS.review = true`, PRs opened by the developer-agent bot on
non-standard branch prefixes (e.g. `validate/*`, `test/*`) are silently skipped
because the branch-prefix predicates do not match and the bot-login predicate is
never evaluated.

**Cause:** The developer-agent login predicate must be filled in before the workflow
functions. It cannot be read from an Actions variable because it gates the workflow
`if:` expression itself (before any variable lookup runs).

**Fix:** Replace `<developer-agent-slug>[bot]` in the `auto-review` job's `if:`
condition with your developer-agent App's bot login — for example,
`my-developer-agent[bot]`. The bot login appears in the first comment a bot posts
after installation, or can be confirmed by checking the App's page on GitHub. The
same slug value (without `[bot]`) is also used in the `agent-resolve-conflicts`
stub's `developer-author` input (as `app/<slug>`) and in the `agent-respond-review`
and `agent-pr-merged` stubs.

---

### `terraform-ci-reusable.yml` is not available for external adoption in v0

`terraform-ci-reusable.yml` is **consumer-only** — it is not part of the
externally published surface for v0. The workflow's `plan` and `apply` jobs
depend on paths specific to this repository's layout (`terraform/`,
`.github/actions/`, `.tool-versions`) and target this repository's dedicated
Terraform GitHub App. Attempting to call it from an external repository will
fail at the composite-action resolution step.

External repositories that need Terraform CI should copy the workflow and its
helper composite actions directly, or build a bespoke CI workflow.

See [docs/design/reusable-workflow-helper-resolution.md](design/reusable-workflow-helper-resolution.md)
Decision 6 for the rationale. This restriction may be revisited in a future
release if external demand emerges.
