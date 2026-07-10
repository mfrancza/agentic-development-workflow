# Design: Automatic merge-conflict resolution

**Issue:** [#54](https://github.com/mfrancza/agentic-development-workflow/issues/54)

## Summary

When a push to `main` makes an open agent-authored PR conflicted, a new
developer-agent action merges `main` into the PR branch, resolves the
conflicts semantically with Claude, and pushes the merge commit. If it cannot
resolve confidently, it aborts and flags the PR for a human with the
`human-required` label.

## Requirements (from issue #54 grooming Q&A)

1. **Strategy** — semantic merge: an LLM reconciles both sets of changes
   (never "ours"/"theirs" wholesale).
2. **Scope** — attempt all conflicts, not just simple line-level ones.
3. **Fallback** — flag for human review when resolution fails.
4. **Trigger** — reactive: run when a conflict appears, not on a poll loop.
5. **Human review of resolutions** — options discussed in this design (below).

## Design

### Trigger: `push` to main, not PR events

GitHub emits no "PR became conflicted" event, and — critically — it drops
`pull_request` / `pull_request_review` workflow runs entirely while a PR has
merge conflicts (observed on PR #26; documented in
[code-review-agent.md](code-review-agent.md)). So the conflicted PR itself
cannot be the event source. Instead, the moment a PR *becomes* conflicted is
always a push to its base branch, which makes `push` to `main` the reliable
reactive trigger:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to check/resolve (skips enumeration)'
```

A new workflow `agent-resolve-conflicts.yml`:

1. Enumerates open PRs authored by the developer agent (same authorship gate
   as `agent-respond-review`; humans resolve their own conflicts).
2. Polls each PR's mergeability until GitHub finishes computing it. In the
   `gh`/GraphQL representation used by `gh pr view --json mergeable`, the
   value is `UNKNOWN` right after a push — retry with backoff, a few
   attempts, until it settles to `MERGEABLE` or `CONFLICTING`.
3. For each PR whose `mergeable` is `CONFLICTING`, runs the developer
   container with `AGENT_ACTION=resolve-conflicts` and that
   `GITHUB_PR_NUMBER`. One container run per conflicted PR; concurrency group
   `agent-resolve-conflicts-pr-<number>`, `cancel-in-progress: false`.

`workflow_dispatch` is the manual backstop for edge cases the push trigger
cannot see — e.g. a PR opened already-conflicted, or re-kicking after a
failed run.

### Resolution flow: entrypoint does git mechanics, Claude does semantics

Following the established split (entrypoint owns clone/branch/push;
Claude owns content — see `respond-review`):

1. Entrypoint checks out the PR branch, fetches the base ref, and runs
   `git merge origin/<base>`. If the merge succeeds cleanly, push and exit
   (GitHub's conflict detection can be stale).
2. On conflict, gather the conflicted file list and hand Claude the working
   tree (conflict markers in place) plus both sides' context: the branch's
   commits since merge-base and the base-branch commits that introduced the
   conflict, along with the PR title/body and linked issue for intent.
3. Claude edits each conflicted file to reconcile *both* intents, `git add`s
   the results, and summarizes each resolution choice.
4. Entrypoint verifies no conflict markers remain and nothing is still
   unmerged, commits the merge (message lists the resolved files), pushes,
   and posts a PR comment with Claude's resolution summary so reviewers can
   see what judgment calls were made.

A merge commit on the PR branch is fine: `main` requires linear history but
PRs are squash-merged, so branch-local merge commits never reach `main`.

### Fallback: abort and flag, never guess

If Claude reports it cannot reconcile confidently, or entrypoint verification
fails (markers remain, unmerged paths, merge produces an empty diff for a
file that had conflicts), the entrypoint runs `git merge --abort`, applies
the `human-required` label, and comments on the PR naming the files it could
not resolve and why. It never pushes a partial resolution. This reuses the
escalation convention added by #46: label + comment, human takes over.

### Human review of resolutions: considered options

Per Q&A item 5, three options were considered:

- **(a) Push to the PR branch; existing PR review covers it** *(chosen)*.
  The resolution commit lands on the PR branch like any other agent commit.
  Branch protection already forces at least one review of the final diff,
  `dismiss_stale_reviews_on_push` dismisses any prior approval the moment
  the resolution is pushed, and the PR comment from step 4 highlights the
  judgment calls. Once the reviewer agent's re-review trigger (#41) lands,
  resolutions also get an automatic re-review — the push is a `synchronize`
  event on a now-mergeable PR.
- **(b) Propose the resolution as a separate PR targeting the agent branch.**
  Isolates the resolution diff, but doubles the PR count per conflict,
  agents would need to manage stacked PRs, and the review burden lands on
  the same human either way. Rejected for complexity.
- **(c) Post the resolution as a patch in a comment; apply on human approval.**
  Slowest loop, needs new approve-and-apply machinery that duplicates what
  PR review already provides. Rejected.

Option (a) adds no new review machinery and no new trust: the human approval
that was already required now simply covers the resolution too.

### Safety bounds

- **Authorship gate:** only PRs authored by the developer agent are touched.
- **No resolution loops:** merging `main` into the branch makes it current,
  so a successful resolution cannot re-trigger itself; the next run only
  happens on the next push to `main`, and a then-clean merge exits at step 1.
- **One attempt per conflict event:** a failed resolution flags
  `human-required` and stops; the workflow does not retry until the next
  push to `main` or a manual dispatch. The prompt instructs Claude to skip
  PRs already labeled `human-required` (a human is mid-intervention) — the
  entrypoint enforces this before merging.
- **Model:** uses `vars.DEFAULT_CLAUDE_MODEL`; no per-PR override initially
  (can adopt the `model:*` PR-label pattern later if needed).

## Out of scope

- Conflicts on human-authored PRs.
- Resolving conflicts between two agent PRs before either merges (rebase
  queues / merge trains).
- Semantic conflicts that merge cleanly textually but break behavior — CI
  and the reviewer agent remain the nets for those.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#63](https://github.com/mfrancza/agentic-development-workflow/issues/63) | `resolve-conflicts` entrypoint action + `resolve-conflicts.md` prompt in the developer image (merge mechanics, semantic resolution, verification, fallback labeling) + AGENTS.md/README docs | — |
| [#64](https://github.com/mfrancza/agentic-development-workflow/issues/64) | `agent-resolve-conflicts.yml` workflow (push trigger, PR enumeration, mergeable polling, per-PR dispatch, `workflow_dispatch` backstop) + docs | — |
| [#65](https://github.com/mfrancza/agentic-development-workflow/issues/65) | End-to-end validation: manufacture a conflict against a test PR, watch it resolve; validate the fallback path with an unresolvable conflict | #63, #64 |

Issues #63 and #64 can proceed in parallel — this document is the contract
(`AGENT_ACTION=resolve-conflicts`, env: `GITHUB_PR_NUMBER`). Issue #65
validates both paths end-to-end.

Dependency order is documented in the task breakdown table above.
