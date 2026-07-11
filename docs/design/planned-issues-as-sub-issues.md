# Design: Planned Issues as Native GitHub Sub-Issues

**Issue:** [#99](https://github.com/mfrancza/agentic-development-workflow/issues/99)

## Summary

When the design agent creates implementation sub-issues for a `plan` issue, it
must link each new issue to its parent using GitHub's native sub-issue
relationship so that child issues appear nested under the plan issue in the
GitHub UI. The current prompt uses a two-step approach (create with
`gh issue create`, then link with a separate `gh api` call) that is fragile:
Claude can omit the second step when creating several issues in sequence. The
fix is to add `--parent "$GITHUB_ISSUE_NUMBER"` to `gh issue create`, making
creation and linking a single atomic operation.

## Requirements (from issue #99 and grooming Q&A)

Issue #99, groomed by the developer agent in its sole comment, identifies the
following problem and constraints:

1. **Observed gap.** The design agent ran for plan issue #41 and created
   implementation issues #94–#98. Issues #94 and #95 carry "Part of #41" in
   their bodies but are **not** native GitHub sub-issues. Issues #96–#98 are
   native sub-issues. The inconsistency proves the current two-step approach
   is unreliable.

2. **Required outcome.** All implementation issues created by the design agent
   must appear nested under the parent plan issue via GitHub's native
   parent-child sub-issue relationship.

3. **API surface to use.** The grooming notes suggest `gh issue create --parent`
   (if available) or `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`.
   Both are valid; which to prefer is a decision for this design.

4. **Retroactive fix.** The grooming notes ask whether this should apply
   retroactively to existing issues — addressed in Out of Scope below.

5. **"Part of #N" text.** The grooming notes ask whether the body text reference
   should be kept alongside or replaced by the native link — settled below.

## Investigation findings

- `gh` CLI v2.96.0 (installed in the developer image per `docker/Dockerfile`)
  supports `--parent <number>` on `gh issue create`. Confirmed by
  `gh issue create --help` output in the runtime environment.
- The target repository's GitHub plan supports sub-issues (issues #96, #97, #98
  are already native sub-issues of #41, demonstrating the feature is available).
- The current `docker/scripts/prompts/design.md` prompt instructs Claude to
  call `gh issue create` and then separately call
  `gh api -X POST "repos/${GITHUB_REPO}/issues/${GITHUB_ISSUE_NUMBER}/sub_issues"`.
  The second step is what Claude skipped for issues #94 and #95.
- **The `POST .../sub_issues` REST endpoint returns 404 for the developer-agent
  token** (confirmed during this design run). The GET endpoint works, confirming
  the feature is enabled for the repo, but the developer-agent App does not have
  the write permission that the POST requires. `gh issue create --parent` uses a
  different internal code path (the CLI wraps a GraphQL mutation) and succeeds.
  This makes `--parent` not just preferable but the only working option for the
  developer-agent identity.

## Design

### Decision 1: Use `--parent` flag, not a separate API call

**Decision:** Add `--parent "$GITHUB_ISSUE_NUMBER"` to the `gh issue create`
invocation in `docker/scripts/prompts/design.md` and remove the separate
`gh api -X POST ... sub_issues` step.

**Alternatives considered:**

| Alternative | Reason rejected |
|-------------|----------------|
| Keep the two-step approach (create, then API link) | Proved unreliable: Claude skips the second step for some issues when creating several in sequence. |
| Move linking to the entrypoint (Claude outputs a manifest file; entrypoint reads it and calls the API) | More complex: requires structured output from Claude plus new entrypoint logic, introducing two new failure surfaces instead of eliminating one. |
| Pre/post issue-list snapshot in entrypoint | Fragile: concurrent runs can create unrelated issues between snapshots; can't distinguish Claude's issues from others. |

`--parent` wins because it is atomic — creation and linking happen in one
operation. If `gh issue create --parent` fails, the issue is not created at
all, eliminating the "created but not linked" partial-failure class.

### Decision 2: Keep "Part of #N" text in sub-issue bodies

**Decision:** Retain the "Part of #N (see design doc: `docs/design/<slug>.md`)"
line in each sub-issue body.

**Rationale:** The native sub-issue relationship is the authoritative link and
appears in the GitHub UI. The body text is now redundant as a relationship
signal but provides useful standalone context when someone reads the issue via
CLI, in a notification email, or linked from a commit message. The redundancy
is harmless; removing it would require changing the sub-issue body template
in the prompt for no functional benefit.

### Decision 3: No change to `docker/scripts/entrypoint.sh`

The `action_design` function in the entrypoint already verifies that at least
one sub-issue exists after Claude runs:

```bash
if [ "$SUB_ISSUE_COUNT" -eq 0 ]; then
    log "ERROR: issue #${GITHUB_ISSUE_NUMBER} has no sub-issues — agent did not create the task breakdown"
    exit 1
fi
```

With the `--parent` approach, any successfully created issue is immediately a
sub-issue, so this check is sufficient. A stricter check (sub-issue count
equals task count) would require Claude to emit the expected count in a
structured file, which adds complexity out of proportion to the benefit. The
existing check already catches complete failures; partial failures become far
less likely once creation and linking are atomic.

### Decision 4: Blocked-by API call corrected; dependency order tracked natively

The investigation (issue #99) found that the original
`POST .../dependencies/blocked_by` calls silently returned 404 due to a
payload bug: the field was named `blocked_by_id` (correct name is `issue_id`),
and issue *numbers* were passed where the API requires the global database *ID*.
The endpoint itself works with the developer-agent App token when called
correctly — this is not a permission gap.

The call was corrected in issue #105:

```bash
BLOCKING_ID="$(gh api "repos/${GITHUB_REPO}/issues/<blocking_issue_number>" --jq '.id')"
gh api -X POST "repos/${GITHUB_REPO}/issues/<blocked_issue_number>/dependencies/blocked_by" \
  -F issue_id="$BLOCKING_ID"
```

Task-to-task dependency order is now tracked natively via GitHub's blocked-by
relationship graph (visible in the issue UI Relationships panel) and also
documented in the task breakdown table ("Depends on" column) for easy
reference.

## Out of scope

- **Retroactive linking of issues #94 and #95 to #41.** Those issues were
  created before this fix and can be linked by a human manually via the
  GitHub UI or `gh api` if desired.
- **Strengthening entrypoint verification to check all sub-issues are linked.**
  Separate concern; addressed by the `--parent` atomicity guarantee.
- **Changes to `docker/scripts/entrypoint.sh`, `agent-design.yml`,
  Terraform, or any workflow file.** The fix is entirely in the prompt.
- **Support for GitHub plans that do not have sub-issues.** The target repo
  already uses sub-issues; no fallback path is needed.
- **Grooming agent changes.** The grooming agent does not create sub-issues.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#102](https://github.com/mfrancza/agentic-development-workflow/issues/102) | Update `docker/scripts/prompts/design.md`: replace the two-step create-then-link pattern with `gh issue create --parent "$GITHUB_ISSUE_NUMBER"` | — |
| [#103](https://github.com/mfrancza/agentic-development-workflow/issues/103) | End-to-end validation: run the designer on a real `plan` issue and verify all sub-issues appear nested under the parent in GitHub's UI | Issue #102 |

The two tasks are strictly sequential. Issue #103 validates the whole fix and
closes issue #99.
