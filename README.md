# agentic-development-workflow

AI coding agents integrated into a GitHub issue-based development lifecycle. Each agent has its own GitHub identity, runs in an isolated container per event, and interacts via PR and issue comments.

See [requirements.md](requirements.md) for the MVP workflow, [AGENTS.md](AGENTS.md) for agent conventions, and [CONTRIBUTING.md](CONTRIBUTING.md) for the human PR workflow.

## How it works

Once the repo is set up (steps below), day-to-day operation is driven entirely by GitHub labels and events:

- Apply **`agent:groom`** to an issue → the grooming agent classifies it and asks clarifying questions.
- Apply **`agent:developer`** to an issue → the developer agent creates `agent/issue-{N}`, implements a solution, and opens a PR.
- Apply **`agent:review`** to a PR → the code review agent reviews the changes (and re-reviews when the PR is updated). (**Note:** the reviewer-agent workflow is not yet implemented; this label is reserved as a placeholder trigger until the workflow lands.)
- CI failure on an agent-authored PR → the agent is re-invoked to fix the checks. (**Note:** `agent-fix-checks` is wired to a workflow named `CI`; this step won't fire until a workflow with that name exists in the repo.)
- PR review submitted on an agent-authored PR → the agent addresses feedback and pushes.
- Deployment failure → the agent opens a follow-up fix-up PR. (Triggers on any `deployment_status` failure; skips cleanly unless it can map the failing deployment SHA to a PR containing `Closes #N`.)
- Add a **`model:<name>`** label (e.g. `model:opus`, `model:haiku`) to override the default Claude model for that issue's run.

Only usernames (and agent bot identities such as `<developer-agent-app-slug>[bot]`) in the Terraform-managed `AGENT_ALLOWLIST` can trigger the label-driven workflows (`agent:groom`, `agent:developer`, `agent:review`). The agent bots are included so an agent can apply `agent:*` labels to hand work off — for example, the developer agent applying `agent:review` on its own PR to request a code review. Event-driven workflows then apply their own gates: `fix-checks`/`respond-review` run only for developer-agent PRs, and `fix-deployment` runs on any failed `deployment_status` event and skips cleanly unless it can map the deployment SHA to a PR containing `Closes #N`.

See [AGENTS.md](AGENTS.md) for the full list of `AGENT_ACTION` values and their required env vars.

## SDLC diagram

The diagram below shows the end-to-end issue → merge → deploy lifecycle, including which steps are performed by agents (blue) and which require a human decision (green). Label-driven triggers are shown on the edges.

```mermaid
flowchart TD
    Start([User opens GitHub issue]):::human --> GroomLabel{"Apply <code>agent:groom</code>?"}:::human

    GroomLabel -- "yes" --> Groom["<b>Grooming agent</b><br/>(AGENT_ACTION=groom)<br/>classifies issue, adds labels,<br/>asks clarifying questions"]:::agent
    GroomLabel -- "no" --> DevLabel
    Groom --> DevLabel{"Apply <code>agent:developer</code>?<br/>(user must be in AGENT_ALLOWLIST)"}:::human

    DevLabel -- "no" --> Wait([Wait for user]):::human
    Wait -- "agent:developer applied later" --> DevLabel
    DevLabel -- "yes" --> Implement["<b>Developer agent</b><br/>(AGENT_ACTION=implement)<br/>creates <code>agent/issue-{N}</code>,<br/>implements solution, opens PR"]:::agent

    Implement --> CI{"CI checks pass?"}:::system
    CI -- "no" --> FixChecks["<b>Developer agent</b><br/>(AGENT_ACTION=fix-checks)<br/>diagnoses failures,<br/>pushes fixes"]:::agent
    FixChecks --> CI

    CI -- "yes" --> Review{"PR review submitted"}:::human
    Review -- "changes requested" --> Respond["<b>Developer agent</b><br/>(AGENT_ACTION=respond-review)<br/>addresses feedback,<br/>pushes updates"]:::agent
    Respond --> CI

    Review -- "approved (≥1 human review; admins may bypass)" --> Merge["Human squash-merges PR to <code>main</code><br/>(issue auto-closed by <code>Closes #N</code> on merge)"]:::human
    Merge --> Deploy{"Deployment succeeds?"}:::system

    Deploy -- "no" --> FixDeploy["<b>Developer agent</b><br/>(AGENT_ACTION=fix-deployment)<br/>diagnoses failure,<br/>opens fix-up PR"]:::agent
    FixDeploy --> CI

    Deploy -- "yes" --> Done([Deployment successful]):::system

    classDef human fill:#d4edda,stroke:#155724,color:#155724
    classDef agent fill:#cfe2ff,stroke:#084298,color:#084298
    classDef system fill:#fff3cd,stroke:#664d03,color:#664d03
```

Notes on the diagram:

- **Human gates** (green) are the only places a person is required: opening the issue, applying `agent:*` labels, submitting a PR review, and squash-merging. Branch protection on `main` requires at least one human review before merge for non-admins — agents cannot self-approve. Repository admins can bypass the review requirement and merge via PR without a prior review (see the Terraform ruleset note in the Setup section).
- **Agent steps** (blue) each run as a fresh container invocation of the developer agent image with a specific `AGENT_ACTION`. See [AGENTS.md](AGENTS.md#agent-actions) for the required env vars per action.
- **System checks** (yellow) are automated (GitHub Actions workflow checks, deployment status events) and drive the feedback loops back into the agent. **Note:** the CI failure feedback loop (`fix-checks`) requires a workflow named `CI` to exist in the repo — see the caveat in the "How it works" section above.
- `fix-deployment` re-enters the flow at the CI/checks stage because it opens a new PR that goes through the same CI → review → merge lifecycle as any other change (including the `fix-checks` feedback loop if checks fail).

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
# Edit terraform.tfvars:
#   repo_owner           — GitHub user or org that owns the repo
#   repo_name            — repository name (default: agentic-development-workflow)
#   agent_allowlist      — GitHub usernames permitted to trigger agent workflows
#   default_claude_model — repo-wide default Claude model (e.g. "sonnet")

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
- Apply branch protection on `main` via a repository ruleset (PR review required, no force pushes, no deletion, linear history — direct pushes to `main` blocked for everyone, admins included; admins can bypass review only via PR merges).
- Publish `AGENT_ALLOWLIST` and `DEFAULT_CLAUDE_MODEL` as repo-level Actions variables so workflows reference them without hardcoding values in YAML.
- Create the labels consumed by the agent workflows (`agent:developer`, `agent:groom`, `agent:review`, `model:sonnet`/`opus`/`haiku`, and the grooming labels `question`/`bug`/`enhancement`/`dependency upgrade`/`do`/`plan`) so they show up in the GitHub label picker on issue and pull request creation.

If `terraform apply` errors with `422 already_exists` on a default GitHub label (`bug`, `enhancement`, `question` — these ship pre-created on new repos), import them and re-apply:

```bash
terraform import 'github_issue_label.automation["bug"]'         "$(terraform console <<<'var.repo_name' | tr -d '"'):bug"
terraform import 'github_issue_label.automation["enhancement"]' "$(terraform console <<<'var.repo_name' | tr -d '"'):enhancement"
terraform import 'github_issue_label.automation["question"]'    "$(terraform console <<<'var.repo_name' | tr -d '"'):question"
```

App private keys are deliberately **not** managed by Terraform — keeping them out of `terraform.tfstate` is the whole point. Set them as repo Actions secrets out of band (next step).

### 3. Set App credentials and API keys as Actions secrets

Run once after `terraform apply`, and again whenever you rotate a key:

```bash
# Required — used by all current agent workflows
gh secret set DEVELOPER_APP_ID         --body "<developer App ID>"
gh secret set DEVELOPER_APP_PRIVATE_KEY < ~/.config/agentic-agents/developer-agent.pem
gh secret set ANTHROPIC_API_KEY        --body "<anthropic api key>"

# Optional — for the reviewer agent (not yet wired into any workflow)
gh secret set REVIEWER_APP_ID          --body "<reviewer App ID>"
gh secret set REVIEWER_APP_PRIVATE_KEY < ~/.config/agentic-agents/reviewer-agent.pem
```

Workflows use `DEVELOPER_APP_ID` / `DEVELOPER_APP_PRIVATE_KEY` to mint short-lived installation tokens at runtime and pass `ANTHROPIC_API_KEY` through to the container. The `REVIEWER_APP_*` secrets are set here for completeness but are not consumed by any current workflow — set them when the reviewer agent lands.

### 4. Build the developer agent container

The image is built on-demand inside each workflow (see [`.github/workflows/`](.github/workflows/)). To build locally for testing:

```sh
docker build -t agent-developer ./docker
```

Run locally against an issue (example — `AGENT_ACTION=implement`):

```sh
docker run --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e GH_TOKEN="$GH_TOKEN" \
  -e GITHUB_REPO="owner/repo" \
  -e AGENT_ACTION="implement" \
  -e GITHUB_ISSUE_NUMBER="1" \
  -e CLAUDE_MODEL="sonnet" \
  agent-developer
```

See [AGENTS.md](AGENTS.md#agent-actions) for the full matrix of `AGENT_ACTION` values and their required env vars.

## Status

MVP substantially built. Implemented:

- Developer agent container with five actions: `implement`, `groom`, `fix-checks`, `respond-review`, `fix-deployment`.
- Grooming agent with label criteria in [`agents/grooming/label-criteria.json`](agents/grooming/label-criteria.json).
- GitHub Actions workflows for each action under [`.github/workflows/`](.github/workflows/).
- Terraform for repo settings, `main` branch-protection ruleset, and repo-level `AGENT_ALLOWLIST` / `DEFAULT_CLAUDE_MODEL` Actions variables.
- Per-issue Claude model override via `model:<name>` labels.

Pending: reviewer agent container, and a dedicated local-run guide for developer and reviewer agents.
