# Design: Multi-provider OpenAI Codex runner and CLI installation

**Issue:** [#81](https://github.com/mfrancza/agentic-development-workflow/issues/81)

**Parent design:** [`multi-provider-models.md`](multi-provider-models.md) (Issue #75)

## Summary

Complete the OpenAI half of multi-provider support for the developer image:
install the OpenAI Codex CLI in both container images (developer + reviewer,
pinned by build arg), implement the developer entrypoint's `run_openai()`
runner as a `codex exec` call with the per-action system prompt prepended to
the task prompt and workspace-confined sandbox flags, add the concrete
OpenAI model names to the `resolve_provider` allowlist, and audit the shared
prompts for any Claude-harness-specific constructs that would break under
Codex.

The higher-level architecture (per-provider agentic CLIs behind a runner
dispatch, explicit model→provider allowlist, both images ship both CLIs,
both keys always passed and validated conditionally) is settled in the
parent design and is not re-argued here. Issue #80 has already merged, so
`resolve_provider` / `run_agent` / a `run_openai` stub already live in
`docker/scripts/entrypoint.sh`. Issue #82's follow-ups have also merged:
`OPENAI_API_KEY` is passed by every agent workflow, and the OpenAI
`model:*` labels are defined in Terraform. This design is the last
implementation slice that turns those hooks into a working OpenAI path for
the developer image; the matching reviewer-side runner lives in [#83].

## Requirements as understood

From issue #81 and its grooming notes (parent context in
`docs/design/multi-provider-models.md`):

1. **Dockerfile changes** — `docker/Dockerfile` and
   `docker/reviewer/Dockerfile` gain a `CODEX_CLI_VERSION` build arg and an
   npm-pinned install of `@openai/codex`, mirroring the existing
   `CLAUDE_CODE_VERSION` pattern. Both images ship the CLI even though
   only the developer entrypoint invokes it in this issue — parent
   decision 5 ("images ship both CLIs"), and the reviewer entrypoint's
   own OpenAI runner lands in [#83] without needing a second Dockerfile
   edit.
2. **`run_openai()` in the developer entrypoint** — replace the stub that
   #80 left in place with a working implementation that:
   - invokes `codex exec` (headless, non-interactive),
   - selects the model with `AGENT_MODEL`,
   - passes the per-action system prompt from `/opt/agent/prompts/<file>`
     prepended to the task prompt string (Codex exec has no
     `--system-prompt` flag), and
   - runs the sandbox in a workspace-confined mode so writes stay inside
     `/home/agent/work` (parent decision 5).
   The preamble's key-validation `case` gains an `openai)` arm that
   requires `OPENAI_API_KEY`.
3. **OpenAI model names in the allowlist** — populate the `openai)` arm of
   `resolve_provider`'s case statement with the same model names Terraform
   already provisions labels for (parent decision 2, one-to-one
   correspondence).
4. **Prompt compatibility audit** — read every prompt in
   `docker/scripts/prompts/` and confirm the `gh` recipes and instructions
   are harness-agnostic; fix anything that breaks under Codex.

Blocked-by from the issue header (already recorded on the GitHub issue):
[#80]. That is now merged, so this design's sub-issues have no
implementation blockers from outside their own tree.

### Ambiguities and how they were resolved

- **Reviewer entrypoint runner** — the issue title says "developer
  entrypoint". Reviewer runner support (its own `run_openai()`, the
  no-write guarantee under `codex exec`, thread-resolution interaction)
  is explicitly [#83]. This design installs Codex in the reviewer image
  (so [#83] doesn't have to reopen `docker/reviewer/Dockerfile`) but does
  not touch `docker/reviewer/entrypoint.sh`.
- **Which OpenAI models go in the allowlist** — resolved by consulting
  Terraform, which is the source of truth per parent decision 2 (labels
  and allowlist are one-to-one). The Terraform `local.automation_labels`
  map in `terraform/main.tf` already defines `model:gpt-5.6-sol`,
  `model:gpt-5.6-terra`, `model:gpt-5.6-luna`, `model:gpt-5`, and
  `model:o3`. Those are the exact names added to `resolve_provider`.
- **`OPENAI_API_KEY` validation timing** — resolved to preamble-time (same
  slot the `anthropic)` arm already lives in), before any clone or API
  call, per parent decision 4 and the fail-loud-on-ambiguous-input rule
  in `AGENTS.md`.
- **`AGENT_MAX_TURNS` symmetry across providers** — Codex exec does not
  expose a Claude-Code-shaped `--max-turns` knob at the CLI version we
  pin. The runner passes whichever equivalent bound Codex exposes (e.g. a
  wall-clock timeout or a maximum-tokens cap) if it maps cleanly to the
  same intent (bounding a runaway agent loop); otherwise it sets no
  explicit cap. Symmetric caps are not a stated requirement.

## Decisions

### Decision 1 — Codex CLI installation: mirror the `CLAUDE_CODE_VERSION` pattern in both Dockerfiles

Both Dockerfiles gain, next to the existing Claude Code install:

```dockerfile
# Install OpenAI Codex CLI. Pin to a specific version so workflow runs are
# reproducible; override at build time with --build-arg if you want a different
# release. Kept in sync between docker/Dockerfile and docker/reviewer/Dockerfile
# for the same reason CLAUDE_CODE_VERSION is.
ARG CODEX_CLI_VERSION=<implementer picks the current pinned release>
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}"
```

The default build-arg value is a concrete, currently-published version
string chosen at implementation time. Same convention as
`CLAUDE_CODE_VERSION`: the pinned default is what CI builds against;
`--build-arg CODEX_CLI_VERSION=<other>` is the local override.

**Alternatives considered:**

- **Install from a GitHub release tag / a curl-bash script** — rejected:
  neither is more reproducible than npm-pinning by version, both bypass
  the tool the image already uses (`npm`) for its other CLI install, and
  both introduce a second install channel that reviewers must keep in
  their heads.
- **Install in the developer image only; defer the reviewer image install
  to [#83]** — rejected: (a) parent decision 5 explicitly says both
  images ship both CLIs; (b) the additional Dockerfile edit is one build
  arg and one `RUN` line, and folding it in here avoids a second
  reviewer-image PR just to add a tool.
- **Multi-stage build / cache mounts / `--omit=dev`** — out of scope:
  consistent with how Claude Code is installed today. If image size or
  build time becomes a problem, address across both CLIs together.

### Decision 2 — `run_openai()` invocation shape

`run_openai()` mirrors `run_anthropic()`'s signature (a prompt-file name
followed by a user prompt) but the body is Codex-specific:

```bash
run_openai() {
    local prompt_file="$1"
    shift
    local user_prompt="$*"

    local system_prompt combined
    system_prompt="$(cat "${SCRIPTS_DIR}/prompts/${prompt_file}")"
    # Codex exec has no --system-prompt flag; prepend the per-action system
    # prompt to the task prompt with a clear separator.
    combined="${system_prompt}

---

${user_prompt}"

    printf '%s' "$combined" | codex exec \
        --model "$AGENT_MODEL" \
        --sandbox workspace-write \
        -
}
```

The block above is the *shape* — the exact Codex flag names (whether the
sandbox flag is `--sandbox` or `-s`, whether the accepted value is
`workspace-write` or a variant, whether the stdin sigil is `-` or
implicit, whether an extra flag is needed to run inside a git-clean
workspace) are pinned to the pinned CLI version at implementation time.
The implementer verifies each flag against `codex exec --help` at the
pinned version before merging.

Rationale for the specific choices:

- **`codex exec`, not the interactive `codex`** — the container is a
  short-lived CI job. `codex exec` is Codex's officially-supported
  headless one-shot mode; the REPL would hang the container.
- **Prompt-file *contents* prepended, not a path** — Codex exec has no
  `--system-prompt-file` (or `--system-prompt`) flag. The prompt is read
  once and concatenated with a horizontal-rule separator (`---` on its
  own line) that is both readable and unlikely to occur in prompt or
  task text.
- **Workspace-write sandbox, not full-access** — the developer entrypoint
  needs to write inside `/home/agent/work` (the clone the agent commits
  from) but nothing outside; a workspace-confined sandbox is exactly
  that. The Claude side uses `--dangerously-skip-permissions`; the Codex
  equivalent is not used because Codex offers a genuine sandbox flag and
  we take it. Outbound HTTP (LLM API traffic, `gh` API calls) is allowed
  under the workspace-write mode Codex ships.
- **Model name passed through directly** — the `AGENT_MODEL` value is one
  of the OpenAI names added by decision 3. Codex accepts model names in
  the exact form OpenAI publishes them, so `--model "$AGENT_MODEL"` is a
  straight pass-through with no rename map.
- **`OPENAI_API_KEY` validation in the preamble** — the existing case
  block (added by #80) gains an `openai)` arm:
  ```bash
  case "$AGENT_PROVIDER" in
      anthropic)
          : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
          ;;
      openai)
          : "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
          ;;
  esac
  ```
  Codex reads `OPENAI_API_KEY` from its environment; the container
  inherits it from the workflow (already plumbed by #167).

  **Amended (issue #227):** the claim above is wrong — Codex CLI does
  *not* read `OPENAI_API_KEY` from the environment. It authenticates
  from `~/.codex/auth.json`, so the `openai)` arm additionally runs
  `printenv OPENAI_API_KEY | codex login --with-api-key` (the
  documented non-interactive login) after the presence check. Without
  it, every Codex request goes out with no Authorization header and
  fails 401 — observed in the #169 validation run.

**Alternatives considered:**

- **Write the combined prompt to a temp file and pass it as an argument
  (`codex exec --input-file /tmp/x`)** — rejected: piping the combined
  prompt on stdin matches what the parent design already anticipated
  ("prepends the same file to the task prompt") and keeps the runner
  free of tempfile-cleanup logic.
- **`printf "$(cat file)\n---\n$prompt"` (command-sub then interpolate)**
  — rejected: command substitution on files with backticks, `$`, or
  history-expansion metacharacters is a footgun even under `set -f`.
  Assigning `cat` output to a local variable and then concatenating in a
  double-quoted string is safer.
- **Use Codex profile files (`~/.codex/config.toml` `[profiles.dev]`) to
  carry the system prompt** — rejected: adds a second surface (a config
  file baked into the image) that would drift from the per-action prompt
  directory Claude Code already uses. Keep the source of truth one
  place: `/opt/agent/prompts/`.
- **Fall back to a `codex` interactive session with piped input** —
  rejected: exactly the "quietly couples 'provider' to 'whatever we can
  fake'" pattern the parent design rejected in decision 1.

### Decision 3 — OpenAI models added to the `resolve_provider` allowlist

The `openai)` arm of `resolve_provider` enumerates the exact model names
Terraform already provisions `model:*` labels for (parent decision 2,
one-to-one). The current Terraform set (see `local.automation_labels` in
`terraform/main.tf`) is: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
`gpt-5`, `o3`. `resolve_provider` becomes:

```bash
case "$model" in
    sonnet|opus|haiku)
        echo "anthropic"
        ;;
    gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5|o3)
        echo "openai"
        ;;
    *)
        log "ERROR: Unknown model '${model}'. Supported values: sonnet, opus, haiku, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5, o3" >&2
        exit 1
        ;;
esac
```

The "supported values" list in the error message is updated in the same
commit — a single source of truth in the case-arm list itself so drift
between the two is a diff-visible mistake, not a silent one.

If the Terraform label set changes between design and implementation, the
implementer re-syncs the case statement to whatever
`local.automation_labels` currently contains and notes the delta in the PR
description. The Terraform map is authoritative because it feeds the
label picker users interact with.

**Alternatives considered:**

- **Pattern-based inference (`gpt-*` → openai)** — rejected by parent
  decision 2. Not re-argued here.
- **Pull the list from Terraform at container build time and generate the
  case statement** — rejected: introduces build-time coupling between the
  container image and Terraform's HCL, and the entrypoint needs the list
  statically at container start. The parent already accepted the
  "case statement duplicated per image" cost.
- **Freeze the list only in this design and defer Terraform to catch up**
  — rejected: Terraform is already ahead (labels exist since
  [#168](https://github.com/mfrancza/agentic-development-workflow/issues/168)
  merged); the entrypoint is what needs catching up.

### Decision 4 — Prompt compatibility audit: read every prompt, edit only what breaks under Codex

The audit produces two outputs:

1. **A brief written note in the audit sub-issue's PR description**
   listing every file under `docker/scripts/prompts/` that was reviewed,
   and what — if anything — was changed and why.
2. **Actual edits** to prompt files only when a `gh` recipe or an
   instruction is harness-specific in a way that materially changes
   behavior under Codex.

Concrete checks the auditor runs on each prompt:

- **Every `gh` invocation** — `gh` is provider-independent by
  construction. Any use in the prompts must work identically under
  Codex; if a snippet passes model or Claude-Code-specific options to
  `gh`, that's a bug to fix.
- **File-path assumptions** — the prompts assume `/home/agent/work` is
  CWD and reference files by repository-relative path. Those are
  entrypoint-side facts, not harness-side. No expected changes.
- **Tool references** — `bash`, `git`, `gh`, `jq`, `curl`. All installed
  at the image layer, provider-independent.
- **Any mention of "Claude" that carries meaning** (case-insensitive) —
  e.g. "as Claude, do X". If any prompt refers to Claude by name in a
  way that changes behavior under Codex, either drop the mention or
  rephrase provider-neutrally (e.g. "as the agent"). Cosmetic mentions
  in narrative text that don't change behavior are left alone (a
  provider-neutral rewrite of every stray "Claude" is prompt-tuning, out
  of scope per parent decision 1 / this design's out-of-scope list).
- **Any harness-specific flag mentioned in a prompt** —
  `--dangerously-skip-permissions`, `--print`, `--system-prompt-file`,
  `--max-turns`. Grep for the strings; not expected, but grepped for.

Expected outcome: little or no change. The parent design's decision-1
note that the prompts are already harness-agnostic ("instructions + `gh`
recipes ... need no changes") is a claim this task verifies; the
fallback is to fix whatever the audit surfaces.

The reviewer image's prompts (`docker/reviewer/prompts/`) are [#83]'s
scope. If the developer audit does surface a shared pattern that the
reviewer prompts likely inherit, the auditor flags it in the sub-issue's
PR description so [#83]'s implementer picks it up.

**Alternatives considered:**

- **Skip the audit; fix under Codex as issues arise** — rejected: turns
  a design-implied guarantee into a series of drive-by fixes. The parent
  design lists this audit explicitly in #81's grooming notes.
- **Fork the prompts per provider (`prompts/anthropic/`,
  `prompts/openai/`)** — rejected by parent decision 1 rationale
  (prompts stay shared; per-provider forks would need their own design).

### Decision 5 — Scope split with issue [#83]

The reviewer image gets the Codex CLI installed here (decision 1) but
the reviewer entrypoint's runner refactor and OpenAI arm are [#83]'s
scope. Reasons for the split:

- The reviewer runner has non-trivial security constraints unique to the
  reviewer image (structural no-write guarantee under `codex exec`,
  `RESOLVE_THREADS_FILE` interaction, Contents:read-only token layer)
  that deserve their own review pass.
- Installing the CLI in the reviewer image without wiring the runner is
  harmless: the image gains one extra binary that nothing calls. [#83]
  then flips the entrypoint to route model names to it, at which point
  the CLI is already there.

**Alternatives considered:**

- **Fold [#83] into #81** — rejected for the review-boundary reason
  above.
- **Install Codex only in `docker/Dockerfile` here and add it to
  `docker/reviewer/Dockerfile` in [#83]** — rejected: violates the
  parent's "images ship both CLIs" contract in the interim, and doubles
  reviewer-image PR churn.

## Out of scope

- **Reviewer entrypoint's `run_openai` runner** — [#83].
- **Terraform label provisioning for OpenAI models** — [#82] /
  [#168]; already merged. This design consumes those labels.
- **`OPENAI_API_KEY` secret plumbing in workflows** — [#82] / [#167];
  already merged.
- **Removing the `CLAUDE_MODEL` / `CLAUDE_MAX_TURNS` fallback in the
  entrypoint** — done as part of the #82 cleanup step.
- **Per-provider prompt forks** — parent design's out-of-scope list;
  unchanged here.
- **Symmetric `AGENT_MAX_TURNS` semantics across providers** —
  best-effort; if Codex's pinned version exposes no clean equivalent, the
  runner sets no explicit cap and the implementation PR documents this
  in its description.
- **A generic runner interface / migration to a hypothetical `openai` SDK
  custom loop** — parent decision 1 rejected the custom-loop path.
- **Cross-provider end-to-end validation via CI** (workflow-level runs
  with an OpenAI `model:*` label) — that lives in
  [#84](https://github.com/mfrancza/agentic-development-workflow/issues/84)
  under the parent design. This design's own e2e task is scoped narrowly
  to `docker run`-level exercise of the OpenAI runner.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#209](https://github.com/mfrancza/agentic-development-workflow/issues/209) | Dockerfile changes: add `CODEX_CLI_VERSION` build arg + npm-pinned install of `@openai/codex` to `docker/Dockerfile` and `docker/reviewer/Dockerfile` (decision 1). Choose the pinned default version at implementation time; keep it identical between the two Dockerfiles. No entrypoint changes here. | — |
| Issue [#210](https://github.com/mfrancza/agentic-development-workflow/issues/210) | `run_openai()` implementation in `docker/scripts/entrypoint.sh`: replace the stub added by #80 with the `codex exec` invocation described in decision 2 (system-prompt contents prepended to task prompt, `--model $AGENT_MODEL`, workspace-confined sandbox flag, stdin input); add the `openai)` arm to the preamble key-validation `case` requiring `OPENAI_API_KEY`; populate the `openai)` arm of `resolve_provider` with the model names from decision 3 and update the "supported values" error message; document the AGENT_MAX_TURNS handling for the Codex path in the PR description. | Issue #209 (needs `codex` present in the image to test end-to-end) |
| Issue [#211](https://github.com/mfrancza/agentic-development-workflow/issues/211) | Prompt compatibility audit: read every file under `docker/scripts/prompts/`, apply decision 4's checks, and edit only what materially breaks under Codex. Report the reviewed set and any changes in the sub-issue's PR description. Flag any shared pattern that the reviewer prompts likely inherit so [#83] can pick it up. | — |
| Issue [#212](https://github.com/mfrancza/agentic-development-workflow/issues/212) | End-to-end validation via `docker run`: build the image with the new Codex CLI, then exercise the developer entrypoint through each of these paths and record the invocation + output in the sub-issue's PR description: (1) `AGENT_MODEL` set to one of the OpenAI names, `OPENAI_API_KEY` unset — fails cleanly in the preamble with the "OPENAI_API_KEY is required" message before any clone; (2) same but with the key set — an existing action (e.g. `groom` on a fixture issue) completes end-to-end via Codex; (3) `AGENT_MODEL=bogus` — fails cleanly with the "Unknown model" message listing all supported values (both providers); (4) `AGENT_MODEL=sonnet` — routes to `run_anthropic` unchanged (regression check on the Anthropic path). | Issues #209, #210, #211 |

The Dockerfile task and the prompt-audit task are independent and can
run in parallel. The `run_openai` task depends on the Dockerfile task
because its own local validation needs `codex` installed in the image.
The e2e task depends on all three landing so it can exercise the full
OpenAI path end-to-end.

Cross-provider CI validation (workflow-level runs with an OpenAI
`model:*` label, and a reviewer-side OpenAI review pass once [#83]
lands) lives in issue
[#84](https://github.com/mfrancza/agentic-development-workflow/issues/84)
under the parent design.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.

[#80]: https://github.com/mfrancza/agentic-development-workflow/issues/80
[#82]: https://github.com/mfrancza/agentic-development-workflow/issues/82
[#83]: https://github.com/mfrancza/agentic-development-workflow/issues/83
[#167]: https://github.com/mfrancza/agentic-development-workflow/issues/167
[#168]: https://github.com/mfrancza/agentic-development-workflow/issues/168
