# External helper checkout identity smoke-test runbook

**Issue:** [#541](https://github.com/mfrancza/agentic-development-workflow/issues/541)
**Related:** [#455](https://github.com/mfrancza/agentic-development-workflow/issues/455), [#513](https://github.com/mfrancza/agentic-development-workflow/issues/513)
**Design ref:** [`helper-checkout-job-workflow-sha-context.md`](helper-checkout-job-workflow-sha-context.md) Decision 3

## Purpose

This runbook describes the human-executed external end-to-end validation required
by Issue #541. It is the release-contract proof that the helpers-ref bootstrap
(validate → resolve → checkout → verify-HEAD) works correctly from a consumer
repository with no local `.github/actions/` helper tree, and that the
checked-out helper commit remains anchored to the release tag even after upstream
`main` advances without moving the release ref.

This test cannot be completed by an agent: it specifically requires invocation
from an external workspace that does not contain this repository's `.github/` tree
and cross-repository credentials that only a maintainer holds. The in-repository
tests (`test-helper-ref.yml`, `test-reusable-portability.yml`) exercise the
mechanism internally; this runbook exercises it as an external consumer would.

**The assertion is not "the checkout step succeeded" — it is equality of the
requested ref, the independently resolved SHA, and the checkout HEAD.** The
incident in run
[34303371563](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34303371563)
demonstrated that a green checkout step is not evidence of version pinning; only
the resolved-value log entries constitute evidence.

## Pre-flight: record the release-ref commit

Before running any workflow, record the expected commit SHA by resolving the `v0`
tag via the GitHub API. This is the ground truth that subsequent runs must match.

```bash
EXPECTED_SHA="$(gh api repos/mfrancza/agentic-development-workflow/commits/v0 --jq '.sha')"
echo "v0 resolves to: ${EXPECTED_SHA}"
```

Save this value. Every subsequent step compares its resolved and checkout SHAs
against it.

## Consumer repo setup

Use a repository you control that does **not** contain a `.github/actions/` tree
matching `mfrancza/agentic-development-workflow`'s helper layout (for example
`mfrancza/drone-laser-tag`). Create the following workflow file in that repository:

**`.github/workflows/external-helper-identity-test.yml`**

```yaml
name: External helper identity test

# Runbook: docs/design/external-helper-identity-smoke-test.md (Issue #541)
#
# Invokes the upstream test-helper-ref-reusable.yml at the released v0 ref
# from an external workspace that contains no .github/actions/ tree, records
# the requested ref, the GitHub API-resolved SHA, and the _agentic-workflow/
# checkout HEAD, and requires exact equality of all three.
#
# A green checkout step alone is not sufficient evidence (see incident
# mfrancza/agentic-development-workflow#526); the resolved-value log lines and
# the equality assertion in the assert-equality job are the actual proof.

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  call-fixture:
    uses: mfrancza/agentic-development-workflow/.github/workflows/test-helper-ref-reusable.yml@v0
    with:
      helpers-ref: v0

  assert-equality:
    name: Assert requested-ref == resolved-sha == checkout-head
    runs-on: ubuntu-latest
    needs: call-fixture
    steps:
      - name: Assert all three commit identities match
        env:
          RESOLVED_SHA: ${{ needs.call-fixture.outputs.resolved-sha }}
          CHECKOUT_HEAD: ${{ needs.call-fixture.outputs.checkout-head }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail

          # Re-resolve v0 independently (does not rely solely on the fixture output).
          API_SHA="$(gh api repos/mfrancza/agentic-development-workflow/commits/v0 --jq '.sha')"

          echo "Requested ref resolved (v0) : ${API_SHA}"
          echo "Fixture-resolved SHA        : ${RESOLVED_SHA}"
          echo "Fixture checkout HEAD       : ${CHECKOUT_HEAD}"

          STATUS=0

          if [[ "${API_SHA}" != "${RESOLVED_SHA}" ]]; then
            echo "::error::API-resolved SHA (${API_SHA}) does not match fixture-resolved SHA (${RESOLVED_SHA})."
            STATUS=1
          fi

          if [[ "${RESOLVED_SHA}" != "${CHECKOUT_HEAD}" ]]; then
            echo "::error::Fixture-resolved SHA (${RESOLVED_SHA}) does not match checkout HEAD (${CHECKOUT_HEAD})."
            STATUS=1
          fi

          if [[ "${STATUS}" -eq 0 ]]; then
            echo "OK: all three commit identities match — external helper bootstrap contract verified."
          fi

          exit "${STATUS}"
```

> **Design note:** the `assert-equality` job independently re-resolves `v0` via
> the GitHub API rather than treating the fixture output alone as ground truth.
> This guards against a scenario where a bug in the fixture's resolve step itself
> produces a consistent but incorrect SHA; the independently-computed API value is
> the authoritative check.

## Execution — Run 1: initial dispatch

1. Confirm the pre-flight SHA matches the released tag (see above).
2. Dispatch the workflow via `workflow_dispatch` in the consumer repo:
   ```bash
   gh workflow run external-helper-identity-test.yml \
     --repo <consumer-repo>
   ```
3. Wait for both jobs (`call-fixture` and `assert-equality`) to succeed.
4. Open the run in the GitHub Actions UI and find the `assert-equality` job log.
   Locate the three lines that begin with `Requested ref resolved`, `Fixture-resolved
   SHA`, and `Fixture checkout HEAD`.
5. Confirm all three SHAs equal the pre-flight `EXPECTED_SHA`.
6. Record the run URL and copy the three log lines (see [Evidence format](#evidence-format-for-issue-541-comments)).

## Stability check: advance upstream main without moving the release ref

This step proves that the bootstrap is pinned to the release commit, not to the
moving `main` branch.

1. Merge any non-breaking change to `main` in `mfrancza/agentic-development-workflow`
   — a doc update, a comment, or a new workflow is sufficient. Do **not** move
   the `v0` or `v0.x.x` tags.
2. Confirm the `v0` tag still resolves to the same `EXPECTED_SHA`:
   ```bash
   gh api repos/mfrancza/agentic-development-workflow/commits/v0 --jq '.sha'
   # Must still equal EXPECTED_SHA
   ```
3. Confirm `main` HEAD is now a different (newer) commit:
   ```bash
   MAIN_SHA="$(gh api repos/mfrancza/agentic-development-workflow/commits/main --jq '.sha')"
   echo "main HEAD: ${MAIN_SHA}"
   # Must differ from EXPECTED_SHA
   ```

## Execution — Run 2: repeat after main advance

1. Dispatch the same workflow again:
   ```bash
   gh workflow run external-helper-identity-test.yml \
     --repo <consumer-repo>
   ```
2. Wait for both jobs to succeed.
3. Locate the three log lines in the `assert-equality` job output.
4. Confirm:
   - All three SHAs again equal `EXPECTED_SHA` (the release commit).
   - The three SHAs do **not** match the new `main` HEAD commit recorded in
     the stability-check step.
5. Record the run URL and copy the three log lines (see [Evidence format](#evidence-format-for-issue-541-comments)).

## Evidence format for Issue #541 comments

Post two separate comments on Issue #541 with the following structure.

**Comment 1 — Run 1 (initial):**

````
## External helper identity test — Run 1 (initial)

Workflow run: <URL>
Consumer repo: <owner>/<repo>
v0 expected SHA: <EXPECTED_SHA>

Log excerpt from `assert-equality` job:
```
Requested ref resolved (v0) : <sha>
Fixture-resolved SHA        : <sha>
Fixture checkout HEAD       : <sha>
```

**Result:** all three match ✅ — bootstrap contract verified.

Cross-reference: #455
````

**Comment 2 — Run 2 (after main advance):**

````
## External helper identity test — Run 2 (after main advance)

Workflow run: <URL>
Consumer repo: <owner>/<repo>
v0 expected SHA: <EXPECTED_SHA>  (unchanged — tag was not moved)
main HEAD after advance: <MAIN_SHA>  (different from expected SHA)

Log excerpt from `assert-equality` job:
```
Requested ref resolved (v0) : <sha>
Fixture-resolved SHA        : <sha>
Fixture checkout HEAD       : <sha>
```

**Result:** all three match the release commit, not the new main HEAD ✅ —
helper checkout is anchored to the release ref; bootstrap stability verified.

Cross-reference: #455
````

## Completion

Issue #541 will **not** close automatically when this PR merges — `Addresses #541`
in the PR body was used instead of `Closes #541` to keep the issue open for
evidence tracking. When both comments are posted on Issue #541 and both runs
have succeeded, close Issue #541 manually. The evidence is part of the
permanent record on Issue #541 and completes Issue #513's release-contract
validation.

## Out of scope

Per Issue #541:

- Fixing failures discovered by the test.
- Completing unrelated adoption-guide steps (Issue #455 scope).
- Moving release tags during the stability check.
- Treating a green checkout conclusion as sufficient evidence.
