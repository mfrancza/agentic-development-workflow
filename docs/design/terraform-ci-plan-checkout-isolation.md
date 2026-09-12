# Design: Isolate the trusted helper checkout from the PR checkout in the Terraform plan job

**Issue:** [#548](https://github.com/mfrancza/agentic-development-workflow/issues/548)
**Parent design:** [`terraform-ci.md`](terraform-ci.md) (Decision 2, threat-model mitigation #1)
**Related:** [`reusable-workflow-helper-resolution.md`](reusable-workflow-helper-resolution.md), [`helper-checkout-job-workflow-sha-context.md`](helper-checkout-job-workflow-sha-context.md)

## Summary

The plan job in `terraform-ci-reusable.yml` performs two sequential
`actions/checkout` calls. The first checks out the base branch into
`$GITHUB_WORKSPACE` so that local composite actions
(`./.github/actions/agent-token`, `./.github/actions/terraform-plan-comment`)
resolve from trusted base-branch code. The second checks out
`inputs.head-sha` into the same directory (no `path:` argument), which
overwrites the trusted tree with PR-head content before the plan-comment
step runs. As a result, `Post Terraform plan comment` invokes
`./.github/actions/terraform-plan-comment` from PR-head content while
holding the minted `terraform-ci` App installation token in
`inputs.token`. A same-repository PR can therefore modify the action,
its composite steps, or the sibling `.github/scripts/**` code it loads,
and receive the App token on the next plan run — contradicting
[`terraform-ci.md`](terraform-ci.md) Decision 2 mitigation #1, which
states that `pull_request_target` "always resolves the workflow YAML
(and any local composite actions the workflow references by path,
i.e. `.github/actions/**`) from the base branch tip, not from the PR
head."

The fix keeps two separate checkouts on the runner:
`_base/` for trusted helper actions and their sibling
`.github/scripts/` package (checked out at the base-branch tip that
GitHub already validates against the workflow YAML), and `_pr/` for
the PR-head Terraform code that the plan steps operate on. Every
`uses: ./.github/actions/<name>` reference in the plan job is rewritten
as `uses: ./_base/.github/actions/<name>`, and every Terraform working
directory becomes `_pr/terraform`. The App token is only ever handed to
composite actions loaded from `_base/`.

The rest of the terraform-ci trust model — `pull_request_target`
trigger choice, fork-PR exclusion, provider allowlist gate,
`patterns_allowed` restriction, single terraform-ci App identity —
is unchanged.

## Requirements as understood

Restated from [Issue #548](https://github.com/mfrancza/agentic-development-workflow/issues/548)
and its grooming Q&A:

- The plan job's second `actions/checkout` overwrites the base-branch
  workspace with PR-head content. The subsequent
  `uses: ./.github/actions/terraform-plan-comment` step therefore
  resolves the composite action from PR-head, not from the trusted
  base branch — despite the workflow file's own comments stating the
  opposite intent.
- The exposure is bounded to same-repository PRs. Fork PRs are
  excluded by the caller's `if:` guard
  (`github.event.pull_request.head.repo.full_name == github.repository`).
  This design is not a claim that arbitrary fork authors can trigger
  the path.
- The reporter is a static-inspection finding and paused adoption in
  `mfrancza/drone-laser-tag`. There is no reproduced exploit or
  credential exposure. The design must still address the finding
  because the workflow's own trust invariant is contradicted by the
  execution order — that invariant is what makes the earlier decision
  to grant `Administration: R/W` to the terraform-ci App defensible
  (see [`terraform-ci.md`](terraform-ci.md) Decision 2).
- The fix must:
  - Keep trusted helper actions and their sibling code (`.github/scripts/`)
    in a checkout the PR-head checkout cannot overwrite.
  - Put the PR Terraform content in a distinct checkout directory and
    adjust working directories and plan-file paths accordingly.
  - Resolve the plan-comment action and any supporting scripts
    exclusively from the trusted checkout when the App token is in
    scope.
  - Add a regression test demonstrating that PR-head modifications
    to the plan-comment action or its supporting code cannot execute
    with the App token through this path.
  - Audit comparable multi-checkout/local-action sequences and
    clarify the remaining trust assumptions for same-repository
    Terraform PRs.

### Runtime-evidence framing (AGENTS.md § "Reverting or replacing code with a passing live-run history")

`terraform-ci-reusable.yml` has passing live runs. The AGENTS.md rule
requires a runtime-failure citation before replacing working code on the
strength of a linter warning or a schema-based guess. This design
satisfies that rule with three complementary runtime facts, not with a
static-only guess:

1. `actions/checkout`'s documented default is "populate the workflow's
   workspace with the repository," which is `$GITHUB_WORKSPACE` when no
   `path:` is set. Two consecutive checkouts without `path:` on the
   second therefore leave the workspace at the second checkout's tree.
   This is not a lint hypothesis; it is observable in any run of the
   current workflow by comparing the timestamps or contents of files
   under `$GITHUB_WORKSPACE/.github/actions/terraform-plan-comment/`
   before and after the second checkout step.
2. GitHub Actions resolves `uses: ./<path>` at step time against the
   current `$GITHUB_WORKSPACE`, not against the ref that
   `pull_request_target` uses to load the workflow YAML itself. That
   distinction is what the reporter observed and is what the parent
   `terraform-ci.md` Decision 2 explicitly relies on but does not
   enforce.
3. The regression test added by this design (Task 2 below) makes the
   trust-boundary crossing empirically observable: before the fix, a
   PR that stamps a marker into
   `.github/actions/terraform-plan-comment/action.yml` causes the
   plan-comment step to emit that marker in its logs; after the fix,
   the same PR's marker is absent because the base-branch action file
   is what actually runs. This converts the static reasoning above
   into a live-run signal that fails today and passes after the
   restructure.

The design is therefore not "replace working code because a linter
warned"; it is "restructure a job so that its documented trust
invariant matches its observable runtime behavior, and add a runtime
test that pins that invariant in place."

### Resolved ambiguities

- **Where should `.tool-versions` be read from?** The plan job reads
  the Terraform version from `.tool-versions` before invoking
  `hashicorp/setup-terraform`. There are two candidates: `_base/.tool-versions`
  (trusted) or `_pr/.tool-versions` (PR-head).
  Decision: **read from `_pr/.tool-versions`**. `.tool-versions` is a
  data file consumed by an external, SHA-pinned action; it does not
  execute PR-authored code. Reading from the PR head means a PR that
  bumps Terraform (e.g. `1.15.3` → `1.15.4`) is planned with the
  version the PR intends to run, which is the point of catching the
  incompatibility in CI. The failure modes are (i) an unrecognised
  version, which fails `setup-terraform` loudly, or (ii) an old
  version, which affects only the Terraform CLI's own behavior on the
  same PR-head Terraform code that already runs. Neither expands
  credential exposure beyond what running Terraform on the PR head
  already implies.
- **Where should `.terraform.lock.hcl` and `required_providers`
  blocks be scanned?** The provider allowlist gate must scan the
  PR-head content because that is the surface it is meant to defend
  against. Read them from `_pr/`. The gate script itself is inline
  in the workflow YAML (base-branch, per `pull_request_target`) —
  moving it to a base-branch helper script would be equivalent and
  is a possible follow-up but is not required.
- **Are the `agent-token` and `terraform-plan-comment` composite
  actions equally at risk?** Yes. Both are `uses: ./.github/actions/<name>`
  references that run after step 4 (PR-head checkout). Today,
  `agent-token` runs *before* the PR-head checkout, so it is not
  currently exposed — but re-ordering later could regress it silently.
  This design resolves both by moving every plan-job
  `uses: ./.github/actions/<name>` reference to `uses: ./_base/.github/actions/<name>`,
  regardless of current ordering.
- **Should the apply job also be restructured?** No. The apply job runs
  on `push: main` with no second checkout — the only tree on disk is
  the merged base, so there is no equivalent overwrite. A single
  `_base/` prefix on the apply job would add cost with no
  security benefit. The design leaves the apply job's structure
  unchanged and documents in the audit section that the current apply
  job does not have the two-checkout pattern.
- **Should the fix follow the `_agentic-workflow/` naming convention
  used by the other reusable workflows?** No. The reusable-workflow
  helper-resolution pattern
  ([`reusable-workflow-helper-resolution.md`](reusable-workflow-helper-resolution.md))
  uses `_agentic-workflow/` for a different purpose: pulling helpers
  from an external repo (`mfrancza/agentic-development-workflow`) for
  callers whose workspace is not this repo. The terraform-ci reusable
  is explicitly consumer-only in v0 (see the header comment on
  `terraform-ci-reusable.yml` and Decision 6 of
  `reusable-workflow-helper-resolution.md`), so it does not use the
  cross-repo helper checkout; both checkouts here refer to this repo,
  differentiated by base vs PR ref. Use `_base/` and `_pr/` to make
  the trust distinction obvious in every step's path. The
  test-reusable-portability lint that skips `terraform-ci-reusable.yml`
  is unaffected; a second lint added in Task 2 handles the new
  invariants.

## Audit of comparable multi-checkout / local-action sequences

The grooming ask requires auditing other workflows for the same
pattern: (a) base-branch checkout, (b) later PR-head checkout into the
same workspace, (c) subsequent invocation of a workspace-local
composite action with elevated credentials.

Results of that audit:

- **`terraform-ci-reusable.yml`** — the workflow this design fixes.
  This is the only workflow in the repository that exhibits the full
  pattern.
- **`agent-review-reusable.yml`** — checks out only `_agentic-workflow/`
  (via the `helpers-ref` pattern) and never checks out PR-head content
  on the runner. The reviewer container fetches PR content inside the
  container using the reviewer App token; the runner-side workspace
  never contains PR-head code. Not affected.
- **`agent-implement-reusable.yml`, `agent-fix-checks-reusable.yml`,
  `agent-fix-deployment-reusable.yml`, `agent-groom-reusable.yml`,
  `agent-design-reusable.yml`, `agent-resolve-conflicts-reusable.yml`,
  `agent-respond-review-reusable.yml`** — same shape as
  `agent-review-reusable.yml`: single `_agentic-workflow/` checkout on
  the runner; PR/branch content is fetched inside the developer
  container. Not affected.
- **`undraft-sub-issues` job in `agent-design-reusable.yml`** — has
  no checkout at all and calls `actions/create-github-app-token`
  directly, as documented in the "Permanent security exceptions" list
  in AGENTS.md. Not affected; the exception is preserved.
- **`agent-pr-merged-reusable.yml`, `agent-pr-merged.yml`** — no
  workspace checkout, per the same "Permanent security exceptions"
  list. Not affected.
- **`agent-auto-trigger-reusable.yml`** — five helper-consuming jobs,
  all using the `_agentic-workflow/` checkout pattern; no PR-head
  checkout on the runner. Not affected.
- **`ci-reusable.yml`, `secret-scan-reusable.yml`,
  `test-reusable-portability.yml`, `test-action-portability.yml`,
  `release.yml`, `release-images.yml`** — do not mint any App token
  before invoking a local composite action, or do not invoke a local
  composite action at all. Not affected.

Conclusion: **`terraform-ci-reusable.yml` is the sole occurrence of
this pattern in the repository.** No other workflow requires a
structural change under this design. The audit result is codified in
Task 2's static lint (see Decision 3) so a future regression that
introduces the same pattern in another reusable workflow fails CI
rather than depending on repeated manual audits.

## Design

### Decision 1 — Split the plan job's workspace into `_base/` and `_pr/`

Replace the two current checkout steps with:

```yaml
- name: Checkout base branch (trusted helper actions)
  uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
  with:
    # No ref: — pull_request_target's default is GITHUB_SHA, which is
    # the current base-branch HEAD.
    path: _base
    persist-credentials: false

- name: Mint terraform-ci App token
  id: token
  uses: ./_base/.github/actions/agent-token
  with:
    client-id: ${{ secrets.TERRAFORM_APP_ID }}
    private-key: ${{ secrets.TERRAFORM_APP_PRIVATE_KEY }}

- name: Checkout PR head (Terraform code)
  uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
  with:
    ref: ${{ inputs.head-sha }}
    path: _pr
    persist-credentials: false
```

Every subsequent step that was `working-directory: terraform` becomes
`working-directory: _pr/terraform`; every `uses: ./.github/actions/<name>`
becomes `uses: ./_base/.github/actions/<name>`; the `plan-file` input
becomes an absolute path under `${{ github.workspace }}/_pr/terraform/tfplan.txt`.

The `terraform-plan-comment` composite action already computes its
scripts directory as `${{ github.action_path }}/../../scripts`, so an
invocation via `./_base/.github/actions/terraform-plan-comment`
resolves the scripts directory to `_base/.github/scripts`. All
TypeScript activity code loaded by the plan-comment step therefore
also comes from the trusted checkout, without any changes to the
composite action itself.

**Alternatives considered.**

- **(a) Add `path: _pr` to only the second checkout, keeping the
  first checkout at workspace root.** Simpler on paper but fragile:
  the workspace root is still available and future steps could
  accidentally reference `./.github/actions/...` (which would resolve
  to the base checkout — correct today but confusing) or
  `terraform/...` (which would resolve to the base checkout — silently
  planning the wrong tree). Two explicit paths make the trust
  distinction visible at every use.
- **(b) Skip the base-branch checkout entirely and invoke
  `actions/create-github-app-token` directly (the pattern used in
  the `undraft-sub-issues` job of `agent-design-reusable.yml`), then
  reimplement the plan-comment activity as an inline `run:` block or
  as a cross-repo `uses:`.** Rejected. The plan-comment activity is
  a real TypeScript program (`.github/scripts/src/terraform-plan-comment.ts`)
  with its own dependencies and unit-test surface; inlining it
  contradicts the Workflow Activity Conventions in AGENTS.md and
  breaks the shared `.github/scripts/` package layout. A cross-repo
  `uses: mfrancza/agentic-development-workflow/.github/actions/terraform-plan-comment@<sha>`
  would work but forces a release-coordination dependency between
  the terraform-ci-reusable release tag and the terraform-plan-comment
  action's tag, which the reusable-workflow-helper-resolution design
  explicitly rejected (see its Decision 1). A local-checkout at
  `_base/` gives the same trust guarantee as either alternative
  without the release-coordination cost.
- **(c) Adopt the `_agentic-workflow/` pattern used by the other
  reusable workflows.** Rejected under "Resolved ambiguities" above.
  The `_agentic-workflow/` name signals cross-repo consumption; the
  terraform-ci reusable is consumer-only in v0 and both checkouts
  refer to this repo. Using `_base/` and `_pr/` names the trust
  distinction explicitly.

### Decision 2 — Read data files from the appropriate tree

- **`_pr/.tool-versions`** — feeds `hashicorp/setup-terraform`. Reading
  from PR head so a version bump in the PR is exercised on the check.
  See "Resolved ambiguities" above.
- **`_pr/terraform/.terraform.lock.hcl`** and **`_pr/terraform/**/*.tf`** —
  scanned by the provider-allowlist gate. The gate must inspect the
  PR-head content because that is the surface it is defending; the
  gate's allowlist itself is inline in the base-branch workflow YAML
  and therefore not modifiable by the PR.
- **Terraform working directory** — `_pr/terraform` for every
  Terraform CLI step (`init`, `fmt -check`, `validate`, `plan`,
  `show`). The `plan-file` argument becomes
  `${{ github.workspace }}/_pr/terraform/tfplan.txt`.

**Alternatives considered.**

- **Reading `.tool-versions` from `_base/`.** Rejected: prevents a PR
  from validating a Terraform version bump. The trust gain is
  negligible because `.tool-versions` is data consumed by a
  SHA-pinned action, not code that runs.
- **Copying the Terraform sources into `_base/`.** Rejected: the point
  is that the plan runs against PR-head Terraform code; copying it
  into the trusted tree does not change the trust boundary and
  makes path handling more confusing.

### Decision 3 — Add a static lint and a runtime regression test

Two complementary tests are added under `test-reusable-portability.yml`
or a new `test-terraform-ci-trust-boundary.yml`:

1. **Static lint (fast, always runs).** Scan `terraform-ci-reusable.yml`
   and fail if the plan job contains any `uses: ./.github/actions/`
   line (only `uses: ./_base/.github/actions/` is permitted in the
   plan job), or any `working-directory: terraform` (only
   `working-directory: _pr/terraform` is permitted). Documented
   exceptions apply only to the apply job, which does not have the
   two-checkout pattern; the lint scopes its rules to the plan job by
   YAML-parsing rather than by grepping the whole file.
2. **Runtime regression test (slower, PR-triggered).** A dedicated
   workflow that simulates the trust-boundary crossing without needing
   the terraform-ci App:
   - Check out the repository twice on the runner: once at
     `github.sha` (base) into `_base/`, once at
     `github.event.pull_request.head.sha` (PR head) into `_pr/`.
   - On the PR head, write a marker line into
     `_pr/.github/actions/terraform-plan-comment/action.yml` (e.g.
     an inserted `echo "MARKER-PR-HEAD-RAN"` step in the composite).
     The marker is only inserted for the duration of this test run
     and only in the on-disk copy under `_pr/`; the PR under review is
     not modified.
   - Invoke the plan-comment composite action via the same
     `uses: ./_base/.github/actions/terraform-plan-comment` line the
     restructured workflow uses, with a dummy token and a scratch
     plan file (so no PR comment is actually posted — the invocation
     is aborted before the API call, or the token is intentionally
     invalid so the run fails at post-time rather than mutation-time;
     the assertion is on the step's log, not on the API result).
   - Assert that `MARKER-PR-HEAD-RAN` is **absent** from the step's
     log. If the workflow ever regresses to
     `uses: ./.github/actions/terraform-plan-comment`, or to a shared
     workspace where the PR-head checkout wins, the marker appears
     and the test fails.

   This regression test is the direct answer to the issue's
   "regression test demonstrating that PR changes to the helper
   action cannot execute with the Terraform App token through this
   path" ask. It runs on `pull_request` (not
   `pull_request_target`), so it needs no elevated token — the point
   of the test is the *resolution path* of `uses:`, not the token
   handoff itself. The token handoff was covered by the parent
   design's Decision 2 threat model; this test covers the previously
   unverified invariant that the plan job's composite action loads
   from the trusted checkout.

**Alternatives considered.**

- **Runtime test that mints a real terraform-ci App token and asserts
  the plan comment is authored by the base-branch code.** Rejected:
  requires exposing `TERRAFORM_APP_ID` / `TERRAFORM_APP_PRIVATE_KEY`
  to a `pull_request` context (unsafe) or to a synthetic PR the
  test workflow creates (fragile). The log-marker approach in the
  chosen design is functionally equivalent for what the test needs
  to prove (which action file was executed) and avoids introducing
  a token surface.
- **Static lint only.** Rejected as the sole test: the parent
  `terraform-ci.md` design's Decision 2 mitigation #1 was itself a
  static-only statement of intent, and the current bug is exactly
  what happens when a static claim is not backed by a runtime
  assertion. The lint is fast and catches regressions in typing; the
  runtime test proves the invariant is real.

### Decision 4 — Update the parent design doc and AGENTS.md in the same PR

The terraform-ci design doc's Decision 2 mitigation #1 currently reads
"a PR that modifies `terraform-ci.yml` or `.github/scripts/**` cannot
cause the modified copy to run on the plan job." That sentence remains
true for `terraform-ci.yml` (the workflow YAML is loaded by GitHub from
the base branch under `pull_request_target`) but is only true for
`.github/scripts/**` once this design lands — the parent doc is the
place to record the additional structural guarantee (helpers checked
out into `_base/`, PR content checked out into `_pr/`). The workflow
implementation PR must add:

- A new subsection under `terraform-ci.md` Decision 2 documenting the
  dual-checkout structural guarantee and pointing here for the full
  rationale.
- An `AGENTS.md` entry under **Repo-specific security defaults**
  describing the pattern: "workflows that check out PR-head content
  on the runner and later invoke a workspace-local composite action
  with an App-minted token must isolate the trusted helper checkout
  into a separate `path:` (`_base/` in `terraform-ci-reusable.yml`)
  and reference every such helper via `./_base/…`." This is
  precisely the "clarify remaining trust assumptions" ask from the
  issue.
- The header comment on `terraform-ci-reusable.yml` restated to
  match the new layout, so the file's own comments are not lying
  about what it does.

## Out of scope

- **Rebuilding the terraform-ci App with narrower scopes for the plan
  job.** Splitting `terraform-ci` into `terraform-ci-plan`
  (read-only) and `terraform-ci-apply` (admin) is discussed and
  deferred in the parent `terraform-ci.md` design; this design does
  not revisit that decision. If the trust calculus ever needs
  strengthening beyond structural checkout isolation, that follow-up
  is the natural next step.
- **Moving away from `pull_request_target`.** The trigger choice is a
  parent-design decision (`terraform-ci.md` Decision 2). This design
  preserves it and only fixes the runtime execution order.
- **Applying the `_base/` / `_pr/` structure to the apply job.** The
  apply job has no second checkout; the pattern does not apply.
- **Adopting the `_agentic-workflow/` cross-repo helper checkout in
  `terraform-ci-reusable.yml`.** Blocked by the consumer-only status
  of that workflow (Decision 6 of
  `reusable-workflow-helper-resolution.md`); revisiting is a
  follow-up if `terraform-ci-reusable.yml` is ever promoted to a
  full external-consumption surface.
- **Auditing consumer repositories (e.g. `mfrancza/drone-laser-tag`)
  for local variants of the pattern.** External consumers copy the
  workflow rather than call it (per the consumer-only status), so
  the fix landing here does not automatically propagate. Notifying
  the reporter that a fix has landed and pointing to the corrected
  workflow file is the manual follow-up implied by the "adoption
  paused" note in the issue; not scheduled here.
- **Rotating the terraform-ci App private key.** Same cadence and
  manual process as the other Apps; not automated by this design.
  A rotation is a reasonable belt-and-braces action for the
  maintainer to take, but is not required by this fix because no
  credential exposure has been observed.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#549](https://github.com/mfrancza/agentic-development-workflow/issues/549) | Restructure the plan job in `terraform-ci-reusable.yml` to use `_base/` for trusted helper actions and `_pr/` for PR Terraform code, per Decisions 1 and 2. Rewrite every plan-job `uses: ./.github/actions/<name>` to `./_base/.github/actions/<name>`; set every Terraform `working-directory` to `_pr/terraform`; change `plan-file` to `${{ github.workspace }}/_pr/terraform/tfplan.txt`; keep the apply job unchanged; update the header comment on the file. Update `terraform-ci.md` Decision 2 with a short note about the dual-checkout guarantee and add an AGENTS.md entry under **Repo-specific security defaults** (Decision 4). | — |
| Issue [#550](https://github.com/mfrancza/agentic-development-workflow/issues/550) | Add the static lint from Decision 3 (fail if the plan job contains `uses: ./.github/actions/` or `working-directory: terraform`) and the runtime marker-based regression test that proves the plan-comment composite is loaded from `_base/`, not from the PR-head workspace. Extend or add to `test-reusable-portability.yml` / a new `test-terraform-ci-trust-boundary.yml` as appropriate. | Issue [#549](https://github.com/mfrancza/agentic-development-workflow/issues/549) |
| Issue [#551](https://github.com/mfrancza/agentic-development-workflow/issues/551) | End-to-end validation: open a small terraform-only PR (e.g. tweak a label description) and confirm the plan job runs, the plan comment posts under the terraform-ci App identity, the provider-allowlist gate inspects the PR-head lockfile, the Terraform working directory is `_pr/terraform`, and the plan-comment composite is invoked via `./_base/.github/actions/terraform-plan-comment` (verifiable in the run logs). Also confirm the regression tests from Issue [#550](https://github.com/mfrancza/agentic-development-workflow/issues/550) pass on the same PR and fail if a marker is temporarily inserted. Notify the reporter (`mfrancza/drone-laser-tag`) that adoption can resume. | Issue [#549](https://github.com/mfrancza/agentic-development-workflow/issues/549), Issue [#550](https://github.com/mfrancza/agentic-development-workflow/issues/550) |

The workflow restructure (Task 1) and the tests (Task 2) are separated
so the test task can validate against the restructured behavior; the
end-to-end validation (Task 3) is the join point that exercises both
on a real Terraform PR.

Dependencies are recorded natively as GitHub blocked-by relationships
on the issues after they are created; the table's `Depends on` column
is informational.
