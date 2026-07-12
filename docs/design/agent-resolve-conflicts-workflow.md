# Design: `agent-resolve-conflicts` Workflow

**Issue:** [#64](https://github.com/mfrancza/agentic-development-workflow/issues/64)
**Parent design:** [docs/design/resolve-conflicts.md](resolve-conflicts.md) (Issue #54)

## Summary

Implement `.github/workflows/agent-resolve-conflicts.yml` — the GitHub Actions
workflow that reacts to pushes on `main` by detecting conflicted agent-authored
PRs and dispatching the `resolve-conflicts` container action for each one.

The parent design doc is the authoritative contract for the overall feature.
This document covers the implementation decisions specific to the workflow file
itself: job structure, token timing, polling strategy, and the `workflow_dispatch`
bypass.

## Requirements as understood

From issue #64, its grooming Q&A, and the parent design doc
(`docs/design/resolve-conflicts.md`):

1. **Triggers** — `push` to `main` (the reactive hook) and `workflow_dispatch`
   with an optional `pr_number` input (the manual backstop). Conflicted PRs emit
   no events of their own; a PR becomes conflicted precisely when `main` advances
   past it, making `push` to `main` the reliable signal (see the PR #26 gotcha
   in the parent design doc).

2. **Enumeration** — enumerate open PRs authored by the developer agent. Only
   agent-authored PRs are touched; human PRs are excluded by this authorship gate.

3. **Mergeable polling** — GitHub computes mergeability asynchronously. A PR's
   `mergeable` field returns `UNKNOWN` immediately after a push. The workflow must
   poll with exponential backoff until the value settles before acting.

4. **Per-PR dispatch** — for each PR with `mergeable == CONFLICTING`, run the
   developer container with `AGENT_ACTION=resolve-conflicts` and
   `GITHUB_PR_NUMBER`. Each PR's run must sit under its own concurrency group
   (`agent-resolve-conflicts-pr-<number>`, `cancel-in-progress: false`) so an
   in-progress resolution is never cancelled by a subsequent push.

5. **Token timing** — the agent token (minted via `.github/actions/agent-token`)
   must be minted *after* the workflow confirms there are conflicted PRs to
   process; do not mint a token for runs where there is nothing to do.

6. **Model** — `vars.DEFAULT_CLAUDE_MODEL`; no per-PR override initially.

7. **Documentation** — AGENTS.md and README.md are updated alongside the
   workflow file. Per the task breakdown below, documentation lands in a
   separate follow-on PR (Issue #131) that is blocked on the workflow
   implementation (Issue #130), so that the docs accurately reflect the
   finished workflow rather than a design-time approximation. "Same PR as the
   workflow file" means Issue #131 and #130 are both merged before Issue #65
   (end-to-end validation) begins — docs are not deferred indefinitely.

8. **Permissions** — although issue #64 only mentions `contents: read` at the
   top level, the workflow must also declare `pull-requests: read` explicitly in
   the top-level `permissions:` block. This is an inferred/corrective requirement:
   GitHub Actions' `permissions:` block is replacing, not additive — any unlisted
   scope defaults to `none`, so `contents: read` alone would set `pull-requests`
   to `none`, causing `gh pr list` to fail with a 403 inside `find-conflicted-prs`.

The grooming notes confirm that this issue can start immediately (the parent
design is the contract), that `cancel-in-progress: false` is intentional, and
that the `push`-to-`main` trigger is the correct hook.

## Decisions

### Decision 1 — Two-job structure: `find-conflicted-prs` + `resolve` matrix

**Decision:** Split the workflow into two jobs:

- **`find-conflicted-prs`** — runs with the default `GITHUB_TOKEN` (read-only),
  enumerates agent PRs, polls mergeability for each, and outputs a JSON array of
  conflicted PR numbers.
- **`resolve`** — a matrix job over that array; each matrix entry runs
  independently under its own concurrency group, mints an agent token, builds
  the image, and dispatches the container.

**Alternatives considered:**

- *Single sequential job* that enumerates PRs and loops over conflicted ones:
  simpler YAML but cannot use GitHub Actions' native per-PR concurrency groups.
  Concurrency keys are evaluated at the job level and must reference values known
  at scheduling time; a `matrix` entry is exactly that. A single looping job
  would either serialize all PRs under one concurrency key (defeating the
  per-PR isolation requirement) or require separate workflow dispatch calls that
  add complexity.

- *Dispatch per-PR via `gh workflow run`* from the outer job: creates a
  dependency on the `workflow_dispatch` trigger, adds API round-trip latency,
  and makes the inner run hard to observe from the outer. Rejected.

The matrix approach is idiomatic for fan-out workflows in GitHub Actions and
maps the per-PR concurrency requirement directly onto the Actions model with no
extra machinery.

### Decision 2 — Token minting scope

**Decision:** The `find-conflicted-prs` job uses `github.token` (the default
read-only GITHUB_TOKEN) for PR listing and mergeability polling. The agent token
is minted only in the `resolve` matrix job, which runs only when there is at
least one conflicted PR, satisfying the spec's requirement to mint "after
determining there is work to do."

**Alternative considered:** Mint the token once in `find-conflicted-prs` and
pass it to the `resolve` job via `outputs`. Rejected: GitHub Actions does not
provide a safe mechanism to pass an installation token between jobs — the value
would appear in plain text in the workflow log. Each job that needs the agent
token must mint its own. This is already the pattern in `agent-respond-review.yml`,
which mints only after the feedback-check step confirms there is something to do.

### Decision 3 — Empty-matrix guard

**Decision:** The `resolve` job carries an `if` condition:

```
needs.find-conflicted-prs.outputs.conflicted_prs != '[]'
```

Without this guard, a `fromJson('[]')` expression in the `strategy.matrix` field
produces no matrix entries, which is a workflow validation error at runtime.
When there are no conflicted PRs the `resolve` job is skipped entirely and no
agent token is minted.

### Decision 4 — Mergeability polling strategy

**Decision:** For each PR, retry up to five times with exponential backoff
(delays: 5 s, 10 s, 20 s, 40 s, 80 s — total worst-case 155 s per PR). If the
value is still `UNKNOWN` after all retries, log the PR number and skip it for
this run. The next `push` to `main` or a manual `workflow_dispatch` is the
natural retry.

All polling for all PRs is done sequentially in the `find-conflicted-prs` job
before the matrix is built. This keeps the polling logic in one place and avoids
spinning up concurrent runner slots for pure waiting.

**Practical runtime bound:** The worst-case polling cost is 155 s per PR ×
the number of open agent PRs. At the `--limit 500` cap this is theoretically
155 s × 500 ≈ 21.5 hours, which would exceed GitHub Actions' job time limit.
In practice this repository is unlikely to have more than a handful of
simultaneously open agent PRs at any time. The implementation should add a
defensive cap — skip polling (and log a warning) if the enumerated PR count
exceeds a threshold (e.g., 50) — so a pathological accumulation of stale PRs
cannot block the runner. The `--limit 500` in Decision 6 is an enumeration cap
(prevents silently missing PRs); the polling cap is a separate guard that fires
only when the count is unreasonably large.

**Alternatives considered:**

- *Fail the entire `find-conflicted-prs` job if any PR stays `UNKNOWN`*: rejects
  the whole batch because of one PR's transient state. Rejected.

- *Poll indefinitely with a hard timeout*: complicates the script, risks burning
  GitHub Actions minutes for pathological cases, and offers no better outcome
  than skipping. Rejected.

### Decision 5 — `workflow_dispatch` input handling

**Decision:** When `$PR_NUMBER_INPUT` is non-empty (the `workflow_dispatch`
path), the `find-conflicted-prs` job skips enumeration entirely and polls only
the specified PR number. On `push` triggers, `$PR_NUMBER_INPUT` is set to an
empty string (via the `|| ''` fallback in the `env:` mapping described below),
so enumeration proceeds normally.

The input value is passed via an `env:` variable (`PR_NUMBER_INPUT`) in the
`run:` step and referenced as `"$PR_NUMBER_INPUT"` inside the script. It is
never interpolated directly into the `run:` body via `${{ inputs.pr_number }}`,
consistent with the output-injection hygiene pattern in `AGENTS.md`.

**Authorship gate on the `workflow_dispatch` path:** The `workflow_dispatch`
path skips enumeration, which also skips the `author.login ==
"app/mfrancza-developer-agent"` filter from Decision 6. This is an intentional
operator-override design choice (Option B): `workflow_dispatch` requires write
access on the repository, so any caller is an authenticated operator who is
explicitly targeting a specific PR number and is trusted to know what they are
doing. Allowing an operator to run the resolver against a human-authored PR (for
debugging, testing, or manual assistance) is a valid use case that should not be
blocked. Implementers should document this behavior in the usage notes so it is
explicit rather than silent: the manual path intentionally bypasses the
authorship gate. If future policy requires that even manual invocations be
restricted to agent-authored PRs, the implementation can add a `gh pr view
--json author` check in the dispatch branch and exit with a clear error if the
authorship check fails.

**Safe env wiring for multi-trigger workflows:** `inputs.*` is only defined
when the trigger is `workflow_dispatch` or `workflow_call`. On a `push` trigger
the entire `inputs` context is absent; referencing `${{ inputs.pr_number }}`
can cause expression evaluation itself to fail — it does not merely resolve to
an empty string. This means `${{ inputs.pr_number }}` must never appear in an
`env:` mapping or expression for a multi-trigger workflow. Even if expression
evaluation were to silently produce an empty string, strict Bash (`set -e -o
pipefail -u`) would still error on an unset variable inside the script.
The `env:` mapping must therefore use a fallback expression:

```yaml
env:
  PR_NUMBER_INPUT: ${{ github.event.inputs.pr_number || '' }}
```

`github.event.inputs` is only present in the event payload for
`workflow_dispatch` and `workflow_call` triggers; on a `push` trigger it is
absent and resolves to `null`. The `|| ''` fallback in the expression makes it
safe regardless of trigger: `null || ''` evaluates to `''`, so
`PR_NUMBER_INPUT` is always set (to an empty string on `push` runs, to the
supplied value on `workflow_dispatch` runs).

### Decision 6 — Developer agent author login

**Decision:** Enumerate agent-authored PRs by filtering
`author.login == "app/mfrancza-developer-agent"` in the output of
`gh pr list --json author,number --limit 500`. The explicit `--limit 500` overrides
`gh`'s default cap of 30 results, ensuring that older open agent-authored PRs
are not silently skipped. 500 is a practical upper bound (a repository with
more than 500 simultaneously open agent PRs warrants a different strategy);
the default 30 would silently miss conflicted PRs beyond the newest 30.

This matches the author login returned by `gh pr view --json author` in
`agent-fix-checks.yml` (`"$AUTHOR" = "app/mfrancza-developer-agent"`). Note
that the `app/`-prefixed form is what the GitHub REST/GraphQL API surfaces via
`gh pr list --json author` and `gh pr view --json author`. Webhook event
payloads (e.g., `github.event.pull_request.user.login`) use a different form
(`mfrancza-developer-agent[bot]`); `agent-respond-review.yml` uses that form
for its `if:` condition. Implementers should use `app/mfrancza-developer-agent`
only when filtering `gh pr list --json author` output — not in event-payload
expressions or any other context.

This login string is repo-specific; it is not abstracted into a variable or
secret, consistent with the existing `agent-fix-checks.yml` precedent.

### Decision 7 — `fail-fast: false` in the matrix

**Decision:** Set `fail-fast: false` on the `resolve` matrix job so that a
resolution failure for one PR does not cancel in-flight or queued resolutions
for other PRs. Each PR's conflict is independent; a failed resolution on one
should not block another from being attempted.

### Decision 8 — Permissions block

**Decision:** The workflow declares the following at the top level:

```yaml
permissions:
  contents: read
  pull-requests: read
```

GitHub Actions' `permissions:` block is *replacing*, not additive — declaring
any explicit scope sets every unlisted scope to `none`. `contents: read` alone
would give `github.token` no pull-requests scope, causing `gh pr list` in
`find-conflicted-prs` to fail with a 403. `pull-requests: read` must therefore
be listed explicitly.

The `resolve` job needs no additional permissions on the Actions side — all PR
writes (comments, labels) happen inside the container using the agent token
injected as `GH_TOKEN`.

## Out of scope

- The `AGENT_ACTION=resolve-conflicts` entrypoint function and prompt — that is
  issue #63.
- End-to-end validation (manufacture a conflict against a test PR, verify
  resolution; validate the fallback path) — that is issue #65, which covers both
  issue #63 and issue #64.
- `model:*` PR-label overrides for the `resolve-conflicts` action (deferred per
  parent design).
- Automatic conflict resolution on human-authored PRs (the `push`-triggered
  path only processes agent-authored PRs via the `author.login` filter in
  Decision 6). Note: the `workflow_dispatch` path intentionally bypasses the
  authorship gate as an operator-override mechanism — see Decision 5 for the
  rationale and the Option A escape hatch if future policy tightens this.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#130](https://github.com/mfrancza/agentic-development-workflow/issues/130) | Implement `.github/workflows/agent-resolve-conflicts.yml`: `push`/`workflow_dispatch` triggers, top-level `permissions:` block (`contents: read` + `pull-requests: read`), `find-conflicted-prs` job (agent PR enumeration, `mergeable` polling with exponential backoff, conflicted-PR JSON output, polling cap guard), `resolve` matrix job (per-PR concurrency group, token mint, image build, container dispatch), empty-matrix guard | — |
| [#131](https://github.com/mfrancza/agentic-development-workflow/issues/131) | Documentation: update AGENTS.md MVP Workflow section and agent actions table; update README.md | Issue #130 |
| [#65](https://github.com/mfrancza/agentic-development-workflow/issues/65) | End-to-end validation: manufacture a conflict, watch it resolve via the full push trigger; validate the fallback path (existing issue — covers both issue #63 and issue #64) | Issue #63, Issue #130, Issue #131 |

The workflow implementation task can start immediately (the parent design doc is
the contract: `AGENT_ACTION=resolve-conflicts`, env `GITHUB_PR_NUMBER`). The
documentation task follows once the workflow's trigger, env vars, and concurrency
model are settled. Issue #65 validates the complete loop end-to-end.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
