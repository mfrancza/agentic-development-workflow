# Validation: reviewer supersedes stale CHANGES_REQUESTED and reaches terminal APPROVE

**Issue:** [#338](https://github.com/mfrancza/agentic-development-workflow/issues/338)  
**Design:** [docs/design/reviewer-supersede-stale-verdict.md](../design/reviewer-supersede-stale-verdict.md)  
**Date:** 2026-08-31  
**Test PR:** [#379](https://github.com/mfrancza/agentic-development-workflow/pull/379)

## Scenario

The test PR (`test/reviewer-supersede-338`) added `.github/scripts/test/validate-reviewer-supersede.sh`
without `set -euo pipefail`, mirroring the seed defect from PR #266 that surfaced issue #267.

## Execution timeline

| Time (UTC) | Event |
|------------|-------|
| 00:03:05 | `agent:review` applied; first review run started (run [33343407417](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33343407417)) |
| 00:04:40 | First pass: **CHANGES_REQUESTED** (review `5062259977`). Inline comment on `.github/scripts/test/validate-reviewer-supersede.sh`: "Missing `set -euo pipefail`." |
| 00:05:28 | Fix commit `97a14519` pushed (adds `set -euo pipefail`); synchronize re-review triggered |
| 00:05:28 | Re-review run started (run [33343523387](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33343523387)) |
| 00:05:48 | `dismiss-stale-reviewer-reviews` step: dismissed review `5062259977` |
| 00:07:16 | Re-review pass: **APPROVED** (review `5062266525`) |
| 00:07:19 | `agent-respond-review` triggered (run [33343617617](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33343617617)); skipped in 10 s |

## Verification results

### ✅ `dismiss-stale-reviewer-reviews` ran and dismissed the prior CHANGES_REQUESTED

Step log from re-review run `33343523387`:

```
Dismissed review 5062259977 (CHANGES_REQUESTED by mfrancza-reviewer-agent[bot]).
Dismissed 1 stale review(s); 0 failed (fail-open).
```

Dismissal message confirmed via GitHub events API:

```json
{
  "state": "changes_requested",
  "review_id": 5062259977,
  "dismissal_message": "Superseded by re-review from this bot."
}
```

The dismiss step ran with `continue-on-error: true` and exited cleanly (no errors).

### ✅ Re-review posted `APPROVE` (not `COMMENTED`)

Review `5062266525` by `mfrancza-reviewer-agent[bot]`:

- API `state`: `APPROVED`
- Anchored to head SHA `97a14519`
- Container log: `- **Verdict:** APPROVE (review ID 5062266525, anchored to head SHA 97a14519)`

This is the terminal event the re-review loop required. Under the pre-fix behaviour
(issue #267) this pass would have settled for `COMMENTED` despite a fully clean diff.

### ✅ `agent-respond-review` skipped on the APPROVE

Run `33343617617` completed in 10 seconds. Log from `check-reviewer-feedback`:

```
review-state: approved
INPUT_REVIEW_STATE: approved
Approval with zero unresolved threads; skipping respond-review.
```

The loop guard (approve + zero unresolved threads → skip) fired correctly. No developer
container was dispatched.

## Conclusion

All three checklist items from issue #338 pass. The fixes in issues #331 (prompt) and
#333 (dismissal step + workflow) together close the re-review loop as designed:

1. The dismissal step removes the stale blocking verdict before Claude runs, eliminating
   the bias signal the design doc hypothesised.
2. The updated prompt correctly selects `APPROVE` on a clean pass rather than hedging
   with `COMMENTED`.
3. The existing loop guard fires on the terminal `APPROVE` and suppresses the respond-review
   dispatch.
