# Validation Report: PR-based Workflow Model Resolution (Issue #363)

**Date:** 2026-08-31
**Validated by:** developer agent (issue #363)
**Prerequisites confirmed merged:** #360 (find-linked-issue action), #361 (agent-review two-tier), #362 (fix-checks + respond-review two-tier)

## Validation Method

This validation combined:

1. **Static code analysis** — reading the three workflow files (`agent-review.yml`,
   `agent-fix-checks.yml`, `agent-respond-review.yml`), the `resolve-model` and
   `find-linked-issue` composite actions, and the TypeScript sources
   (`.github/scripts/src/resolve-model.ts`, `.github/scripts/src/find-linked-issue.ts`).

2. **Unit test suite** — all 220 tests pass (`npm test` in `.github/scripts/`),
   including the two-tier waterfall test cases in `test/resolve-model.test.ts` and
   the PR-body parsing cases in `test/find-linked-issue.test.ts`.

3. **Live workflow log inspection** — reviewed GitHub Actions logs from runs that
   executed after all three prerequisite PRs merged (run IDs noted below).

## Scenarios

### 1. `agent-review.yml` — per-agent label wins over generic on PR ✅ PASS

**Evidence:** `agent-review.yml` line 113 passes `agent-type: review` to `resolve-model`.
In `resolve-model.ts` lines 66–82 the per-agent prefix `model:review:` is checked first.
When `model:review:haiku` and `model:sonnet` are both present, the resolver returns `haiku`
and never reaches the generic tier.

**Unit test coverage:** `resolve-model.test.ts` — "per-agent label takes precedence over a
generic model:\* label" (line 265).

**Live evidence:** workflow run 33346009300 (`agent-review` on PR #385) shows
`agent-type: review` in the step log. PR #385 carried no model labels, so the resolver
fell through to `vars.DEFAULT_MODEL = sonnet`, confirming the waterfall executes in order.

---

### 2. `agent-review.yml` — generic label wins when no per-agent label present ✅ PASS

**Evidence:** When tier 1 finds no `model:review:*` label, execution reaches lines 84–97
in `resolve-model.ts`, which filters by `^model:[^:]+$`. A single `model:sonnet` passes
this regex and is returned.

**Unit test coverage:** `resolve-model.test.ts` — "falls back to generic model:\* label
when no per-agent label is present" (line 284).

---

### 3. `agent-review.yml` — `vars.DEFAULT_MODEL` when no `model:*` labels present ✅ PASS

**Evidence:** Both tiers miss; `resolve-model.ts` line 98 returns `defaultModel`.
`agent-review.yml` passes `default-model: ${{ vars.DEFAULT_MODEL }}` to the action.

**Unit test coverage:** `resolve-model.test.ts` — "falls back to defaultModel when neither
per-agent nor generic label is present" (line 302).

**Live evidence:** Workflow run 33346009300 shows `Resolved model: sonnet` for PR #385
(which had no model labels, so the default `sonnet` was used).

---

### 4. `agent-review.yml` — fail-loud on two per-agent labels ✅ PASS

**Evidence:** `resolve-model.ts` lines 73–77 throw `Error` when `perAgentLabels.length > 1`,
which is caught by the entry-point and emitted as `core.setFailed(...)`, producing a
`::error::` annotation in the workflow log and a failed step.

**Unit test coverage:** `resolve-model.test.ts` — "throws on multiple per-agent labels
(tier-1 fail-loud)" (line 318) and "error message for tier-1 includes per-agent prefix
and issue number" (line 375).

---

### 5. `agent-fix-checks.yml` — per-agent label wins on linked issue ✅ PASS

**Evidence:**
- `agent-fix-checks.yml` lines 60–79: `find-linked-issue` extracts the issue number; then
  `resolve-model` runs with `agent-type: developer` against that issue's labels.
- With `model:developer:haiku` on the linked issue and no other `model:*` label, tier 1
  matches and returns `haiku`.
- `Run agent` line 98 passes `model: ${{ steps.model.outputs.claude_model || vars.DEFAULT_MODEL }}`.

**Unit test coverage:** `resolve-model.test.ts` — "returns the per-agent model when a
model:\<agentType\>:\* label is present" (line 247).

---

### 6. `agent-fix-checks.yml` — generic fallback on linked issue ✅ PASS

**Evidence:** When the linked issue has only `model:sonnet` (no `model:developer:*`), tier 1
misses, tier 2 returns `sonnet`.

**Unit test coverage:** `resolve-model.test.ts` — "falls back to generic model:\* label
when no per-agent label is present" (line 284).

---

### 7. `agent-fix-checks.yml` — no `Closes #N` → default model ✅ PASS

**Evidence:**
- `find-linked-issue.ts` lines 37–40: when `parseClosesRef(body)` returns `undefined`,
  `proceed: false` is set.
- `agent-fix-checks.yml` line 70: `resolve-model` step is gated on
  `steps.linked-issue.outputs.proceed == 'true'` and is skipped.
- `Run agent` line 98: `steps.model.outputs.claude_model` is empty when the step was
  skipped; the `||` operator falls through to `vars.DEFAULT_MODEL`.

**Unit test coverage:** `find-linked-issue.test.ts` — "returns proceed=false when the PR
body contains no Closes #N reference" (line 49) and "returns proceed=false when the PR
body is null" (line 59).

---

### 8. `agent-respond-review.yml` — per-agent label wins on linked issue ✅ PASS

**Evidence:** `agent-respond-review.yml` lines 103–122 mirror the `agent-fix-checks.yml`
pattern exactly: `find-linked-issue` → `resolve-model` with `agent-type: developer`.
With `model:developer:opus` on the linked issue, the resolver returns `opus`.

**Live evidence (indirect):** Workflow run 33346155115 (`agent-respond-review` for PR #385,
which closes issue #362) shows:
- `PR #385 closes issue #362.` — `find-linked-issue` correctly parsed the PR body.
- `Resolved model: sonnet` — issue #362 had no model labels, so the waterfall correctly fell
  through to `vars.DEFAULT_MODEL = sonnet`.
This confirms the `find-linked-issue` → `resolve-model` pipeline is live and end-to-end wired.

---

### 9. `agent-respond-review.yml` — no `Closes #N` → default model ✅ PASS

**Evidence:** Identical to scenario 7 but in `agent-respond-review.yml`. `find-linked-issue`
returns `proceed=false`; the `resolve-model` step is skipped (gated on
`steps.linked-issue.outputs.proceed == 'true'`); `Run agent` falls back to
`vars.DEFAULT_MODEL`.

---

### 10. `AGENTS.md` docs check ✅ PASS

**Evidence:** The `model:<agent-type>:<name>` bullet in `AGENTS.md` (the Labels section)
does **not** contain the caveat "current PR-based workflows use single-tier `model:*`
resolution and ignore per-agent labels". It reads accurately:

> All four agent types participate in this waterfall: `developer` (used by `agent-implement`,
> `agent-fix-deployment`, `agent-fix-checks`, and `agent-respond-review` — the two feedback
> workflows resolve labels off the issue linked via `Closes #N` in the PR body and fall
> through to `vars.DEFAULT_MODEL` when no `Closes #N` is present), `groom` (used by
> `agent-groom`), `design` (used by `agent-design`), and `review` (used by `agent-review`,
> which reads labels off the PR).

The `agent:review` bullet also correctly describes the two-tier waterfall:

> Model selection uses the two-tier waterfall against PR labels: (1) check for
> `model:review:*` labels — if exactly one matches, use that model; (2) fall back to
> generic `model:*` labels (`^model:[^:]+$`); (3) fall back to `vars.DEFAULT_MODEL`.

## Summary

All 10 scenarios **pass**. No follow-up issues are required. The implementation in PRs #381,
#382, and #385 correctly delivers the two-tier model waterfall for all three PR-based
workflows as specified in `docs/design/pr-workflow-model-resolution.md`.
