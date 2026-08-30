# Design: Grok models — developer image + entrypoint

**Amended (Issue [#353](https://github.com/mfrancza/agentic-development-workflow/issues/353)):** The runner described in this document (OpenAI Codex CLI with a `[model_providers.xai]` config block) has been superseded. Grok models are now executed by the Grok Build CLI (`grok -p`); see [`grok-build-cli.md`](grok-build-cli.md) for the current runtime design.

**Issue:** [#279](https://github.com/mfrancza/agentic-development-workflow/issues/279)

**Parent design:** [`docs/design/grok-models.md`](grok-models.md) (Issue [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275))

## Summary

Wire the xAI runner into the developer image: bake a `[model_providers.xai]`
block into `~/.codex/config.toml` at image build time, then add `run_xai()`,
`resolve_provider` xai arm, preamble key validation, and `XAI_API_KEY`
redaction to `docker/scripts/entrypoint.sh`. This is the developer-image half
of Issue [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275);
the reviewer-image half is Issue [#280](https://github.com/mfrancza/agentic-development-workflow/issues/280)
and the end-to-end validation is Issue [#281](https://github.com/mfrancza/agentic-development-workflow/issues/281).

## Requirements as understood

From the issue body and grooming comment (Issue [#279](https://github.com/mfrancza/agentic-development-workflow/issues/279)):

1. **`docker/Dockerfile`**: add a build-time step that writes
   `[model_providers.xai]` (with `name = "xAI"`,
   `base_url = "https://api.x.ai/v1"`, `env_key = "XAI_API_KEY"`) to
   `/home/agent/.codex/config.toml` and sets the file to `agent`-readable
   ownership. If the pinned Codex CLI release already exposes `xai` as a
   built-in first-class provider, the config-file block is unnecessary and
   the entrypoint runner reduces to a bare `--config model_provider="xai"`
   invocation — document the choice in the PR description.

2. **`docker/scripts/entrypoint.sh`**, per parent design decisions 4 and 5:
   - Add the chosen Grok model names to a new `xai)` arm in
     `resolve_provider`'s case statement, matching the Terraform label set
     from task 1 (Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278))
     exactly. Update the wildcard arm's "supported values" error message to
     include the Grok names.
   - Add `run_xai()` with the same shape as `run_openai()`, using
     `--config model_provider="xai"`, `--model "$AGENT_MODEL"`,
     `--sandbox workspace-write`, and stdin input with system prompt
     prepended via `---` separator.
   - Add an `xai)` arm to `run_agent()`'s dispatch case delegating to
     `run_xai`.
   - Add an `xai)` arm to the preamble key-validation case requiring
     `XAI_API_KEY`. Do **not** call `codex login` — the custom `xai`
     model-provider reads its key from the env via `env_key`. Add a comment
     explaining this asymmetry so a future maintainer does not remove one
     under the impression the other must behave the same.
   - Add an `XAI_API_KEY` redaction pass to `_log_capture_exit()` mirroring
     the existing `OPENAI_API_KEY` block.

3. **`AGENT_MAX_TURNS` handling** under the xAI runner is best-effort —
   same policy as parent design's `run_openai`
   (parent out-of-scope: "Symmetric `AGENT_MAX_TURNS` semantics across
   providers"). Document the chosen approach in the PR description.

### Ambiguities resolved

- **Built-in Codex `xai` provider vs. config-file block.** The issue allows
  either path and says to verify at build time via `codex --help`. This
  design resolves the ambiguity: write the config-file block regardless.
  At the pinned Codex CLI release (`0.146.0`), the built-in `xai` provider
  has not been confirmed, so the safe path is to write the block. If a
  future pinned release ships a built-in `xai` provider, the block is
  additive (inert) rather than harmful — see Decision 1. Document the
  verification result in the PR description.

- **Grok model names in `resolve_provider`.** The exact list is locked down
  in task 1 (Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278))'s
  Terraform `local.automation_labels`. The implementer syncs the
  `xai)` case-arm list to whatever `local.automation_labels` contains at
  PR time and notes any delta from the design date's list
  (`grok-3`, `grok-3-mini`, `grok-code-fast-1`) in the PR description.
  This is the same escape hatch parent design Decision 5 already documents.

## Decisions

### Decision 1 — Write `config.toml` at image build time; document verification result

**Decision:** Both Dockerfiles gain a `RUN` step that writes
`/home/agent/.codex/config.toml` containing:

```toml
[model_providers.xai]
name = "xAI"
base_url = "https://api.x.ai/v1"
env_key = "XAI_API_KEY"
```

The file is created after the `USER agent` instruction so it is owned by
the non-root `agent` user without an explicit `chown` step.

This matches parent design Decision 2 exactly. The two cases the issue calls
out — config-file block needed vs. built-in first-class provider already
present — are handled as follows: if `codex --help` at the pinned release
confirms a built-in `xai` provider, the config block is omitted and the PR
description says so; if it does not, the block is written and documented.
The implementation PR must state which path shipped.

**Alternatives considered:**

- **Emit the config file from the entrypoint's preamble at runtime.** Rejected
  in parent design Decision 2: moves a static fact into imperative shell, and
  the file must exist before Codex is invoked either way — so the extra runtime
  step buys nothing. The per-action prompt files under `/opt/agent/prompts/`
  follow the same baked-in pattern.

- **Use a Codex profile (`[profiles.xai]`).** Rejected in parent design
  Decision 2: profiles couple provider selection to model selection, which
  fights the `AGENT_MODEL` contract (`--config model_provider="xai"` and
  `--model "$AGENT_MODEL"` are passed separately so the model can vary per
  run without a profile change).

### Decision 2 — `run_xai()` shape: copy `run_openai()`, add `--config model_provider="xai"`

**Decision:** `run_xai()` in `docker/scripts/entrypoint.sh` is a near-copy of
`run_openai()`:

```bash
run_xai() {
    local prompt_file="$1"
    shift
    local user_prompt="$*"

    local system_prompt combined
    system_prompt="$(cat "${SCRIPTS_DIR}/prompts/${prompt_file}")"
    # Codex exec has no --system-prompt flag; prepend the per-action system
    # prompt to the task prompt with a clear separator (same convention as
    # run_openai).
    combined="${system_prompt}

---

${user_prompt}"

    # --config model_provider="xai" points Codex at the [model_providers.xai]
    # block in ~/.codex/config.toml (base_url = xAI's OpenAI-compatible endpoint;
    # env_key = XAI_API_KEY). --model passes the Grok model name through
    # directly. No codex login step needed — custom model_providers read
    # credentials from the process environment via env_key, not auth.json
    # (contrast the openai arm; see docs/design/grok-models.md decision 2).
    printf '%s\n' "$combined" | codex exec \
        --config model_provider="xai" \
        --model "$AGENT_MODEL" \
        --sandbox workspace-write \
        -
}
```

The system-prompt prepend convention, sandbox flag, and stdin-pipe pattern are
unchanged from `run_openai()`. The only structural difference is the added
`--config model_provider="xai"` flag that routes Codex to the xAI endpoint.

The exact flag syntax (`--config model_provider="xai"` vs. a short form) is
pinned to the pinned Codex CLI version at implementation time via
`codex exec --help`. If the pinned release exposes a simpler form, the runner
uses that form and documents it in the PR description.

**`AGENT_MAX_TURNS` handling.** The pinned Codex CLI (`0.146.0`) does not
expose a `--max-turns` equivalent flag for the `exec` subcommand in the same
way Claude Code's `--max-turns` works. No explicit turn-cap is passed to the
xAI runner; the behavior is best-effort. This matches `run_openai()`'s
`AGENT_MAX_TURNS` omission and is within the parent design's accepted
out-of-scope boundary. Document in the PR description.

**Alternatives considered:**

- **Share a single `run_codex()` function, parameterized by `--config`
  flag.** A function that takes the model-provider config as an argument and
  generates the Codex invocation was considered. Rejected: the two runners
  are near-identical today, but may diverge (prompt-assembly logic, sandbox
  policy, retry handling) as providers evolve. Keeping them separate (same
  pattern as `run_anthropic` vs. `run_openai`) means each can evolve
  independently without flag-parameterization gymnastics.

### Decision 3 — Preamble key validation: `xai)` arm requires `XAI_API_KEY`; no `codex login`

**Decision:** The preamble `case "$AGENT_PROVIDER" in` block gains:

```bash
xai)
    : "${XAI_API_KEY:?XAI_API_KEY is required}"
    # No codex login step needed — the [model_providers.xai] block in
    # ~/.codex/config.toml binds XAI_API_KEY via env_key, so Codex reads
    # the key directly from the process environment (see
    # docs/design/grok-models.md decision 2).
    ;;
```

The comment about the auth asymmetry is mandatory (per issue body) so a
future maintainer who notices that `openai)` calls `codex login` and `xai)`
does not will understand the difference rather than "normalizing" one branch
to match the other. The divergence is intentional: the built-in `openai`
provider authenticates from `~/.codex/auth.json` (see Issue
[#227](https://github.com/mfrancza/agentic-development-workflow/issues/227)),
while custom `model_providers` entries authenticate via `env_key`.

### Decision 4 — `XAI_API_KEY` redaction in `_log_capture_exit()`

**Decision:** A fourth redaction block is added to `_log_capture_exit()`,
mirroring the existing `OPENAI_API_KEY` block:

```bash
if [ -n "${XAI_API_KEY:-}" ]; then
    _escaped_xai=$(printf '%s\n' "${XAI_API_KEY}" | sed 's/[.^$*\\/]/\\&/g; s/\[/\\[/g')
    find /home/agent/logs -type f \
        -exec sed -i "s/${_escaped_xai}/***REDACTED-XAI_API_KEY***/g" {} +
fi
```

The same escape-then-replace pattern used for `GH_TOKEN`, `ANTHROPIC_API_KEY`,
and `OPENAI_API_KEY` is applied for `XAI_API_KEY`. Empty-guard (`-n`) prevents
the sed pattern from corrupting files when the variable is unset (matches every
character boundary otherwise).

This is already documented in `AGENTS.md` under "Redaction" (the `AGENTS.md`
update is task 1's scope, Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278)).

### Decision 5 — `resolve_provider` xai arm; error message kept in sync

**Decision:** `resolve_provider`'s case statement gains an `xai)` arm:

```bash
grok-3|grok-3-mini|grok-code-fast-1)
    echo "xai"
    ;;
```

The wildcard arm's error message is updated to enumerate the Grok names
alongside the existing Anthropic and OpenAI values. The case-arm list is the
single source of truth — the error message is derived from or kept in sync
with it so drift is diff-visible.

The specific model names (`grok-3`, `grok-3-mini`, `grok-code-fast-1`) are
the coding-capable xAI lineup as of the parent design date. These **must
match** the Terraform label set from task 1 (Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278))
exactly — if the Terraform set changes between design and implementation, the
implementer re-syncs the case arm and notes the delta in the PR description.
This one-to-one rule is parent design Decision 5.

## Out of scope

- **Reviewer image and reviewer entrypoint** (`docker/reviewer/Dockerfile`,
  `docker/reviewer/entrypoint.sh`) — Issue [#280](https://github.com/mfrancza/agentic-development-workflow/issues/280).
  The reviewer image receives the same `config.toml` block and `run_xai()` /
  `xai)` arm additions, but is a separate PR.
- **Terraform `local.automation_labels` and `model:grok-*` labels** — task 1,
  Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278).
  The Grok model names in `resolve_provider` must match that label set; the
  implementation of task 2 is blocked by task 1 finalizing those names.
- **`run-agent` composite action and workflow `xai-api-key` plumbing** — task 1
  (Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278));
  without the workflow plumbing, `XAI_API_KEY` never reaches the container.
- **End-to-end validation** (building and running the container against live
  xAI API, regression checks for Anthropic and OpenAI paths) — Issue [#281](https://github.com/mfrancza/agentic-development-workflow/issues/281).
- **`AGENTS.md` and `README.md` documentation updates** for `XAI_API_KEY`,
  provider/key mapping, reviewer-env line, and redaction paragraph — task 1's
  scope.
- **Symmetric `AGENT_MAX_TURNS` semantics** across providers — explicitly
  out of scope in the parent design; no change here.
- **Prompt tuning** for Grok-specific behaviour — parent design out-of-scope.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|------------|
| Issue [#308](https://github.com/mfrancza/agentic-development-workflow/issues/308) | Implement `docker/Dockerfile` config.toml block and all `docker/scripts/entrypoint.sh` changes: `run_xai()`, `xai)` arm in `resolve_provider` (matching the Terraform label set from Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278)), `xai)` arm in `run_agent` dispatch, `xai)` arm in preamble key-validation, `XAI_API_KEY` redaction pass. Document the config-file vs. built-in-provider verification result and `AGENT_MAX_TURNS` handling in the PR description. | Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278) (needs the Grok label set to match) |
| Issue [#309](https://github.com/mfrancza/agentic-development-workflow/issues/309) | Local validation via `docker run`: build the developer image; then with an `XAI_API_KEY` set out of band: (1) `AGENT_MODEL` set to a Grok name, `XAI_API_KEY` unset — fails in the preamble with "XAI_API_KEY is required" before any clone; (2) `AGENT_MODEL` set to a Grok name with key set — an action (e.g. `groom` on a fixture issue) completes end-to-end via the xAI path; (3) `AGENT_MODEL=bogus` — "Unknown model" message lists Grok names alongside Claude and OpenAI models; (4) `AGENT_MODEL=sonnet` — routes to `run_anthropic` unchanged; (5) `AGENT_MODEL=<an-openai-name>` — routes to `run_openai` unchanged. Confirm no `codex login` call appears in the `xai)` preamble arm (inspect container log). Record invocations and outputs in the PR description. | Issue [#308](https://github.com/mfrancza/agentic-development-workflow/issues/308) |

Issues [#308](https://github.com/mfrancza/agentic-development-workflow/issues/308) and [#309](https://github.com/mfrancza/agentic-development-workflow/issues/309) are sequential (validation requires the implementation
to be buildable). The broader end-to-end validation (both images, live API,
reviewer path) is Issue [#281](https://github.com/mfrancza/agentic-development-workflow/issues/281)
and depends on Issues [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278),
[#279](https://github.com/mfrancza/agentic-development-workflow/issues/279),
and [#280](https://github.com/mfrancza/agentic-development-workflow/issues/280).

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
