# End-to-end validation: grooming agent picks tier per `docs/model-guidance.md`

**Validation issue:** [#340](https://github.com/mfrancza/agentic-development-workflow/issues/340)
**Validated on:** 2026-08-30
**Branch:** `agent/issue-340`

---

## Objective

Verify that the guidance doc (`docs/model-guidance.md`), the grooming criteria update
(`agents/grooming/label-criteria.json`), and the defaults audit (the *Repo Defaults* section of
`docs/model-guidance.md`) are all wired up correctly and produce the expected behavior on live
test issues.

---

## Test Case 1 — Groomer selects the correct tier (no pre-existing `model:*` label)

**Test issue:** [#369](https://github.com/mfrancza/agentic-development-workflow/issues/369)
— *[Validation test] Add a brief note to README about the 30-day artifact retention policy*

**Task class:** `enhancement — docs-only`
**Expected tier (per Task-Class Matrix):** `model:haiku`
**Pre-existing `model:*` label:** none

**Workflow run:** [`agent-groom` run 33336908026](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33336908026)
**Log artifact:** `agent-logs-groom-issue-369-run-33336908026-1`

```bash
gh run download 33336908026 \
  --repo mfrancza/agentic-development-workflow \
  --name agent-logs-groom-issue-369-run-33336908026-1
```

**Result:** ✅ PASS

The grooming agent applied `model:haiku` plus classification labels `enhancement` and `do`.
The agent's comment on the issue (excerpted):

> **Labels applied:** `model:haiku`, `enhancement`, `do`
>
> | Label | Reason |
> |---|---|
> | `model:haiku` | Docs-only enhancement — adding a brief note with wording already present verbatim in `AGENTS.md`. The Task-Class Matrix maps `enhancement — docs-only` to `model:haiku`; the Decision Heuristics confirm that docs-only changes are haiku work unless they touch security prose (this does not). |
> | `enhancement` | The issue requests new content in `README.md` (a sentence about 30-day artifact retention that is currently absent). |
> | `do` | The change is fully specified and trivially scoped: copy 1–2 sentences into the Debugging / log artifacts subsection of `README.md`. No architectural decisions are needed; implementable in a single commit. |

The agent cited both the Task-Class Matrix and the Decision Heuristics from `docs/model-guidance.md`
by name, confirming the guidance document is read and applied at run time.

---

## Test Case 2 — Groomer preserves pre-existing `model:*` label (skip behavior)

**Test issue:** [#370](https://github.com/mfrancza/agentic-development-workflow/issues/370)
— *[Validation test] Add example workflow dispatch command to README debugging section*

**Task class:** `enhancement — docs-only` (would normally map to `model:haiku`)
**Pre-existing `model:*` label:** `model:opus` (intentionally mismatched to the task class)
**Expected behavior:** groomer does NOT overwrite `model:opus`

**Workflow run:** [`agent-groom` run 33336913570](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33336913570)
**Log artifact:** `agent-logs-groom-issue-370-run-33336913570-1`

```bash
gh run download 33336913570 \
  --repo mfrancza/agentic-development-workflow \
  --name agent-logs-groom-issue-370-run-33336913570-1
```

**Result:** ✅ PASS

The grooming agent preserved `model:opus` and applied classification labels `enhancement` and `do`.
The agent's comment on the issue (excerpted):

> Grooming notes:
>
> - Applied labels: `enhancement` (adds a new example), `do` (small, well-scoped, single-commit change).
> - **Skipped model-label selection:** `model:opus` was already present on this issue, and per
>   grooming instructions any pre-existing `model:*` label takes precedence and must not be
>   overwritten — even when the task class (docs-only enhancement) would otherwise map to a lower
>   tier. This matches the validation intent noted in the issue body.

Final labels on issue #370: `enhancement`, `do`, `model:opus` — `model:opus` untouched. ✅

---

## Summary

| Test | Issue | Expected tier | Actual outcome | Pass? |
|---|---|---|---|---|
| Groomer picks tier from guidance (no pre-existing label) | [#369](https://github.com/mfrancza/agentic-development-workflow/issues/369) | `model:haiku` | `model:haiku` applied | ✅ |
| Groomer preserves pre-existing label (skip behavior) | [#370](https://github.com/mfrancza/agentic-development-workflow/issues/370) | `model:opus` preserved | `model:opus` preserved | ✅ |

Both the guidance-driven tier selection and the pre-existing-label skip behavior are confirmed
working end-to-end. The guidance doc, the criteria file, and the groom prompt are all wired up
correctly as of 2026-08-30.

No discrepancies found; no follow-up issues required.

---

## References

- `docs/model-guidance.md` — Tier Summary and Task-Class Matrix (read by groomer at run time)
- `agents/grooming/label-criteria.json` — `model:*` label criteria with `guidance` pointers
- `docker/scripts/prompts/groom.md` — groom prompt (instructs the agent to read model-guidance.md)
- [PR #368](https://github.com/mfrancza/agentic-development-workflow/pull/368) — defaults audit
  (the *Repo Defaults* subsection this validation confirms is accurate)
- [PR #367](https://github.com/mfrancza/agentic-development-workflow/pull/367) — grooming wire-up
  (criteria + prompt changes validated here)
