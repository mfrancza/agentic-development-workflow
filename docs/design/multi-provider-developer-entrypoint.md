# Design: Developer entrypoint — `run_agent` dispatch and model→provider map

**Issue:** [#80](https://github.com/mfrancza/agentic-development-workflow/issues/80)
**Parent design:** [docs/design/multi-provider-models.md](multi-provider-models.md) (Issue #75)

## Summary

Refactor `docker/scripts/entrypoint.sh` so the shape needed for multi-provider
support lands cleanly ahead of the OpenAI runner in issue #81. Behavior stays
Anthropic-only and unchanged for every existing action; the change is a
mechanical restructuring plus two env-var renames and two guardrails
(explicit model→provider allowlist, conditional key validation).

The higher-level architecture (per-provider agentic CLIs behind a runner
dispatch, explicit model→provider map, `AGENT_MODEL`/`DEFAULT_MODEL` naming,
conditional key validation) is already settled in the parent design doc and
is not re-argued here. This document covers the implementation decisions
that remain open within that contract, plus how the change lands coherently
with the parallel Terraform/workflows task (#82).

## Requirements as understood

From issue #80 and its grooming notes, the deliverables are:

- **Dispatch skeleton.** Rename `run_claude()` → `run_agent()`. Move the
  current `claude ... --print` invocation into a new `run_anthropic()`
  runner. `run_agent()` decides which runner to call based on the provider
  resolved from `AGENT_MODEL`.
- **Explicit model→provider allowlist.** A `case` statement enumerating the
  exact supported model names. Today's set is
  `sonnet`, `opus`, `haiku` (all Anthropic). Unknown model names fail loudly
  at the start of the run — before any clone or API call — with an error
  listing the supported values.
- **OpenAI stub arm.** `run_agent()` must have an `openai` dispatch arm that
  exits with a clear "not yet implemented" message. Issue #81 replaces the
  stub with a real `run_openai()` and populates the OpenAI models in the
  case statement.
- **Env-var renames.** Container env `CLAUDE_MODEL` → `AGENT_MODEL` and
  `CLAUDE_MAX_TURNS` → `AGENT_MAX_TURNS`.
- **Conditional key validation.** Validate only the API key for the
  provider selected for this run. Today that always means Anthropic; the
  OpenAI arm (once #81 lands) will validate `OPENAI_API_KEY` instead.
- **Documentation.** Update the agent-actions env-var table in `AGENTS.md`
  and the `docker run` example in `README.md` in the same PR.

The reviewer entrypoint (`docker/reviewer/entrypoint.sh`) is explicitly out
of scope — issue #83 handles it. Neither the OpenAI runner nor the OpenAI
model names are decided here — those belong to issues #81 and #82.

## Decisions

### Decision 1 — Dispatch shape: `run_agent` → `resolve_provider` → `run_<provider>`

**Decision:** Introduce two helper functions:

- `resolve_provider(model)` — the case statement that maps a model name to
  its provider string (`anthropic` today; `openai` added by #81). Unknown
  values `log` an error and `exit 1`.
- `run_agent(prompt_file, user_prompt...)` — the dispatcher. Routes on the
  cached `$AGENT_PROVIDER` (set in the preamble — see Decision 3) to
  `run_anthropic` (implemented) or `run_openai` (stub).

`run_anthropic()` contains the exact invocation that lives in `run_claude()` today — lifted verbatim, with `$CLAUDE_MODEL` / `$CLAUDE_MAX_TURNS` renamed to their `AGENT_*` counterparts:

```bash
claude --print \
  --dangerously-skip-permissions \
  --model ... \
  --max-turns ... \
  --system-prompt-file ...
```

`run_openai()` is a stub that logs `"OpenAI runner not yet implemented (see issue #81)"` and exits non-zero.

**Alternatives considered:**

- **Fold the dispatch into `run_agent` itself** (inline `case` on
  provider). Rejected: separating provider resolution from runner
  invocation makes the boot-time validation step (Decision 3) natural to
  place — `resolve_provider` is called once up front in the preamble, and
  `run_agent` consumes the cached `$AGENT_PROVIDER` result without
  duplicating the case body. Extracting it into a
  helper also makes the shape symmetric to `run_anthropic` / `run_openai`
  and easier to unit-test if we ever add a bash test harness.
- **Skip `run_openai()` entirely and let the case statement error until
  #81 lands.** Rejected: the issue is explicit that the OpenAI arm must
  exist and error with "not yet implemented" — so that #81 lands as a pure
  fill-in (delete the stub body, add the real invocation) rather than a
  structural change. It also makes the dispatch shape self-documenting.

### Decision 2 — Model allowlist scope: Anthropic aliases only, today

**Decision:** The `resolve_provider` case statement enumerates
`sonnet | opus | haiku` → `anthropic`. No OpenAI model names appear yet;
that is #81/#82's decision (which OpenAI models to add). The unknown-model
error message lists exactly the supported values (`sonnet, opus, haiku`),
generated from a single source of truth (a local variable or the case-arm
list itself) so it stays in sync when models are added.

**Alternatives considered:**

- **Pre-populate placeholder OpenAI arms** (e.g. `gpt-5) echo openai;;`).
  Rejected: guessing OpenAI model names now means either a lucky guess or
  a follow-up rename. #81/#82 pick the names against OpenAI's lineup at
  implementation time.
- **Regex/pattern inference** (`gpt-*` → openai). Explicitly rejected in
  the parent design (decision 2) — it silently accepts typos and unvetted
  models. Not re-argued here.

### Decision 3 — Validate model and key up front, before any side effects

**Decision:** The entrypoint's preamble runs, in this order, before any
`gh` call, clone, or Claude invocation:

1. Resolve `AGENT_MODEL`'s provider via `resolve_provider`. Unknown model →
   exit non-zero with the "supported values: sonnet, opus, haiku" message.
2. Validate only the selected provider's API key with the existing
   `${VAR:?message}` idiom — today this is `ANTHROPIC_API_KEY`; #81 adds
   the `OPENAI_API_KEY` branch. The other provider's key may be absent.
3. Continue with the existing `GH_TOKEN` / `GITHUB_REPO` / `AGENT_ACTION`
   validation.

This ordering matters: a typo in a `model:*` label must not cause a fresh
clone or a wasted API call — the failure mode should be identical to what
users already see when `AGENT_ACTION` is invalid. It also satisfies the
repo's fail-loud-on-ambiguous-input security default (`AGENTS.md`, Code
Review Standards).

The provider resolved during this preamble is stashed in a script-local
variable (e.g. `AGENT_PROVIDER`) so `run_agent` does not need to re-resolve
it on every call. `AGENT_PROVIDER` is not exported to child processes — it
is internal to the entrypoint.

**Alternatives considered:**

- **Validate lazily inside `run_agent`.** Rejected: `action_implement`
  runs `setup_repo` (a clone) before `run_claude`; a bad model name would
  waste a clone. Fail-fast beats fail-late.
- **Always validate both provider keys.** Rejected by the parent design
  (decision 4). Local operators running Anthropic-only should not need to
  set `OPENAI_API_KEY` at all.

### Decision 4 — Env-var rename coordination with issue #82

**Decision:** `run_anthropic` reads `$AGENT_MODEL` and `$AGENT_MAX_TURNS`
directly. During the transition window between #80 merging and #82
merging, the entrypoint accepts the old names as a fallback:

```bash
AGENT_MODEL="${AGENT_MODEL:-${CLAUDE_MODEL:-sonnet}}"
AGENT_MAX_TURNS="${AGENT_MAX_TURNS:-${CLAUDE_MAX_TURNS:-100}}"
```

The fallback exists solely to keep the workflows working during the
window when they still pass `CLAUDE_MODEL` (before #82 lands). Issue #82
does two things: (a) renames the env-var keys in every workflow and in
Terraform; (b) removes the `${CLAUDE_MODEL:-...}` fallback lines from
`entrypoint.sh`. The parent design's "no compatibility shims" rule
describes the *final* state; a transient shim living for the merge window
between two paired PRs is not that.

**Alternatives considered:**

- **Read `$AGENT_MODEL` only; require #82 to merge first.** Rejected: the
  parent design lists #80 and #82 as parallelizable (both "Depends on:
  nothing"). Adding an implicit ordering constraint just to avoid a
  two-line shim narrows the merge window for no lasting benefit.
- **Bundle #80 and #82 into a single PR.** Rejected: the two issues touch
  different subsystems (bash entrypoint vs Terraform + five YAML
  workflows) and reviewers benefit from reviewing them separately. Also,
  the parent design already committed to keeping them as independent
  issues.
- **Deprecation warning in the log.** Considered and dropped: not worth
  the log noise, since the shim only lives for the paired-merge window
  and no operator outside this repo is a consumer.

The exact removal of the fallback happens in #82 (its scope explicitly
includes the workflow renames). To make that coordination unmistakable,
#82's issue body must state "removes the `CLAUDE_MODEL`/`CLAUDE_MAX_TURNS`
fallback from `docker/scripts/entrypoint.sh`" (see task breakdown below —
we edit #82's body when this design merges).

### Decision 5 — `AGENTS.md` and `README.md` updates

**Decision:** Update both in the same PR, per the `Keeping Documentation
Current` standard:

- `AGENTS.md`, **Agent Actions** section: change the optional-vars line
  from `Optional: CLAUDE_MODEL (default sonnet), CLAUDE_MAX_TURNS (default 100).`
  to `Optional: AGENT_MODEL (default sonnet), AGENT_MAX_TURNS (default 100).`
- `AGENTS.md`, **Labels** section: the `model:<name>` label description
  still mentions `DEFAULT_CLAUDE_MODEL` in prose. Leave that for #82 to
  rename in one pass with the Terraform/workflow changes — mixing the
  Actions-variable rename into #80 would step on #82's scope.
- `README.md`, section 4 `docker run` example: replace `-e
  CLAUDE_MODEL="sonnet"` with `-e AGENT_MODEL="sonnet"` in the developer
  container run example. Same for the "Optional" line further down.

The reviewer image's mentions of `CLAUDE_MODEL` / `CLAUDE_MAX_TURNS`
(reviewer entrypoint, reviewer design doc paragraph in AGENTS.md,
`docs/design/reviewer-container.md`, `docs/design/code-review-agent.md`)
are #83's scope and stay untouched here.

**Alternatives considered:**

- **Rename `DEFAULT_CLAUDE_MODEL` mentions in AGENTS.md now.** Rejected:
  that variable is Actions-variable/Terraform-owned and belongs to #82.
  Renaming it here would create a doc-vs-Terraform mismatch until #82
  lands.

## Out of scope

- The OpenAI runner itself (`run_openai` body, Codex CLI wiring, prompt
  assembly, sandbox flags) — issue #81.
- OpenAI model names in the allowlist — issue #82 (label provisioning +
  the model list to pre-populate).
- Terraform variable rename (`default_claude_model` →
  `default_model`), Actions variable rename (`DEFAULT_CLAUDE_MODEL` →
  `DEFAULT_MODEL`), all five workflow env passes, `OPENAI_API_KEY` secret
  plumbing — issue #82.
- Removing the `CLAUDE_MODEL`/`CLAUDE_MAX_TURNS` fallback from
  `entrypoint.sh` — issue #82's cleanup step (see Decision 4).
- Reviewer entrypoint changes (`docker/reviewer/entrypoint.sh`) — issue
  #83.
- Any change to Claude Code invocation flags or per-action prompts.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#164](https://github.com/mfrancza/agentic-development-workflow/issues/164) | Refactor `docker/scripts/entrypoint.sh`: add `resolve_provider()` case statement (Anthropic aliases only), `run_agent()` dispatcher, `run_anthropic()` (Claude invocation lifted from `run_claude`), `run_openai()` stub that errors with "not yet implemented"; move model→provider validation and conditional key validation into the preamble before any clone/API call; add `AGENT_MODEL`/`AGENT_MAX_TURNS` with transient fallback to `CLAUDE_MODEL`/`CLAUDE_MAX_TURNS`; update `AGENTS.md` (agent-actions optional-vars line) and `README.md` (developer `docker run` example) in the same PR | — |
| [#165](https://github.com/mfrancza/agentic-development-workflow/issues/165) | Isolated local validation via `docker run`: (1) valid `AGENT_MODEL=sonnet` run — an existing action (e.g. `groom` on a fixture issue) completes as it does today; (2) unknown `AGENT_MODEL=bogus` fails before any clone with the expected message; (3) missing `ANTHROPIC_API_KEY` fails with the existing message; (4) legacy `CLAUDE_MODEL=opus` (no `AGENT_MODEL` set) still works via the shim; (5) `AGENT_MODEL` unset falls back to the `sonnet` default. Record the invocations and outputs in the PR description or a short log file | Issue #164 |

The implementation is a single sub-issue because the entrypoint change and
the doc updates must land in one PR (`AGENTS.md`/`README.md` describe env
vars renamed by the same PR; splitting them creates a documentation
mismatch window). The validation sub-issue depends on the implementation
being merged so it can exercise the built image.

End-to-end validation of the full multi-provider flow (OpenAI + Anthropic
in CI) lives in issue #84 under the parent design; this local validation
sub-issue is scoped to #80's Anthropic-only refactor.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
