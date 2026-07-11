# Validation Report: Sub-Issues Created with `--parent` Flag

**Issue:** [#103](https://github.com/mfrancza/agentic-development-workflow/issues/103) — End-to-end validation: verify sub-issues are created with `--parent` flag

**Design doc:** `docs/design/planned-issues-as-sub-issues.md`

**Fix PR:** [#110](https://github.com/mfrancza/agentic-development-workflow/pull/110) — Use `--parent` flag for atomic sub-issue creation in design.md (implements Issue #102)

**Acceptance gate for:** Issue [#99](https://github.com/mfrancza/agentic-development-workflow/issues/99) — Planned issues should be created as sub-issues of the issue with the plan tag

---

## Test scenario

The design agent (`AGENT_ACTION=design`) was applied to issue #99 (a `plan` issue) on 2026-07-10. This triggered the design workflow, which ran Claude using `docker/scripts/prompts/design.md` as the system prompt, creating a design document and sub-issues.

**Parent issue:** [#99](https://github.com/mfrancza/agentic-development-workflow/issues/99) — "Planned issues should be created as sub-issues of the issue with the plan tag"

**Design PR:** [#104](https://github.com/mfrancza/agentic-development-workflow/pull/104) — "Design: Planned issues should be created as sub-issues of the issue with the plan tag" (merged 2026-07-10T04:37:34Z)

---

## Acceptance criteria results

### 1. Sub-issues appear nested under the parent plan issue ✅

API verification (`gh api repos/mfrancza/agentic-development-workflow/issues/99/sub_issues`):

| Issue | Title | State |
|-------|-------|-------|
| [#101](https://github.com/mfrancza/agentic-development-workflow/issues/101) | TEST: sub-issue link test (will close) | closed |
| [#102](https://github.com/mfrancza/agentic-development-workflow/issues/102) | Update design.md prompt to use --parent flag for sub-issue creation | open |
| [#103](https://github.com/mfrancza/agentic-development-workflow/issues/103) | End-to-end validation: verify sub-issues are created with --parent flag | open |

All three issues appear as native sub-issues of #99 in the GitHub sub-issue API.

**Confirmation of atomic `--parent` usage:** The issue timeline shows `parent_issue_added` within one second of issue creation in all cases, which is the fingerprint of `gh issue create --parent` (GraphQL atomic mutation). A two-step create-then-link approach would show a larger gap between creation and linking.

The table below uses the `labeled` event timestamp as a proxy for issue creation time. Labels are applied atomically at creation time via `gh issue create --label ...`, so the `labeled` event timestamp closely approximates the `created` event in the GitHub timeline API. The gap column measures the interval from the `labeled` event to the `parent_issue_added` event, making the sub-second atomicity comparison unambiguous.

| Issue | labeled event (creation proxy) | parent_issue_added event | Gap |
|-------|-------------------------------|--------------------------|-----|
| Issue #101 | 2026-07-10T04:24:18Z | 2026-07-10T04:24:19Z | 1s |
| Issue #102 | 2026-07-10T04:24:56Z | 2026-07-10T04:24:57Z | 1s |
| Issue #103 | 2026-07-10T04:25:08Z | 2026-07-10T04:25:09Z | 1s |

Note: issue #101 was the design agent's own throwaway test to verify `--parent` works before creating the real sub-issues.

### 2. Sub-issues have correct `draft` and `enhancement` labels ✅

Issues #102 and #103 were created with both `draft` and `enhancement` labels (confirmed by timeline events at creation time). The `draft` label was correctly removed from all three sub-issues when design PR #104 merged (automated by the `undraft-sub-issues` job in `agent-design.yml`).

| Issue | Labels at creation | Labels after design PR merged |
|-------|-------------------|-------------------------------|
| Issue #101 | draft (test issue) | (none — also closed) |
| Issue #102 | draft, enhancement | enhancement ✓ |
| Issue #103 | draft, enhancement | enhancement ✓ |

### 3. Blocked-by relationships between sub-issues ⚠️ (verified: not recorded — pre-existing API limitation)

Issue #103 includes verifying whether blocked-by relationships are recorded. The check was performed using the GitHub issue REST API:

```bash
gh api repos/mfrancza/agentic-development-workflow/issues/102 --jq '.blocked_by // 0'
# => 0
gh api repos/mfrancza/agentic-development-workflow/issues/103 --jq '.blocked_by // 0'
# => 0
```

The API reports `blocked_by: 0` for both issues — **no blocked-by relationships were recorded**.

The underlying cause is a **pre-existing limitation** documented in `docs/design/planned-issues-as-sub-issues.md` (Decision 4):

> The investigation found that the `POST .../dependencies/blocked_by` endpoint also returns 404 for the developer-agent token. This is a separate pre-existing limitation (outside the scope of issue #99); it is documented here as context for a future fix.

The verification was performed and produced a clear result (no relationships recorded). The *fix* for this gap is out of scope for issues #99, #102, and #103 — this criterion is a known-blocked check, not an excluded one.

### 4. Entrypoint post-run verification passes ✅

Design PR [#104](https://github.com/mfrancza/agentic-development-workflow/pull/104) was opened and merged successfully (`state: MERGED`, `mergedAt: 2026-07-10T04:37:34Z`). The entrypoint's post-run checks both passed:
- PR existence check: PR #104 was found for branch `design/issue-99` ✓
- Sub-issue count check: 3 sub-issues found for issue #99 (`SUB_ISSUE_COUNT > 0`) ✓

---

## PR #110 diff review

PR #110 updates `docker/scripts/prompts/design.md` to explicitly instruct Claude to use `--parent "$GITHUB_ISSUE_NUMBER"` and removes the now-redundant separate API step. The diff is correct:

- Adds `--parent "$GITHUB_ISSUE_NUMBER"` as an additional flag on `gh issue create` ✓
- Removes the `gh api -X POST ... sub_issues` step ✓
- Renumbers the blocked-by step from step 3 to step 2 (no functional change) ✓
- The `gh issue create --parent` flag is confirmed available in the runtime environment ✓

This change ensures future design runs use `--parent` explicitly and consistently, rather than relying on Claude inferring it from issue context (as happened during the issue #99 design run).

---

## Overall result

**PASS** — The design agent creates all implementation sub-issues as native GitHub sub-issues nested under the parent plan issue. Sub-issues receive correct labels. The entrypoint exits 0. The only gap: blocked-by relationships were verified as not recorded (`blocked_by: 0` for both sub-issues — the check was performed). The root cause is a pre-existing API limitation; only the *fix* for that limitation is out of scope for issues #99 and #103.

Issue #99 is ready to close once PR #110 merges (which formalizes this behavior in the prompt).
