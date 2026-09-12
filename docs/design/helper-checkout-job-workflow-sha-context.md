# Design: Explicit, verified helper checkout refs

**Issue:** [#513](https://github.com/mfrancza/agentic-development-workflow/issues/513)
**Related:** [#498](https://github.com/mfrancza/agentic-development-workflow/issues/498), [#526](https://github.com/mfrancza/agentic-development-workflow/issues/526), [#455](https://github.com/mfrancza/agentic-development-workflow/issues/455)

## Summary

The reusable workflows currently ask `actions/checkout` to fetch helper actions
at `${{ github.job_workflow_sha }}`. Runtime evidence from agent-groom run
[34303371563](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34303371563)
shows that expression resolved to an empty value: the checkout input dump omitted
`ref`, and checkout selected `main` with `-B main` rather than detaching at a
commit. The green checkout step therefore did not prove version pinning.

The replacement is an explicit, required `helpers-ref` reusable-workflow input.
Repository-owned caller stubs pass `github.sha`; external caller examples pass the
same major tag, exact tag, or SHA used to select the reusable workflow. Before any
helper action runs, each affected job resolves the requested ref to a commit,
checks out that commit, and fails unless the checkout HEAD equals it. This removes
the undocumented context dependency and makes version skew observable.

This document supersedes its retracted earlier revision and plans to correct the
follow-up incident record in
[`job-workflow-sha-linter-trap.md`](job-workflow-sha-linter-trap.md).

## Requirements as understood

Issue #513 and its grooming notes originally requested replacing
`github.job_workflow_sha` with `job.workflow_sha`, auditing every reusable
workflow, adding fail-loud validation, exercising the behavior from an external
consumer, and publishing a patch release. Subsequent runtime evidence resolves
the central ambiguity:

- `github.job_workflow_sha` parses, but in run 34303371563 its evaluated value was
  absent and `actions/checkout` fell back to upstream `main`. This is the runtime
  failure required by `AGENTS.md` § “Reverting or replacing code with a passing
  live-run history”; a successful step conclusion is not evidence of the resolved
  ref.
- `job.workflow_sha` is not a viable replacement. PRs #522–#525 demonstrated that
  it invalidates these reusable workflows at dispatch time, and PR #527 reverted
  that fleet-wide failure.
- No implicit Actions context has been demonstrated to carry the invoked reusable
  workflow ref reliably. The design must replace the mechanism rather than rename
  the property.
- All reusable workflows that bootstrap local composite actions are affected: the
  eight agent action workflows plus `agent-auto-trigger-reusable.yml`. The latter
  has five helper-consuming jobs, and `agent-resolve-conflicts-reusable.yml` has
  two. `agent-pr-merged-reusable.yml`, `ci-reusable.yml`, and
  `secret-scan-reusable.yml` do not bootstrap local helpers and remain outside the
  checkout change.
- Internal workflows must execute helper code from the same repository commit as
  the caller stub. External consumers must be able to choose the release line
  (`v0`), an immutable patch tag, or a commit SHA without an unnoticed fallback.
- Validation must prove both that a requested ref was supplied and that the helper
  checkout HEAD is the independently resolved commit, before any checked-out
  composite action is loaded.
- The misleading incident artifacts and adoption guidance must be corrected, and
  the external adoption smoke test must record the resolved ref and checked-out
  HEAD rather than treating a green checkout as sufficient.
- After implementation and regression coverage merge, a maintainer publishes a
  new immutable patch tag and advances `v0`; the historical `v0.0.1` tag is not
  rewritten.

### Ambiguity resolutions

1. **Is `helpers-ref` optional with a `v0` default?** No. The later issue comment
   suggested external callers default to the major release tag, but a workflow
   invoked at an exact tag could then silently load helpers from a newer `v0`.
   The input is required. The adoption guide's recommended examples explicitly
   pass `v0`; exact-tag and SHA examples pass the identical selector on both
   interfaces.
2. **What does “matches the reusable workflow's selected commit” mean without an
   introspectable invoked-ref context?** The explicit input becomes the public
   version-coherence contract. The job resolves that selector to a commit before
   checkout and verifies HEAD against the resolved commit. External validation
   additionally records the commit behind the workflow selector and confirms it
   is the same expected commit.
3. **Does a patch release belong in an implementation issue?** Yes, but it is a
   separate human-required task. Tag creation and movement are release writes and
   must occur only after code, documentation, and automated checks land on
   `main`.

## Design

### Decision 1 — Make the helper version an explicit required input

Every affected reusable workflow declares a string input named `helpers-ref` with
`required: true` and no default. Every repository-owned caller passes:

```yaml
with:
  helpers-ref: ${{ github.sha }}
```

All external caller snippets in `docs/adopting.md` pass `helpers-ref: v0` beside
`uses: ...@v0`. The version-pinning section shows that exact-tag and SHA users
must repeat the same selector for `helpers-ref`.

**Alternatives considered.** Keeping `github.job_workflow_sha` is rejected by the
resolved-value evidence from run 34303371563. `job.workflow_sha` is rejected by
the dispatch failures in PRs #522–#525. `github.sha` inside the reusable workflow
is rejected because, for an external invocation, it identifies the consumer's
event commit. An optional `helpers-ref` defaulting to `v0` is rejected because it
weakens exact-tag and SHA pins. Requiring a raw commit SHA only would be strongest
but makes the documented moving-major update channel impractical; explicit refs
retain that supported policy while the verification step removes fallback.

### Decision 2 — Resolve first, checkout the commit, then compare HEAD

The bootstrap sequence in every helper-consuming job is:

1. Reject an empty `helpers-ref` with an Actions error annotation.
2. Resolve it against `mfrancza/agentic-development-workflow` to a full commit SHA
   using GitHub's commits API and the workflow token's existing public
   `contents: read` access. Failure or ambiguity is fatal.
3. Give the resolved SHA—not the symbolic input—to `actions/checkout`, retaining
   `path: _agentic-workflow` and `persist-credentials: false`.
4. Read `_agentic-workflow` HEAD and require exact equality with the resolved SHA.
   Only subsequent steps may use `./_agentic-workflow/.github/actions/...`.

The repeated bootstrap is kept as a small, uniform workflow sequence rather than
a local composite action: the local action cannot be loaded until the checkout it
would implement has succeeded. This is a narrow bootstrap exception to the normal
TypeScript-activity extraction threshold and must not consume code from the
caller's workspace. Shared comments and static tests keep the copies aligned.
Resolution output uses delimiter-safe `GITHUB_OUTPUT` handling and the shell sees
the input through `env:`, never direct expression interpolation.

**Alternatives considered.** Comparing HEAD with the input string is rejected
because supported inputs include tags. Checking only that HEAD is non-empty is the
same weak evidence that hid the current bug. Resolving after checkout is rejected
because it can make the proof circular. A new local bootstrap action is rejected
because it cannot be referenced safely before upstream helpers exist on disk.

### Decision 3 — Test the contract statically and at runtime

`test-reusable-portability.yml` gains inventory checks that require `helpers-ref`
on every helper-consuming reusable workflow, require repository-owned callers to
pass `github.sha`, ban `github.job_workflow_sha` and `job.workflow_sha`, and verify
the resolve/checkout/HEAD-compare ordering. Its synthetic external workspace test
continues proving that no helper is resolved from the caller workspace.

A minimal reusable-workflow runtime fixture exercises the same explicit-ref
contract without minting an App token or running an agent. Its caller runs on PR
and manual dispatch, supplies the current commit SHA, and exposes/logs the
requested ref, resolved SHA, and checkout HEAD. The assertion is equality of the
three commit identities, not merely a successful checkout step.

Finally, the human-owned external smoke test in Issue #455 invokes the released
workflow from a repository with no local helper tree, records the commit behind
the selected release ref, and verifies the runtime log reports that same resolved
SHA and HEAD. It repeats after upstream `main` advances without moving the selected
release ref. This is the release-contract proof that an in-repository test cannot
provide.

**Alternatives considered.** Static checks alone cannot prove Actions expression
evaluation or checkout behavior. An in-repo runtime test alone cannot reproduce an
external caller workspace. Treating `actions/checkout` success as the assertion is
explicitly rejected by the incident evidence.

### Decision 4 — Correct the incident record and publish a patch

Implementation updates the authoritative convention in `AGENTS.md`, the parent
design `reusable-workflow-helper-resolution.md`, this document, the #526 incident
design, `.github/actionlint.yaml`, workflow comments/tests, and the helper section
of `docs/adopting.md`. The correction must say that actionlint's diagnostic was
accidentally right, `github.job_workflow_sha` parsed but evaluated empty in the
cited run, and `job.workflow_sha` remains invalid. The runtime-evidence rule is
refined to require inspection of resolved values and effects—not step conclusion
alone.

After the implementation and automated regression tasks merge, a maintainer cuts
the next available patch release (expected `v0.0.2`) using `release.yml`, advances
`v0`, and verifies image publication. The release notes identify `v0.0.1` as
affected and direct consumers to upgrade; the immutable historical tag remains.

**Alternatives considered.** Leaving the #526 artifacts as historical statements
is rejected because `AGENTS.md` currently instructs agents to preserve the broken
expression. Deleting the incident documents is rejected because correction in
place preserves the epistemic trail. Rewriting `v0.0.1` is rejected because
released tags are immutable history.

## Out of scope

- Discovering or depending on another undocumented implicit Actions context.
- Changing agent actions, labels, GitHub App permissions, branch protection, or
  the outer-container trust boundary.
- Loading bootstrap validation code from an external consumer's workspace.
- Rewriting or deleting `v0.0.1` or retroactively changing past workflow logs.
- Automating release-tag creation or granting agents release authority.
- Completing the broader Issue #455 adoption checklist beyond the helper-version
  assertions added here.

## Rollout and failure behavior

The input addition is a deliberate interface change. Repository-owned callers and
reusable workflows land together so internal dispatches remain valid. External
consumers that copy the revised `v0` examples receive the explicit input; callers
that invoke the new release without it fail validation rather than execute an
unknown helper version. Existing consumers remain on the immutable affected
`v0.0.1` until they update, while moving-major consumers receive the corrected
contract when `v0` advances.

An empty, nonexistent, unauthorized, or otherwise unresolvable ref stops before
checkout. A checkout mismatch stops before any helper action loads. Logs include
the requested selector and the two commit SHAs but no credentials.

## Task breakdown

| Issue | Task | Dependencies |
|---|---|---|
| Issue [#537](https://github.com/mfrancza/agentic-development-workflow/issues/537) | Add the required `helpers-ref` input, independently resolved SHA checkout, and pre-helper HEAD equality guard to every affected reusable workflow; update all repository-owned callers to pass `github.sha`. | Issue #538 |
| Issue [#538](https://github.com/mfrancza/agentic-development-workflow/issues/538) | Correct the helper-checkout contract and incident record in `AGENTS.md`, the related design docs, `.github/actionlint.yaml`, workflow comments, and `docs/adopting.md`, including explicit `helpers-ref` in every external caller example. | — |
| Issue [#539](https://github.com/mfrancza/agentic-development-workflow/issues/539) | Extend static portability coverage and add a minimal in-repository runtime fixture that proves requested ref, resolved SHA, and helper HEAD equality. | Issue #537 |
| Issue [#540](https://github.com/mfrancza/agentic-development-workflow/issues/540) | Publish the next patch release, advance `v0`, and verify release artifacts and notes. This task requires a maintainer. | Issues #537, #538, #539 |
| Issue [#541](https://github.com/mfrancza/agentic-development-workflow/issues/541) | Run the external-consumer end-to-end regression: invoke the released reusable workflow with an explicit release ref, prove helper HEAD identity, advance upstream `main` without moving that ref, repeat, and record evidence. This task requires a maintainer with consumer-repository access. | Issues #537, #538, #539, #540 |

The documentation correction lands before the workflow task so implementing
agents are no longer instructed to preserve the broken expression. Automated
regression follows the workflow contract so it never creates an intentionally
failing mainline state. Release is serialized after all code and documentation,
and the external validation is the final end-to-end gate.
