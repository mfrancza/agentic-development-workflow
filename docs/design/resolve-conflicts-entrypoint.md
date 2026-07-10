# Design: Conflict Resolution Entrypoint Action and Prompt

**Issue:** [#63](https://github.com/mfrancza/agentic-development-workflow/issues/63)
**Parent design:** [docs/design/resolve-conflicts.md](resolve-conflicts.md) (Issue #54)

## Summary

Implement `AGENT_ACTION=resolve-conflicts` inside the existing developer
container image. This comprises three deliverables that travel together in one
PR:

1. `action_resolve_conflicts` — a new function in
   `docker/scripts/entrypoint.sh` that handles all git mechanics: checking out
   the PR branch, running `git merge`, gathering conflict context, verifying the
   outcome, committing and pushing a clean resolution, or aborting and
   escalating when resolution fails.
2. `docker/scripts/prompts/resolve-conflicts.md` — the Claude system prompt
   that instructs the agent to reconcile both sides' intent semantically, record
   every judgment call, and signal clearly when a file cannot be reconciled
   confidently.
3. Documentation updates to `AGENTS.md` and `README.md` per the
   _Keeping Documentation Current_ standard in `AGENTS.md`.

The higher-level design (trigger strategy, authorship gate, safety bounds,
human-review option) is already settled in the parent design doc and is not
re-argued here. This document covers the implementation decisions that remain
open within that contract.

## Requirements as understood

From issue #63 and its grooming Q&A, the deliverables for this issue are:

- **Entrypoint**
  - Requires `GITHUB_PR_NUMBER`; exits non-zero if absent.
  - Check out the PR branch. Skip (return 0) if the PR carries the
    `human-required` label — a human is already intervening.
  - Fetch the base ref, then `git merge origin/<base>`.
  - If the merge is clean: push and exit 0.
  - On conflict: gather the conflicted working tree plus both sides' commit
    context and the PR/issue intent, then hand all of it to Claude via
    `run_claude`.
  - After Claude runs: verify no conflict markers (`<<<<<<<`, `=======`,
    `>>>>>>>`) remain and no paths are listed as unmerged.
  - If verification passes: commit the merge, push, and post a PR comment with
    Claude's resolution summary.
  - If Claude or verification fails: `git merge --abort`, apply
    `human-required` to the PR, post a comment naming the unresolvable files,
    exit non-zero.
  - Never push a partial resolution.

- **Prompt** (`docker/scripts/prompts/resolve-conflicts.md`)
  - Instruct Claude to reconcile _both_ intents semantically — never accept
    `ours` or `theirs` wholesale.
  - For every conflicted file: edit it to resolve the markers, then `git add`
    it.
  - Summarize each judgment call in a structured block that the entrypoint will
    later post as a PR comment.
  - If a file cannot be reconciled confidently, state so explicitly (do not
    silently pick a side) so the entrypoint's verification step catches it and
    triggers the fallback path.

- **Documentation** — add `resolve-conflicts` to the agent actions table in
  `AGENTS.md` and update `README.md` to describe the new action.

The action is `GITHUB_PR_NUMBER`-scoped (not issue-scoped), consistent with
`fix-checks` and `respond-review`.

## Decisions

### Decision 1 — Entrypoint owns git mechanics; Claude owns semantic content

**Decision:** Follow the same split used by `respond-review`: the entrypoint
does all git operations (checkout, merge, push, abort, commit), while Claude
only edits file content and produces a human-readable summary.

**Alternatives considered:**
- Have Claude do the git operations too (as with `action_implement`). Rejected:
  conflict resolution requires precise sequencing — merge, then edit, then
  verify, then commit — and doing verification inside a Claude session is
  unreliable. Keeping git operations in the shell ensures the verification step
  is authoritative.

This matches the pattern documented for this issue in the parent design doc and
requires no new architectural decision.

### Decision 2 — How to detect a clean merge vs. a conflict

**Decision:** After `git merge origin/<base>`, check the exit code:

- Exit 0 → merge is clean; push and exit.
- Exit 1 → conflict detected; proceed to Claude.
- Exit 2 (or any other non-1, non-zero code) → hard error (e.g. missing ref,
  dirty worktree, lock failure); do **not** attempt Claude resolution. Run
  `git merge --abort` if the merge was partially started, then exit non-zero
  with a log line describing the failure. Do not apply `human-required` for
  these operational errors — a re-run after the underlying issue is fixed is
  the expected recovery path.

Additionally, before running Claude, capture the list of unmerged paths with
`git diff --name-only --diff-filter=U` so the prompt can name specific files
and the fallback comment can list them.

**Alternatives considered:**
- Parse `git status --porcelain` for `UU`/`AA`/`DD` markers. Also works but
  exit-code check is simpler and less parsing surface.

### Decision 3 — What context to pass Claude

**Decision:** Pass Claude:

- The conflicted working tree (Claude Code has direct filesystem access, no
  need to embed full file content in the prompt; naming the conflicted files is
  sufficient).
- Both sides' recent commit log: `git log --oneline <merge-base>..HEAD` (branch
  commits) and `git log --oneline <merge-base>..origin/<base>` (base commits
  that introduced the conflict).
- The PR title and body (for intent).
- The linked issue number, if parseable from the PR body (for additional
  intent; non-fatal if absent).
- The explicit list of conflicted file paths.

This mirrors the context-gathering pattern in `action_respond_review`.

**Alternative considered:** Also pass the full PR review history. Rejected:
conflict resolution does not require review feedback; including it risks
distraction and adds token cost for no benefit.

### Decision 4 — How to verify no markers remain

**Decision:** Two complementary checks after Claude finishes:

1. `git diff --cached --check` — checks **staged** content for conflict markers.
   This is the correct scope because Claude is required to `git add` every
   resolved file; an unstaged check (`git diff --check`, without `--cached`)
   would see the working tree vs. the index and would produce no output for
   files that have already been staged, missing any markers Claude accidentally
   left in.  Both forms are run so that any unstaged file (never `git add`ed by
   Claude) is also caught:
   - `git diff --cached --check` — staged content (working tree changes that
     Claude added).
   - `git diff --check` — unstaged content (any file Claude edited but did not
     stage, which is itself an error).
2. `git ls-files --unmerged` — lists files still in the "unmerged" index state
   (catches files that were never `git add`ed by Claude, even if they have no
   markers in the working copy).

If any check produces output (or a non-zero exit), treat verification as failed
and trigger the fallback.

**Alternative considered:** grep for `<<<<<<<` across modified files. Rejected:
`git diff --check` / `git diff --cached --check` are the canonical tools for
this and handle edge cases (e.g. markers in binary-adjacent context) better
than a raw grep.

### Decision 5 — Merge commit message

**Decision:** Use a fixed message format:

```
Merge origin/<base> into <branch>: resolve conflicts in <file1>, <file2>, ...

Automated resolution by resolve-conflicts agent.
```

This is distinct from a squash-merge message; it stays on the PR branch only
and never reaches `main` (PRs are squash-merged, so branch-local merge commits
are not linear-history violations).

### Decision 6 — Where to output the resolution summary

**Decision:** Claude writes the summary to stdout as part of its normal output
(consistent with all other actions). The entrypoint captures Claude's output
and posts it verbatim as a PR comment using `gh pr comment`. The comment begins
with a fixed header line so reviewers can find it easily.

**Alternative considered:** Have Claude post the comment itself. Rejected: the
entrypoint must see the summary to decide whether verification passed; giving
the entrypoint control over the comment avoids a race where Claude posts before
verification completes.

### Decision 7 — Fallback comment content

**Decision:** The fallback PR comment must include:

- A statement that automated resolution failed.
- The explicit list of files that could not be resolved (from `git ls-files
  --unmerged` or Claude's output).
- The instruction to a human to resolve the conflict manually and remove the
  `human-required` label when done.

This reuses the escalation convention established by the `human-required` label
system described in `AGENTS.md`.

### Decision 8 — `human-required` skip check

**Decision:** Before running the merge, call `gh pr view $GITHUB_PR_NUMBER
--json labels` and exit 0 (with a log line) if the `human-required` label is
present. This matches the skip-guard pattern already used in other actions (e.g.
`action_implement` skips `draft`-labeled issues).

### Decision 9 — No `CLAUDE_MODEL` override for this action

**Decision:** Use `$CLAUDE_MODEL` (the repo-wide default, same as all other
actions). The parent design doc explicitly defers per-PR model overrides to a
later iteration. No new mechanism is introduced here.

## Out of scope

- The `agent-resolve-conflicts.yml` workflow file (trigger, PR enumeration,
  mergeable polling, per-PR dispatch) — that is issue #64.
- End-to-end validation through the full workflow trigger — that is issue #65.
- Model override via `model:*` PR labels for this action (deferred per parent
  design).
- Conflict resolution on human-authored PRs.
- Semantic conflicts that merge cleanly at the text level.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#106](https://github.com/mfrancza/agentic-development-workflow/issues/106) | Implement `action_resolve_conflicts` in `docker/scripts/entrypoint.sh`: checkout, skip-if-human-required guard, fetch, merge, context-gathering, `run_claude` call, verification (no markers / no unmerged paths), commit, push, PR comment on success; `merge --abort`, `human-required` label, fallback comment, exit non-zero on failure | — |
| [#107](https://github.com/mfrancza/agentic-development-workflow/issues/107) | Create `docker/scripts/prompts/resolve-conflicts.md`: semantic reconciliation instructions, `git add` directive, judgment-call summary format, explicit flag for unresolvable files | — |
| [#108](https://github.com/mfrancza/agentic-development-workflow/issues/108) | Update `AGENTS.md` (agent actions table: `resolve-conflicts`, required var `GITHUB_PR_NUMBER`) and `README.md` (new action in "How it works" and action matrix) | Issue #106 (env var contract must be settled first) |
| [#109](https://github.com/mfrancza/agentic-development-workflow/issues/109) | Isolated container validation: locally `docker run` the container against a test PR that has a manufactured conflict; verify clean-resolution path and fallback path without the full workflow trigger | Issue #106, Issue #107, Issue #108 |

The entrypoint task and the prompt task are independent and can proceed in
parallel — the prompt file is read at runtime, not compiled into the image
logic. The documentation task can follow once the entrypoint task settles the
exact env-var contract (`GITHUB_PR_NUMBER`). The validation task depends on all
three implementation tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
