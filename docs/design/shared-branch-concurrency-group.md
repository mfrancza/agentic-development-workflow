# Design: Shared per-PR concurrency group for branch-writing developer actions

**Issue:** [#769](https://github.com/mfrancza/agentic-development-workflow/issues/769)
**Context:** `AGENTS.md` § MVP Workflow steps 4–6 (fix-checks, respond-review, resolve-conflicts);
`AGENTS.md` § Known traps (shape for a single-source concurrency rule that must stay in sync across three files).
**Related (not duplicate):**
Issue [#770](https://github.com/mfrancza/agentic-development-workflow/issues/770) (`--force-with-lease` lease-against-remote-tracking-ref bug) and
Issue [#771](https://github.com/mfrancza/agentic-development-workflow/issues/771) (model-issued in-session push bypassing entrypoint guards) are defence-in-depth against the same class of race. This design is the primary serialisation boundary; those two designs are complementary and independent.

## Requirements as understood

Issue #769 documents a real runtime failure. Three reusable workflows push commits to the same `agent/issue-{N}` branch on a developer-agent PR, but each sits in its own per-PR concurrency group:

| Reusable | Current group |
|----------|---------------|
| `agent-fix-checks-reusable.yml` | `agent-fix-checks-pr-<N>` |
| `agent-respond-review-reusable.yml` | `agent-respond-review-pr-<N>` |
| `agent-resolve-conflicts-reusable.yml` | `agent-resolve-conflicts-pr-<N>` |

Because the keys are distinct, Actions serialises each reusable with itself but not with the other two. Nothing prevents a `fix-checks` container and a `respond-review` container (or either of them and a `resolve-conflicts` container) from running simultaneously against the same PR, and the first writer's commit is force-pushed away by the second.

**Observed on PR #767 (2026-11-01, from the issue body):** two races within half an hour:

1. 19:40:57 — fix-checks (run 41342567276) pushes `b83f95b`.
   19:47:36 — respond-review (run 41342733649, container started 19:39) force-pushes `b01805a` over it.
2. 20:08:01 — fix-checks (run 41344840055) pushes `e57ac0b`.
   20:08:08 — respond-review (run 41344375599) force-pushes `d51405e` over it; the fix-checks entrypoint's trailing push then fails with "rejected (fetch first)".

In the second race the two agents produced contradictory edits — fix-checks added an `adopting.md` stub for `protected-approval-gate-reusable.yml`, while respond-review retired the same workflow. Each push also triggered its own `agent-review` run, so `d51405e` received an approval (a review generated against `e57ac0b`) and then a changes-requested review (generated against `d51405e`) two minutes apart — compounding the damage with a stale review recorded against a commit that no longer existed.

Per `AGENTS.md` § Reverting or replacing code with a passing live-run history: the citation above is runtime evidence (two independent bursts with observable force-push losses and stale reviews), not a linter or schema warning. This design modifies working code and the citation satisfies the runtime-evidence requirement.

### What the fix must deliver

The issue text and grooming notes already prescribe the fix shape. This design settles the detail — the exact group key, where it sits in each reusable, the static test that keeps the key in sync, how the dropped-pending-run caveat is acceptable for each action, and the documentation surfaces that must change.

Concretely, after this design ships:

- `fix-checks`, `respond-review`, and `resolve-conflicts` runs against the same PR must never execute their container steps concurrently; the loser must sit in Actions' per-group queue (or be the single "latest pending" replacement) until the winner's job completes.
- The shared concurrency group remains **inside** each reusable's work job, after any pre-authorize gates, matching the pattern already enforced by `test/workflow-concurrency.test.ts`. The group is not hoisted to workflow level and is not pushed into the caller stubs.
- `cancel-in-progress: false` is retained on all three groups — a running agent container must never be cancelled by a newer event; cancelling mid-run is as destructive as the race this design closes.
- A static test under `.github/scripts/test/` asserts that the three reusables all use the same literal group-key prefix (`agent-branch-pr-`), so a future refactor cannot silently split them again without the test turning red.
- `AGENTS.md` § MVP Workflow steps 4–6 describe the shared group once (the authoritative paragraph) and cross-reference it from each affected step.
- The caveat that GitHub keeps only one pending run per concurrency group — so a third queued event replaces the second — is explicitly noted, with the per-action recovery path.

### Ambiguities resolved from the issue

- **"e.g. `agent-branch-pr-<N>`"** in the issue body is a name suggestion, not a mandate. The chosen name is `agent-branch-pr-<pr-number>` (Decision 1).
- **"Keep the group inside the reusable's work job (after the authorize gate)"** is unambiguous for `fix-checks` and `respond-review`. For `resolve-conflicts` the "work job" is the matrix `resolve` job, and the key uses `${{ matrix.pr_number }}` because the matrix produces one job per PR; the per-matrix-instance group already mirrors the pattern.
- **"Confirm that's acceptable for each action, or note how a dropped event is recovered"** — Decision 4 enumerates the recovery path per action; none of the three actions produces a work item that, if a single pending slot is dropped under contention, cannot be regenerated by the next natural upstream signal or the existing polling backstop.

## Decisions

### Decision 1 — Group key is `agent-branch-pr-<pr-number>` for all three reusables

Alternatives considered:

- **(a) `agent-branch-pr-<N>`** (the issue's suggestion, with the per-reusable PR-number input as the variable portion).
- **(b) `agent-pr-<N>`** — shorter, but loses the "writes to the branch" intent. The group is specifically about branch writes; if a future read-only PR-level action is added (e.g. a per-PR audit workflow) the shorter name would invite it onto the same group and needlessly serialise unrelated work.
- **(c) `agent-write-pr-<N>`** — equally descriptive but less grep-able. The existing convention uses `-pr-<N>` as a trailing qualifier (e.g. `agent-respond-review-pr-<N>`, `agent-review-pr-<N>`); `agent-branch-pr-<N>` fits that shape.
- **(d) Key on `agent/issue-{N}` branch name rather than PR number.** Technically the branch is the resource being contested, but the PR number is always available in the reusable's inputs/needs, is a stable integer, and is already the key used by every per-PR group in this repo. Switching to branch name adds a resolution step with no benefit.

**Chosen: (a).** The issue's suggested prefix becomes the committed name. The literal key is:

```yaml
concurrency:
  group: agent-branch-pr-${{ <pr-number-expression-for-this-reusable> }}
  cancel-in-progress: false
```

The `<pr-number-expression-for-this-reusable>` part differs per reusable because each reusable already has a different source for the PR number — e.g. `inputs.pr-number`, `matrix.pr_number`, or a fallback expression on fix-checks that picks between a pre-resolved poll input and a resolver output. The static test (Decision 3) matches the prefix, not the expression, precisely because this expression is irreducibly different across the three files.

### Decision 2 — Keep the group inside the reusable's work job, after the pre-authorize/resolve gates

Alternatives considered:

- **(a) Workflow-level `concurrency:` on each reusable.** Would serialise the gate jobs too (resolve-trigger, feedback-gate, authorize, find-conflicted-prs), consuming the single serialisation slot for pure-metadata work that costs seconds. Worse, it would serialise events that the gate jobs end up rejecting, letting a rejected (and therefore never-run) event sit at the head of the queue and block a legitimate event behind it.
- **(b) Hoist the group into the caller stubs.** Rejected because `test/workflow-concurrency.test.ts` already enforces the opposite rule: caller stubs with label/sender gates must not declare workflow-level concurrency, because a competing label event in the same group displaces the queued run before its `if:` condition is evaluated. Moving the shared branch-group into a caller stub would re-introduce exactly the class of silent displacement that test was written to prevent.
- **(c) Inside the work job, after any gate jobs.** Mirrors the existing per-reusable placement. The first time a per-PR slot is taken is when real work is about to run, so the queue only contains actionable events.

**Chosen: (c).** The three files already place their concurrency block inside the work job (`fix-checks`, `respond-review`, `resolve`); this design only changes the key, not the placement.

The downstream consequence: the gate jobs (`resolve-trigger`, `feedback-gate`, `authorize`, `find-conflicted-prs`) continue to run in parallel for competing events. Only the work jobs serialise. This is the correct granularity — gates are cheap, idempotent, and have no side effects on the branch.

### Decision 3 — Static test: single-regex content check in `.github/scripts/test/`

Alternatives considered:

- **(a) Full YAML parse with a schema that pins the group-key shape.** Would be structurally sound but requires picking a YAML parser dependency for the test package (not currently installed) and encoding a position within each reusable's structure. The reusables are long and have evolving job shapes; a positional parse would be fragile.
- **(b) `grep`-style content regex over the three files.** Read each reusable with `fs.readFileSync`, assert the file contains a line matching `group:\s*agent-branch-pr-`. Cheap, terse, matches the style of the existing `test/workflow-concurrency.test.ts`, and is resistant to re-ordering jobs or renaming other inputs.
- **(c) Extract the full concurrency block.** Overkill; the key prefix is the only thing that needs to stay in sync. The expression after the prefix is irreducibly different per reusable (Decision 1).

**Chosen: (b).** The test file is a new `.github/scripts/test/branch-concurrency-group.test.ts` that:

1. Reads the three reusable YAML files from `.github/workflows/`.
2. Asserts each file contains exactly one line matching `/^\s*group:\s*agent-branch-pr-/`.
3. Asserts no file contains a line matching the retired prefixes (`agent-fix-checks-pr-`, `agent-respond-review-pr-`, `agent-resolve-conflicts-pr-`) — a belt-and-braces guard against a partial revert.

The assertion that there is *exactly one* match per file is the key invariant — a future refactor that adds a second concurrency block with a different key would be caught immediately. The retired-prefix guard catches the "forgot to delete the old key" class of mistake.

This test lives alongside `test/workflow-concurrency.test.ts` (which polices a different rule — workflow-level concurrency vs. label/sender gates in caller stubs). The two tests are complementary.

### Decision 4 — Dropped-pending-run behaviour is acceptable for each of the three actions

GitHub Actions keeps **at most one pending run** per `cancel-in-progress: false` concurrency group. If a third event arrives while one run is in progress and another is pending, the new event replaces the pending one. The displaced event is lost — no retry, no notification.

This matters for the three actions in different ways. Each row below answers the issue's explicit question — "Confirm that's acceptable for each action, or note how a dropped event is recovered":

| Action | What a dropped pending run would miss | Recovery path |
|--------|---------------------------------------|---------------|
| `fix-checks` | One Checks API failure event. | The `agent-fix-checks-poll.yml` workflow can re-dispatch `fix-checks` for open agent PRs whose head SHA still carries a failing check on the `FIX_CHECKS_ALLOW` list. It runs on the repository's poll cron or by manual dispatch. |
| `respond-review` | One reviewer-submitted review event. | The pre-existing `check-reviewer-feedback` activity reads the PR's current unresolved review threads from GraphQL, not just the triggering review — so the first run after the drop still sees any unresolved feedback left by the displaced reviewer. If the dropped review was a bare approval, it is lost; the reviewer can re-approve, or `agent-review` will re-approve on the next `synchronize` as part of the re-review loop. |
| `resolve-conflicts` | One push-to-main event. | Conflicted PRs are detected by polling `mergeable` on every open agent PR on every push to `main`, not by per-PR delivery. If an intermediate push's event is dropped, the next push to `main` (or a manual `workflow_dispatch` with `pr_number`) re-enumerates and picks up the still-conflicted PR. The PR does not resolve itself; it stays conflicted until a resolver run completes. |

In each case the lost event is recoverable — either idempotently by the next natural upstream signal (new review submitted, new fix needed, next push to `main`) or by an explicit polling backstop. No row produces a "permanently stuck PR" scenario.

The alternative — a larger pending queue — is not available: GitHub's concurrency model is fixed. A homegrown queue (e.g. recording pending events in an external store and replaying them) would introduce an entire new class of failure modes (queue consistency, token scope, cleanup) to solve a problem the existing backstops already address at zero added cost.

### Decision 5 — Scope: only the three reusables that push to the existing agent PR branch

The MVP has eight agent-container workflows. The shared group applies to the three that write to an existing `agent/issue-{N}` branch of an open PR:

| Workflow | Writes to agent/issue branch? | On the shared group? | Why |
|----------|-------------------------------|----------------------|-----|
| `agent-fix-checks` | Yes | **Yes** | In scope. |
| `agent-respond-review` | Yes | **Yes** | In scope. |
| `agent-resolve-conflicts` | Yes | **Yes** | In scope. |
| `agent-implement` | Creates a new `agent/issue-{N}` branch | No | The branch does not exist yet; the only writer is this one container. The existing `agent-implement-issue-<N>` per-issue group already prevents re-dispatch while the first run is in flight. |
| `agent-fix-deployment` | Creates a new `agent/fix-deploy-issue-{N}` branch and opens a fresh fix-up PR | No | Different branch from any existing agent PR; no contention possible with the three in-scope workflows. |
| `agent-review` | Does not write | No | Reviewer App has `Contents: read` only; the image ships no `git push` code path. |
| `agent-groom` | Does not write to any PR branch | No | Writes only to the issue (labels/comments). |
| `agent-design` | Writes to a new `design/issue-{N}` branch | No | Separate branch namespace from `agent/issue-{N}`; cannot collide with the three in-scope workflows. |

The three excluded write-paths (`agent-implement`, `agent-fix-deployment`, `agent-design`) write to branches that are either not shared with other write-path workflows (`agent/fix-deploy-issue-{N}`, `design/issue-{N}`) or are only ever touched by the single creator (`agent-implement` creates `agent/issue-{N}` before any of the three in-scope workflows can fire on it). Adding them to the shared group would widen the serialisation surface with no corresponding race to close.

### Decision 6 — AGENTS.md documentation shape

The authoritative paragraph goes in a new one-paragraph sub-section after step 6 of the MVP Workflow list, titled **"Shared per-PR concurrency group for branch-writing actions."** Steps 4, 5, and 6 are each given a one-sentence forward reference ("Serialised against the other branch-writing actions via the shared `agent-branch-pr-<N>` group — see the sub-section after step 6").

The authoritative paragraph covers:

1. The three in-scope workflows and the group name.
2. The placement rule (inside the work job, after pre-authorize gates).
3. The `cancel-in-progress: false` invariant.
4. The dropped-pending-run caveat and the per-action recovery path (summarised; the table in Decision 4 is the fuller reference).
5. The pointer to the enforcing test (`test/branch-concurrency-group.test.ts`).

Alternative considered: edit each of steps 4/5/6 in place with the full paragraph. Rejected because the paragraph would have to be duplicated three times, which would drift — the merge-friendly-docs rules at the end of `AGENTS.md` explicitly discourage this.

No `README.md` changes are required — the shared group is an internal workflow-engineering detail that is invisible to operators (no new env var, no new label, no setup step).

## Out of scope

- **Force-push guard (`--force-with-lease` lease-against-remote-tracking-ref bug).** Issue #770 is a defence-in-depth fix in `docker/scripts/entrypoint.sh`. It covers the class of race that this design closes *plus* writers outside the three in-scope workflows (e.g. a human pushing to the agent branch). The two fixes are independent and complementary; neither supersedes the other.
- **In-session push bypass.** Issue #771 covers the model issuing its own `git push` from inside the container, bypassing the entrypoint's push logic. Also defence in depth; also independent. Shared-group serialisation does not prevent in-session pushes from colliding with each other (both would hold the slot) — issue #771 is required for that.
- **Widening the shared group to cover `agent-implement`, `agent-fix-deployment`, or `agent-design`.** Decision 5 rules these out on the grounds that they write to branches no other in-scope workflow touches. If a future workflow is added that also writes to `agent/issue-{N}`, it must join the shared group — that is a change to the shared group's membership, documented in the same place as the group definition, and is out of scope for this design.
- **Changing `cancel-in-progress` semantics.** Decision 2 preserves `cancel-in-progress: false`. A hypothetical `true` would discard mid-run agent containers, which is destructive; no analysis of a `true` variant is in scope.
- **Hoisting the group to the workflow level or to caller stubs.** Decision 2 rules these out as placement variants.
- **Replacing GitHub's single-pending-slot model with a custom queue.** Decision 4 rules this out on complexity and recoverability grounds.
- **Cleaning up PR #767 or restoring any lost commits.** The lost commits are observable in the run logs; re-landing their content is a human task and is out of scope for this automation change.
- **Changing the `agent-fix-checks-pr-<N>` / `agent-respond-review-pr-<N>` / `agent-resolve-conflicts-pr-<N>` references in historical design docs** (e.g. `docs/design/fix-checks-any-failing-check.md`, `docs/design/agent-resolve-conflicts-workflow.md`). Those docs describe the system as it was at merge time; updating them in place would be gratuitous. Once this design merges, it is the authoritative description of the current shape and the older docs point back to it by implication.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#809](https://github.com/mfrancza/agentic-development-workflow/issues/809) | Update the concurrency group key to `agent-branch-pr-${{ … }}` in all three reusable workflows (`.github/workflows/agent-fix-checks-reusable.yml`, `.github/workflows/agent-respond-review-reusable.yml`, `.github/workflows/agent-resolve-conflicts-reusable.yml`), keeping each file's existing PR-number expression and the current `cancel-in-progress: false` and in-job placement. Add a new static test `.github/scripts/test/branch-concurrency-group.test.ts` that reads the three files, asserts each contains exactly one line matching `/^\s*group:\s*agent-branch-pr-/`, and asserts none contains any of the retired prefixes `agent-fix-checks-pr-`, `agent-respond-review-pr-`, `agent-resolve-conflicts-pr-`. The three workflow edits and the test must land together so CI cannot pass with a partial change. | — |
| [#810](https://github.com/mfrancza/agentic-development-workflow/issues/810) | Update `AGENTS.md` per Decision 6: add the authoritative paragraph titled "Shared per-PR concurrency group for branch-writing actions" after step 6 of the MVP Workflow list, and add a one-sentence cross-reference to that paragraph at the end of each of steps 4, 5, and 6. The paragraph names the three in-scope reusables, the group key `agent-branch-pr-<N>`, the `cancel-in-progress: false` invariant, the dropped-pending-run caveat with the per-action recovery path (fix-checks: poll on the repository's cron or manual dispatch; respond-review: unresolved-thread query is idempotent on the next review, plus re-review loop; resolve-conflicts: re-enumerated on the next push to `main` or `workflow_dispatch`), and the pointer to `test/branch-concurrency-group.test.ts`. | — |
| [#811](https://github.com/mfrancza/agentic-development-workflow/issues/811) | End-to-end validation on a scratch PR: (i) manufacture a fix-checks trigger and a respond-review trigger within seconds of each other against the same agent PR; verify in the Actions UI that the two work jobs sit sequentially in the `agent-branch-pr-<N>` group (one `in_progress`, the other `queued`) and that only one container runs at a time; (ii) manufacture a push to `main` that conflicts the same PR while one of the above is still in flight; verify the `resolve-conflicts` matrix job also queues on the same group and runs only after the first two complete; (iii) confirm that the branch HEAD after all three complete contains contributions from all three runs (no silent force-push loss); (iv) manufacture a fourth event while two are queued to confirm the dropped-pending-slot behaviour and its recovery (next poll tick for fix-checks, next review for respond-review, next push to `main` for resolve-conflicts). | Issues #809, #810 |

Issues #809 and #810 can proceed in parallel — the implementation task's test enforces the invariant independently of the documentation, and the documentation task's text is derivable from this design doc without waiting on code. Issue #811 (end-to-end validation) depends on both: the implementation must be merged for the groups to actually serialise, and the documentation must be merged so the validation plan matches the authoritative description.

Dependencies are recorded natively as GitHub blocked-by relationships on the sub-issues.
