# End-to-end validation: respond-review self-trigger guards (Issue #574)

**PR:** This file is the scratch PR change for end-to-end validation of the two
guards introduced in issues #571, #572, and #573.  All three implementation PRs
merged before this validation began (#576 Guard 1, #577 AGENTS.md, #578 Guard 2).

**Issue:** [#574](https://github.com/mfrancza/agentic-development-workflow/issues/574)  
**Scratch PR:** [#579](https://github.com/mfrancza/agentic-development-workflow/pull/579)

---

## Validation plan

Six cases, as specified in issue #574.

| Case | Guard | Trigger | Expected outcome | Status |
|------|-------|---------|-----------------|--------|
| 1 | Guard 1 (caller `if:`) | Developer-agent thread reply on own PR | `respond-review` job skipped at gate | ✅ PASS |
| 2 | Guard 2 (activity) | Human `COMMENTED` review, 0 unresolved threads | `check-reviewer-feedback` skips; no token minted | ⏳ pending mfrancza action |
| 3 | Guard 2 (positive path) | Human `COMMENTED` review, ≥1 unresolved thread | Container runs; agent posts reply | ⏳ pending mfrancza action |
| 4 | Regression | Human `CHANGES_REQUESTED` review | Agent proceeds unconditionally | ✅ PASS |
| 5 | Regression | Human `APPROVED`, 0 threads | `check-reviewer-feedback` skips (existing zero-threads path) | ✅ PASS |
| 6 | Doc check | Spot-check AGENTS.md § step 5 | Matches live run behaviour | ✅ PASS |

---

## Evidence

### Case 1 — Guard 1 (caller `if:`) catches the self-reply loop ✅ PASS

**Run URL:** https://github.com/mfrancza/agentic-development-workflow/actions/runs/37171225727

**Mechanism:**
1. The reviewer agent posted `CHANGES_REQUESTED` review 5403922423 with 5 inline comments on `docs/validation/scratch-validation-helper.sh` at 2026-10-04T02:27:57Z.
2. Run 37171137502 fired (CHANGES_REQUESTED → Guard 2 proceeds unconditionally).
3. The developer agent container ran, replied to all 5 inline threads via `gh api … /comments/{id}/replies`, and pushed fixes.
4. GitHub synthesised 5 `COMMENTED` reviews from the replies (IDs 5403931934 through 5403932614, all authored by `mfrancza-developer-agent[bot]`), each firing `pull_request_review: submitted`.
5. The last `COMMENTED` review triggered run 37171225727.

**Key evidence:**
- **Run conclusion:** `skipped`
- **Job conclusion:** `skipped`
- **Steps executed:** `[]` (empty — zero steps ran; no runner was allocated for the job)
- **Guard 1 condition that evaluated false:** `github.event.review.user.login ('mfrancza-developer-agent[bot]') != github.event.pull_request.user.login ('mfrancza-developer-agent[bot]')` → `false` → job skipped.

---

### Case 2 — Guard 2: COMMENTED with zero unresolved threads ⏳ PENDING

Awaiting human `COMMENTED` review from `mfrancza` on scratch PR #579 with no body text and all threads resolved. See evidence request in issue comment.

---

### Case 3 — Guard 2: COMMENTED with ≥1 unresolved thread ⏳ PENDING

Awaiting human `COMMENTED` review from `mfrancza` on scratch PR #579 with at least one open inline thread. See evidence request in issue comment.

---

### Case 4 — No regression on `CHANGES_REQUESTED` ✅ PASS (scratch PR #579)

**Run URL:** https://github.com/mfrancza/agentic-development-workflow/actions/runs/37171137502

- **Trigger:** `mfrancza-reviewer-agent[bot]` submitted `CHANGES_REQUESTED` on scratch PR #579 with 5 inline comments on `docs/validation/scratch-validation-helper.sh`.
- **Key log line:** `Review state is 'changes_requested'; proceeding.`
- **Mint installation token:** ✅ ran (token minted; `proceed=true` confirmed)
- **Run agent step:** ✅ present (developer container ran, fixed shell script issues, pushed commit)

---

### Case 5 — No regression on `APPROVED` with zero threads ✅ PASS (scratch PR #579)

**Run URL:** https://github.com/mfrancza/agentic-development-workflow/actions/runs/37170959770

- **Trigger:** `mfrancza-reviewer-agent[bot]` submitted `APPROVED` on scratch PR #579 (markdown-only commit; zero unresolved threads).
- **Key log line:** `Approval with zero unresolved threads; skipping respond-review.`
- **Mint installation token:** ❌ absent (no token minted; 9s total duration)
- **Run agent step:** ❌ absent (container did not run)

---

### Case 6 — AGENTS.md § MVP Workflow step 5 spot-check ✅ PASS

**Result:** Pre-verified against `main` commit `5dfc4fd` (merge of PR #577).

`AGENTS.md` lines 52–79 document the `check-reviewer-feedback` ordered checks:
1. PR not open → skip (fail-open on API error).
2. Author equality (Guard 2) → if `review-author == pr-author`, skip unconditionally.
3. Non-approval, non-commented (`changes_requested`, `dismissed`) → proceed.
4. Zero unresolved threads (`approved` or `commented`) → skip; non-zero → proceed.
5. Bare-approval fallback (`approved` only, GraphQL error) → skip if nothing to respond to.

Matches the implementation in `.github/scripts/src/check-reviewer-feedback.ts` (Decision 4 of the design doc). ✓
