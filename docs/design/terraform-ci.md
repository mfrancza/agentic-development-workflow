# Design: Terraform CI pipeline

**Issue:** [#255](https://github.com/mfrancza/agentic-development-workflow/issues/255)

## Summary

Add a GitHub Actions pipeline that runs `terraform fmt -check`,
`terraform validate`, and `terraform plan` on every PR that touches
`terraform/**`, posts the plan output as a PR comment for reviewer
visibility, and auto-applies on push to `main`. The pipeline replaces
the current local-only workflow (an operator runs `terraform apply`
from their laptop with a personal `GITHUB_TOKEN`) — that flow drifts
easily, has no plan review, and makes state changes invisible to
reviewers.

Scope-shaping requirements from the maintainer's grooming answer:
GitHub Actions; propose best-practice stages; auto-apply on merge; one
environment (this repo); credentials via GHA secrets; the state
backend is part of scope; target directory is `terraform/`.

## Requirements as understood

From the grooming Q&A on issue [#255](https://github.com/mfrancza/agentic-development-workflow/issues/255):

1. **CI system** — GitHub Actions.
2. **Stages** — Not specified in advance; the design proposes them.
   Baseline set for a Terraform pipeline: `fmt -check`, `validate`,
   `plan` (PR), `apply` (main).
3. **Apply behavior** — Auto-apply on merge to `main`. No extra
   approval gate on top of what branch protection already enforces
   (branch protection already requires one human review before any
   PR merges to `main`, so every apply has already been reviewed by
   construction).
4. **Environments** — One (this repo). No dev/staging/prod matrix.
5. **Credentials** — Stored as GHA secrets.
6. **State backend** — Not currently configured (local state on the
   operator's laptop). Setting up a remote backend is part of this
   work.
7. **Target directory** — `terraform/` in this repo.

### Resolved ambiguities

- **Which stages to run.** The issue does not fix the stage list, so
  this design picks the standard baseline: `fmt -check`, `validate`,
  `plan` with PR-comment output on pull requests; `init`, `plan`,
  `apply` on push to `main`. `tflint` / `tfsec` / `checkov` are not
  in scope; they can be added later as extra jobs without changing
  the pipeline shape.
- **What "auto-apply" means.** The pipeline applies without a
  workflow-level approval step, but the `main`-branch protection
  ruleset (`terraform/modules/branch-protection/main.tf`) already
  requires one approving human review before any PR can merge —
  so every auto-apply corresponds to a human-approved plan. No
  separate GitHub `environment` protection rule is added; see
  Decision 3.
- **Which identity terraform runs as in CI.** The grooming answer
  says "GHA secrets" but does not say "a PAT". The repo already has
  a strong convention (see AGENTS.md **Repo-specific security
  defaults**, *Least-privilege tokens*) that automation uses
  short-lived tokens minted from GitHub Apps, not PATs. This design
  extends that convention by adding a dedicated `terraform-ci`
  App identity — Decision 2. The App is named `terraform-ci` (not
  `terraform-agent`) because the `-agent` suffix in this repo is
  reserved for AI-agent-backed automation (developer-agent,
  reviewer-agent); the terraform-ci App runs a deterministic
  Terraform pipeline, not an LLM, so a different name makes the
  automation type immediately readable.
- **Which remote state backend.** The issue leaves this open. This
  design proposes HCP Terraform (Terraform Cloud) as a
  state-only backend — Decision 1. S3+DynamoDB was considered and
  rejected because it drags in an AWS account the repo does not
  otherwise need.

## Decisions

### Decision 1: state backend — HCP Terraform in state-only mode

Terraform state must live somewhere remote and lockable before CI can
run `plan` / `apply` — otherwise concurrent runs (CI, a local operator
during migration, a second CI run on a rapid double-merge) will
race and corrupt the state file. Four options were considered:

- **(a) HCP Terraform ("Terraform Cloud"), state-only** *(chosen)*.
  Native state locking, free for individual users, no cloud-provider
  account required. Terraform runs in GitHub Actions (per the
  grooming answer); HCP is used only as a state backend, not as a
  runner. Sole extra dependency is one `TF_API_TOKEN` GHA secret and
  a `cloud {}` block in `terraform/main.tf`.
- **(b) S3 + DynamoDB for state and locking.** Battle-tested but
  requires an AWS account, an IAM user or OIDC federation, a bucket
  with versioning + SSE, and a DynamoDB table for locking — none of
  which this repo currently needs. Rejected: adds a whole cloud
  vendor for one file.
- **(c) State file committed to the repo.** Rejected outright:
  Terraform state can contain resource attributes that are useful
  reconnaissance for an attacker, git provides no locking, and the
  file changes on every apply which turns every merge into a state
  bump PR. This is a well-known anti-pattern.
- **(d) GitHub Actions cache / artifact.** Rejected: caches are
  evicted (7-day inactivity, or ~10 GB per-repo limit), artifacts
  have no locking primitive, and there is no atomic
  compare-and-swap for updates. State corruption is a matter of
  when, not if.

Chosen: (a). The state file for this repo contains only public
information (repo settings, labels, branch-protection rules,
Actions-variable *values* — not the API-key secrets they hold), so
the trust surface of HCP is narrow. The workspace is configured with
**execution mode = local** — HCP only stores state and holds the
lock; every plan and apply runs in the GitHub Actions runner where
the workflow's short-lived App token and provider environment live.

### Decision 2: CI identity — a new `terraform-ci` GitHub App

The current local flow uses `GITHUB_TOKEN=$(gh auth token)` — the
operator's personal token, with whatever scopes their PAT has. In CI,
that pattern would need to become either (a) a PAT stored as a GHA
secret, (b) reuse of the existing `developer-agent` App, or (c) a
new App identity. Three options were considered:

- **(a) PAT stored as `TERRAFORM_GITHUB_TOKEN`.** Simplest, but PATs
  are long-lived, tied to a human account, and hard to rotate. This
  contradicts AGENTS.md's *Least-privilege tokens* default (short-lived
  installation tokens minted per run) and the repo's separation of
  human vs. agent identities.
- **(b) Reuse the `developer-agent` App.** The developer-agent App
  deliberately does **not** hold `administration:write` (see
  AGENTS.md *Manual repository settings*, first paragraph: "No
  identity holds administration:write in Actions"). Terraform needs
  admin scope to manage the branch-protection ruleset, the
  `security_and_analysis` block, and the `github_actions_repository_permissions`
  resource. Widening the developer-agent App to hold admin scope
  breaks the least-privilege boundary that keeps a compromised
  developer-agent run from being able to weaken branch protection
  or the actions policy — the exact attack the reviewer-agent /
  developer-agent split was designed to contain.
- **(c) New `terraform-ci` App with only the scopes Terraform
  needs** *(chosen)*. Scopes: `Administration: R/W` (repo settings,
  branch protection, security_and_analysis, actions permissions);
  `Metadata: R`; `Contents: R` (nothing else in this App needs to
  write files); `Issues: R/W` (label management); `Actions: R/W`
  (Actions variables). No `Pull requests`, no `Workflows` — the
  App neither opens PRs nor edits workflow files. The App's private
  key and Client ID become the `TERRAFORM_APP_ID` and
  `TERRAFORM_APP_PRIVATE_KEY` GHA secrets. The workflow mints a
  short-lived installation token via the existing
  [`.github/actions/agent-token`](../../.github/actions/agent-token/action.yml)
  composite action and exports it as `GITHUB_TOKEN` for the
  `integrations/github` provider.

  **This is a conscious, narrow exception to the AGENTS.md principle
  "No identity holds `administration:write` in Actions."** The
  principle exists to prevent a compromised workflow run on
  unreviewed code from weakening branch protection or the actions
  policy. The exception is acceptable here because the
  terraform-ci App is only used by `terraform-ci.yml`, and that
  workflow uses the token asymmetrically:
    - On the **plan job** (fired from `pull_request_target` — see
      the threat-model discussion below for why not `pull_request`),
      the token is used **read-only from a GitHub API perspective** —
      the `integrations/github` provider performs a state refresh
      (reads current resource attributes to compute the plan), and
      the plan-comment activity posts a PR comment via `Issues: R/W`
      (`pulls/{n}/comments` is served by the issues API for PR
      conversation comments). Neither call exercises the
      `Administration: R/W` scope, and the workflow does **not** run
      `terraform apply` on this trigger.
    - On the **apply job** (`push` to `main`), admin writes can
      occur — but this trigger only fires post-merge, and branch
      protection requires one approving human review before any
      merge (Decision 3). So every admin-scope write in this
      pipeline corresponds to a human-approved plan.

  The safeguard is that admin writes only occur after a
  human-approved merge to `main`; the trade-off (accepted by this
  design) is that any bug or compromise in the apply-job path of
  `terraform-ci.yml` itself — which is workflow code and must
  therefore also go through PR review under branch protection —
  would have admin-level access to the repository.

  **Threat model: token exfiltration via workflow modification on a
  PR head.** A minted App installation token is a short-lived bearer
  credential exposed as `GITHUB_TOKEN` inside the runner. Any code
  the runner executes on the plan job — inline `run:` steps, called
  actions, TypeScript activities, Terraform providers loaded during
  `init` — has read access to that token's value in the process
  environment. GitHub's Actions runtime does not sandbox secrets
  away from user steps; the runner's log-masking only prevents the
  literal token string from appearing in logs, not exfiltration via
  outbound HTTP, base64-mangled logs, or writes to the artifact
  store. The relevant question is therefore not "can workflow code
  see the token?" (yes, always) but "whose workflow code runs, and
  under what review gate?"

  The concrete attack path this design guards against is: a PR head
  modifies `.github/workflows/terraform-ci.yml`, `.github/scripts/src/terraform-plan-comment.ts`,
  or an inline `run:` step to send the minted token to an attacker
  endpoint before the PR is reviewed and merged. Mitigations, from
  strongest to weakest:

    1. **Plan job trigger = `pull_request_target`, not `pull_request`.**
       This is the single most important mitigation and the reason
       Decision 4's table lists `pull_request_target` for the plan
       job. Under `pull_request_target`, GitHub always resolves the
       workflow YAML (and any local composite actions the workflow
       references by path, i.e. `.github/actions/**`) from the
       **base branch tip**, not from the PR head. A PR that modifies
       `terraform-ci.yml` or `.github/scripts/**` cannot cause the
       modified copy to run on the plan job — the modification only
       takes effect once the PR is merged and the change becomes
       part of the base branch (which is exactly the human-review
       gate the AGENTS.md principle wants). This is the same idiom
       [`agent-review.yml`](../../.github/workflows/agent-review.yml)
       uses for exactly the same reason (see the header comment on
       that file). The plan job explicitly checks out the PR head
       with `ref: ${{ github.event.pull_request.head.sha }}` and
       `persist-credentials: false` so the base-branch workflow
       runs `terraform plan` against the PR-head Terraform code
       without giving that code access to the workflow's own
       credentials via checkout persistence.
    2. **Fork-headed PRs are excluded on the plan job.** Under
       `pull_request_target`, secrets are available to same-repo
       PRs by default; fork PRs go through the fork-PR approval
       policy (`all_external_contributors`, see AGENTS.md
       *Manual repository settings*). The plan job's `if:` guard
       additionally requires
       `github.event.pull_request.head.repo.full_name == github.repository`
       so a fork PR whose Terraform diff would trigger the plan
       cannot run against the terraform-ci token even if a
       maintainer approves the workflow — this matches the belt-and-braces
       pattern already used by `agent-review.yml`. Collaborators
       who need to plan a fork's Terraform changes must cherry-pick
       the diff onto a same-repo branch first (also the reviewer's
       pattern).
    3. **`patterns_allowed` remains restrictive.** The actions
       allowlist (`hashicorp/setup-terraform` per Decision 6, plus
       whatever the pipeline already needs) constrains which
       external actions the workflow can call. A modified inline
       `run:` step cannot introduce a new `uses:` for
       `evil-user/exfil-action` without also expanding
       `patterns_allowed` in `terraform/main.tf`, which is
       Terraform code that goes through the same PR review gate.
    4. **Base-branch-enforced Terraform provider allowlist gate.**
       Terraform providers are the second source of arbitrary code
       execution the plan job runs against PR-head content
       (`hashicorp/external`, or a fresh provider whose plugin
       shells out during `plan`, are the obvious escape hatches).
       Before `terraform init` runs, the plan job executes a
       "provider-allowlist" step that parses the PR head's
       `.terraform.lock.hcl` and every `required_providers` block
       under `terraform/**` and fails the job unless every provider
       source appears on a hardcoded allowlist. The allowlist is
       initially just `registry.terraform.io/integrations/github`
       and lives in the plan job's YAML (or in a small script the
       plan job calls); because the plan job's workflow file and
       any local composite actions it references are resolved from
       the base branch under `pull_request_target`, the PR under
       inspection cannot modify the gate that inspects it. Adding
       a provider therefore requires a **base-branch** change to
       the allowlist — workflow code that goes through the same PR
       review gate as `patterns_allowed` in mitigation #3. This
       converts "reviewers must flag provider additions as
       security-relevant" from a standing vigilance obligation
       into a red X on the PR check, matching this repo's
       fail-loud-machine-gate posture elsewhere with review as the
       second layer.

       *Optional hardening (deferred, considered):* the runner
       could be pre-seeded with only allowlisted provider binaries
       and `terraform init -plugin-dir=<dir>` used to disable
       registry downloads entirely, making the constraint
       structural (Terraform simply cannot load a provider that
       isn't on disk) rather than grep-based. Not chosen for the
       initial implementation because the grep-based allowlist
       gate above is sufficient given the `pull_request_target`
       base-branch trust guarantee and involves no provider-binary
       caching or mirror infrastructure; the switch to
       `-plugin-dir` is a follow-up if the trust calculus changes
       or if the allowlist grows large enough that a manifest
       becomes easier to maintain than a grep list.
    5. **Trusted-collaborator boundary.** Same-repo push access is
       already required to open a PR that bypasses fork-PR
       approval. Anyone with push access is trusted at the same
       level as anyone who could merge to `main` — this is the
       repo's existing threat model for the developer-agent and
       reviewer-agent tokens as well.

  Residual risk this design **does not** eliminate: with the
  base-branch provider allowlist gate above, exfiltrating the
  token via a provider addition to `.terraform.lock.hcl` now
  requires a **base-branch** change to expand the allowlist
  (i.e. a reviewed workflow or gate-script change), not just a
  reviewed lockfile change on the PR head — so the residual
  shrinks to "a trusted collaborator with push access lands a
  reviewed change to the plan job's workflow YAML, the
  allowlist, or the gate script itself that opens the exfil
  surface (e.g. widens the allowlist to a code-executing
  provider, or removes/weakens the gate step)." Detecting that
  is the same PR review that gates every workflow-touching
  change under branch protection, and is a strict subset of the
  trust the repo already places in same-repo collaborators.

Chosen: (c). Creating a third App is a one-time manual bootstrap
step — the same pattern the repo already documents for the developer
and reviewer Apps (README §1). The bootstrap steps are listed in the
sub-issue for identity setup and mirrored into README §1.

The `TERRAFORM_APP_ID` / `TERRAFORM_APP_PRIVATE_KEY` secrets are used
by both the plan and apply jobs — the plan job could in principle
use a narrower read-only identity (a second App with the write
scopes downgraded to read), which would further narrow the exfil
blast radius even if the base-branch trust guarantee above failed.
This was not chosen because (i) Terraform state refresh on the plan
job needs `Administration: R` to read current branch-protection
attributes, and every other scope drops similarly to R-only, so the
narrower App is not trivially a subset of the full App's non-write
scopes — it's a second bootstrap surface; and (ii) the
`pull_request_target` trust guarantee already prevents PR-authored
code from running on the plan job, so the additional identity is
belt-and-braces for a threat the trigger choice already blocks. A
single App identity for both jobs is the simpler design; splitting
into `terraform-ci-plan` (read-only) and `terraform-ci-apply`
(admin) is a follow-up refinement if the trust guarantee ever needs
strengthening (e.g. if a future change forces the plan job back
onto `pull_request`).

**Documented fallback of last resort — credential-less PR plans.**
Recorded here alongside the split-App follow-up so it is available
if the trust calculus changes (e.g. a forced move back to
`pull_request`, or a class of Terraform provider vulnerability that
the allowlist gate cannot distinguish): the plan job could mint no
App installation token at all and run `terraform plan -refresh=false`
against the HCP state backend using only the `TF_API_TOKEN`.
Because the GitHub provider would be given no credential and the
plan would skip the state-refresh call, the plan output is
drift-blind (any out-of-band change to a managed resource since
the last state refresh is invisible) but there is no App token
in the runner's process environment for a hostile provider or
`run:` step to exfiltrate. This is contingent on the Terraform
configuration having no plan-time data sources that call GitHub
(currently true — the config uses only `resource` blocks, no
`data "github_..."` blocks). Not adopted in v1 because the value
the plan comment provides to reviewers depends on the refresh
being live; documented as the escape hatch of last resort.

### Decision 3: apply gating — rely on branch protection, no extra approval gate

The maintainer explicitly said "auto apply". Two ways this could be
implemented:

- **(a) Apply immediately on push to `main`** *(chosen)*. The
  `main`-branch protection ruleset already requires (i) one
  approving review from a human, (ii) linear history, (iii) no
  direct pushes, (iv) no force-push. Every commit that lands on
  `main` has already been human-reviewed on a PR, so the plan the
  reviewer saw in the PR comment is the plan being applied. No
  extra approval step needed.
- **(b) Push apply through a GitHub `environment` (e.g.
  `production`) with a required reviewer.** Rejected: adds a
  second approval on top of the PR review, contradicting the
  "auto apply" answer. Would also require configuring the
  `environments/production/reviewers` list — another Terraform
  surface — for no gain over branch protection.

The apply job uses `concurrency: group: terraform-apply,
cancel-in-progress: false` so a second merge that lands while an
apply is running queues rather than cancels. Cancelling mid-apply
leaves the state file locked and requires manual `terraform force-unlock`.

The apply job also uses a **path filter** (`paths: ['terraform/**',
'.github/workflows/terraform-ci.yml']`) so a merge that does not
touch Terraform does not trigger an apply. This keeps state-refresh
noise low and avoids applying a plan that is stale relative to some
manual change (drift is detected by the next PR's plan step or by
a manual `workflow_dispatch`).

**Known limitation — stale-plan window.** The apply job runs its
own fresh `init → plan → apply -auto-approve` sequence rather than
persisting the plan artifact from the PR run and re-using it after
merge. This means the plan the apply job executes may differ from
the plan the PR reviewer saw if state drift occurred between the
PR's plan step and the post-merge apply (e.g. an out-of-band change
via a local `terraform apply`, or a rapid second merge that landed
first and shifted state). This is a standard Terraform CI trade-off:
the alternative — saving the PR's plan file as an artifact and
consuming it in the apply job — requires cross-workflow artifact
plumbing, tighter concurrency guarantees on the plan file's
freshness, and handling of the "plan artifact expired" edge case,
which is disproportionate for a single-environment repo whose only
expected drift source is the migration-period local apply. Apply
job logs must be inspected on any run whose diff looks unfamiliar
relative to the merged PR; the e2e validation sub-issue ([#428](https://github.com/mfrancza/agentic-development-workflow/issues/428))
covers checking this on the initial rollout.

### Decision 4: workflow shape — one `terraform-ci.yml` file with two jobs

Options considered:

- **(a) Single workflow `terraform-ci.yml` with a `plan` job (on
  `pull_request`) and an `apply` job (on `push: main`)** *(chosen)*.
  Both jobs share the same setup (checkout, install terraform,
  configure the App-minted token, `terraform init`). Keeping them
  in one file makes the whole pipeline visible at a glance and
  matches the shape of `secret-scan.yml`, which also fires on
  multiple event types from a single file.
- **(b) Two workflow files, `terraform-plan.yml` and
  `terraform-apply.yml`.** Rejected: two files with 90% overlap.
  Any change to `terraform` install or token minting has to be
  made in both files, so a review-and-drift hazard for no
  benefit.

The workflow also gets a `-reusable.yml` companion per the repo's
established pattern for every non-trivial workflow (see
[`docs/design/publish-reusable-workflows-and-modules.md`](publish-reusable-workflows-and-modules.md)),
so external consumers who adopt the terraform layout can call it
by `uses:` reference. The caller stub delegates to the reusable and
carries only the trigger configuration.

Job matrix:

| Job     | Trigger                                                                                                                                                                                                          | Steps                                                                                                                                                                                            | Token identity |
|---------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| `plan`  | `pull_request_target` (base-branch YAML runs, PR head checked out explicitly) with `paths: ['terraform/**', '.github/workflows/terraform-ci.yml']` and `if: head.repo.full_name == github.repository` — see Decision 2 threat-model discussion | checkout PR head with `ref: github.event.pull_request.head.sha` and `persist-credentials: false` → mint app token → setup-terraform → init → fmt -check -recursive → validate → plan → post plan comment | terraform-ci   |
| `apply` | `push` to `main` with same paths filter                                                                                                                                                                          | checkout → mint app token → setup-terraform → init → plan → apply -auto-approve                                                                                                                  | terraform-ci   |

### Decision 5: plan output visibility — TypeScript activity, not a third-party action

`terraform plan` output needs to reach the PR as a comment for
reviewers to see what will change. Three options:

- **(a) A dedicated `.github/actions/terraform-plan-comment/`
  composite action backed by a `.github/scripts/src/terraform-plan-comment.ts`
  activity** *(chosen)*. Reads the plan file (produced by
  `terraform show -no-color <plan-file>`), truncates to 60 KB
  (GitHub's PR-comment size limit is 65 536 characters — leaving
  headroom for the fenced-code wrapper and a "truncated"
  footer), finds any existing comment authored by the terraform-ci
  App identity and updates it in place (falling back to a new
  comment on the first PR run). Matches the repo's Workflow
  Activity Conventions (AGENTS.md).
- **(b) A third-party action like `robburger/terraform-pr-commenter`.**
  Rejected: not on the allowed-actions list, would require adding a
  new `patterns_allowed` entry for a third-party action, and would
  still need pinning + monitoring. The comment-post logic is small
  enough that owning it is cheaper than owning a dependency.
- **(c) `hashicorp/setup-terraform`'s `wrapper: true` mode +
  `actions/github-script`.** Rejected: `wrapper: true` captures
  stdout/stderr but does not itself write to `GITHUB_STEP_SUMMARY`
  or PR comments; we would still write the same comment-poster
  logic, just inline in the workflow YAML. Extracting it into
  `.github/scripts/` per the repo's shell-vs-TypeScript threshold
  (branching + parsing → TypeScript) is the more consistent
  option.

The comment is deliberately updated-in-place (single evergreen
comment per PR) rather than appended-per-push, to avoid a wall of
stale plans obscuring the current one. The activity uses the
terraform-ci App identity's `github.event.repository.owner.login`
+ `${TERRAFORM_APP_SLUG}[bot]` login pattern to find its own
previous comment — the same idiom the reviewer agent uses to find
its own review.

The concrete source of `TERRAFORM_APP_SLUG` at workflow runtime
(hardcoded workflow env var vs. Actions variable vs. derived from
the minted installation token's `GET /app` response) is left to
the plan-comment activity implementation sub-issue ([#426](https://github.com/mfrancza/agentic-development-workflow/issues/426))
to resolve. The reviewer-agent's existing "find my own comment"
idiom is the reference implementation the sub-issue should follow.

### Decision 6: pin `hashicorp/setup-terraform` and add it to `patterns_allowed`

Terraform is not pre-installed on the `ubuntu-latest` runner image.
Two ways to get it:

- **(a) `hashicorp/setup-terraform@<sha>` action** *(chosen)*.
  Standard, well-maintained, supports version pinning, caches the
  binary between runs. Requires (1) a full-SHA pin in the
  workflow YAML and (2) an `hashicorp/setup-terraform` entry in
  `var.patterns_allowed` in the `module "actions_policy"` call
  in `terraform/main.tf` — same coordinated change already
  documented in AGENTS.md for `anthropics/claude-code-action`.
- **(b) `curl` the binary from releases.hashicorp.com in an
  inline `run:` step.** Rejected: reimplements what
  `hashicorp/setup-terraform` already does (arch detection,
  cache, checksum verification), and inlines a URL that the
  workflow author has to keep current. The action is the
  standard way and adding one `patterns_allowed` entry is not
  a meaningful policy expansion.

The Terraform version is pinned via an env var in the workflow
(`TF_VERSION: '1.9.0'` — matching the current
`required_version = ">= 1.6.0"` in `terraform/main.tf`; a
`.terraform-version` file is not added because it would need to
stay in sync with the workflow pin, and one source of truth is
better).

### Decision 7: state-migration bootstrap is a one-time manual step

Adding the `cloud {}` block to `terraform/main.tf` and running the
workflow will not automatically migrate the existing local state
into the HCP workspace. The maintainer must run:

```bash
cd terraform
terraform init -migrate-state
# Terraform will prompt: "Do you want to copy existing state? yes"
```

This step is unavoidable — Terraform does not migrate state on
`plan`/`apply`, only on `init`. The state-migration sub-issue's
body includes the exact command sequence. After migration the
local `terraform.tfstate` is left in place but no longer
authoritative; the sub-issue's checklist has the maintainer
delete it (adding a fresh entry to the `.gitignore` block for
`.terraform/` is already covered — see the existing `.gitignore`).

## Out of scope

- **Additional static-analysis tools** — `tflint`, `tfsec`,
  `checkov`, `terraform-docs`, and cost-estimation tools
  (Infracost). Each is a separate follow-up; the initial
  pipeline lands with the `fmt` + `validate` + `plan` baseline
  and can be extended.
- **Multi-environment matrix (dev / staging / prod)** — the
  grooming answer says "just one env"; no workspace or
  `terraform.tfvars` swapping is added.
- **Automatic drift detection** — no scheduled `terraform plan`
  cron job to alert on out-of-band changes. Drift shows up on
  the next PR's plan step. Adding a nightly drift-check
  workflow is a follow-up.
- **State-file access for humans other than the maintainer** —
  HCP workspace access management is out of scope. The
  maintainer is the sole HCP workspace owner; add
  collaborators via HCP's UI if that changes.
- **Reusable module for consumers** — the workflow follows the
  reusable-workflow pattern so external consumers *can* adopt
  it, but the state backend (HCP workspace name, organization)
  is repo-specific. Extracting a fully-parameterised reusable
  workflow is a follow-up that pairs with adopting.md updates.
- **Rotating the App private key on a schedule** — same
  cadence and manual process as the developer-agent and
  reviewer-agent keys. Not automated by this design.
- **Removing the current local-apply flow from the README** —
  the README's `terraform apply` snippet in §2 is still valid
  for first-time bootstrap (before the state moves to HCP).
  The state-migration sub-issue updates the README to note
  that ongoing applies happen in CI and local `apply` is only
  used for the migration itself.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#423](https://github.com/mfrancza/agentic-development-workflow/issues/423) | HCP Terraform state backend: create workspace (manual, human-required); add `cloud {}` block to `terraform/main.tf`; document `terraform init -migrate-state` bootstrap; add `TF_API_TOKEN` secret; update README §2. | — |
| [#424](https://github.com/mfrancza/agentic-development-workflow/issues/424) | `terraform-ci` GitHub App identity: create App (manual, human-required) with `Administration: R/W`, `Metadata: R`, `Contents: R`, `Issues: R/W`, `Actions: R/W`; install on repo; add `TERRAFORM_APP_ID` and `TERRAFORM_APP_PRIVATE_KEY` GHA secrets; update README §1 and §3. | — |
| [#425](https://github.com/mfrancza/agentic-development-workflow/issues/425) | Extend `actions-policy` allowlist: add `hashicorp/setup-terraform` to the `patterns_allowed` argument of `module "actions_policy"` in `terraform/main.tf`. | — |
| [#426](https://github.com/mfrancza/agentic-development-workflow/issues/426) | Terraform plan-comment activity: new `.github/scripts/src/terraform-plan-comment.ts` (upsert-single-comment logic keyed on the terraform-ci App bot login, 60 KB truncation) + `.github/actions/terraform-plan-comment/action.yml` composite wrapper + Vitest tests. | — |
| [#427](https://github.com/mfrancza/agentic-development-workflow/issues/427) | `terraform-ci.yml` + `terraform-ci-reusable.yml` workflow: `plan` job on `pull_request_target` (base-branch YAML runs, PR head checked out with `ref: github.event.pull_request.head.sha` and `persist-credentials: false`, `if:` guard requires `head.repo.full_name == github.repository` — see Decision 2 threat-model discussion) running **base-branch-enforced Terraform provider allowlist gate** (before `terraform init`; parses the PR head's `.terraform.lock.hcl` and every `required_providers` block under `terraform/**`, fails the job unless every provider source is on a hardcoded allowlist — initially just `registry.terraform.io/integrations/github` — with the allowlist living in the base-branch workflow YAML or a base-branch gate script so a PR cannot modify the gate that inspects it) → fmt -check → validate → plan → post comment; `apply` job on `push` to `main` (init → plan → apply -auto-approve); paths filter on `terraform/**` + `.github/workflows/terraform-ci.yml`; concurrency guard `terraform-apply`; `hashicorp/setup-terraform` pinned to a full SHA. Update AGENTS.md and README to describe the pipeline, secrets, manual bootstrap, and the trigger/trust rationale. | #423, #424, #425, #426 |
| [#428](https://github.com/mfrancza/agentic-development-workflow/issues/428) | End-to-end validation: open a small terraform-only PR (e.g. tweak a label description), verify fmt / validate / plan run and the plan comment appears; merge; verify apply runs and updates the label; confirm the plan on the following PR matches the expected drift-free state. | #423, #424, #425, #426, #427 |

All four foundation tasks (state backend, App identity, actions-policy, plan-comment activity) are independent and can proceed in parallel — the workflow sub-issue is the join point that consumes all of them. The e2e validation sub-issue depends on the workflow being live end-to-end.

Dependencies are recorded natively as GitHub blocked-by relationships on the issues after they are created.
