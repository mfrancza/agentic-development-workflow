# End-to-end validation: respond-review self-trigger guards (Issue #574)

**PR:** This file is the scratch PR change for end-to-end validation of the two
guards introduced in issues #571, #572, and #573.  All three implementation PRs
merged before this validation began (#576 Guard 1, #577 AGENTS.md, #578 Guard 2).

**Issue:** [#574](https://github.com/mfrancza/agentic-development-workflow/issues/574)

---

## Validation plan

Six cases, as specified in issue #574.

| Case | Guard | Trigger | Expected outcome |
|------|-------|---------|-----------------|
| 1 | Guard 1 (caller `if:`) | Developer-agent thread reply on own PR | `respond-review` job skipped at gate |
| 2 | Guard 2 (activity) | Human `COMMENTED` review, 0 unresolved threads | `check-reviewer-feedback` skips; no token minted |
| 3 | Guard 2 (positive path) | Human `COMMENTED` review, ≥1 unresolved thread | Container runs; agent posts reply |
| 4 | Regression | Human `CHANGES_REQUESTED` review | Agent proceeds unconditionally |
| 5 | Regression | Human `APPROVED`, 0 threads | `check-reviewer-feedback` skips (existing zero-threads path) |
| 6 | Doc check | Spot-check AGENTS.md § step 5 | Matches live run behaviour |

---

## Evidence

### Case 6 — AGENTS.md § MVP Workflow step 5 spot-check

**Result: PASS (pre-computed; no live run needed)**

`AGENTS.md` lines 52–79 (as of commit merged via PR #577) describe the
`check-reviewer-feedback` decision flow in the following order, which matches
the implementation in `.github/scripts/src/check-reviewer-feedback.ts`:

1. **PR not open** → skip immediately (fail-open on API error).
2. **Author equality** (Guard 2, defence in depth) → if `review-author ==
   pr-author`, skip unconditionally regardless of review state.
3. **Non-approval, non-commented states** (`changes_requested`, `dismissed`)
   → proceed unconditionally.
4. **Zero unresolved threads** (primary check for `approved` and `commented`)
   → skip; non-zero → proceed.
5. **Bare-approval fallback** (`approved` only, when GraphQL errors) → skip
   if no body and no inline comments.

This matches Decision 4 from the design doc and the updated AGENTS.md wording
introduced by PR #577 / issue #573. ✓

---

### Case 4 — CHANGES_REQUESTED no regression

**Result: PASS — evidence from PR #578 (implementation branch)**

- **Run:** https://github.com/mfrancza/agentic-development-workflow/actions/runs/37169059936
- **Branch:** `agent/issue-572`
- **Trigger:** `mfrancza-reviewer-agent[bot]` submitted a `CHANGES_REQUESTED`
  review (state appears as `changes_requested` in the event payload; the
  review was later dismissed by `mfrancza`, which changes its REST state to
  `DISMISSED` but does not alter the original event).
- **Key log line:** `Review state is 'changes_requested'; proceeding.`
- **`run-agent` step:** present (job ran 2m 7s; developer-agent container
  executed and responded to the review).

Guard 2 correctly let the `CHANGES_REQUESTED` state proceed unconditionally.
No regression. ✓

---

### Case 5 — APPROVED with zero threads no regression

**Result: PASS — evidence from PR #578 (implementation branch)**

- **Run:** https://github.com/mfrancza/agentic-development-workflow/actions/runs/37169323229
- **Branch:** `agent/issue-572`
- **Trigger:** `mfrancza-reviewer-agent[bot]` submitted an `APPROVED` review
  with zero unresolved threads (the reviewer found no blocking issues on the
  second pass after the developer agent addressed the AGENTS.md omission).
- **Key log line:** `Approval with zero unresolved threads; skipping respond-review.`
- **`run-agent` step:** absent (job completed in 48 s without minting a token
  or running the container).

Guard 2 correctly skipped the zero-threads approval. ✓

---

### Cases 1, 2, 3 — pending live-run evidence

Cases 1, 2, and 3 require live runs on this scratch PR:

- **Case 1** is triggered automatically: `agent:review` applied → reviewer
  posts inline comments → developer agent replies → GitHub synthesises
  COMMENTED reviews from the replies → Guard 1 should skip the resulting
  `agent-respond-review` run.
- **Cases 2 and 3** require a human account in `vars.AGENT_ALLOWLIST`
  (i.e. `mfrancza`) to submit `COMMENTED` reviews on this PR — one with all
  threads resolved (Case 2) and one with at least one unresolved thread open
  (Case 3).

Evidence will be appended to the issue comment once the runs complete.
