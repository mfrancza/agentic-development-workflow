# E2E Validation: Cross-org secrets explicit-passthrough fix

**Issue:** [#593](https://github.com/mfrancza/agentic-development-workflow/issues/593)  
**Parent:** [#581](https://github.com/mfrancza/agentic-development-workflow/issues/581)  
**Design doc:** [`cross-org-secrets-explicit-passthrough.md`](cross-org-secrets-explicit-passthrough.md)

This document records the end-to-end validation results for the cross-org
secrets fix landed in PRs [#595](https://github.com/mfrancza/agentic-development-workflow/pull/595),
[#597](https://github.com/mfrancza/agentic-development-workflow/pull/597),
[#598](https://github.com/mfrancza/agentic-development-workflow/pull/598),
[#599](https://github.com/mfrancza/agentic-development-workflow/pull/599),
and [#600](https://github.com/mfrancza/agentic-development-workflow/pull/600).

---

## Check 1 — Audit cross-check

**Result: PASS**

Every rewritten caller stub was verified against the reusable-workflow secrets
inventory in the design doc. No missing keys, no extra keys, no typos. The
table below records the actual `secrets:` keys in each stub vs. the declared
secrets in the matching reusable.

| Caller stub | Jobs | Actual secrets block | Matches audit table? |
|---|---|---|---|
| `agent-auto-trigger.yml` | 6 (auto-groom, auto-design, auto-developer-do, auto-developer-undraft, auto-review, auto-developer-unblock) | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | ✓ |
| `agent-design.yml` | `call-design` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-design.yml` | `call-undraft` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-fix-checks.yml` | `fix-checks` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-fix-deployment.yml` | `fix-deployment` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-groom.yml` | `groom` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-implement.yml` | `implement` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-pr-merged.yml` | `remove-developer-label` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | ✓ |
| `agent-resolve-conflicts.yml` | `resolve-conflicts` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-respond-review.yml` | `respond-review` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `agent-review.yml` | `review` | `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ✓ |
| `terraform-ci.yml` | `plan` | `TERRAFORM_APP_ID`, `TERRAFORM_APP_PRIVATE_KEY`, `TF_API_TOKEN` | ✓ |
| `terraform-ci.yml` | `apply` | `TERRAFORM_APP_ID`, `TERRAFORM_APP_PRIVATE_KEY`, `TF_API_TOKEN` | ✓ |

All 11 files (13 job-level `secrets:` blocks) match the audit table exactly.

---

## Check 2 — In-repo smoke run

**Result: PASS**

A disposable test issue ([#601](https://github.com/mfrancza/agentic-development-workflow/issues/601))
was created and the `agent:groom` label applied. The `agent-groom.yml` caller stub
(with explicit secrets) triggered workflow run
[37237489384](https://github.com/mfrancza/agentic-development-workflow/actions/runs/37237489384),
which completed `success`.

Key steps from the run log (confirming explicit-secrets wiring works end-to-end):

```
✓ Validate helpers-ref input
✓ Resolve helpers-ref to commit SHA
✓ Check out upstream helper actions
✓ Verify helper checkout HEAD matches resolved SHA
✓ Mint installation token for developer-agent    ← explicit DEVELOPER_APP_ID/PRIVATE_KEY passed correctly
✓ Resolve Claude model from issue labels
✓ Prepare agent log directory
✓ Run grooming agent                             ← agent ran to completion
✓ Upload agent logs
✓ Remove agent:groom label                       ← success path cleanup completed
```

The "Mint installation token for developer-agent" step confirms that
`DEVELOPER_APP_ID` and `DEVELOPER_APP_PRIVATE_KEY` were correctly passed through
the explicit `secrets:` block in `agent-groom.yml` to the reusable. A missing or
mistyped secret name would fail this step with "missing required secret".

Additionally, the `agent-implement` workflow run
[37235248922](https://github.com/mfrancza/agentic-development-workflow/actions/runs/37235248922)
(triggered on 2026-10-04T21:13:58Z, after PR #595 landed) also completed `success`
with explicit secrets, providing further evidence that the wiring is correct across
the full developer-agent surface.

---

## Check 3 — CI pass

**Result: PASS**

All 19 vitest test files pass with 268 tests (run locally with `vitest run` inside
`.github/scripts`):

- `caller-stub-secrets-inherit.test.ts` — **2 tests pass** (the new regression
  test that asserts no caller stub uses `secrets: inherit` on a `*-reusable.yml`
  call). The test enumerates all 19 non-reusable `.yml` files in
  `.github/workflows/` and finds no violations.
- All other 18 test files pass with no regressions.

---

## Check 4 — Doc/stub consistency

**Result: PASS** (semantic match)

Three caller-stub code blocks in `docs/adopting.md` were spot-checked against the
matching `.github/workflows/` file on the `secrets:` block. In each case, every
key name and value expression matches exactly; the only difference is that the
adopting.md code blocks use aligned column spacing for readability (as specified by
Decision 2 of the design doc), while the repo's own caller stubs omit the alignment
padding. The semantics (and YAML parse result) are identical in both cases.

**agent-groom** (5-secret shape, developer-agent App + three provider keys):

`docs/adopting.md` code block (lines 601–606):
```yaml
    secrets:
      DEVELOPER_APP_ID:          ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY:         ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY:            ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY:               ${{ secrets.XAI_API_KEY }}
```

`.github/workflows/agent-groom.yml` (lines 37–42):
```yaml
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
```

**agent-review** (5-secret shape, reviewer-agent App + three provider keys):

`docs/adopting.md` code block (lines 833–838):
```yaml
    secrets:
      REVIEWER_APP_ID:           ${{ secrets.REVIEWER_APP_ID }}
      REVIEWER_APP_PRIVATE_KEY:  ${{ secrets.REVIEWER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY:         ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY:            ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY:               ${{ secrets.XAI_API_KEY }}
```

`.github/workflows/agent-review.yml`:
```yaml
    secrets:
      REVIEWER_APP_ID: ${{ secrets.REVIEWER_APP_ID }}
      REVIEWER_APP_PRIVATE_KEY: ${{ secrets.REVIEWER_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
```

**agent-pr-merged** (2-secret shape, developer-agent App only):

`docs/adopting.md` code block (lines 1175–1177):
```yaml
    secrets:
      DEVELOPER_APP_ID:          ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
```

`.github/workflows/agent-pr-merged.yml` (lines 74–76):
```yaml
    secrets:
      DEVELOPER_APP_ID: ${{ secrets.DEVELOPER_APP_ID }}
      DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
```

All three shapes verified. The key names match, the value expressions match,
the ordering matches — no missing keys, no extra keys, no typos.

---

## Summary

All four checks passed. The cross-org secrets fix is complete and the
published surface is consistent with the design doc.

Issue #455 (adoption smoke test) and Issue #456 (release-notes/gotchas update)
have been notified via comments pointing at the design doc and the merged PRs.
