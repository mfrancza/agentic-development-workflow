# Design: developer agent runs tsc + vitest before committing changes to `.github/`

**Issue:** [#772](https://github.com/mfrancza/agentic-development-workflow/issues/772)
**Context:** `AGENTS.md` § MVP Workflow (developer-agent actions), `AGENTS.md` § CI (what the `CI` workflow runs), `AGENTS.md` § Shell Script Conventions (how helpers under `docker/scripts/lib/` are tested), and [`.github/scripts/package.json`](../../.github/scripts/package.json) (the `npm test` / `npm run typecheck` script bindings).

## Requirements as understood

Issue #772 reports that the developer-agent container routinely commits and
pushes changes to `.github/scripts/` without first running the repo's own
checks — `tsc --noEmit` and `vitest run` in `.github/scripts/`. Because CI is
the enforcement layer, the first visible symptom is a red `CI` check on the
new HEAD. `CI` is subscribed in `agent-fix-checks.yml`'s `workflow_run`
list, so a failure spawns `AGENT_ACTION=fix-checks`. That run then races
the next `respond-review` for the same PR (a separate concurrency concern
tracked elsewhere), wasting agent turns and reviewer time on failures the
agent's own change introduced.

### Runtime evidence

Per `AGENTS.md` § "Reverting or replacing code with a passing live-run
history", a design that proposes to change working code must cite a runtime
failure. The failing runs on PR [#767](https://github.com/mfrancza/agentic-development-workflow/pull/767)
on 2026-11-01 provide that evidence:

- Four `respond-review` runs on PR #767 were inspected. Only one
  (`41342733649`) ran `npm test` before committing. The other three
  (`41339961072`, `41343143885`, `41344375599`) committed straight after
  editing.
- The resulting `CI` failures — `test-reusable-portability.yml` no-bootstrap
  inventory and the `adopting-guide-stubs` contract test — consumed several
  reviewer rounds and triggered `fix-checks` cycles that would not have
  been needed had the agent run the tests itself.

This is a prompt-and-entrypoint change, not a workflow revert. The runtime
evidence applies to the premise ("agent skips tests"), not to any specific
expression being replaced.

### What the fix must deliver

The issue text prescribes two layers; this design settles the open details.

1. **Prompt-side instruction.** The three agent prompts that author commits
   on branches —
   [`implement.md`](../../docker/scripts/prompts/implement.md),
   [`respond-to-review.md`](../../docker/scripts/prompts/respond-to-review.md),
   and [`respond-to-checks.md`](../../docker/scripts/prompts/respond-to-checks.md) —
   must require running the repo's checks before every commit when the
   change touches `.github/`. The required commands must be spelled out
   verbatim so the agent cannot invent approximations.
2. **Entrypoint-side backstop.** A helper that runs the same commands
   after Claude exits, independently of what the prompt asked for. The
   issue leaves the failure policy open ("hand back to Claude for one
   more turn", "push anyway but comment", or "block the push"); this
   design resolves it.
3. **Acceptance.** Prompts state the requirement with exact commands.
   If a backstop is added, a run whose commit fails `vitest` is handled
   per the chosen policy and the outcome is visible in the container log.

### Ambiguities resolved

- **Prompt scope.** The issue says "when the change touches `.github/`" —
  which is broader than just `.github/scripts/` where the tests live. Kept
  at `.github/` because several tests under `.github/scripts/test/` read
  workflow YAML files (e.g. `branch-concurrency-group.test.ts`,
  `caller-stub-secrets-inherit.test.ts`) — touching
  `.github/workflows/` can break tests just as surely as touching
  `.github/scripts/src/`.
- **Action scope.** The issue lists three prompts (`respond-review`,
  `fix-checks`, `implement`). Settled in Decision 5: the prompt updates
  land for exactly those three; the entrypoint backstop also runs for
  `fix-deployment` because it has the same "entrypoint pushes after
  Claude exits" shape as `fix-checks`.
- **Failure policy for the backstop.** Resolved in Decision 3: push
  anyway, post a PR comment with the failing output. Do not block the
  push; do not retry Claude.

## Decisions

### Decision 1 — Both layers: prompt instruction and entrypoint backstop

Alternatives considered:

- **(a) Prompt-only.** Cheapest; the agent is supposed to follow explicit
  instructions. PR #767 is the proof that this alone is not reliable —
  three of four runs ignored an implicit "run the tests" expectation. A
  stronger-worded prompt may improve the rate but cannot guarantee it.
- **(b) Backstop-only.** More reliable per run, but every failure costs
  a CI cycle that the agent could have prevented locally. Also makes
  the prompt silent about a load-bearing convention, which is a
  discoverability problem for human maintainers reading the prompts.
- **(c) Both.** Prompt instruction gets most agents to self-check before
  committing (cheap, fast, converges in one turn). Backstop closes the
  gap when the agent ignored the instruction (PR #767 shape). The two
  layers guard different failure modes.

**Chosen: (c)** — both. The prompt is the first line of defence; the
backstop is the enforcement layer. This mirrors the belt-and-braces
pattern used in
[`docs/design/respond-review-self-trigger-guard.md`](respond-review-self-trigger-guard.md)
(caller `if:` plus activity-level check).

### Decision 2 — Exact commands: `npm ci && npm run typecheck && npm test` in `.github/scripts/`

Alternatives considered:

- **(a) `npx tsc --noEmit` and `npx vitest run`.** What the issue text
  proposes verbatim. Works, but bypasses the `scripts` section in
  [`.github/scripts/package.json`](../../.github/scripts/package.json),
  so if the package ever adds flags (e.g. a vitest reporter, a
  `tsconfig.ci.json`), the prompt and the backstop drift.
- **(b) `npm run typecheck && npm test`.** Uses the script bindings
  already defined in `package.json` (`typecheck` → `tsc --noEmit`,
  `test` → `vitest run`). Any future tweak to how the tests run is
  captured by updating the package script, not every prompt and the
  backstop.

**Chosen: (b)** with `npm ci` prepended — `npm ci && npm run typecheck && npm test`.

Rationale:

- `npm ci` is prepended because the container starts clean and the
  test harness has no pre-installed `node_modules`. `npm ci` is
  idempotent on a warm cache (~1–2 s if `node_modules` matches the
  lockfile) and the correct choice over `npm install` because it
  refuses to run when the lockfile and `package.json` disagree —
  that mismatch is itself a bug the agent must see and fix.
- The commands run inside `.github/scripts/` (the npm package root),
  not from repo root. The prompts and the backstop state this
  explicitly.
- The commands match what [`.github/workflows/ci-reusable.yml`](../../.github/workflows/ci-reusable.yml)
  runs on CI, so a local pass is strong evidence of a CI pass.

### Decision 3 — Backstop failure policy: push anyway, post PR comment; do not block, do not retry Claude

Alternatives considered:

- **(a) Block push on failure.** Exits the container non-zero, nothing
  reaches the PR. Clean "correctness first" posture. Rejected because
  it loses the agent's work (reviewers cannot see what was proposed),
  gives no artefact to debug, and has no recovery path — the next
  event has to start from scratch.
- **(b) Retry Claude once.** Feed the failure output back as a
  follow-up turn. Doubles the LLM cost on bad days and converges
  non-deterministically (the model may still get it wrong). Also
  doubles the max-turn budget used per run, pushing some runs into
  exhaustion that would otherwise have finished. Rejected because
  `fix-checks` is the deterministic re-entry point for CI failures
  and already handles the "fix what's broken" case.
- **(c) Push anyway, post PR comment with failures.** CI is already
  the enforcement layer; the PR comment makes the backstop outcome
  visible per the acceptance criterion, and `fix-checks` picks up the
  real CI failure on the subsequent delivery.

**Chosen: (c)**. The backstop is a visibility layer, not a gate. The
rationale:

- **CI is the gate.** Blocking the push does not add safety — the next
  push attempt will still hit CI with the same code. The backstop's
  value is early detection and attribution ("this failure comes from
  the change you just made, before CI even runs"), which a PR comment
  delivers.
- **No work loss.** The agent's commits still land on the branch; a
  human reviewer can see the diff, the agent's commit messages, and
  the backstop comment all together.
- **Deterministic cost.** One backstop run per agent turn, no LLM
  retry loop. The `fix-checks` workflow handles the follow-up.
- **Visible outcome.** The container log records "backstop checks
  passed" or "backstop checks failed — posted PR comment"; the PR
  comment itself is the external artefact. Both satisfy the issue's
  acceptance criterion.

The container does not exit non-zero on backstop failure — that would
surface as a workflow failure, confusing it with the different failure
mode of "the agent itself crashed". Instead, the backstop logs an
explicit success/fail line and the push proceeds.

**Fail-open on backstop errors.** If the backstop itself errors (e.g.
`npm ci` fails due to transient network, or `vitest` cannot be
resolved), the backstop logs a warning and does NOT post a PR comment.
A false-positive "your code is broken" comment is worse than silence —
the next CI run will tell the truth either way.

### Decision 4 — Trigger the backstop only when `HEAD..HEAD` diff touches `.github/`

Alternatives considered:

- **(a) Always run.** Simplest, but ~15 s overhead on every agent run
  including runs that touched nothing in `.github/` — a waste.
- **(b) Diff-gated.** Run only when the paths changed by this run
  overlap `.github/`.

**Chosen: (b)** — diff-gated. The diff is computed from
`HEAD_BEFORE_CLAUDE..HEAD` (every action already captures or can
cheaply capture `HEAD_BEFORE_CLAUDE`). The path predicate is
`grep -q '^\.github/'` over `git diff --name-only`.

For `action_implement` and `action_fix_deployment` the "before" SHA
is the branch tip at container start (equal to base branch), and the
"after" SHA is HEAD after Claude. For `action_respond_review` and
`action_fix_checks` the "before" SHA is HEAD at container start on
the already-checked-out branch.

### Decision 5 — Prompt updates for the three actions the issue names; entrypoint backstop additionally covers `fix-deployment`

The issue lists three prompts (`respond-review`, `fix-checks`, `implement`).
The entrypoint backstop scope is a separate question — it should cover
every action where the entrypoint owns a push-or-create path for a
Claude-authored commit.

| Action | Prompt updated? | Backstop runs? | Push owner |
|---|---|---|---|
| `implement` | Yes | Yes | Claude (pushes + creates PR) |
| `fix-checks` | Yes | Yes | Entrypoint (`git push`) |
| `respond-review` | Yes | Yes | Entrypoint (`git push`) |
| `fix-deployment` | No | Yes | Entrypoint (`git push` + `gh pr create`) |
| `resolve-conflicts` | No | No | Entrypoint (`git push` of merge commit) |
| `design` | No | No | Claude (design PR; no code changes) |
| `groom` | No | No | No branch, no push |

Rationale for each row:

- `fix-deployment` has the same entrypoint-push shape as `fix-checks`
  and can land `.github/`-touching fixes; the backstop is a near-zero
  addition in the entrypoint. Prompt update not needed — the
  `fix-deployment.md` prompt already says "Run any existing tests or
  linters locally to verify"; if it proves insufficient later, add
  the explicit-commands block in a follow-up.
- `resolve-conflicts` is excluded. The commit it produces is a merge,
  not a Claude-authored edit — the "change this run introduced" is
  the content of the base branch, which has already passed CI on
  main. Running checks on the merged state is useful in principle,
  but the action's existing escalation path (`conflicts-escalated` +
  `human-required`) is the right place for any merge-time failure to
  surface, and conflating backstop failures with conflict-resolution
  failures would muddle the escalation semantics. Out of scope here;
  file a follow-up issue if a resolve-conflicts run ever breaks
  `.github/scripts/` tests in practice.
- `design` writes design docs to `docs/design/`, never `.github/`,
  so the diff-gate would always skip it.
- `groom` does not create a branch and performs no commits.

### Decision 6 — Backstop extracted into `docker/scripts/lib/pre-commit-checks.sh`; unit-tested via vitest-driven bash spawn (same pattern as `fix-checks-guard.sh`)

Alternatives considered:

- **(a) Inline the backstop into each `action_*()` function.** Four
  near-identical blocks. Diverges over time; hard to unit-test.
- **(b) Shell helper under `docker/scripts/lib/` sourced by
  `entrypoint.sh`.** Mirrors the existing `fix-checks-guard.sh` pattern:
  the function body lives in a sourced file, has a stable API, and
  is tested from vitest using `spawnSync('bash', …)` with mocked
  `PATH` for `npm` / `git` / `gh` (see
  [`.github/scripts/test/fix-checks-guard.test.ts`](../../.github/scripts/test/fix-checks-guard.test.ts)
  for the canonical shape).

**Chosen: (b)**. Convention already exists; CI already runs the
vitest suite that will host the new tests.

Helper API (sketch — see the Task 2 sub-issue for the final shape):

```bash
# Runs tsc --noEmit + vitest run in .github/scripts when the diff
# HEAD_BEFORE..HEAD touches .github/. Posts a PR comment on failure.
# Returns 0 whether checks pass, fail, or the diff gate skipped;
# non-zero only on bad arguments. Fail-open on backstop errors.
#
# Required env: WORK_DIR, GITHUB_REPO, GH_TOKEN
# Required args: 1=HEAD_BEFORE_SHA  2=PR_NUMBER (may be empty for runs
#                 where no PR exists yet)
pre_commit_checks_run <head-before-sha> <pr-number>
```

Log lines emitted (ASCII-friendly, prefixed with `[agent]` by the
existing `log()` helper so they end up in `container.log`):

- `pre-commit-checks: diff does not touch .github/, skipping`
- `pre-commit-checks: running npm ci && npm run typecheck && npm test in .github/scripts`
- `pre-commit-checks: passed`
- `pre-commit-checks: failed — posting PR comment to PR #<n>`
- `pre-commit-checks: encountered error running checks (<err>); skipping PR comment`

### Decision 7 — PR-comment format: machine-grep-able header plus a fenced output block

The comment must be:

- **Grep-able.** A fixed header line
  (`### Developer agent pre-commit checks failed`) so humans and
  future tooling can locate backstop comments without parsing prose.
- **Bounded.** The last ~200 lines of the combined
  `typecheck` + `test` output, fenced in triple backticks. Larger
  outputs truncate with a `(…truncated — full output in container
  logs…)` marker. Container logs carry the full output as an
  artefact (`AGENTS.md` § Container logs and session transcripts).
- **Scoped to this run.** The comment body references the
  container run via `GITHUB_RUN_ID`-style identifier if available,
  so a reviewer can correlate the comment to the specific agent
  run that produced it.
- **Non-noisy.** One comment per failing backstop run. No rate
  limit needed; `fix-checks` already serialises against the shared
  `agent-branch-pr-<N>` concurrency group (see `AGENTS.md` §
  "Shared per-PR concurrency group for branch-writing actions"),
  so the max backstop-comment rate is one per concurrency slot.

Example body:

```
### Developer agent pre-commit checks failed

`npm run typecheck && npm test` in `.github/scripts/` failed on commit `<sha>`.
The branch was pushed anyway; CI will re-check. See the agent run logs for the full output.

```
<last 200 lines>
```
```

### Decision 8 — AGENTS.md update: add a short "Pre-commit checks" note; do not duplicate the exact commands

The AGENTS.md update records the convention (developer-agent prompts
require tsc+vitest before commit when `.github/` is touched; the
entrypoint backstop enforces the same) without copying the exact
commands — those live in the prompts and in the helper source, per
`AGENTS.md` § "Volatile facts live at their sources". The AGENTS.md
entry points at `docker/scripts/prompts/` and
`docker/scripts/lib/pre-commit-checks.sh` as the authoritative
sources.

## Out of scope

- **Blocking the push on failure.** Decision 3 settles the policy;
  the backstop is a visibility layer, not a gate.
- **Retrying Claude with the failure output.** `fix-checks` is the
  deterministic re-entry point for CI failures; this design does
  not add a parallel in-container retry loop.
- **The `fix-checks`-vs-`respond-review` concurrency race.** Called
  out in the issue as related but tracked separately (see
  `AGENTS.md` § "Shared per-PR concurrency group for branch-writing
  actions"); this design relies on that lock to serialise backstop
  comments and does not change the lock itself.
- **Pre-installing `node_modules` in the developer container image.**
  An optional optimisation (shaves ~10 s off the backstop) that
  trades image size and staleness risk; can be revisited if backstop
  latency ever becomes a bottleneck.
- **`resolve-conflicts` backstop coverage.** Decision 5 defers this;
  file a follow-up if a real failure appears.
- **Tests under paths other than `.github/scripts/test/`.** The repo
  currently has no other automated test harness; if one is added
  later (e.g. Terraform unit tests), extend the backstop separately.
- **Reviewer-agent-side enforcement.** The reviewer container never
  commits, so pre-commit checks do not apply.
- **Cleaning up PR #767's historical CI failures.** Out of scope;
  this design prevents the next occurrence.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#821](https://github.com/mfrancza/agentic-development-workflow/issues/821) | **Update the three developer-agent prompts.** In [`docker/scripts/prompts/implement.md`](../../docker/scripts/prompts/implement.md), [`docker/scripts/prompts/respond-to-review.md`](../../docker/scripts/prompts/respond-to-review.md), and [`docker/scripts/prompts/respond-to-checks.md`](../../docker/scripts/prompts/respond-to-checks.md), add a "Before you commit" section that requires running `npm ci && npm run typecheck && npm test` inside `.github/scripts/` whenever the change touches `.github/`, and either fixing failures or stating in the reply why a failure is unrelated. Use the exact command string (Decision 2). Do not duplicate across the three prompts beyond the mandatory text — keep each file self-contained so a prompt can be read in isolation. | — |
| Issue [#822](https://github.com/mfrancza/agentic-development-workflow/issues/822) | **Implement `docker/scripts/lib/pre-commit-checks.sh`.** Create the helper with the API shape from Decision 6: a `pre_commit_checks_run <head-before-sha> <pr-number>` function that (i) computes `git diff --name-only <head-before>..HEAD`, (ii) returns early when no path matches `^\.github/`, (iii) runs `npm ci && npm run typecheck && npm test` in `.github/scripts/` capturing combined output, (iv) on a non-zero exit, posts a PR comment via `gh pr comment` using the format from Decision 7 (header, fenced output, ~200-line cap with truncation marker), (v) emits the log lines listed in Decision 6. Fail-open on backstop errors (log warning, no PR comment). Add vitest tests at [`.github/scripts/test/pre-commit-checks.test.ts`](../../.github/scripts/test/pre-commit-checks.test.ts) following the `fix-checks-guard.test.ts` pattern (spawn bash with mocked `PATH` for `git`, `npm`, `gh`). Cover: diff-does-not-touch-`.github/` skip, successful checks, failing checks → comment posted with expected header + body shape, backstop error (mocked `npm` non-zero on `ci` step) → no comment posted, log warning emitted. | — |
| Issue [#823](https://github.com/mfrancza/agentic-development-workflow/issues/823) | **Wire the backstop into `entrypoint.sh`.** In [`docker/scripts/entrypoint.sh`](../../docker/scripts/entrypoint.sh), `source` the new helper near the top (next to the existing `source "${SCRIPTS_DIR}/lib/fix-checks-guard.sh"`). For each action in `{implement, fix-checks, respond-review, fix-deployment}`, capture the `HEAD_BEFORE_CLAUDE` SHA before invoking `run_agent` (already done for `respond-review`; add for the other three) and call `pre_commit_checks_run "$HEAD_BEFORE_CLAUDE" "$PR_NUMBER"` after Claude exits but before the push/PR-create step (for `implement`, after the PR URL is resolved; `PR_NUMBER` is passed to the helper so the comment lands on the right PR). The call must not abort the action on backstop failure (Decision 3). Update the `action_*()` doc-comments to mention the backstop. | Issue #822 |
| Issue [#824](https://github.com/mfrancza/agentic-development-workflow/issues/824) | **AGENTS.md update.** Add a short "Pre-commit checks" bullet under the developer-agent-actions section (near § MVP Workflow step 3 or an adjacent conventions subsection), per Decision 8. Describe the convention in two or three sentences and point at `docker/scripts/prompts/` and `docker/scripts/lib/pre-commit-checks.sh` as the sources. Do not duplicate the exact commands into AGENTS.md. | — |
| Issue [#825](https://github.com/mfrancza/agentic-development-workflow/issues/825) | **End-to-end validation on scratch PRs.** (i) Open a scratch PR that deliberately introduces a typecheck failure in `.github/scripts/src/`, trigger `agent-fix-checks`, confirm the backstop runs, the push proceeds, and a comment with the Decision 7 header appears on the PR. (ii) Open a second scratch PR with a correct change touching `.github/workflows/` only, trigger `agent-respond-review`, confirm the backstop ran `npm ci && npm run typecheck && npm test` (the diff gate matches `.github/workflows/`), the checks passed, and no PR comment was posted. (iii) Open a third scratch PR touching `docs/` only, trigger `agent-respond-review`, confirm the backstop logged the `diff does not touch .github/, skipping` line and no commands ran. (iv) Verify the AGENTS.md note renders as expected and the Markdown links resolve. | Issues #821, #822, #823, #824 |

Issues #821, #822, and #824 are independent and can proceed in
parallel: #821 touches only `docker/scripts/prompts/*.md`, #822
touches only `docker/scripts/lib/pre-commit-checks.sh` and
`.github/scripts/test/pre-commit-checks.test.ts`, and #824 touches
only `AGENTS.md`. Issue #823 depends on #822 (needs the helper to
exist before sourcing it). Issue #825 depends on all four
implementation tasks landing.

Dependencies are recorded natively as GitHub blocked-by relationships
on the sub-issues.
