# Design: Publish reusable GitHub workflows and Terraform modules

**Issue:** [#256](https://github.com/mfrancza/agentic-development-workflow/issues/256)

## Summary

Refactor the repository so the pieces that make up this issue-based SDLC —
GitHub Actions workflows, composite actions, container images, and Terraform
infrastructure — become **published, versioned artifacts** that other repos
can adopt one component at a time.

The proposed changes are:

1. Split `terraform/main.tf` into small, single-purpose **Git-sourced Terraform
   modules** under `terraform/modules/*`, with a root-level example composing
   them for this repo's own use.
2. Publish the agent container images to **GHCR** on tag push. Teach the
   `run-agent` composite action to pull a pinned image tag instead of always
   building from `./docker/`.
3. Extract each `.github/workflows/agent-*.yml` file into a **reusable
   workflow** (`on: workflow_call`) plus a thin **caller stub** that responds
   to the same event and delegates via `uses: ./.github/workflows/…`. External
   consumers replace the stub with their own event-triggered file that calls
   `uses: mfrancza/agentic-development-workflow/.github/workflows/<name>.yml@v1`.
4. Fix the existing composite actions in `.github/actions/*` so they are
   consumable from another repo — the TypeScript activities currently expect a
   working directory in the caller's checkout, which does not exist there.
5. Adopt **semver git tags** (`v1.2.3` + moving `v1`) as the versioning
   contract, backed by a `release.yml` workflow that creates a GitHub Release
   and updates the moving major tag on each release.
6. Add a **consumer adoption guide** in `docs/adopting.md` covering the
   per-component checklist (secrets, Actions variables, labels, GitHub App
   permissions) and the wiring for each supported component.

Nothing about the SDLC behavior changes — this issue is about the
distribution shape.

## Requirements as understood

From issue #256, its grooming Q&A, and the owner's answers:

- The repo's GHA workflows and Terraform definitions must be **consumable from
  other repos**, so a fresh or existing repo can pick up the same
  issue-based SDLC.
- Adoption must be **component-by-component and relatively granular** — a repo
  should be able to bring only the grooming agent, or only the label set, or
  only the reviewer pipeline. Higher-level "bundle" components can be layered
  on later; they are not required at MVP.
- The design must **recommend** a publishing mechanism for both GHA workflows
  and Terraform modules, considering **ease of adoption** and **trust
  boundaries** — not merely list alternatives.
- The design must **recommend a versioning strategy** for consumers to pin
  against.
- The design must **recommend the refactor scope**: what moves where, and how
  the resulting directory layout supports publishing.

### Ambiguity resolutions

- **"Publish to Terraform Registry?"** — Rejected in favour of **Git-sourced
  modules** (`git::https://…//path?ref=v1.0.0`). The Terraform Registry
  requires a repo per module named `terraform-<provider>-<name>`, which is
  incompatible with this monorepo layout and would force a set of new
  siblings. Git-sourced modules give the same version-pinning contract with
  zero infrastructure. See Decision 2.
- **"One dedicated repo per component or keep in this repo?"** — Keep in
  this repo. Reusable workflows and composite actions can be referenced
  cross-repo via `owner/repo/.github/workflows/<name>.yml@v1` and
  `owner/repo/.github/actions/<name>@v1` respectively; there is no adoption
  benefit from fragmenting the source. See Decision 1.
- **"Container images: rebuild in the caller repo or publish?"** — Publish.
  A reusable workflow called from a consumer repo does not have `./docker/`
  in its workspace, so the current `docker build ./docker` step in
  `run-agent` cannot work as-is when called externally. Publishing to GHCR at
  release time gives consumers a fast (`docker pull`) start and preserves the
  option to build from source for dev-time runs. See Decision 4.

## Component inventory

The units below are the granularity we publish. Each is independently
adoptable and independently versioned via the same tag on this repo.

### Terraform modules (`terraform/modules/*`)

| Module | Contents (from today's `terraform/main.tf`) |
|--------|----------------------------------------------|
| `labels` | `github_issue_label.automation` and the `automation_labels` local map (agent trigger labels, model labels, grooming labels, workflow labels, lifecycle labels). |
| `agent-vars` | `AGENT_ALLOWLIST`, `DEFAULT_MODEL`, `ADMIN_ASSIGNEES`, `CODE_REVIEWERS`, `AUTO_TRIGGER_AGENTS` Actions variables. |
| `branch-protection` | `github_repository_ruleset.main` (`main-protection`). |
| `actions-policy` | `github_actions_repository_permissions.this` (`allowed_actions = "selected"` + GitHub-owned-only pattern list). |
| `security` | `github_repository_vulnerability_alerts.this` plus a re-exposed helper for the `security_and_analysis` block on the caller's `github_repository` resource (documented as a snippet — the block itself is on the repo resource which the caller owns). |

The `github_repository.this` resource itself is **not** modularized: it stays
part of the root composition (or the caller's own root), because adoption
patterns differ (existing repo → `terraform import`, new repo → `resource
"github_repository" "this" { … }`) and squeezing both into a module adds more
surface than it saves. Modules operate against a `repository = <name>` input.

### GHA reusable workflows (`.github/workflows/agent-*.yml`, `on: workflow_call`)

Reusable variants of every workflow in `.github/workflows/`, one per
workflow:

- Agent-container workflows (each dispatches an `AGENT_ACTION`):
  `agent-groom`, `agent-design`, `agent-implement`, `agent-review`,
  `agent-respond-review`, `agent-fix-checks`, `agent-fix-deployment`,
  `agent-resolve-conflicts`.
- Non-container workflows: `agent-pr-merged`, `agent-auto-trigger`.
- Support workflows: `ci` (typecheck + vitest for the shared TS package),
  `secret-scan` (gitleaks history scan).

Each `workflow_call` file declares typed `inputs:` (e.g. `image-tag`,
`default-model`, `code-reviewers`) and `secrets:` (the App private key
inputs plus provider API keys). No secret is hard-coded in the reusable
file; the caller wires them in.

### GHA composite actions (`.github/actions/<name>/`)

The existing composite actions are already published-shaped (single-purpose,
`action.yml` + optional TypeScript source). They need one portability fix
(Decision 5) but are otherwise ready to be consumed via
`uses: mfrancza/agentic-development-workflow/.github/actions/<name>@v1`.

### Container images (GHCR)

- `ghcr.io/mfrancza/agentic-development-workflow/developer:<tag>`
- `ghcr.io/mfrancza/agentic-development-workflow/reviewer:<tag>`

Tags follow the repo's git tags: `v1.2.3` (exact), `v1` (moving major),
`main` (bleeding edge, for internal use only).

## Decisions

### Decision 1 — GHA publishing mechanism: reusable workflows + composite actions, in-repo

**Decision.** Publish two GitHub Actions primitives from this same repo:

1. **Reusable workflows** (`on: workflow_call`) for whole-agent pipelines,
   referenced as
   `uses: mfrancza/agentic-development-workflow/.github/workflows/<name>.yml@v1`.
2. **Composite actions** for finer-grained pieces (`agent-token`,
   `resolve-model`, `run-agent`, all the preflight helpers), referenced as
   `uses: mfrancza/agentic-development-workflow/.github/actions/<name>@v1`.

Consumers with an off-the-shelf need adopt the reusable workflow via a
~10-line caller stub. Consumers with a customized event flow (e.g. wanting
to combine allowlist gating with their own preflight) skip the reusable and
compose the composite actions inside their own workflow.

**Alternatives considered.**

- **Extract to a dedicated repo per component.** Rejected: cross-repo action
  references already exist as first-class GitHub features (`owner/repo/…@ref`
  works for both workflows and composite actions), so splitting the source
  adds N releases to coordinate for zero adoption benefit. Consumer
  ergonomics are identical either way (one `uses:` line per component). If
  we later need per-component release cadence, we can split without changing
  the consumer contract by keeping the same tag surface on new repos, but
  there is no evidence that pressure exists today.
- **Copy-paste templates only.** Rejected: no shared upgrade path. Bug fixes
  in the shared logic (e.g. the allowlist gate, the `check-blockers`
  action) would have to be manually reapplied by every consumer.
- **Reusable workflows only, no composite actions published.** Rejected:
  loses the "component-by-component" granularity requirement. A consumer
  that wants only the model-label resolver would have to pull in an entire
  agent pipeline.

**Trust boundary.** Reusable workflows run in the caller repo's context.
GitHub does not expose the caller's secrets to the source repo, and the
caller's `GITHUB_TOKEN` is what the reusable workflow sees. Consumers
choose which secrets to pass via `secrets:` (either explicitly or
`secrets: inherit`). Version pinning at a tag (or SHA — see Decision 6)
gives consumers control over what code runs.

### Decision 2 — Terraform publishing mechanism: Git-sourced modules

**Decision.** Publish each Terraform module as a directory under
`terraform/modules/<name>/` in this repo, consumed via:

```hcl
module "agent_labels" {
  source = "git::https://github.com/mfrancza/agentic-development-workflow.git//terraform/modules/labels?ref=v1.0.0"
  repository = github_repository.this.name
}
```

**Alternatives considered.**

- **Terraform Registry publication.** Rejected: the Registry requires a
  dedicated public repo per module, named
  `terraform-<provider>-<name>`, with a specific tag scheme. That would
  fragment source (five modules → five new repos) and force a repo rename
  for the primary source. Marginal ergonomic gain over the Git-sourced form
  (`source = "mfrancza/labels/github"` vs. the URL above) does not justify
  it.
- **Private Terraform Registry (Terraform Cloud).** Rejected: adds a paid
  dependency for consumers, and does not solve any problem the Git-sourced
  form does not already solve.
- **Copy-paste (`terraform/` files as templates only).** Rejected: same
  reason as the workflow copy option — no shared upgrade path.

**Trust boundary.** Terraform's `git::` module source honours the `ref=`
query parameter, so consumers pin to a tag or a full commit SHA. Modules
receive only the variables the caller passes; there is no ambient state
sharing. The caller's `GITHUB_TOKEN` (or provider config) is what the
module uses.

### Decision 3 — Component granularity: fine-grained modules and workflows

**Decision.** Each Terraform module owns one concern (labels; Actions
variables; branch protection; Actions policy; security settings), and each
reusable workflow owns one SDLC transition (groom, design, implement,
review, respond, fix-checks, fix-deployment, resolve-conflicts,
auto-trigger). No composite bundle modules or workflows are shipped in this
change; higher-level bundles can be added later as the community consumer
patterns emerge, as the owner indicated.

**Rationale.** Fine granularity is what the owner asked for
("relatively granular components so repos using it can adapt themselves to
a wide variety of workflows"). A repo that only wants the grooming agent
picks up the `labels` and `agent-vars` modules and the `agent-groom`
reusable workflow, and stops there. A repo that only wants to enforce the
`main-protection` ruleset can adopt only that Terraform module.

The one place fine-graining costs is documentation: five modules and eleven
reusable workflows is a longer table than one bundle. Addressed by the
adoption guide (Task G).

### Decision 4 — Container image distribution: publish to GHCR at release time

**Decision.** On every git tag push matching `v*`, a new
`release-images.yml` workflow builds `docker/Dockerfile` and
`docker/reviewer/Dockerfile` and pushes them to GHCR under:

- `ghcr.io/mfrancza/agentic-development-workflow/developer:<tag>`
- `ghcr.io/mfrancza/agentic-development-workflow/reviewer:<tag>`

Each image is tagged with the exact version (`v1.2.3`) and the moving major
(`v1`) at release time. A separate `push: branches: [main]` trigger in the
same workflow additionally rebuilds and pushes the `main` tag on every
commit to the default branch, so `ghcr.io/…/developer:main` and
`ghcr.io/…/reviewer:main` genuinely track the tip of `main` between
releases. This `main` tag is used by this repo's own self-hosted workflows
during dev and is not part of the public pinning contract in Decision 6.

The `run-agent` composite action grows an `image` input. When set (the
external-consumer path), the composite runs `docker pull` and `docker run
<image>` — no build. When empty (the current path, used by this repo's own
workflows), the composite falls back to `docker build "${build-context}"`,
preserving today's behaviour for source-repo runs. The behaviour is
selectable per-workflow so a consumer can also choose to build from source
locally (e.g. after forking).

**Alternatives considered.**

- **Always build from source in the reusable workflow.** Rejected: forces
  the reusable workflow to first check out this source repo at the pinned
  tag, doubling checkout time and paying the ~2-5 minute `docker build`
  every run. Trust-boundary neutral (the source repo is trusted at the tag
  either way), but bad ergonomics.
- **Publish only `latest` / `main` tags.** Rejected: breaks the pinned
  version contract established in Decision 6. A consumer pinning at `@v1`
  for their workflow must be able to pin at `v1` for the image too.

**Trust boundary.** GHCR is public for public packages by default; images
are signed by the GHCR provenance flow (`actions/attest-build-provenance`
can be added as a follow-up if attestation becomes a requirement).
Consumers can point at a fork's image via the `image` input if they want to
control the container binary end-to-end.

### Decision 5 — Composite action portability: reference the action's own directory

**Decision.** Every composite action that runs the shared TypeScript package
(`.github/scripts/`) must reference it via `${{ github.action_path }}/../../scripts`
rather than the current `working-directory: .github/scripts` or
`${{ github.workspace }}/.github/scripts`. The former resolves inside the
action's own checked-out directory tree (works both when the action is
`./.github/actions/…` locally and `owner/repo/.github/actions/…@ref`
remotely); the latter two only work when the caller's workspace happens to
contain a matching `.github/scripts/` directory — true for this repo, false
for a consumer repo.

**Rationale.** GitHub materializes a composite action's containing repo
under `_actions/owner/repo/<ref>/…` when the action is fetched from
elsewhere, and `${{ github.action_path }}` resolves to that path. Sibling
directories (`.github/scripts/`) are available via a relative walk. This is
the standard portability fix for shared-package composite actions.

The self-hosted case (this repo consuming its own actions via `./…`) is
unaffected: `github.action_path` still resolves to the workspace-local
path, and the relative walk still lands on the same `.github/scripts/`.

**Scope of the fix.** Every `.github/actions/*/action.yml` that runs
`npm ci` or `npx tsx` in `.github/scripts` — inventory today:
`apply-unblocked-labels`, `check-blockers`, `check-draft-label`,
`check-reviewer-feedback`, `dismiss-stale-reviewer-reviews`,
`filter-agent-pr`, `find-conflicted-prs`, `find-existing-pr`,
`find-linked-issue`, `find-newly-unblocked`, `resolve-deployment`,
`resolve-model`, `resolve-review-threads`. The `agent-token` and
`run-agent` composites are pure-YAML/shell and unaffected.

### Decision 6 — Versioning: semver tags with a moving major tag

**Decision.** Adopt semantic versioning. Every release is a git tag
matching `v<major>.<minor>.<patch>` (e.g. `v1.2.3`). A moving tag `v<major>`
(e.g. `v1`) is force-updated to point at the newest release within that
major on each release, giving consumers three pinning options:

| Pin | Consumer references | Semantics |
|-----|--------------------|-----------|
| Major (recommended) | `@v1` | Tracks patches and minor releases within `v1`. |
| Exact | `@v1.2.3` | Fully reproducible. |
| SHA | `@<40-char-sha>` | Maximally reproducible; opaque to humans. |

The `release.yml` workflow (Task F) is manually triggered
(`workflow_dispatch` with a `version` input) so a maintainer chooses the
version bump per release. It:

1. Validates the input matches `v<M>.<m>.<p>`.
2. Creates the git tag from the workflow's checked-out SHA (typically the
   tip of `main`).
3. Force-updates the moving `v<M>` tag to the same SHA.
4. Publishes a GitHub Release with autogenerated notes from
   `Release.generate-notes`.
5. Triggers image publication (Decision 4) via the created tag.

**Alternatives considered.**

- **Branch-based versioning (`@release/v1`).** Rejected: branches move
  silently. Consumers pinning at a branch cannot tell which commits they are
  running without inspecting the ref, and force-pushing over a branch is
  the standard footgun.
- **Only exact tags, no moving major.** Rejected: consumers who want
  patches-only-track have no clean way; they must either watch for tags
  manually or accept `main`.
- **CalVer (`2026.08.31`).** Rejected: semver is what consumers already
  read in every other action they consume (`actions/checkout@v7.0.0`,
  `anthropics/claude-code-action@…`); matching that idiom is worth more than
  the CalVer benefit of "date-obvious progress" for a workflow library.

**Backwards compatibility.** This repo has no existing tags, so v1.0.0 is
free of legacy constraints. Once v1.0.0 ships, breaking changes to a
reusable workflow's `inputs:` / `secrets:` contract, a Terraform module's
required variables, or the composite actions' inputs are major bumps.
Documentation drift or internal refactors that do not change the consumer
surface are patch bumps.

### Decision 7 — Refactor scope: restructure `terraform/`, add reusables alongside stubs, minimize workflow renames

**Decision.**

- **Terraform.** Restructure from a single `terraform/main.tf` to
  `terraform/modules/<name>/` per module (Decision 2), plus a top-level
  `terraform/main.tf` (or `terraform/examples/single-repo/`) that composes
  the modules for this repo's own use. `terraform mv` in a state-migration
  block (`moved { … }`) is used to preserve the existing state; no
  `terraform destroy`/`import` is required.
- **Workflows.** For each existing `.github/workflows/agent-*.yml`, add a
  sibling reusable file (`<name>-reusable.yml` or the same name with an
  `on: workflow_call` re-shape) and reduce the original to a thin caller
  stub that responds to the event and calls the reusable. Filenames stay
  the same where possible so no external URL breaks; where a rename is
  needed for clarity, the reusable variant takes a `-reusable.yml` suffix
  and the event-listening stub keeps the original name. The stub's `on:`
  block remains the source of truth for triggers; consumers copy the stub
  or write their own.
- **Composite actions.** No restructure needed — Decision 5's
  `github.action_path` fix is an edit-in-place per action.
- **Docker.** Unchanged on disk; the release workflow (Decision 4) is the
  only new consumer.

**Rationale.** This restructure keeps every existing consumer of this repo's
own workflows (the workflows are the consumers, in the self-hosted case)
unaffected: the caller stubs are functionally identical to today's files,
and Terraform state migrates transparently. External consumers gain a clean
publish surface.

### Decision 8 — Consumer adoption guide

**Decision.** Add `docs/adopting.md` with a per-component section covering,
for each Terraform module and each reusable workflow:

- **What it does.** One-paragraph summary.
- **Prerequisites.** The GitHub App identities (developer-agent,
  reviewer-agent) and secret names (`DEVELOPER_APP_ID`,
  `DEVELOPER_APP_PRIVATE_KEY`, `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` — subset as needed
  per component), the Actions variables (`AGENT_ALLOWLIST`, `DEFAULT_MODEL`,
  etc.), and the labels the component reads.
- **Wiring snippet.** A copy-paste example of the caller stub / module block.
- **Trust considerations.** Which permissions the reusable workflow needs,
  and what it does with the App private key.

The guide's index maps to the "Components" section of this design.
`README.md` gets a "Reuse in another repo" section linking to the guide.

## Out of scope

- **Migrating away from the Docker-build path for local dev-time runs.** The
  `docker build ./docker` invocation stays as the default when `run-agent`
  is called without an `image` input, so `docker/scripts/entrypoint.sh` and
  the local run instructions in `README.md` are unaffected.
- **Bundle components / higher-level meta-modules.** The owner explicitly
  said "will build up to higher level released components over time";
  MVP publication is per-piece. A `full-sdlc` reusable workflow or
  `full-sdlc` Terraform module is future work.
- **Publishing composite actions or reusable workflows from a separate
  distribution repo.** Kept in this repo per Decision 1.
- **Terraform Registry submission.** Rejected in Decision 2.
- **Attestation / signing of GHCR images
  (`actions/attest-build-provenance`).** Nice-to-have, not required for
  MVP; add later without breaking any consumer contract.
- **Consumer-side CI harness verifying the reusable workflows in a
  never-merged-into-main dry-run repo.** The end-to-end validation task
  (H) exercises a real consumer repo one time to prove the mechanism; a
  continuous cross-repo CI loop is future work.
- **Automating the interaction-limits or fork-PR-approval settings for
  consumer repos.** Those remain manual (documented today for this repo in
  `docs/design/public-visibility-flip.md`); the adoption guide documents the
  same manual steps consumers must run.
- **Renaming the primary repo, or creating any `terraform-<provider>-<name>`
  sibling repos** — implied by Decision 2's rejection of the Registry.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#398](https://github.com/mfrancza/agentic-development-workflow/issues/398) | Split `terraform/main.tf` into `terraform/modules/{labels,agent-vars,branch-protection,actions-policy,security}` and a root composition (or `terraform/examples/single-repo/`) that reproduces today's applied state. Use `moved { … }` blocks to migrate the state — no `destroy`/`import`. Document each module's variables/outputs in a per-module `README.md`. | — |
| [#399](https://github.com/mfrancza/agentic-development-workflow/issues/399) | Composite-action portability: change every TypeScript-running action in `.github/actions/*` to run `npm ci`/`npx tsx` with `working-directory: ${{ github.action_path }}/../../scripts`. Update the workflow-activity conventions doc in AGENTS.md to record the new pattern. Add a self-test workflow on the `design/issue-256` branch that invokes each affected composite action via a remote reference — `- uses: mfrancza/agentic-development-workflow/.github/actions/<name>@<sha>` — so `github.action_path` resolves to `$RUNNER_TOOL_CACHE/_actions/mfrancza/agentic-development-workflow/<sha>/…` (the way an external consumer would see it) rather than the workspace-local checkout path. A temp-directory shim on the same runner does not reproduce this and is not sufficient; the true end-to-end remote-reference validation is Issue #407's scratch consumer repo. | — |
| [#400](https://github.com/mfrancza/agentic-development-workflow/issues/400) | Container image publishing: add `.github/workflows/release-images.yml` that (a) on `push: tags: 'v*'` builds `docker/Dockerfile` and `docker/reviewer/Dockerfile` and pushes to GHCR at `<tag>` and `v<major>`, and (b) on `push: branches: [main]` rebuilds and pushes the moving `main` tag so it tracks the tip of `main` between releases. Extend `.github/actions/run-agent/action.yml` with an `image` input; when set, `docker pull` + `docker run` the image; when empty, keep today's `docker build "${build-context}"`. Preserve today's self-hosted build-from-source path in this repo's own workflows. | Issue #399 (portability needed for pulls-only path) |
| [#401](https://github.com/mfrancza/agentic-development-workflow/issues/401) | Reusable-workflow extraction (core agent-container workflows): convert `agent-groom.yml`, `agent-design.yml`, `agent-implement.yml`, `agent-review.yml` into `on: workflow_call` reusable files with typed `inputs:` and `secrets:` declarations, and reduce the originals to thin caller stubs delegating via `uses: ./.github/workflows/<name>-reusable.yml`. Verify the four workflows still fire from real triggers on this repo. | Issue #399, Issue #400 |
| [#402](https://github.com/mfrancza/agentic-development-workflow/issues/402) | Reusable-workflow extraction (secondary + support workflows): same treatment as Issue #401 for `agent-respond-review.yml`, `agent-fix-checks.yml`, `agent-fix-deployment.yml`, `agent-resolve-conflicts.yml`, `agent-pr-merged.yml`, `agent-auto-trigger.yml`, `ci.yml`, `secret-scan.yml`. | Issue #399, Issue #400 |
| [#403](https://github.com/mfrancza/agentic-development-workflow/issues/403) | Release / tagging workflow: add `.github/workflows/release.yml` (manual `workflow_dispatch` with a `version: v<M>.<m>.<p>` input) that validates the version, creates the tag from the workflow-run SHA, force-updates the moving `v<M>` tag, and creates a GitHub Release with autogenerated notes. Chained image publish happens automatically via Issue #400's `push: tags: 'v*'` trigger. | Issue #400 |
| [#405](https://github.com/mfrancza/agentic-development-workflow/issues/405) | Consumer adoption guide: add `docs/adopting.md` with one section per Terraform module and per reusable workflow — prerequisites (secrets, Actions variables, labels), wiring snippet, trust considerations — and a "Reuse in another repo" link from `README.md`. | Issue #398, Issue #401, Issue #402, Issue #403 |
| [#407](https://github.com/mfrancza/agentic-development-workflow/issues/407) | End-to-end validation from a scratch consumer repo: create a throwaway public GitHub repo, install the two GitHub Apps on it, apply the Terraform modules pinned at `v1.0.0`, add the caller stubs pinned at the same tag, open an issue and apply `agent:groom` → verify the grooming agent runs against the consumer repo using the published image. Record the results (secrets required, wiring gotchas discovered) as amendments to `docs/adopting.md`. | Issues #398, #401, #402, #403, #405 |

Issues #398 and #399 are independent and can proceed in parallel — they
touch disjoint parts of the tree (`terraform/*` vs. `.github/actions/*`).
Issue #400 depends on the portability fix (any pull-mode consumer runs the
composite actions from an external ref). Issues #401 and #402 can proceed
in parallel with each other once #399 and #400 land; #403 can proceed once
#400 lands. Issue #405 waits for all producing tasks so the guide reflects
the actual published surface. Issue #407 is the final validation and
exercises the whole loop end-to-end.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
