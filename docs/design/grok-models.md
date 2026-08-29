# Design: xAI Grok model support

**Issue:** [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275)

**Parent design:** [`multi-provider-models.md`](multi-provider-models.md) (Issue [#75](https://github.com/mfrancza/agentic-development-workflow/issues/75))

## Summary

Add xAI Grok models as a third provider in the multi-provider agent
architecture, wired the same way OpenAI is today: routed via the existing
`model:*` label convention, plumbed through every agent workflow, key-scoped
per run. The runner reuses the OpenAI Codex CLI that both images already
ship, pointed at xAI's OpenAI-compatible endpoint via a new `xai`
model-provider entry in Codex's config file — so no new CLI, no new base
image, and one runner function added per image.

## Requirements as understood

From issue [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275)'s
grooming Q&A (the issue body itself was empty; the grooming agent asked five
clarifying questions and the user's answers are the operative spec):

1. **Which Grok models** — every Grok model suitable for coding tasks.
   The specific list is chosen at implementation time against xAI's current
   lineup, same policy as the parent design applied to the OpenAI subset
   (parent requirement 4).
2. **Integration approach** — deliberately deferred to this design. The
   analysis and chosen path are Decision 1 below.
3. **Scope within this workflow** — the same as every other provider: every
   developer-image action (implement, fix-checks, respond-review,
   fix-deployment, groom, design, resolve-conflicts) and the reviewer image.
   Selection is via the existing `model:*` label; no new selection surface.
4. **Parity with existing models** — yes; Grok labels behave identically to
   the Anthropic `sonnet/opus/haiku` and OpenAI `gpt-*/o3` labels. The
   grooming agent's routing labels stay Claude-scoped (parent design's
   decision 2 already decouples the label picker from the agent's routing
   heuristic — no change here).
5. **Authentication & configuration** — proposed in this design (Decision 3
   below). The user will set up the recommended secret out of band.

### Ambiguities and how they were resolved

- **Is there a first-party xAI agentic CLI?** No — xAI publishes an API,
  not a headless agentic harness comparable to Claude Code or Codex. The
  parent design's Decision 1 lays out the three options for a new provider:
  per-provider agentic CLI (chosen for Anthropic + OpenAI), translation
  proxy (rejected), or a custom agent loop (rejected). This design picks a
  fourth path made possible by xAI's API surface: **reuse Codex as the
  agentic harness, configured to talk to xAI's OpenAI-compatible endpoint**.
  See Decision 1 for why that is not the "translation proxy" the parent
  rejected.
- **Provider name in `resolve_provider`.** Named `xai` (not `grok`,
  `x`, or `xai-openai-compatible`). `xai` is the vendor's own short name,
  matches Codex's convention for model-provider keys in `config.toml`, and
  is future-proof if xAI ships more model families beyond Grok.
- **Secret name.** `XAI_API_KEY` (not `GROK_API_KEY` or
  `X_AI_API_KEY`). Matches xAI's own env-var convention in their docs and
  the `X_` prefix would be ambiguous with the retired Twitter API.
- **Which Grok models go in the allowlist and get `model:*` labels.** Left
  to the implementer at Terraform + entrypoint change time, mirroring
  parent Decision 2's one-to-one label ↔ allowlist rule. The current
  coding-capable xAI lineup as of the design date (2026-08-28) includes
  `grok-code-fast-1` (coding-specialized), `grok-4` (latest general
  reasoning), and any successor of `grok-3` still marketed for code tasks;
  the implementer picks the intended subset against xAI's then-current
  model page and updates both `local.automation_labels` and
  `resolve_provider`'s case arm in the same PR.

## Decisions

### Decision 1 — Reuse the Codex CLI, pointed at xAI's OpenAI-compatible endpoint

xAI publishes an **OpenAI-compatible chat/completions API** at
`https://api.x.ai/v1`. The OpenAI Codex CLI that both agent images already
install (parent Decision 5) supports arbitrary OpenAI-compatible backends
via a `[model_providers.<name>]` entry in `~/.codex/config.toml`. Configured
that way, Codex speaks its normal wire protocol against xAI's endpoint; the
agent loop, tool-use handling, prompt-file convention, and sandbox flags
all come from Codex itself.

Three ways to run Grok agentically were considered:

- **(a) Reuse Codex with an `xai` model-provider entry** *(chosen).* One
  extra `run_xai()` runner per image (mostly a copy of `run_openai()`) plus
  ~4 lines of config-file content. No new CLI in the image, no new base
  layer, no new agent-loop code. The provider layer's contract already
  isolates per-provider differences to one runner function, which is
  exactly the extension point this design uses.
- **(b) Add a hypothetical xAI-authored first-party CLI.** No such CLI
  exists at the design date — xAI publishes API SDKs (Python/JS) and IDE
  plugins, not a headless agentic harness. Rejected on availability.
- **(c) Custom agent loop over xAI's Python/JS SDK.** Explicitly rejected
  by parent Decision 1 (custom loop = "this repo would be maintaining its
  own coding-agent harness"). Not re-argued here.
- **(d) Translation proxy (LiteLLM or similar).** The parent design
  rejected this generically because it "quietly couples 'provider' to
  whatever the proxy can fake." Codex's own `model_providers` mechanism
  is *not* a translation proxy — it is a Codex-native config knob for
  picking the base URL and auth env var of any OpenAI-compatible
  endpoint. The wire format going out is what Codex speaks natively and
  what xAI documents; there is no third-process translation layer to
  drift. So (a) is compatible with parent Decision 1, and (d) stays
  rejected.

**Consequence.** Adding a third provider is now a runner-function change,
not another architectural pass — the shape the parent design promised
("adding a provider is an add-a-runner change"). The multi-provider layer
is validated by this design's existence.

### Decision 2 — `xai` model provider configured via Codex `config.toml`, baked into both images

Both Dockerfiles gain a small `~/.codex/config.toml` for the agent user,
containing:

```toml
[model_providers.xai]
name = "xAI"
base_url = "https://api.x.ai/v1"
env_key = "XAI_API_KEY"
```

`env_key` tells Codex which env var to read the bearer token from — the
same knob Codex already uses for other custom providers. The runner does
not need a `codex login`-style pre-step for the `xai` arm (contrast the
`openai` arm, which does need one — see next paragraph); custom
model-providers read their credentials from the process environment via
the `env_key` binding, not from `~/.codex/auth.json`.

The `openai)` arm keeps its existing `printenv OPENAI_API_KEY | codex
login --with-api-key` step because the *built-in* `openai` provider still
authenticates from `~/.codex/auth.json` (issue #227's fix). The custom
`xai` provider bypasses that path by design — this asymmetry is worth a
comment in both entrypoints so a future maintainer does not remove one
under the impression that the other must behave the same.

**Where the config file lives.** Baked into both images at
`/home/agent/.codex/config.toml` via a `COPY` (or inline `cat >` `RUN`
step) at image build time. Rationale:

- The content is static and versioned with the image, matching how the
  per-action prompts under `/opt/agent/prompts/` are baked in rather than
  emitted at runtime.
- Every container run shares one identical config; there is nothing
  per-run to compute.
- Runtime emission from the entrypoint's preamble was considered and
  rejected: it moves a static fact into imperative shell, and the file
  path (`~/.codex/config.toml`) has to exist before Codex is invoked
  either way — so the extra runtime step buys nothing.

The file is chown-ed to `agent:agent` at image build time so the non-root
runtime user can read it (matching the ownership treatment Codex-adjacent
files already get).

**Verification at implementation time.** The `--config
model_provider="xai"` flag (used by the runner in Decision 4 below), the
exact TOML key names inside `[model_providers.xai]`, and whether the
pinned Codex release already ships a built-in `xai` provider are all
verified against `codex --help` and the pinned Codex release notes at the
implementation PR's build time. If a newer Codex release adds
`xai` as a first-class built-in provider, the config-file block becomes
unnecessary and the runner reduces to a straight `--config
model_provider="xai"` invocation. The runner shape below is written to
work in either state — the config-file block is additive when it is
needed and inert when it is not.

**Alternatives considered.**

- **Use Codex profiles** (`[profiles.xai]` with `model_provider = "xai"`
  and `model = "grok-code-fast-1"` baked in). Rejected: profiles couple
  provider selection to model selection, which fights the `AGENT_MODEL`
  contract (one label selects both). The runner passes `--model
  "$AGENT_MODEL"` and `--config model_provider="xai"` separately so the
  model can vary per run without a profile change.
- **Set the OpenAI Codex client to talk to xAI by overriding
  `OPENAI_BASE_URL` at runtime.** Rejected: this would also redirect the
  `openai` arm's traffic in a shared container, and picking which arm
  gets which base URL by env-var toggle is exactly the "quietly couples
  provider to whatever we can fake" antipattern parent Decision 1
  rejected. `model_providers` is Codex's supported extension point for
  this; use it.
- **Ship a separate `docker/xai/` image.** Same rejection as parent
  Decision 5's "per-provider images" — image matrix doubles for no
  isolation win here (the CLI and the API key are the only per-provider
  surface, both scoped per-invocation).

### Decision 3 — `XAI_API_KEY` mirrors the two existing provider keys

A repository secret set out of band (`gh secret set XAI_API_KEY`), passed
into the container by every agent workflow through the `run-agent`
composite action's new `xai-api-key` input, and validated conditionally in
each entrypoint's preamble — the exact same pattern the parent design
established for `OPENAI_API_KEY`:

- Workflows pass all three provider secrets (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `XAI_API_KEY`) unconditionally. Absent secrets resolve
  to empty strings in `${{ secrets.* }}` — GitHub Actions does not fail on
  missing secrets, it just returns empty.
- The container's preamble `case` statement grows an `xai)` arm:
  ```bash
  xai)
      : "${XAI_API_KEY:?XAI_API_KEY is required}"
      ;;
  ```
  No `codex login` sub-step (see Decision 2).
- The `run-agent` composite action gains a required `xai-api-key` input
  and a matching `-e XAI_API_KEY` in the container invocation, mirroring
  `openai-api-key` line-for-line.
- The container's log-capture EXIT trap gains an `XAI_API_KEY` redaction
  pass. This is duplicated in both entrypoints (developer and reviewer),
  same as the existing `OPENAI_API_KEY` redaction — the redaction body is
  three near-identical blocks today; adding a fourth is one more block.

Alternative: gate `XAI_API_KEY` behind a workflow-level `if:` that only
passes it when a Grok model is actually selected. Rejected for the same
reason as parent Decision 4 rejected the equivalent OpenAI conditional —
the model → provider map lives in the container, not in workflow YAML;
duplicating it into every workflow's YAML would be fragile and drift-prone.

### Decision 4 — `run_xai()` shape: copy `run_openai()`, swap the `--config` flag

The new runner is a small copy of `run_openai()` in both entrypoints. In
`docker/scripts/entrypoint.sh`:

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
    # directly.
    printf '%s\n' "$combined" | codex exec \
        --config model_provider="xai" \
        --model "$AGENT_MODEL" \
        --sandbox workspace-write \
        -
}
```

`run_agent()`'s dispatch case gains an `xai)` arm delegating to
`run_xai`, symmetric to `anthropic)` and `openai)`. The reviewer
entrypoint's `run_xai()` mirrors this shape, preserving the reviewer image's
no-write guarantee via `--sandbox workspace-write` (same rationale as the
reviewer's `run_openai`).

The exact `--config` flag syntax (`--config model_provider="xai"` vs.
`--config model_provider=xai` vs. a `-C key=value` short form) is pinned to
the pinned Codex CLI version at implementation time (`codex exec --help`).
If the pinned Codex release already exposes a built-in `xai` provider that
takes a bare `--model-provider xai` flag, the runner uses that shorter form.
Either way the runner's semantics — pick xAI, name a Grok model, sandbox
writes to the workspace — are unchanged.

`AGENT_MAX_TURNS` handling matches `run_openai()`'s: whichever equivalent
bound the pinned Codex release exposes if it maps cleanly, otherwise no
explicit cap (parent design's out-of-scope: "Symmetric `AGENT_MAX_TURNS`
semantics across providers — best-effort").

### Decision 5 — Model → provider allowlist grows a Grok arm; error message stays in sync

`resolve_provider`'s case statement in both entrypoints gains a third arm:

```bash
case "$model" in
    sonnet|opus|haiku)
        echo "anthropic"
        ;;
    gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5|o3)
        echo "openai"
        ;;
    <grok-model-names>)
        echo "xai"
        ;;
    *)
        log "ERROR: Unknown model '${model}'. Supported values: <full list>" >&2
        exit 1
        ;;
esac
```

The `<grok-model-names>` and the `<full list>` message are populated in the
implementation PR from the exact set the Terraform `local.automation_labels`
map provisions Grok labels for (parent Decision 2's one-to-one rule). The
"supported values" error message enumerates all three providers' models in
one line — the case-arm list is the single source of truth so drift between
the two is diff-visible.

If the Terraform label set changes between design and implementation, the
implementer re-syncs the case statement to whatever
`local.automation_labels` currently contains and notes the delta in the PR
description — same escape hatch parent Decision 3 already documents.

**Alternatives considered.**

- **Pattern-based inference (`grok-*` → xai).** Rejected by parent
  Decision 2 (accepts typos and unvetted model names silently). Not
  re-argued here.
- **Separate label prefix (`model:xai/grok-4`).** Rejected: breaks the
  existing single-flat-namespace `model:*` convention for zero gain.

### Decision 6 — Documentation updates: three call-sites, mechanical

- **`AGENTS.md` Provider/key mapping paragraph** — add
  `XAI_API_KEY` for Grok models (e.g. `model:grok-code-fast-1`,
  `model:grok-4`).
- **`AGENTS.md` Reviewer-image env line** — add `XAI_API_KEY` alongside
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the required-env list.
- **`AGENTS.md` Debugging → Redaction paragraph** — mention
  `XAI_API_KEY` in the list of redacted secrets alongside
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
- **`README.md` §3 (Actions secrets)** — add one line:
  ```bash
  gh secret set XAI_API_KEY --body "<xai api key>"   # optional if not using Grok models
  ```
  Below the corresponding `OPENAI_API_KEY` line so the three provider keys
  read as a group.

The merge-friendly documentation guidance in `AGENTS.md` ("no
implementation-status notes in prose", "prefer bullets over numbered
lists", "one fact per line") applies unchanged. Every edit is a
one-line insertion adjacent to an existing OpenAI-shaped line; parallel
merges with unrelated doc edits should be trivial.

## Out of scope

- **Providers beyond xAI.** The parent design's extension point is now
  exercised twice (OpenAI, then xAI); adding another provider (Gemini,
  Bedrock, on-prem …) remains a new-runner-function change plus a key
  secret plus a Dockerfile config line, tracked as its own issue.
- **Per-workflow or per-action Grok defaults** ("use `grok-code-fast-1`
  for grooming"). Parent design's out-of-scope list; unchanged here.
- **Reviewer-side or grooming-agent heuristics that pick Grok automatically**
  based on issue complexity. Grooming's routing map today emits
  Claude-only labels (`model:haiku`/`sonnet`/`opus`); teaching it about
  Grok tiers is a separate design in
  [`split-model-labels-by-agent-type.md`](split-model-labels-by-agent-type.md)'s
  neighbourhood — not this one.
- **Prompt tuning per provider.** Prompts stay shared. If Grok's behavior
  under the existing prompts materially diverges from Codex-on-OpenAI,
  fork the prompt in a follow-up design (same policy as parent).
- **Cost tracking / routing policies** ("use the cheap Grok for grooming").
  Parent design's out-of-scope list; unchanged.
- **Removing the OpenAI or Anthropic providers** — Grok is additive.
- **Cross-provider CI validation** (a Grok label on a real issue, driven
  end-to-end through workflows) — see task 4 below; local `docker run`
  validation is in scope, workflow-level CI validation is captured in the
  same task's PR description as an operator-run check (there is no
  automated agent-run CI in this repo).

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#278](https://github.com/mfrancza/agentic-development-workflow/issues/278) | Terraform + workflows + docs: add `model:grok-*` labels to `local.automation_labels` for the chosen Grok subset; add a `xai-api-key` input to `.github/actions/run-agent/action.yml` and thread `${{ secrets.XAI_API_KEY }}` through all eight agent workflows (`agent-implement`, `agent-groom`, `agent-design`, `agent-fix-checks`, `agent-fix-deployment`, `agent-resolve-conflicts`, `agent-respond-review`, `agent-review`); add `gh secret set XAI_API_KEY` to the README §3 secrets block; update the AGENTS.md provider/key mapping, reviewer-image env line, and redaction paragraph per Decision 6. One atomic PR. | — |
| Issue [#279](https://github.com/mfrancza/agentic-development-workflow/issues/279) | Developer image + entrypoint: add `[model_providers.xai]` block at `/home/agent/.codex/config.toml` in `docker/Dockerfile` (chowned to `agent:agent`); add the `xai)` arm to `resolve_provider` in `docker/scripts/entrypoint.sh` populating the chosen Grok model names (matching the Terraform label set from #278); add `run_xai()` per Decision 4; add the `xai)` arm to `run_agent`'s dispatch case; add the `xai)` arm to the preamble key-validation case requiring `XAI_API_KEY`; add the `XAI_API_KEY` redaction pass to the log-capture EXIT trap; document `AGENT_MAX_TURNS` handling under the xAI runner in the PR description. | Issue #278 (needs the label set to match) |
| Issue [#280](https://github.com/mfrancza/agentic-development-workflow/issues/280) | Reviewer image + entrypoint: same set of changes as #279, applied to `docker/reviewer/Dockerfile` and `docker/reviewer/entrypoint.sh` — `[model_providers.xai]` config block, `resolve_provider` xai arm, `run_xai()` mirroring `run_openai()` with `workspace-write` sandbox, `run_agent` dispatch arm, preamble key validation, redaction. Preserves the reviewer image's structural no-write guarantee (no `git-askpass.sh`, no push credentials) — the xAI runner does not change the token-layer contract. | Issue #278 (same label-set coupling) |
| Issue [#281](https://github.com/mfrancza/agentic-development-workflow/issues/281) | End-to-end validation via `docker run`: build both images with the new config; then, using an `XAI_API_KEY` provisioned out of band, exercise each path — record invocation + output in the PR description: (1) developer container with `AGENT_MODEL=<a-grok-name>`, `XAI_API_KEY` unset — fails cleanly in the preamble with the "XAI_API_KEY is required" message before any clone; (2) same but with key set — an existing action (e.g. `groom` on a fixture issue) completes end-to-end via the xAI Codex path; (3) `AGENT_MODEL=bogus` — the "Unknown model" message lists Grok models alongside Claude and OpenAI models; (4) `AGENT_MODEL=sonnet` — routes to `run_anthropic` unchanged (regression check); (5) `AGENT_MODEL=<an-openai-name>` — routes to `run_openai` unchanged (regression check); (6) reviewer container with `AGENT_MODEL=<a-grok-name>` — a live PR gets a review from Grok; verify no `codex login` step is invoked in the `xai)` arm (checked from the container log). | Issues #278, #279, #280 |

Tasks 2 and 3 are independent of each other and can proceed in parallel
once task 1 lands (or concurrently with task 1, provided the implementer
picks the Grok model set once and applies the same list to Terraform and to
both entrypoints in matched PRs — the parent design already accepts this
coordination pattern for the OpenAI case). Task 4 depends on all three so
it can exercise the full path.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
