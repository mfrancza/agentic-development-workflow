# Reviewer Loop End-to-End Validation Report

**Issue:** [#98](https://github.com/mfrancza/agentic-development-workflow/issues/98)  
**Date:** 2026-07-12  
**Test PR:** [#146](https://github.com/mfrancza/agentic-development-workflow/pull/146) (`validation/issue-98-test`)  
**Parent issue:** [#41](https://github.com/mfrancza/agentic-development-workflow/issues/41)

---

## Summary

The validation exercised the full reviewer re-review loop against throwaway test PR [#146](https://github.com/mfrancza/agentic-development-workflow/pull/146). The test PR contains `validation/apply-label.sh` with two deliberate defects (missing `set -euo pipefail` and a JSON-injection vulnerability) to drive the multi-round review loop.

Two gaps were identified. Both feed back to sibling issues.

---

## Step 1 — Enrollment

**Expected:** Apply `agent:review` as an allowlisted user; `agent-review.yml` fires on `labeled` and posts an initial review.

**Actual:**

- `agent:review` applied by `mfrancza-developer-agent[bot]` (the running developer-agent identity).
- `agent-review.yml` triggered on `pull_request_target: labeled` — but the job **SKIPPED** (conclusion: `SKIPPED`).
- Cause: `github.event.sender.login` (`mfrancza-developer-agent[bot]`) is not in `vars.AGENT_ALLOWLIST`.

**Gap — configuration:** `mfrancza-developer-agent[bot]` is absent from `AGENT_ALLOWLIST` despite AGENTS.md stating agent bots are included so they can apply `agent:*` labels to route work. The Terraform `agent_allowlist` variable needs updating to include the developer-agent bot login.

**Workaround used:** Pushed a new commit to trigger the `synchronize` event. The `synchronize` path gates on label presence only (no sender allowlist), so the reviewer ran successfully on the second commit.

---

## Step 2 — Re-review on push

**Expected:** Push a commit addressing one finding; reviewer resolves that thread, leaves the other open, posts `REQUEST_CHANGES`.

**Actual:**

- Synchronize event fired on commit `740b20c`; `agent-review.yml` ran (conclusion: `SUCCESS`).
- Reviewer agent (`mfrancza-reviewer-agent[bot]`) posted `CHANGES_REQUESTED` on `740b20c` with two inline threads:
  - Thread `PRRT_kwDORzgBhs6QOg4Z` (line 1): missing `set -euo pipefail`
  - Thread `PRRT_kwDORzgBhs6QOg4a` (line 22): JSON injection via `$LABEL`
- `agent-respond-review.yml` triggered on the `CHANGES_REQUESTED` review; set `proceed=true`; developer-agent ran.
- Developer agent pushed commit `25b62852` ("Fix shell safety and JSON injection issues") that addressed **both** findings simultaneously.

Note: The developer agent fixed both findings in one commit, which collapsed the planned two-step validation into a single re-review round.

---

## Step 3 — Terminal approval

**Expected:** Reviewer resolves all threads via `resolveReviewThread` and posts `APPROVE`; `agent-respond-review.yml` logs `proceed=false`.

**Actual:**

- Re-review triggered on `synchronize` for commit `25b62852`; `agent-review.yml` concluded `SUCCESS`.
- Reviewer posted `APPROVE` on `25b62852` ✓ — correctly identified that both issues were fixed.
- **Gap — thread resolution not called:**
  - Thread `PRRT_kwDORzgBhs6QOg4Z` remains `isResolved: false` after the APPROVE.
  - Thread `PRRT_kwDORzgBhs6QOg4a` remains `isResolved: false` after the APPROVE.
  - The reviewer agent did not issue `resolveReviewThread` mutations for either addressed thread.
- `agent-respond-review.yml` triggered on the `APPROVE` review; set `proceed=false` ✓ — developer agent did **not** run.
  - However, the skip fired via the **bare-approval short-circuit** (no body, no inline comments on the APPROVE review) rather than the zero-unresolved-thread check. With two unresolved threads, the GraphQL check would have returned `proceed=true` had the bare-approval check not short-circuited first.

---

## Step 4 — Conflicted-PR workaround

**Expected:** Push to `main` to create a conflict; confirm synchronize alone does not restart the loop; re-apply `agent:review` and confirm loop resumes.

**Actual:** Not tested — branch protection on `main` (required PR + approval) prevents direct pushes needed to manufacture the conflict. The conflicted-PR behavior and the `agent:review` re-apply workaround are documented in AGENTS.md (see PR [#143](https://github.com/mfrancza/agentic-development-workflow/pull/143)).

---

## Findings

### F1 — Configuration: developer-agent bot not in `AGENT_ALLOWLIST`

**Severity:** Medium  
**Symptom:** `labeled` trigger skips for `agent:review` when applied by the developer-agent bot.  
**Impact:** Agents cannot apply `agent:review` to route their own PRs to the reviewer, violating the intent in AGENTS.md. Humans in the allowlist can apply the label and work around it.  
**Fix:** Update `vars.AGENT_ALLOWLIST` (via Terraform `agent_allowlist`) to include `mfrancza-developer-agent[bot]`.  
**Tracks:** Configuration/deployment gap (no code change needed in this repo).

### F2 — Code: reviewer agent does not resolve threads via `resolveReviewThread`

**Severity:** High  
**Symptom:** Both review threads remain `isResolved: false` after the reviewer posts `APPROVE`.  
**Impact:** Threads accumulate across re-reviews; the loop guard relies on resolved threads as the ground truth that all findings are addressed. An APPROVE with open threads is misleading to human reviewers looking at the PR.  
**Fix:** Debug why the reviewer agent is skipping the `resolveReviewThread` mutations. The prompt (`docker/reviewer/prompts/review.md`) clearly instructs Claude to resolve addressed threads before posting. Possible causes: (a) Claude is not following the multi-step instruction reliably with the current model; (b) the mutations fail silently; (c) the `isOutdated: true` state on thread 2 caused the reviewer to skip the resolve step.  
**Tracks:** Sibling issues #96 / PR #144 (which also changes the resolve order). The underlying non-resolution should be investigated separately.

### F3 — Logic: loop guard short-circuits on bare approval before checking unresolved threads

**Severity:** Low (latent)  
**Symptom:** With two unresolved threads and a bare APPROVE, `agent-respond-review.yml` set `proceed=false` via the bare-approval path (no body, no inline comments on the APPROVE review) before reaching the GraphQL thread count check.  
**Impact:** If the reviewer posts a bare APPROVE with unresolved threads (which Finding F2 confirms can happen), the developer agent silently skips rather than responding. This is the scenario PR [#141](https://github.com/mfrancza/agentic-development-workflow/pull/141) / issue #94 is designed to fix.  
**Tracks:** PR #141 / issue #94 (reordering: GraphQL thread count check before bare-approval check).

---

## Checklist vs. expected outcomes

| Step | Expected | Actual | Pass/Fail |
|------|----------|--------|-----------|
| 1a. `labeled` fires and posts review | `labeled` trigger fires | Job SKIPPED (allowlist miss) | ✗ |
| 1b. Initial review posted with ≥1 inline finding | At least one inline thread | Two threads posted via `synchronize` workaround | ✓ (workaround) |
| 2a. `synchronize` re-fires | `agent-review.yml` runs on push | Ran on `25b62852` | ✓ |
| 2b. Addressed thread resolved | `isResolved: true` on fixed thread | Both threads still `isResolved: false` | ✗ |
| 2c. Unfixed thread remains open | One thread open | N/A (both fixed in same commit) | N/A |
| 2d. Review lands on new HEAD SHA | Review commit matches HEAD | APPROVE on `25b62852` matches HEAD | ✓ |
| 3a. APPROVE posted | `state == APPROVED` | APPROVED | ✓ |
| 3b. All threads resolved | All `isResolved: true` | Both still `isResolved: false` | ✗ |
| 3c. `proceed=false` logged | Loop guard skips | `proceed=false` (bare-approval path) | ✓ (wrong path) |
| 4. Conflicted-PR workaround | Manual test | Not tested (branch protection) | N/A |

---

## Open PRs tracking the gaps

- [#141](https://github.com/mfrancza/agentic-development-workflow/pull/141) (`agent/issue-94`) — reorder loop guard checks (F3)
- [#143](https://github.com/mfrancza/agentic-development-workflow/pull/143) (`agent/issue-97`) — document conflicted-PR limitation
- [#144](https://github.com/mfrancza/agentic-development-workflow/pull/144) (`agent/issue-96`) — reviewer resolve+post ordering (related to F2)

The core re-review loop is functional end-to-end. The two blocking gaps (F1 and F2) should be resolved before this issue is closed as the acceptance gate for #41.
