> ## ⚠ RETRACTED
>
> This design is retracted in full. It was premised on an actionlint false positive that reported
> `github.job_workflow_sha` as an undefined property. That report was incorrect:
> **`github.job_workflow_sha` is the correct, GitHub-documented expression** for reusable-workflow
> runs, and it was the expression originally written in the parent design. Every PR this design
> spawned (#522–#525) was reverted in #527, which restored the original working state.
>
> **Do not follow the recommendations in this document.**
>
> For the full postmortem and preventive follow-ups, see:
> - [`docs/design/job-workflow-sha-linter-trap.md`](job-workflow-sha-linter-trap.md)
>   (Issue [#526](https://github.com/mfrancza/agentic-development-workflow/issues/526))
> - `AGENTS.md` § Known traps

# Design: Correct helper-checkout context expression to `job.workflow_sha`

**Issue:** [#513](https://github.com/mfrancza/agentic-development-workflow/issues/513)
**Parent design:** [docs/design/reusable-workflow-helper-resolution.md](reusable-workflow-helper-resolution.md) (Issue [#498](https://github.com/mfrancza/agentic-development-workflow/issues/498))
**Related:** [#496](https://github.com/mfrancza/agentic-development-workflow/issues/496) (documentation still referencing v1), [#455](https://github.com/mfrancza/agentic-development-workflow/issues/455) (external adoption smoke test)

## Summary

The v0.0.1 portability fix ships every reusable workflow with an
`actions/checkout` step that pins the upstream helper tree to
`${{ github.job_workflow_sha }}`. GitHub's
[job-context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context)
documents this property under the **`job`** context, not the **`github`**
context: the correct expression is `${{ job.workflow_sha }}`. The
`github` context has no `job_workflow_sha` property, so the expression
resolves to an empty string, the `ref:` input on `actions/checkout`
receives an empty value, and the action falls back to an
event-dependent default ref (typically the caller-influenced HEAD of
`mfrancza/agentic-development-workflow`'s default branch) rather than
the reusable-workflow release SHA the caller pinned to.

The trust argument in the parent design was correct — a resolved,
GitHub-populated SHA that matches the caller's pin — but the property
name that was written down and shipped is not a GitHub-populated value
at all. This design corrects the expression in every affected file,
adds a fail-loud runtime guard so the same silent-fallback failure
mode cannot recur, extends the in-repo portability tests with a
regression assertion that only passes when the resolved SHA is
non-empty, and cuts a `v0.0.2` patch release that advances the moving
`v0` tag.

## Requirements as understood

Restated from issue #513 and its
[grooming Q&A](https://github.com/mfrancza/agentic-development-workflow/issues/513#issuecomment-grooming):

- **Correct the property name.** Every occurrence of
  `github.job_workflow_sha` in a released reusable workflow, its
  supporting documentation, and any test that references the pattern
  must be replaced with the documented `job.workflow_sha`.
- **Audit for silent siblings.** The audit covers not only the
  originally reported `agent-implement-reusable.yml` but every file in
  the repository that references the invalid expression, including
  `AGENTS.md`, `docs/adopting.md`, `docs/design/reusable-workflow-helper-resolution.md`
  (the parent design), and the comment inside
  `.github/workflows/test-reusable-portability.yml`.
- **Validate at runtime.** Each affected reusable workflow must
  fail loudly if `job.workflow_sha` resolves to an empty string,
  rather than silently letting `actions/checkout` fall back to an
  unpinned ref. The failure message must name the workflow file and
  point to this design doc so a future recurrence is diagnosable from
  the log alone.
- **In-repo regression test.** The existing
  `test-reusable-portability.yml` must (a) statically reject any
  reappearance of `github.job_workflow_sha` in a reusable workflow and
  (b) exercise the runtime behaviour of `job.workflow_sha` from a
  dispatched reusable workflow — asserting that the value is
  populated and that the checkout HEAD matches it.
- **External-consumer runtime regression test.** After the release,
  confirm from a consumer repo that has no local
  `.github/actions/` tree that (a) the helper checkout completes and
  (b) the resulting `_agentic-workflow/` HEAD commit matches
  `job.workflow_sha` even after upstream `main` has advanced.
- **Publish a patch release.** The fix ships as `v0.0.2`; the moving
  `v0` tag advances to the new SHA. `v0.0.1` is left in place as an
  immutable historical tag but is no longer pointed to by `v0`.

### Ambiguity resolutions

1. **Which value is actually returned when `github.job_workflow_sha`
   is referenced?** GitHub Actions expression evaluation for a missing
   context property returns an empty string, not an evaluation error.
   That is why v0.0.1 dispatched successfully in testing but silently
   drifted the helper tree off the release SHA — the fault is
   invisible unless someone inspects the checkout HEAD after the
   fact. This design's Decision 2 (runtime guard) exists specifically
   to convert this silent failure into a loud one on every future
   dispatch.
2. **Does the caller-side `github.workflow_sha` (documented) serve as
   a viable alternative?** No. `github.workflow_sha` resolves to the
   SHA of the *calling* workflow's YAML file inside the caller's
   repository, not the reusable workflow's SHA inside this repo. Using
   it would pin the helper checkout to a caller-controlled value —
   the exact wrong trust boundary the parent design's Decision 1
   already rejected for `github.sha`. `job.workflow_sha` is the only
   documented property that returns "the SHA of the workflow file
   defining the current job, including reusable workflows".
3. **Should the parent design doc be amended in place or superseded?**
   Amended in place with an inline correction. The parent design's
   trust-anchor argument, subdirectory convention, audit inventory,
   and PR-head-immunity reasoning are all still correct — only the
   property name in the code snippets and prose is wrong. Rewriting a
   whole successor design would obscure the fact that this is a
   mechanical rename of a single expression, not a change in strategy.
   Decision 4 below records the amendment surface precisely so a
   reviewer of the fix PR can confirm every citation was updated.
4. **Should `terraform-ci-reusable.yml` be included in the fix?** No
   change required. Grep across the repo shows this file does not
   reference `job_workflow_sha` in any form (it was declared
   consumer-only in the parent design's Decision 6 and never migrated
   to the self-checkout pattern). The regression lint in Decision 3
   below covers this file for future safety.
5. **Should the runtime guard live in each reusable workflow or in a
   shared composite action?** In each reusable workflow, inline. A
   composite action would add exactly the failure mode the guard is
   defending against — a helper-resolution step that runs before the
   fix has any chance to trigger. A three-line inline `run:` block in
   each affected workflow keeps the guard self-contained and free of
   ordering hazards. See Decision 2.

## Decisions

### Decision 1 — Replace `github.job_workflow_sha` with `job.workflow_sha` everywhere

**Decision.** In every affected file, replace the string
`github.job_workflow_sha` with `job.workflow_sha`. The replacement is
mechanical and preserves the semantics the parent design intended.

Concretely, in each reusable workflow the checkout step becomes:

```yaml
- name: Check out upstream helper actions
  uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
  with:
    repository: mfrancza/agentic-development-workflow
    ref: ${{ job.workflow_sha }}
    path: _agentic-workflow
    persist-credentials: false
```

The surrounding trust argument — that GitHub populates the SHA from
the caller's pin, that the caller cannot influence it, and that it
matches whatever `@<ref>` the caller wrote — is unchanged.
`job.workflow_sha` is
[documented](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context)
as "The commit SHA of the workflow file defining the current job,
including reusable workflows", which is exactly the property the
parent design was reaching for.

**Alternatives considered.**

- **Introduce a new composite action that resolves the SHA.**
  Rejected. Adds a helper-resolution dependency that itself needs the
  pattern to work correctly — a bootstrapping problem. The fix is a
  three-character rename; wrapping it is over-engineering.
- **Fall back to `github.sha` when `job.workflow_sha` is empty.**
  Rejected. `github.sha` is the caller's repository SHA in a reusable
  workflow — the same wrong-trust-boundary problem the parent design
  Decision 1 already rejected. A missing `job.workflow_sha` is a bug
  that must fail loudly (Decision 2), not silently substitute a
  caller-controlled value.
- **Hardcode `v0` at release time.** Rejected. Same tag-drift and
  reproducibility failure modes the parent design already enumerated;
  a consumer pinning `@v0.0.2` would still resolve helpers via the
  moving `v0` tag.

### Decision 2 — Add a fail-loud runtime guard in every affected reusable workflow

**Decision.** Before the `Check out upstream helper actions` step in
each affected reusable workflow, add a validation step that asserts
`job.workflow_sha` is populated. If empty, exit with an `::error::`
annotation that names the workflow file and links to this design doc.

The step is inline and identical across every reusable:

```yaml
- name: Validate job.workflow_sha is populated
  env:
    JOB_WORKFLOW_SHA: ${{ job.workflow_sha }}
  run: |
    set -euo pipefail
    if [ -z "${JOB_WORKFLOW_SHA}" ]; then
      echo "::error::job.workflow_sha resolved to an empty string. \
The reusable-workflow helper checkout cannot proceed without a resolved SHA. \
See docs/design/helper-checkout-job-workflow-sha-context.md."
      exit 1
    fi
    echo "job.workflow_sha=${JOB_WORKFLOW_SHA}"
```

The guard runs as the very first step of each affected job, ahead of
even the upstream checkout, so a regression to an invalid expression
fails the workflow immediately with a diagnosable log line rather than
silently drifting the helper tree onto whichever ref
`actions/checkout` picks by default.

**Trust properties preserved.** The guard reads `job.workflow_sha`
via an environment variable (per repo-wide output-injection defaults)
and never interpolates the value into a shell command. The `echo`
statement is a debug aid; the SHA is a GitHub-populated hex string
and not attacker-influenceable.

**Alternatives considered.**

- **No runtime guard; rely on the static lint alone.** Rejected. The
  static lint (Decision 3) catches known-bad expressions but cannot
  detect other future ways the value might land empty (for example, a
  workflow refactor that inadvertently changes the trigger event to
  one where `job.workflow_sha` is not populated). The runtime guard is
  a belt-and-braces defence with negligible cost.
- **Assert the checkout succeeded post-hoc by comparing HEAD to
  `job.workflow_sha`.** Rejected as the *primary* guard because it
  fires only after the untrusted checkout has already happened; kept
  in Decision 4's runtime regression test as a
  correctness-of-the-fix assertion.

### Decision 3 — Extend `test-reusable-portability.yml` static lint

**Decision.** Add a step to the existing `static-lint` job in
`.github/workflows/test-reusable-portability.yml` that greps every
`*-reusable.yml` file for the literal string `github.job_workflow_sha`
and fails the job if any match is found. The error message must name
the file, cite this design, and instruct the author to use
`job.workflow_sha` (job context, not github context).

This is the same enforcement pattern the existing lint uses for
`uses: ./.github/actions/` references — a single scan that fails
loudly rather than a semantic simulation. It catches copy-paste
regressions and stale examples in unmerged branches.

**Alternatives considered.**

- **Scan the entire repo, not just `*-reusable.yml`.** Rejected as
  the primary check because prose in `docs/design/` may legitimately
  cite the invalid expression when explaining the historical bug this
  design fixes. Restricting the scan to `*-reusable.yml` avoids
  false positives on legitimate documentation of the old expression.
  A separate follow-up docs pass (Decision 4) handles the doc files
  explicitly.
- **Also scan every workflow file, not only reusables.** Deferred.
  Only reusable workflows have the failure mode (calling stubs and
  local workflows do not resolve to a caller's `@<ref>`). Expanding
  the scan surface is trivial if a future need appears.

### Decision 4 — Update every consuming doc; amend the parent design in place

**Decision.** All doc files that cite the invalid expression are
updated in the same PR as the code fix. The list is exhaustive:

| File | Location | Update |
|------|----------|--------|
| `AGENTS.md` | Reusable workflows self-checkout section (~line 261, 274) | Replace expression in the code snippet and in the "trust anchor" bullet. |
| `docs/adopting.md` | Adoption gotchas — helper-action-not-found entry (~line 1527) | Replace the sentence "keyed to `github.job_workflow_sha` so the helper version is always consistent" to use `job.workflow_sha`. |
| `docs/design/reusable-workflow-helper-resolution.md` | Summary paragraph, Requirements→Ambiguity Resolution 1, Decision 1 title, Decision 1 body (multiple), Decision 8, Human ratification section | Replace every occurrence in prose and code blocks. Add a short **Correction note** at the top of Decision 1 pointing at Issue #513 and this design doc so the historical context is preserved. |
| `.github/workflows/test-reusable-portability.yml` | Header comment (line ~17) | Replace `github.job_workflow_sha` with `job.workflow_sha` in the explanation. |

The parent design is amended in place rather than superseded because
the *strategy* it describes remains correct — only one property name
was wrong. Amending preserves the single-source-of-truth property
of the design doc; the correction note makes clear this design owns
the fix.

**Alternatives considered.**

- **Write a full successor design instead of amending.** Rejected.
  The parent design's decisions on subdirectory naming, audit scope,
  test strategy, and documentation-update surface are all still
  correct. A successor would duplicate that content, drift out of
  sync, and confuse future readers.
- **Leave the docs unchanged and add a footnote.** Rejected. Future
  agent runs will copy the docs verbatim; leaving the wrong
  expression in an authoritative doc guarantees the bug recurs the
  next time someone follows the pattern.

### Decision 5 — In-repo runtime regression test

**Decision.** Add a small test-only reusable workflow
(`test-only-job-workflow-sha-reusable.yml`) whose single job:

1. Runs the same `Validate job.workflow_sha is populated` guard from
   Decision 2.
2. Executes a `actions/checkout` at `${{ job.workflow_sha }}` into
   `_agentic-workflow/` with `persist-credentials: false`.
3. Runs `git -C _agentic-workflow rev-parse HEAD` and asserts the
   output equals the value of `job.workflow_sha`, failing loudly on
   mismatch.

A caller workflow (`test-reusable-workflow-sha.yml`) invokes it via
`uses: ./.github/workflows/test-only-job-workflow-sha-reusable.yml` on
`pull_request` (paths gated to the reusable workflows, the test
files, and this design doc) and `workflow_dispatch`. The step-3
checkout-HEAD assertion (`git -C _agentic-workflow rev-parse HEAD` ==
`job.workflow_sha`) is the primary correctness check and is
trigger-independent: it directly proves the property the parent
design's trust-anchor argument depends on. A secondary `job.workflow_sha
== github.sha` assertion is included but scoped with
`if: github.event_name == 'workflow_dispatch'` because for
`pull_request` triggers `github.sha` is the *merge commit* GitHub
synthesises to test mergeability, while `job.workflow_sha` is the SHA
of the reusable workflow file in the PR head branch — the two will
legitimately differ whenever the PR branch is not at the default
branch HEAD, so an unconditional equality check would produce false
failures on every non-trivial PR.

This is a *runtime* regression guard that complements the static
lint: it exercises the actual GitHub Actions behaviour that the
parent design's trust-anchor argument depends on, so a future
GitHub-side change that (say) starts returning an empty
`job.workflow_sha` under some new trigger would surface immediately
in CI rather than silently in production.

**Alternatives considered.**

- **Dispatch one of the real reusables (e.g. `agent-implement`)
  against a throwaway test issue.** Rejected as the automated
  regression test because it consumes agent-container time, requires
  test-fixture issues, and mixes SHA-validation with unrelated
  end-to-end flow. Kept as the manual external-consumer smoke test
  scope (Decision 6).
- **Verify `job.workflow_sha` inside the existing
  `reusable-portability-test` job.** Rejected. That job simulates the
  layout in `/tmp/simulated-caller-workspace` and does not dispatch a
  real reusable workflow, so it cannot exercise the runtime context
  value at all. The new test is deliberately a separate job with the
  right shape for what it is testing.
- **Add the assertion inline to every real reusable and let it fail
  in production.** Rejected. That is what Decision 2's guard already
  does; the regression test in CI catches the bug *before* a release
  ships rather than *when* a consumer's dispatch fails.

### Decision 6 — External-consumer runtime smoke test

**Decision.** After `v0.0.2` publishes and the `v0` tag advances, run
a manual smoke test from a consumer repository (e.g. `mfrancza/drone-laser-tag`
or a scratch throwaway repo) that has no local `.github/actions/`
tree. The smoke test dispatches an agent workflow via the `v0` (or
`@v0.0.2`) pin, waits for the `Validate job.workflow_sha is populated`
guard to log a non-empty SHA, and confirms via a subsequent workflow
run — after upstream `main` has intentionally advanced (a no-op
commit is sufficient) — that the checked-out helper tree HEAD still
matches `job.workflow_sha` rather than tracking main.

The smoke test result is recorded as a comment on the release issue
(or on the `v0.0.2` release). If any assertion fails, the release is
withdrawn (delete `v0.0.2`, move `v0` back to `v0.0.1`) and the fix
is re-triaged.

**Rationale.** The in-repo tests (Decisions 3 and 5) run in the
same repository as the reusable workflows, so they cannot fully
reproduce a cross-repo dispatch. The smoke test is the ground-truth
proof that a consumer sees the fix. This complements — does not
replace — the standing external-adoption smoke test in
[#455](https://github.com/mfrancza/agentic-development-workflow/issues/455).

### Decision 7 — Publish the fix as `v0.0.2`; advance `v0`

**Decision.** After all preceding tasks land on `main`, a maintainer
dispatches `.github/workflows/release.yml` with `version=v0.0.2` and
`ref=main`. The release workflow tags the current `main` SHA as
`v0.0.2`, force-updates the moving `v0` tag to the same SHA, and
publishes the GitHub Release. The `release-images.yml` workflow
automatically republishes the developer and reviewer images at
`:v0.0.2` and `:v0`.

`v0.0.1` is left in place as an immutable historical tag documenting
what the initial portability fix shipped. Adoption docs get a
short note (added under `docs/adopting.md`'s existing pre-v0.0.1
gotcha) explaining that `v0.0.1` had the same silent-fallback bug and
that consumers should upgrade to `v0.0.2` (or track `v0`).

**Alternatives considered.**

- **Cut `v0.0.1a` or another patch label instead of `v0.0.2`.**
  Rejected. Release tag validation in `release.yml` enforces
  `v<major>.<minor>.<patch>`; non-integer patches would require a
  workflow change with no offsetting benefit.
- **Skip the release; leave the fix on `main` for external
  consumers.** Rejected. The moving `v0` tag is the documented
  entrypoint for external adoption; leaving it pointing at v0.0.1
  perpetuates the bug for every consumer who pinned by tag.
- **Rewrite the `v0.0.1` tag to point at the fixed SHA.** Rejected.
  Rewriting a published immutable tag violates release-history
  norms; the correct answer is a new patch release plus a moving-tag
  advance.

## Out of scope

- **Reworking `terraform-ci-reusable.yml` for external adoption.**
  This design retains its consumer-only posture (parent design
  Decision 6); the file does not carry the invalid expression and no
  change is needed here.
- **Backporting the fix to `v0.0.0` or `v0.0.1`.** Both are immutable
  release tags; consumers move to `v0.0.2` or `v0`. Same posture as
  the parent design's "no backport" scope declaration.
- **Making the runtime guard a reusable composite action.** Explicitly
  rejected in Decision 2; the inline three-line block is intentional.
- **Changing the trust anchor.** The parent design's rationale for
  pinning to the reusable-workflow SHA (not `github.sha`, not
  `github.workflow_sha`, not a floating tag) is unchanged. This
  design only corrects the property name that was written down.
- **Auditing other GitHub Actions context expressions in the repo
  for typos.** A one-shot audit for `github.job_workflow_sha`
  specifically covers the reported bug; a broader audit is a
  separate hygiene sweep and not in scope here.
- **Automating the moving-tag advance.** The `release.yml` workflow
  already handles both the annotated `v0.0.2` tag and the moving
  `v0` tag advance in a single dispatch (see
  `.github/workflows/release.yml` step "Create and push tags"); no
  additional automation is added here.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue #515 | Replace `github.job_workflow_sha` with `job.workflow_sha` in every reusable workflow (9 files: `agent-implement-reusable.yml`, `agent-groom-reusable.yml`, `agent-design-reusable.yml`, `agent-review-reusable.yml`, `agent-respond-review-reusable.yml`, `agent-fix-checks-reusable.yml`, `agent-fix-deployment-reusable.yml`, `agent-resolve-conflicts-reusable.yml`, `agent-auto-trigger-reusable.yml` — 5 refs in the last file). In the same PR, update `AGENTS.md` (self-checkout section — code snippet and trust-anchor bullet), `docs/adopting.md` (helper-action-not-found gotcha), the header comment in `.github/workflows/test-reusable-portability.yml`, and `docs/design/reusable-workflow-helper-resolution.md` (amend Decision 1 in place with a correction note pointing at Issue #513 and this design). | — |
| Issue #516 | Add the `Validate job.workflow_sha is populated` fail-loud runtime guard step from Decision 2 as the first step of each affected reusable-workflow job (same 9 files, 14 job entry points once `agent-auto-trigger-reusable.yml`'s five affected jobs are counted individually). | Issue #515 |
| Issue #517 | Extend the `static-lint` job in `.github/workflows/test-reusable-portability.yml` to fail on any occurrence of the string `github.job_workflow_sha` in `*-reusable.yml`, with a message that names the file, cites this design, and instructs the author to use `job.workflow_sha`. | Issue #515 |
| Issue #518 | Add the in-repo runtime regression test from Decision 5: `test-only-job-workflow-sha-reusable.yml` (single-job reusable that validates and asserts checkout HEAD == `job.workflow_sha`) plus a caller `test-reusable-workflow-sha.yml` triggered on `pull_request` (paths gated to `*-reusable.yml`, the two new test files, and this design doc) and `workflow_dispatch`. | Issue #515 |
| Issue #519 | Human-triggered `v0.0.2` release: dispatch `.github/workflows/release.yml` with `version=v0.0.2`, `ref=main`. Confirm `release-images.yml` republishes `developer:v0.0.2`, `developer:v0`, `reviewer:v0.0.2`, `reviewer:v0`. Update `docs/adopting.md` to extend the existing pre-v0.0.1 gotcha with a `v0.0.1` note pointing at `v0.0.2` (or `@v0`). Mark `human-required`; assign the maintainer. | Issues #515, #516, #517, #518 |
| Issue #520 | External-consumer runtime smoke test (Decision 6): from a consumer repository with no local `.github/actions/` tree, dispatch an agent workflow via `@v0.0.2` (or `@v0`), verify the runtime guard logs a non-empty SHA, then push a no-op commit to this repo's `main` and re-dispatch to confirm the helper checkout HEAD still matches `job.workflow_sha`. Record the result on the release issue. | Issue #519 |

Issues #516, #517, and #518 can proceed in parallel once #515 lands
and establishes the corrected property name across the repo. Issue
#519 (the release) waits on all four preceding tasks being merged so
the tag captures the complete fix. Issue #520 exercises the published
release from a real consumer repository and closes the loop.

Dependencies are recorded natively as GitHub blocked-by
relationships on the issues; the table above documents the intent
so a reviewer of the design PR can confirm the created dependency
graph matches.
