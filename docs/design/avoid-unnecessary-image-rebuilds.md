# Design: Avoid rebuilding the agent image unnecessarily

**Issue:** [#643](https://github.com/mfrancza/agentic-development-workflow/issues/643)

## Summary

Every agent workflow run spends ~90–150 seconds rebuilding the developer or
reviewer Docker image. The `run-agent` composite action already supports a
pull mode, and four caller stubs (`agent-groom`, `agent-design`,
`agent-implement`, `agent-review`) wire the `DEVELOPER_IMAGE` /
`REVIEWER_IMAGE` Actions variables through to it — but those variables are
not managed by Terraform and so default to empty in a greenfield install,
leaving every workflow in build mode. The four feedback-path caller stubs
(`agent-fix-checks`, `agent-fix-deployment`, `agent-resolve-conflicts`,
`agent-respond-review`) deliberately hardcode `image: ''` so they always
build from source — preserving the no-GHCR escape hatch for forks and
bootstrapping. The build context is the `docker/` tree checked out at
`helpers-ref` (the default-branch commit for the workflow_run,
push-to-main, and deployment_status triggers used by the first three of
those stubs; the PR merge SHA for the pull_request_review trigger used by
`agent-respond-review`). Either way they pay the full rebuild cost on
every run even when `docker/` has not changed.

This design keeps the existing two-mode split intact and reduces the per-run
image-prep cost of both modes to seconds:

- **Main-path workflows** (groom, design, implement, review) pull a floating
  `:main` tag that is republished whenever `docker/**` lands on `main`. The
  underlying `DEVELOPER_IMAGE` / `REVIEWER_IMAGE` Actions variables become
  Terraform-managed so the pull-mode default survives a `terraform apply`
  and is reproducible across adopters.
- **Feedback-path workflows** keep building from source so they still exercise
  PR-level changes to `docker/`, but the `run-agent` build step uses the
  same published `:main` image as a BuildKit registry cache source. Unchanged
  layers (OS install, CLI installs — the slow 60–120 s portion) are reused
  from the registry; only PR-modified layers are rebuilt.

Source-build without any cache remains the behavior external callers get
when the registry cache is unreachable, so the escape hatch for local dev
and private forks is preserved by default.

## Requirements (from issue #643 and grooming Q&A)

Issue [#643](https://github.com/mfrancza/agentic-development-workflow/issues/643)
describes the problem in one sentence: "The image gets rebuilt each run —
avoid this to reduce run times." The grooming agent posted four clarifying
questions that remained unanswered at design-start time; this document
resolves each ambiguity explicitly rather than waiting on human input, and
notes the resolution so a reviewer can push back:

1. **Scope — which workflows should stop rebuilding?** All eight
   agent-container caller stubs, but with two strategies (see the Summary):
   pull-mode default for the four main-path workflows; cached source-build
   for the four feedback-path workflows. Resolution: addressing only the
   four main-path workflows leaves half the runs paying full rebuild cost;
   addressing all eight with a single pull-only strategy would remove the
   no-GHCR escape hatch that fork-based adopters and the composite action's
   documented build-mode contract depend on. (The empty-image default is
   the "no publishing required" fallback, not a mechanism for exercising
   PR-level `docker/` changes — after the issue #498 self-checkout
   migration the build context is the `helpers-ref` tree, which for three
   of the four feedback-path reusables resolves to the default-branch
   commit; only `agent-respond-review` sees a PR-related SHA, and even
   there it is the merge commit rather than the PR head.)
2. **Strategy — pre-built image, GHA cache, or something else?** Pre-built
   image for pull mode, registry-backed BuildKit cache (`type=registry`,
   read-only, pointing at the published `:main` tag) for build mode.
   Freshness guarantee: the main-path pulled image is at most one `main`
   push behind HEAD (push-to-main republishes `:main` whenever `docker/**`
   changes); the build-mode cache is advisory and never silently serves
   stale layers (BuildKit invalidates cache for any changed layer input).
   Reproducibility: operators who need a frozen image reference can set
   `developer_image = ghcr.io/.../developer:v<N>` in their `terraform.tfvars`
   instead of the default `:main`.
3. **Must source-build mode remain available?** Yes. External callers
   without GHCR access, local developers running `docker run` by hand, and
   this repo's own feedback workflows all depend on `run-agent` falling
   back to a plain `docker build`. The cache source is pointed at a public
   image; a 404 or network failure degrades silently to a cacheless build,
   not a hard failure.
4. **Measurable target.** Baseline: median image-prep step duration across
   the last 10 runs of each of the eight agent-container workflows (expected
   ~90–150 s). Target: median <15 s for pull-mode runs and <30 s for cached
   build-mode runs when `docker/**` is unchanged in the triggering PR. The
   final sub-issue (end-to-end validation) measures both and posts the
   comparison back on this design PR.

Repo-conventions requirements the design must respect without re-arguing
them (see `AGENTS.md`):

- The two-mode split (pull vs. build) and the composite action's `image`
  input are the ratified mechanism (`AGENTS.md` → "Both images are
  published to GHCR"); this design extends it, not replace it.
- Any new third-party action requires a coordinated allowlist entry in
  `terraform/main.tf`'s `patterns_allowed` (see "Repo-specific security
  defaults" → "Pinned action SHAs"). This design avoids that cost by using
  `docker buildx build` with the default BuildKit driver (pre-installed on
  `ubuntu-24.04`) rather than adding `docker/setup-buildx-action`.
- Variables added to Terraform follow the existing pattern in
  [`terraform/modules/agent-vars/main.tf`](../../terraform/modules/agent-vars/main.tf)
  (one `github_actions_variable` per operator-settable value, matching
  output, documented default in `terraform.tfvars.example`).
- The published image path is set by
  [`.github/workflows/release-images.yml`](../../.github/workflows/release-images.yml);
  that file is the source of truth for image tagging and must be edited
  there (per `AGENTS.md` → "Volatile facts live at their sources").

## Design

### Terraform-managed image references

Add two variables to `terraform/variables.tf` and expose them as the
`DEVELOPER_IMAGE` / `REVIEWER_IMAGE` Actions variables that the caller stubs
already read:

```hcl
variable "developer_image" {
  description = "Pre-built developer image reference consumed by agent-groom, agent-design, and agent-implement via the DEVELOPER_IMAGE Actions variable. Empty string means build from docker/ source (slower but no GHCR dependency). The recommended default once image publishing is wired up is ghcr.io/<owner>/<repo>/developer:main — a floating pointer republished on every main-branch docker/** change. Operators who want a frozen pointer for stricter reproducibility should instead pin to the floating major tag (e.g. :v1) or a full tag (e.g. :v1.2.3)."
  type        = string
  default     = ""
}

variable "reviewer_image" {
  description = "Pre-built reviewer image reference consumed by agent-review via the REVIEWER_IMAGE Actions variable. Same semantics as developer_image but for docker/reviewer: default empty, recommended floating value ghcr.io/<owner>/<repo>/reviewer:main, pin to :v<N> or a full tag for reproducibility."
  type        = string
  default     = ""
}
```

The defaults remain empty strings so adopters who have not yet published an
image (or who have no GHCR access) see no behavioral change. This repo's
own `terraform.tfvars` sets both to the floating `:main` tag published by
`release-images.yml` (below) in the same sub-issue, so a `terraform apply`
flips the main-path workflows into pull mode without any workflow YAML
changes.

**Alternatives considered.** (a) Default the variables to the published
`:main` tag — rejected because an adopter who sets `repo_owner` to a fork
would end up pulling an image that does not exist in their org and failing
loudly before they realise what happened; empty default + explicit opt-in
in tfvars is the safer pattern (same shape as `REVIEWER_MODELS` and
`REVIEW_MODEL_PAIRING`). (b) Hard-wire the image reference in the caller
stubs rather than going through Terraform — rejected because that forces
every external adopter to fork the caller stubs to repoint `ghcr.io/`.

### Publish a floating `:main` tag on every `docker/**` push to `main`

Extend `release-images.yml` with a second job that fires on push-to-main
and republishes the `:main` tag whenever the Dockerfiles, prompts, or
scripts change. The existing tag-triggered job is left intact (continues
to publish `:v<N>` and `:v<N.M.P>` on `v*` tags).

Two GitHub Actions constraints shape the exact shape of this change:

- **Workflow-level `paths:` filters apply to every ref matched by the
  trigger — including tag pushes.** Putting `paths: ['docker/**']` on
  `on.push` would therefore skip the existing `release-images` job on any
  `v*` tag whose diff does not touch `docker/**` (e.g. a release that only
  changes workflows or docs). The path filter has to live elsewhere.
- **`paths:` is not a job-level key.** GitHub ignores a `paths:` field on
  a job definition, so the "filter lives on the main-publish job only"
  idiom cannot be expressed with `paths:` syntax.

Required shape (adjusting the trigger block, gating the existing job, and
adding a path-detection + publish job pair):

```yaml
on:
  push:
    tags: ['v*']
    branches: ['main']
  workflow_dispatch:
    inputs:
      tag: ...

jobs:
  release-images:
    # Existing job. Add this gate so main-branch pushes do not run the tag
    # validation (which would fail the FULL_TAG=~^v[0-9] regex). Keeps
    # workflow_dispatch runs (manual re-push from a branch) working.
    if: >
      github.event_name == 'workflow_dispatch' ||
      startsWith(github.ref, 'refs/tags/')
    ...

  detect-docker-changes:
    # Tiny gate job that reads the push diff. Separated from publish-main
    # so publish-main's permissions block only grants packages: write when
    # we actually intend to publish.
    if: >
      github.event_name == 'push' &&
      github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    outputs:
      changed: ${{ steps.detect.outputs.changed }}
    steps:
      - uses: actions/checkout@<pinned-sha>
        with:
          fetch-depth: 2
          persist-credentials: false
      - id: detect
        run: |
          set -euo pipefail
          if git diff --name-only HEAD^1 HEAD | grep -q '^docker/'; then
            echo "changed=true"  >> "$GITHUB_OUTPUT"
          else
            echo "changed=false" >> "$GITHUB_OUTPUT"
          fi

  publish-main:
    needs: detect-docker-changes
    if: needs.detect-docker-changes.outputs.changed == 'true'
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@<pinned-sha>
        with:
          persist-credentials: false
      - name: Log in to GHCR
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          _ACTOR: ${{ github.actor }}
        run: |
          echo "${GITHUB_TOKEN}" | docker login ghcr.io -u "${_ACTOR}" --password-stdin
      - name: Build and push :main images
        env:
          _REPO: ${{ github.repository }}
        run: |
          set -euo pipefail
          BASE="ghcr.io/${_REPO}"
          docker build ./docker          -t "${BASE}/developer:main"
          docker build ./docker/reviewer -t "${BASE}/reviewer:main"
          docker push "${BASE}/developer:main"
          docker push "${BASE}/reviewer:main"
```

The two image builds run sequentially inside `publish-main` (same pattern
as the existing release job) because the GHCR login step is shared and the
push is seconds. Freshness guarantee: workflows that pull `:main` are at
most one post-merge push behind HEAD.

**Alternatives considered for the path gate.** (a) `dorny/paths-filter` —
rejected because it is a non-GitHub-owned action and would require an
allowlist entry in `terraform/main.tf`'s `patterns_allowed`. (b) A
separate workflow file dedicated to the main-branch path — rejected
because duplicating the GHCR-login scaffolding adds surface area with no
compensating benefit. (c) A single workflow-level `paths:` filter —
rejected per the first bullet above (would skip tag pushes whose diff
does not touch `docker/**`).

**Alternatives considered.** (a) Publish on every push to main regardless
of changed paths — rejected as wasteful: ~95% of main pushes do not touch
`docker/**` and would still rebuild/push the same bytes. (b) Publish on PR
merge via `pull_request: closed` + `merged == true` — rejected because the
push-to-main trigger is simpler, equivalently timed, and avoids running on
force-pushes or direct admin pushes. (c) Use `:latest` as the floating tag
name — rejected because `:latest` is semantically ambiguous (OCI convention
treats it as the default pull tag, which invites accidental use); `:main`
is explicit about which branch the image reflects.

### `run-agent` composite action: BuildKit registry cache for build mode

The pull-mode branch of `run-agent` is unchanged (`docker pull "${_IMAGE}"`).
The build-mode branch switches from `docker build` to `docker buildx build`
with a registry-backed cache source:

```bash
docker buildx build \
  --cache-from "type=registry,ref=${CACHE_REF}" \
  -t "${_IMAGE_TAG}" \
  --load \
  "${ctx}"
```

where `CACHE_REF` resolves to
`ghcr.io/<owner>/<repo>/developer:main` or `.../reviewer:main` based on which
`build-context` is in use (the composite action already knows this via
`inputs.build-context` — `docker/reviewer` → reviewer; otherwise →
developer). `--load` ensures the built image is loaded into the local
image store so the subsequent `docker run` finds it (buildx's default
output is OCI format, not loaded).

**Cache behavior.** BuildKit fetches the cache manifest from the registry
(single HTTP request to GHCR), then selectively pulls only the cached
layer blobs it needs. Unchanged layers (base image, apt install, npm
install) deserialise in seconds. Changed layers (modified `COPY scripts/`
after an edit to a prompt or entrypoint) rebuild as today. If the registry
is unreachable or `:main` has not yet been published, BuildKit logs a
warning and falls back to a cacheless build — the same behavior as today,
only slower on the first run after this change ships.

**Why `type=registry` and not `type=gha` cache.** `type=gha` requires
`docker/setup-buildx-action` to export `ACTIONS_CACHE_URL` and
`ACTIONS_RUNTIME_TOKEN`, which pulls in a non-GitHub-owned action and
forces an actions-policy allowlist update (per `AGENTS.md` → "Pinned
action SHAs"). `type=registry` uses the registry we already publish to,
with no new actions and no permission changes (pull is anonymous on a
public repo; the composite action never writes cache, only reads). This
also keeps the cache usable by external callers who adopt our reusables
without having to set up GHA cache themselves.

**Why not `--cache-to`.** Writing cache from every workflow run would
require `packages: write` on every job that invokes `run-agent` in build
mode (today only `release-images.yml` has that scope). The published
`:main` image already contains the layer metadata BuildKit needs as a
cache source, so there is no gain to writing an additional cache artifact.

**No change to the `docker run` step** that follows the build: the loaded
image tag is identical, and `--load` guarantees it is addressable through
the normal docker image store.

### No change to the four feedback-path caller stubs

`agent-fix-checks`, `agent-fix-deployment`, `agent-resolve-conflicts`, and
`agent-respond-review` continue to pass `image: ''` to their reusables.
The AGENTS.md comment explaining this ("they continue to build from
source regardless of this variable") remains accurate: they still build
from source. They just build faster now because `run-agent` fetches cached
layers from GHCR. The build context remains the `docker/` tree checked
out at `helpers-ref` (the default-branch commit for the workflow_run,
push-to-main, and deployment_status triggers used by three of the four;
the PR merge SHA for `agent-respond-review`), so the empty-image mode
preserves the "no GHCR dependency" escape hatch for forks and private
deployments. The registry cache simply makes that path fast when `:main`
is reachable; BuildKit invalidates any layer whose input has changed, so
a landed `docker/` change on `main` still fully rebuilds the next time
these workflows run.

### Documentation updates (bundled with implementation sub-issues)

- `AGENTS.md`: update the `DEVELOPER_IMAGE` / `REVIEWER_IMAGE` descriptions
  to reflect Terraform management (today they claim Terraform management
  that does not exist) and link the new `:main` tag publishing cadence.
  Mention the `type=registry` cache behavior in the "Pinned action SHAs"
  context (as the reason we did not need to allow-list a buildx action).
- `README.md`: add `developer_image` / `reviewer_image` to the Terraform
  variable list and mention them in the "Reproduce this yourself" section
  for operators who want the pull-mode optimisation locally.
- `terraform/terraform.tfvars.example`: show both variables with the
  commented `ghcr.io/<owner>/<repo>/{developer,reviewer}:main` defaults so
  adopters know the recommended value.
- `terraform/modules/agent-vars/README.md`: document the two new Actions
  variables alongside the existing ones.
- `.github/workflows/release-images.yml` header comment: note that `:main`
  is a floating pointer republished on every main push to `docker/**`.

The reusable workflow headers already describe the `image` input; no
changes needed there.

## Out of scope

- **Publishing cache artifacts to the registry (`--cache-to`).** Would need
  write permissions on every `run-agent` consumer; not worth the surface
  given `:main` already serves as the cache source.
- **Changing the two-mode semantics.** Both pull and build modes remain;
  this design does not consolidate on one.
- **GHA-cache (`type=gha`) support.** Not pursued because it requires a
  non-GitHub-owned action (`docker/setup-buildx-action`) and would mean
  every external caller also needs to allow-list it. If a future need
  arises (e.g. for workflows that genuinely cannot reach GHCR), the
  composite action could learn a second cache-source via a new input, but
  no caller needs it today.
- **Publishing images per-PR for feedback loop pre-warming.** Would require
  a `pull_request` trigger with write permissions to GHCR — a larger
  security surface than this issue justifies.
- **Removing `release-images.yml`'s v* tag job.** Reproducibility pins
  still rely on the `:v<N>` tags for operators who want them.
- **Changing the base image or Dockerfile layering** to make rebuilds
  cheaper independent of cache. A separate concern (and a trap: changing a
  passing Dockerfile without runtime failure evidence is forbidden by
  `AGENTS.md` → "Reverting or replacing code with a passing live-run
  history").
- **Making the `developer_image` / `reviewer_image` defaults non-empty.**
  Explicit opt-in matches the existing pattern for operator-settable
  variables (REVIEWER_MODELS, REVIEW_MODEL_PAIRING, DESIGN_DEFAULT_MODEL)
  and avoids pull-404 failures for fork-based adopters.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| [#684](https://github.com/mfrancza/agentic-development-workflow/issues/684) | Terraform: add `developer_image` + `reviewer_image` variables and `DEVELOPER_IMAGE` / `REVIEWER_IMAGE` Actions variables (modules/agent-vars + root variables); update tfvars.example and README | — |
| [#685](https://github.com/mfrancza/agentic-development-workflow/issues/685) | `release-images.yml`: add `publish-main` job that republishes `ghcr.io/<owner>/<repo>/{developer,reviewer}:main` on push to main when `docker/**` changes | — |
| [#686](https://github.com/mfrancza/agentic-development-workflow/issues/686) | `run-agent` composite action: switch build mode to `docker buildx build --cache-from=type=registry,ref=…:main --load`; resolve the cache ref from `build-context`; add a smoke test covering the ref-resolution logic | — |
| [#687](https://github.com/mfrancza/agentic-development-workflow/issues/687) | This repo's `terraform.tfvars`: set `developer_image` / `reviewer_image` to the `:main` tags so the main-path workflows switch to pull mode by default | #684, #685 |
| [#688](https://github.com/mfrancza/agentic-development-workflow/issues/688) | End-to-end validation: measure image-prep baseline across all eight agent-container workflows (last 10 runs each), re-measure after #685/#686/#687 land, post the comparison as a comment on this design PR and on issue #643; confirm cache fall-through by landing a small `docker/` change on `main` and observing that the next workflow_run / push-to-main / deployment_status feedback-path trigger (whose `helpers-ref` is the just-updated default-branch commit) rebuilds the affected layer against the updated `:main` cache source. Do **not** try to validate cache-miss by opening a PR that edits `docker/` and inspecting `agent-fix-checks` — feedback reusables build the `helpers-ref` tree, not the PR head, so a PR-only `docker/` change is invisible to that workflow until it merges. | #685, #686, #687 |

Issue #684, Issue #685, and Issue #686 are independent and can land in
any order:

- Issue #684 defaults the new variables to empty strings, so it is a
  no-op until Issue #687 flips the tfvars.
- Issue #685 publishes a `:main` image whether or not anything consumes
  it.
- Issue #686 uses `type=registry` cache which silently no-ops if `:main`
  is unpublished, so it is safe to land before Issue #685.

Issue #687 flips this repo into pull mode and depends on both the
variable plumbing (Issue #684) and the published image (Issue #685).
Issue #688 validates the end state and depends on all upstream work
being merged.

Dependencies are recorded natively as GitHub blocked-by relationships
after sub-issue creation; the table is updated with the real issue numbers
in the same PR as this design document.
