# Design: Multi-provider model support

**Issue:** [#75](https://github.com/mfrancza/agentic-development-workflow/issues/75)

## Summary

Let every agent in this repo run on OpenAI models as well as Anthropic
models, selected through the existing `model:*` label convention, with the
provider layer designed so further providers (Gemini, Bedrock, …) are an
add-a-runner change rather than another architectural pass.

## Requirements (from issue #75 grooming Q&A)

1. **Scope** — all the places agents are used: every developer-image action
   (implement, fix-checks, respond-review, fix-deployment, groom) and the
   reviewer image.
2. **Selection** — extend the existing `model:<name>` label convention.
3. **Key management** — same approach as the Anthropic key: a repository
   secret injected into the container per run.
4. **Models** — any model useful for software tasks; no hardcoded shortlist.
5. **Motivation** — cost, capabilities, redundancy, and diversity of model
   behavior.
6. **Architecture** — multi-provider, not an OpenAI one-off.

## Design

### Decision 1: one agentic CLI per provider, behind a runner dispatch

The agents are not raw API calls — they are agentic coding sessions (tool
use, shell, file edits) run through the Claude Code CLI. Three ways to make
that multi-provider were considered:

- **(a) Per-provider agentic CLI** *(chosen)*: keep Claude Code for
  Anthropic models; add the OpenAI Codex CLI (`codex exec`, OpenAI's
  first-party headless agent) for OpenAI models. Each entrypoint's
  `run_claude()` becomes `run_agent()`, which dispatches to a small
  per-provider runner function.
- **(b) Translation proxy**: keep Claude Code as the only harness and route
  it through a proxy (e.g. LiteLLM) that serves the Anthropic API backed by
  OpenAI models. One harness, unchanged prompts — but it adds a proxy
  process inside every container, is an officially unsupported path for
  Claude Code, and quietly couples "provider" to "whatever the proxy can
  fake." Rejected as brittle.
- **(c) Custom agent loop** over provider SDKs: maximum control, but this
  repo would be maintaining its own coding-agent harness — exactly the
  wheel the first-party CLIs exist to avoid. Rejected.

Option (a) is also what makes requirement 5 real: diversity of model
behavior includes diversity of harness behavior, and each provider's
first-party CLI is the best-supported way to run its models agentically.
The cost is per-provider differences (flags, prompt injection, sandboxing),
contained in one runner function each.

Repo guidance in `AGENTS.md` reaches the agent through explicit prompt
instructions — the per-action prompts tell the agent to read it (e.g. the
reviewer prompt's `cat AGENTS.md` step) — not through assumed native harness
behavior, so the mechanism is provider-independent by construction. The
per-action system prompts ship inside the images at `/opt/agent/prompts/`
(COPYed at build time from `docker/scripts/prompts/` and
`docker/reviewer/prompts/`); Claude Code receives them via
`--system-prompt-file`, and the Codex runner prepends the same file to the
task prompt (Codex exec has no separate system-prompt flag). The prompts are
already harness-agnostic (instructions + `gh` recipes) and need no changes.

### Decision 2: explicit model→provider map, validated up front

The `model:*` convention stays exactly as-is — one label, one value, e.g.
`model:opus` or `model:gpt-5-codex`. The entrypoint maps the model name to
its provider through an **explicit allowlist**: a case statement enumerating
the exact supported model names (today's Anthropic aliases
`sonnet`/`opus`/`haiku` plus the chosen OpenAI models). An unknown model
name fails loudly at the start of the run — before any clone or API call —
with an error listing the supported values, consistent with the repo's
fail-loud-on-ambiguous-input security default. Adding a model is a one-line
map change plus its Terraform label.

Alternatives considered: pattern-based inference (`gpt-*` → openai, else
anthropic) — accepts typos and unvetted model names silently, trading input
validation for convenience; an explicit `provider/model` label syntax
(`model:openai/gpt-5`) — more typing and a breaking convention change for
existing labels; and a checked-in registry file mapping models to providers
— indirection with no current payoff, and the reviewer image would need it
before cloning the repo. The case statement is duplicated once per image
(developer, reviewer) with a comment noting the twin; if a third image ever
appears, promote it to a shared lib file COPYed into the images.

Terraform pre-provisions a `model:*` label per supported model, keeping the
label picker and the allowlist in one-to-one correspondence. Which OpenAI
models make the initial list is decided at implementation time against
OpenAI's current lineup (requirement 4 — models useful for software tasks).

### Decision 3: generalize the naming — `DEFAULT_MODEL`, `AGENT_MODEL`

`DEFAULT_CLAUDE_MODEL` (Actions variable) and `CLAUDE_MODEL` (container env)
are Anthropic-branded names for what is now a provider-neutral setting.
They are renamed in one mechanical pass: Terraform variable + Actions
variable `default_model`/`DEFAULT_MODEL`, container env `AGENT_MODEL`
(`CLAUDE_MAX_TURNS` similarly becomes `AGENT_MAX_TURNS`). All five workflows
and both entrypoints change together in one PR — no compatibility shims; the
repo is the only consumer of these names. Alternative (keep the old names to
avoid churn) rejected: the misnomer would outlive the reason for it.

### Decision 4: `OPENAI_API_KEY` mirrors `ANTHROPIC_API_KEY`

A repository secret set out of band (`gh secret set OPENAI_API_KEY`), passed
by every agent workflow into the container. The entrypoints validate keys
conditionally: the provider selected for this run must have its key present;
the other provider's key may be absent. Workflows pass both secrets
unconditionally — absent secrets simply arrive empty, and the container
fails loudly only if the empty one is actually needed.

### Decision 5: images ship both CLIs

`docker/Dockerfile` and `docker/reviewer/Dockerfile` install the Codex CLI
next to Claude Code, both npm-pinned by version for reproducibility (same
convention as `CLAUDE_CODE_VERSION`; a `CODEX_CLI_VERSION` build arg). The
alternative — per-provider images and workflow-level image selection — is
deliberately deferred rather than rejected: a split could yield an isolation
benefit (each image carrying only its own provider's CLI and key surface),
but it doubles the image matrix and moves provider knowledge up into every
workflow. Revisit once a second provider integration exists to compare
against (see Out of scope).

The reviewer image's structural no-write guarantee must hold for the Codex
path too: `codex exec` is invoked with write access confined to the
workspace (its sandbox flags), the image still ships no push credentials,
and the reviewer token stays Contents-read-only — the token layer is
provider-independent.

## Out of scope

- Providers beyond OpenAI (the runner dispatch is the extension point;
  adding one is a new runner function + key secret + Dockerfile line).
- Per-action or per-agent default models (one repo-wide default, overridden
  per issue/PR by `model:*`, same as today).
- Cost tracking/routing policies ("use the cheap model for grooming") —
  possible later on top of the same convention.
- Prompt tuning per provider — prompts stay shared; provider-specific prompt
  forks would need their own design if behavior diverges materially.
- Per-provider image split for isolation — deferred until a second provider
  integration exists to compare against (see Decision 5).

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#80](https://github.com/mfrancza/agentic-development-workflow/issues/80) | Developer entrypoint: `run_agent()` dispatch, explicit model→provider map with up-front validation, conditional key validation, `AGENT_MODEL`/`AGENT_MAX_TURNS` rename (Anthropic path only — behavior unchanged) | — |
| [#81](https://github.com/mfrancza/agentic-development-workflow/issues/81) | OpenAI runner: Codex CLI in both Dockerfiles (pinned), `run_openai()` in the developer entrypoint (prompt assembly, exec flags, sandboxing) | #80 |
| [#82](https://github.com/mfrancza/agentic-development-workflow/issues/82) | Terraform + workflows: `DEFAULT_MODEL` rename, OpenAI `model:*` convenience labels, `OPENAI_API_KEY` secret documented and passed by all five workflows | — |
| [#83](https://github.com/mfrancza/agentic-development-workflow/issues/83) | Reviewer entrypoint: same runner dispatch + OpenAI path, preserving the no-write guarantee under `codex exec` | #81 |
| [#84](https://github.com/mfrancza/agentic-development-workflow/issues/84) | End-to-end validation via CI: groom + implement runs with an OpenAI `model:*` label; reviewer run on an OpenAI model once #40 lands; confirm Anthropic default path unchanged | #81, #82, #83 |

Issues #80 and #82 can proceed in parallel (this document is the contract:
the explicit model→provider map, `AGENT_MODEL`, `DEFAULT_MODEL`, both keys
passed).
Validation is CI-first per the project's convention — no local credential
provisioning.

Dependency order is documented in the task breakdown table above.
