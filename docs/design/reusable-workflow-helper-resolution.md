# Design: External resolution of local composite actions in reusable workflows

**Issue:** [#498](https://github.com/mfrancza/agentic-development-workflow/issues/498)
**Related:** [#256](https://github.com/mfrancza/agentic-development-workflow/issues/256) (publish reusable workflows and modules), [#455](https://github.com/mfrancza/agentic-development-workflow/issues/455) (external adoption smoke test), [#451](https://github.com/mfrancza/agentic-development-workflow/issues/451) (initial release), [#496](https://github.com/mfrancza/agentic-development-workflow/issues/496) (documentation still referencing v1)
**Parent design:** [docs/design/publish-reusable-workflows-and-modules.md](publish-reusable-workflows-and-modules.md)

## Summary

The v0 reusable workflows fail for any external consumer because they reference
their own helper composite actions via workspace-relative paths
(`uses: ./.github/actions/<name>`). When a caller repo invokes the reusable
workflow, the runner's implicit `actions/checkout` step populates the
**caller's** repository into `$GITHUB_WORKSPACE`, not the reusable workflow's
repository, so those `./.github/actions/…` references resolve against a tree
that does not contain them and the job fails before an agent-token is even
minted.

The fix is to make every reusable workflow that uses local composite actions
first check out **its own source repository at the exact SHA the caller
pinned to**, into a dedicated subdirectory, and then reference every helper
action from that subdirectory (`uses: ./_agentic-workflow/.github/actions/<name>`).
The `job.workflow_sha` context variable, which GitHub populates with the
resolved SHA of the reusable workflow file being executed, is the trust anchor
that makes this safe: it is chosen by GitHub from the ref the caller pinned to
(`@v1`, `@v1.2.3`, or `@<sha>`), so the code that runs is exactly the code the
caller opted into.

## Requirements as understood

Restated from issue #498 and its
[grooming Q&A](https://github.com/mfrancza/agentic-development-workflow/issues/498#issuecomment-grooming):

- An external consumer must be able to call
  `mfrancza/agentic-development-workflow/.github/workflows/<name>-reusable.yml@<ref>`
  from a repo that does **not** contain a copy of this repo's
  `.github/actions/` tree, and the workflow must run to completion (subject to
  the caller supplying the documented inputs/secrets and installing the two
  GitHub Apps).
- Helper actions must be resolved from an **explicit, trusted upstream
  version** — not from the caller's tree, not from a PR head, and not from an
  unpinned floating ref that a future upstream commit could silently change.
- The reusable workflow must keep target-repository operations directed at the
  **consumer** repository. The upstream checkout is source-code only; nothing
  the reusable does writes back to this repo.
- No fix may execute untrusted PR-head helper code while
  `DEVELOPER_APP_PRIVATE_KEY`, `REVIEWER_APP_PRIVATE_KEY`, or any provider API
  key is in scope. The existing security exceptions in
  `agent-pr-merged-reusable.yml`, the `undraft-sub-issues` job in
  `agent-design-reusable.yml`, and the `auto-review` job in
  `agent-auto-trigger-reusable.yml` — none of which reference a local helper
  action — must be preserved unchanged.
- The audit must cover **every** reusable workflow with the local-action
  pattern, not only the one reported.
- A test must catch this class of regression before the next release. The full
  scratch-consumer-repo smoke test (#455) remains the ultimate check; a
  faster automated proxy belongs in this repo's CI.
- The fix must be published in an installable release (a new `v0.0.x` patch).

### Ambiguity resolutions

1. **Which upstream ref to pin the helper checkout to?** The grooming Q&A
   explicitly flagged this as the security-critical decision requiring human
   ratification. This design proposes `job.workflow_sha`. That value is
   populated by GitHub with the resolved SHA of the reusable workflow file
   the caller invoked — it is not attacker-influenceable within a workflow
   run, and it exactly matches what the caller already pinned to (`@v1` →
   SHA, `@v1.2.3` → SHA, `@<sha>` → the same SHA). Alternatives (hardcoded
   `@v1`, `@main`, or a full SHA baked into each release) all break
   consumer-side reproducibility or introduce a release-coordination
   dependency between the reusable-workflow tag and the helper-action tag.
   See Decision 1.
2. **Which layout for the upstream checkout?** A dedicated subdirectory
   (`_agentic-workflow/`) rather than an alternative workspace path or a
   root-level checkout. A distinct subdirectory name avoids colliding with
   files a consumer already has, keeps the `github.action_path` relative walk
   to `.github/scripts/` intact, and makes the mechanism grep-able. See
   Decision 3.
3. **Cross-repo `uses:` vs. self-checkout?** Rejected in favour of
   self-checkout. GitHub Actions does not allow expressions in the ref
   portion of a `uses:` line, so a cross-repo reference
   (`uses: mfrancza/agentic-development-workflow/.github/actions/<name>@<ref>`)
   would have to hardcode a ref. Any hardcoded ref forces the reusable
   workflow's version and the helper actions' version to diverge on every
   release. See Decision 2.
4. **Which workflows are in scope?** Every reusable workflow that references
   `./.github/actions/<name>` and is intended to be consumed externally. The
   audit inventory below (Decision 5) enumerates them. `ci-reusable.yml`,
   `secret-scan-reusable.yml`, and `agent-pr-merged-reusable.yml` do not
   reference local composite actions and need no change.
   `terraform-ci-reusable.yml` uses local composite actions but also depends
   on the caller having this repo's exact `terraform/` layout, so it is
   documented as consumer-only rather than fixed. See Decision 6.

## Decisions

### Decision 1 — Pin the upstream checkout to `job.workflow_sha`

> **Correction note (Issue [#515](https://github.com/mfrancza/agentic-development-workflow/issues/515)):**
> The original decision text and all implementations shipped with the expression
> `github.job_workflow_sha`. That expression is invalid — the `github` context
> has no `job_workflow_sha` property, so the value resolves to an empty string,
> causing `actions/checkout` to fall back to an unpinned default ref. The correct
> expression is `job.workflow_sha` (under the `job` context), as documented in
> [GitHub's job-context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context).
> The bug is tracked in Issue [#513](https://github.com/mfrancza/agentic-development-workflow/issues/513)
> and the correction design is at
> [`docs/design/helper-checkout-job-workflow-sha-context.md`](helper-checkout-job-workflow-sha-context.md).
> Issue #515 corrected the expression in every affected file; the remainder of
> this decision section has been updated in place to reflect the corrected name.

**Decision.** Each affected reusable workflow adds an initial step that runs
`actions/checkout` with:

```yaml
- name: Check out upstream helper actions
  uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
  with:
    repository: mfrancza/agentic-development-workflow
    ref: ${{ job.workflow_sha }}
    path: _agentic-workflow
    persist-credentials: false
```

Subsequent steps reference the helpers via
`uses: ./_agentic-workflow/.github/actions/<name>`.

`job.workflow_sha` is a
[GitHub-provided context value](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context)
described as "the commit SHA for the reusable workflow file" of the currently
executing job. GitHub sets it by resolving the ref the caller used in `uses:
owner/repo/.github/workflows/<name>.yml@<ref>` at dispatch time; the value is
opaque to the workflow file and cannot be spoofed by a caller who lacks push
access to this repo.

**Trust properties.**

- **Matches the caller's intent.** A consumer pinning `@v1.0.0` gets the
  helpers at the `v1.0.0` SHA; a consumer pinning `@v1` (moving major) gets
  the helpers at whatever SHA `v1` currently points to — which is the same
  SHA the workflow file itself came from. There is no version drift between
  the reusable and its helpers.
- **No caller-supplied code executes.** The upstream checkout writes into
  `$GITHUB_WORKSPACE/_agentic-workflow/`; the caller's `$GITHUB_WORKSPACE`
  root is not modified. The subsequent `uses: ./_agentic-workflow/.github/actions/<name>`
  references never walk into the caller's `.github/actions/`.
- **No secret exposure to caller code.** Helper actions run before agent-token
  minting inside their step context, from the trusted upstream checkout, with
  the caller's `GITHUB_TOKEN` used only for the read-only checkout of this
  public repo (persist-credentials disabled).
- **PR-head immunity.** The upstream checkout does not use
  `github.sha`, `github.event.pull_request.head.sha`, or any caller-supplied
  ref; the input is purely GitHub-controlled.

**Alternatives considered.**

- **Hardcode a floating tag (`ref: v1`).** Rejected. Consumers pinning to an
  exact tag (e.g. `@v1.0.0`) still run whatever helper code the moving `v1`
  currently resolves to, breaking the reproducibility promise. A CVE in helper
  code fixed only in v1.2.3 would not reach a consumer pinned at v1.0.0 if
  they read the helper via the moving tag — or, worse, an unintended breaking
  change in v1.3.0 would reach v1.0.0 consumers automatically.
- **Hardcode the release SHA at release time.** Rejected. Requires a release
  workflow that rewrites every reusable workflow's helper-checkout ref before
  tagging, which adds a moving target that dispatches from the release
  workflow itself. Fragile and easy to forget on a manual release.
- **`github.sha` fallback.** Rejected. In a reusable workflow, `github.sha` is
  the caller's SHA (e.g. the caller's default-branch tip at the moment the
  triggering event fired), not the reusable's SHA. Using it would check out
  this repo at an arbitrary consumer-influenced SHA, which is exactly the
  wrong trust boundary. `job.workflow_sha` is the correct value.

### Decision 2 — Self-checkout, not cross-repo `uses:` references

**Decision.** Prefer a single upstream checkout followed by workspace-relative
`uses:` references (`./_agentic-workflow/.github/actions/<name>`) over
cross-repo remote references
(`uses: mfrancza/agentic-development-workflow/.github/actions/<name>@<ref>`).

**Alternatives considered.**

- **Cross-repo remote `uses:` per action.** GitHub Actions requires the ref in
  a `uses:` line to be a literal string; expressions are not permitted in the
  ref position. This forces a hardcoded ref (either a floating major tag or a
  release-time-baked SHA), reintroducing the same tag-drift and
  release-coordination problems Decision 1 rejects. It also downloads N action
  archives per run (one per referenced action) instead of one checkout, and
  spreads the pin across the file rather than concentrating it on one line.
- **Publish the helper actions as standalone repos.** Rejected in
  [docs/design/publish-reusable-workflows-and-modules.md](publish-reusable-workflows-and-modules.md)
  Decision 1. No adoption benefit; adds N releases to coordinate.
- **Vendor helper actions into the caller's repo.** Explicitly rejected by the
  issue text ("External consumers should be able to use the documented caller
  stub without vendoring undocumented upstream implementation files"). Also
  loses the shared-upgrade property.

**Consequences accepted.** Every affected reusable workflow gains one extra
`actions/checkout` step (~2–4 s runtime on a warm runner). Composite actions
inside the checked-out `_agentic-workflow/` tree see
`${{ github.action_path }}` resolve to
`$GITHUB_WORKSPACE/_agentic-workflow/.github/actions/<name>` — the
`../../scripts` walk still lands correctly on
`$GITHUB_WORKSPACE/_agentic-workflow/.github/scripts`. The existing portability
fix (Decision 5 of the parent design) is unchanged.

### Decision 3 — Fixed subdirectory name: `_agentic-workflow/`

**Decision.** The upstream checkout is written to a single, fixed subdirectory
`_agentic-workflow/` under the caller's workspace. All updated `uses:` lines
reference `./_agentic-workflow/.github/actions/<name>` verbatim.

**Rationale.**

- A distinct, prefixed name (`_agentic-workflow`) is unlikely to collide with
  any file or directory a consumer already has. The leading underscore
  signals "not part of my repo".
- A fixed name means every reusable workflow uses the same path, making the
  pattern uniformly grep-able and reviewable.
- Reusable workflows that never checkout the caller's workspace at all can now
  do so without incidentally exposing caller code paths — the upstream
  subdirectory is the only tree the reusable's steps ever touch.

**Alternatives considered.**

- **Random / per-run directory name.** No benefit; the fixed name is not a
  secret and cannot be shadowed by an attacker who does not already have push
  access to this repo.
- **Check out at `$GITHUB_WORKSPACE` root.** Rejected. The runner's implicit
  behaviour, plus any caller step that already ran `actions/checkout` before
  invoking the reusable, may have populated the workspace with the caller's
  repo. Overwriting it silently is fragile and violates "target-repo
  operations directed at the consumer".

### Decision 4 — Do not add a caller-workspace checkout unless a job needs one

**Decision.** For jobs whose only reason to check out the caller's workspace
was to resolve `./.github/actions/…` references, the caller-workspace
checkout is **removed** and replaced by the upstream checkout from Decision 1.
The reusable workflow's own steps run against the trusted upstream tree; the
caller's workspace is not populated at all.

For jobs that legitimately need the caller's workspace (currently only the
`plan` job in `terraform-ci-reusable.yml`, which reads the caller's
`terraform/` directory), the fix keeps the existing caller-workspace checkout
and layers the upstream checkout on top under `_agentic-workflow/`.

**Rationale.** Minimising the caller-workspace footprint keeps the reusable
workflow's trust surface small and matches the pattern the security
exceptions already use (`agent-pr-merged-reusable.yml`,
`undraft-sub-issues`, `auto-review` — all of which deliberately omit any
caller checkout).

**Interaction with existing checkouts.** The existing `actions/checkout` step
at the top of each affected reusable is deleted; the upstream checkout
replaces it. `persist-credentials: false` remains set on the upstream
checkout. On `agent-review-reusable.yml`, the existing checkout serves the
`Resolve addressed review threads` step (which runs from the workspace with
the workflow `GITHUB_TOKEN`). The activity that step invokes
(`resolve-review-threads`) will move behind the `_agentic-workflow/` prefix
like all the others, and the step itself needs no additional workspace access
beyond what the composite action provides. Confirm during implementation that
the mounted-file read path (`${{ runner.temp }}/reviewer-output/...`) is
unaffected — it is a runner-temp path, not a workspace path, so it is.

### Decision 5 — Audit scope and inventory

Every reusable workflow that currently references `./.github/actions/<name>`
is in scope. The full inventory:

| Reusable workflow | Local-action references | Action |
|-------------------|-------------------------|--------|
| `agent-implement-reusable.yml` | agent-token, find-existing-pr, check-draft-label, check-blockers, resolve-model, run-agent | **Fix** (the reported failure) |
| `agent-groom-reusable.yml` | agent-token, resolve-model, run-agent | **Fix** |
| `agent-design-reusable.yml` (design job only) | agent-token, find-existing-pr, check-blockers, resolve-model, run-agent | **Fix** |
| `agent-design-reusable.yml` (undraft-sub-issues job) | *(none — uses `actions/create-github-app-token` directly)* | **Preserve as-is** (permanent security exception) |
| `agent-review-reusable.yml` | agent-token, resolve-model, dismiss-stale-reviewer-reviews, run-agent, resolve-review-threads | **Fix** |
| `agent-respond-review-reusable.yml` | check-reviewer-feedback, agent-token, find-linked-issue, resolve-model, run-agent | **Fix** |
| `agent-fix-checks-reusable.yml` | filter-agent-pr, agent-token, find-linked-issue, resolve-model, run-agent | **Fix** |
| `agent-fix-deployment-reusable.yml` | resolve-deployment, agent-token, resolve-model, run-agent | **Fix** |
| `agent-resolve-conflicts-reusable.yml` | find-conflicted-prs, agent-token, run-agent | **Fix** |
| `agent-auto-trigger-reusable.yml` (auto-groom, auto-design, auto-developer-do, auto-developer-undraft, auto-developer-unblock jobs) | agent-token, check-blockers, find-newly-unblocked, apply-unblocked-labels | **Fix** |
| `agent-auto-trigger-reusable.yml` (auto-review job) | *(none — uses `actions/create-github-app-token` directly, no checkout)* | **Preserve as-is** (permanent security exception, `docs/design/auto-trigger-agents.md` Decision 3) |
| `agent-pr-merged-reusable.yml` | *(none)* | No change (permanent security exception) |
| `ci-reusable.yml` | *(none)* | No change (paths are relative to caller's `.github/scripts/`; documented as fork-only) |
| `secret-scan-reusable.yml` | *(none)* | No change (only `actions/checkout` and `actions/upload-artifact`) |
| `terraform-ci-reusable.yml` | agent-token, terraform-plan-comment | See Decision 6 |

### Decision 6 — Declare `terraform-ci-reusable.yml` consumer-only

**Decision.** `terraform-ci-reusable.yml` is not intended for external
adoption in v0. Its `plan` and `apply` jobs read `terraform/`, `.tool-versions`,
and other paths that only exist in this repo's specific layout, and it targets
this repo's `terraform-ci` GitHub App. The file's header comment already says
so ("the caller's repository must have the same layout"); this design
formalises the intent by not fixing the local-action references and instead
documenting the workflow as consumer-only.

Consumers running their own Terraform can copy the workflow and its helpers or
build a bespoke one; the reusable is not part of the published surface.

**Rationale.** Fixing `terraform-ci-reusable.yml` for external consumption
would require checking out the caller's `terraform/` tree and validating it
matches the expected schema, plus a Terraform-app abstraction. That is
significant scope for zero identified consumer demand today. The one-line
header note plus this design's explicit "not published" declaration keeps the
audit honest without expanding scope.

If demand materialises, adopting the same self-checkout pattern for the
Terraform CI reusable is straightforward (Decision 1 applies mechanically);
the reusable would still need a caller-workspace checkout for the Terraform
files.

### Decision 7 — Automated portability test in this repo's CI

**Decision.** Extend the existing `test-action-portability.yml` (or add a
sibling workflow) so it also validates that a reusable workflow invoked from a
different workspace can resolve its helper actions. The simulation must:

1. Populate `_agentic-workflow/.github/actions/…` and `.github/scripts/…` at a
   path outside `$GITHUB_WORKSPACE` (mirroring the `_actions/` cache layout
   from the existing test).
2. Run a mock caller job in an empty workspace that dispatches a reusable
   workflow file and asserts that the resulting job resolves helper actions
   from the upstream subdirectory rather than the caller's workspace.

The truest test is a real cross-repo dispatch (issue #455). The in-repo
automated test is the fast regression guard that catches this class of bug
inside a single PR.

**Alternatives considered.**

- **In-repo mock only.** Rejected as *sufficient* — cannot fully mirror the
  cross-repo secret and permission surface — but accepted as *necessary*
  because #455's scratch-consumer test is manual and slow.
- **No new test; rely on #455 only.** Rejected. The reported regression
  proves that a mechanism which is only smoke-tested on demand from a
  separate repo is not tested often enough.

### Decision 8 — Documentation updates

Two docs get updated in this design's implementation tasks:

- **`AGENTS.md`** gains a short subsection under **Workflow Activity
  Conventions** documenting the "self-checkout at `job.workflow_sha`" pattern
  and pointing to the reusable workflows that already implement it.
- **`docs/adopting.md`** already assumes the reusable workflows work; the
  wording does not need to change functionally, but a new short **Adoption
  gotchas** entry links back to this design so a future adopter searching for
  "helper action not found" finds the explanation.

The parent design
(`docs/design/publish-reusable-workflows-and-modules.md`) is not amended
in place — it correctly assumed the composite-action portability fix
(Decision 5 there) was sufficient. This document is the successor that
records the additional reusable-workflow-side fix that Decision 5 did not
address.

## Out of scope

- **Reworking `run-agent` build mode for external consumers.** In its
  current form, `run-agent` with `image: ''` (build mode) requires the
  caller's workspace to contain `./docker/`. External consumers should
  always set `image:` (pull mode); this design does not change that. A
  future enhancement could pull `docker/` from the upstream checkout if
  demand emerges.
- **Making `terraform-ci-reusable.yml` externally consumable.** Declared
  out-of-scope in Decision 6; can be revisited if demand emerges.
- **Renaming `_agentic-workflow/`.** Bikeshed candidate; the name is
  ratified in Decision 3.
- **Repo-wide changes to how composite actions themselves are packaged.**
  The portability fix in the parent design (Decision 5) is unchanged and
  still correct; this design layers on top of it.
- **Fixing docs that still reference `@v1`.** Tracked separately in #496.
- **Auto-cutting a release from CI.** Release cutting remains manual
  (`workflow_dispatch` on `release.yml`).
- **Backporting the fix to `v0.0.0`.** The published `v0` moving tag will
  be advanced to the fixed SHA when the patch release is cut; no separate
  backport is needed because `v0.0.0` is the initial release and there is
  no supported prior version.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| [#500](https://github.com/mfrancza/agentic-development-workflow/issues/500) | Establish the upstream-checkout pattern in `agent-implement-reusable.yml` (the reported failure): remove the caller-workspace `actions/checkout`; add the `_agentic-workflow` checkout at `job.workflow_sha`; update every `uses: ./.github/actions/<name>` reference to `uses: ./_agentic-workflow/.github/actions/<name>`. Add the "self-checkout at `job_workflow_sha`" subsection to `AGENTS.md` under **Workflow Activity Conventions** so it becomes the documented pattern for the follow-up tasks. | — |
| [#501](https://github.com/mfrancza/agentic-development-workflow/issues/501) | Apply the same pattern to the remaining developer/reviewer container reusables: `agent-groom-reusable.yml`, `agent-design-reusable.yml` (design job only — leave `undraft-sub-issues` untouched), `agent-review-reusable.yml`, `agent-respond-review-reusable.yml`, `agent-fix-checks-reusable.yml`, `agent-fix-deployment-reusable.yml`, `agent-resolve-conflicts-reusable.yml`. | Issue #500 |
| [#502](https://github.com/mfrancza/agentic-development-workflow/issues/502) | Apply the pattern to `agent-auto-trigger-reusable.yml` for the five jobs that reference local actions (auto-groom, auto-design, auto-developer-do, auto-developer-undraft, auto-developer-unblock). Explicitly do not modify the `auto-review` job. Add a header note to `terraform-ci-reusable.yml` declaring it consumer-only (Decision 6) and add a paragraph to `docs/adopting.md` recording the same. | Issue #500 |
| [#503](https://github.com/mfrancza/agentic-development-workflow/issues/503) | Extend `.github/workflows/test-action-portability.yml` (or add a sibling `test-reusable-portability.yml`) to reproduce the failing scenario from Issue #498: simulate a caller workspace with no `.github/actions/` tree, dispatch a reusable workflow that expects to find its helpers under `_agentic-workflow/`, and assert that helper resolution succeeds. Fails the CI job if the fix regresses. | Issues #500, #501, #502 |
| [#504](https://github.com/mfrancza/agentic-development-workflow/issues/504) | External-consumer smoke test: mint a throwaway public repo with no upstream helpers copied, install the two GitHub Apps, add the caller stubs from `docs/adopting.md` pinned to the new patch tag, open an issue, apply `agent:developer`, and verify the reusable runs end-to-end without a helper-resolution failure. Record any adoption gotchas as amendments to `docs/adopting.md`. Coordinates with (does not replace) Issue #455. | Issues #500, #501, #502, #503, #505 |
| [#505](https://github.com/mfrancza/agentic-development-workflow/issues/505) | Publish the fix as a `v0.0.1` patch release via the existing `release.yml` `workflow_dispatch`. Human-triggered; the release advances the moving `v0` tag to the new SHA. `human-required` because release cutting is an explicit maintainer action. | Issues #500, #501, #502, #503 |

Issues #501 and #502 can proceed in parallel with each other once #500 lands
and establishes the pattern. Issue #503 waits for #500–#502 so the automated
test can assert the fix on every affected workflow. Issue #505 (the release)
is human-triggered and depends on the code being correct and the automated
regression test passing. Issue #504 (the real external smoke test) exercises
the published tag end-to-end and closes the loop.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.

## Human ratification required

The parent issue carries the `human-required` label because the trust-anchor
choice in Decision 1 (`job.workflow_sha`) and the "no caller-workspace
checkout" posture in Decision 4 are security-sensitive. Before implementation
proceeds, a maintainer should confirm:

1. **Decision 1 is acceptable.** `job.workflow_sha` is the pinning
   anchor; the reusable workflow's helpers run at whatever SHA the caller's
   pin resolved to.
2. **Decision 4 is acceptable.** Reusable workflows that previously checked
   out the caller's workspace to resolve local actions will stop doing so;
   only the upstream subdirectory is populated.
3. **Decision 6 is acceptable.** `terraform-ci-reusable.yml` is declared
   consumer-only rather than fixed for external adoption.

The design PR carries the same `human-required` label and is assigned to the
maintainer.
