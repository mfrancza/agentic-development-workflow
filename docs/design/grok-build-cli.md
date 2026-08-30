# Design: Use Grok Build CLI for Grok models

**Issue:** [#353](https://github.com/mfrancza/agentic-development-workflow/issues/353)

**Parent designs:**
- [`grok-models.md`](grok-models.md) (Issue [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275)) — established the `xai` provider arm, `XAI_API_KEY` secret, workflow plumbing, and `resolve_provider` allowlist.
- [`grok-developer-image-entrypoint.md`](grok-developer-image-entrypoint.md) (Issue [#279](https://github.com/mfrancza/agentic-development-workflow/issues/279)) — implemented the current `run_xai()` runner that reuses OpenAI Codex CLI against xAI's OpenAI-compatible endpoint.

## Summary

Replace the current Grok runtime — OpenAI Codex CLI pointed at
`https://api.x.ai/v1` via a `[model_providers.xai]` block in
`~/.codex/config.toml` — with xAI's first-party [Grok Build CLI](https://x.ai/news/grok-build-cli).
The `xai` provider arm keeps its shape (dedicated `run_xai()` in each
entrypoint, dispatched from `run_agent()`) but the runner body swaps
`codex exec …` for the Grok CLI's headless-mode invocation, and the model
allowlist is re-sourced from what the Grok Build CLI itself supports at
the pinned release. All other layers — `model:grok-*` labels, `XAI_API_KEY`
plumbing, redaction, log capture, key-scoping — are unchanged.

The multi-provider architecture (per-provider agentic CLIs behind a runner
dispatch, explicit model → provider allowlist, both images ship all CLIs,
provider keys always passed and validated conditionally) is settled in
[`multi-provider-models.md`](multi-provider-models.md) and is not
re-argued here. This design is a runner-body swap plus a Dockerfile edit,
scoped to the `xai)` arm.

## Requirements as understood

From issue [#353](https://github.com/mfrancza/agentic-development-workflow/issues/353)
and its grooming notes:

1. **Execution layer.** Switch the runtime for `AGENT_PROVIDER=xai` from the
   OpenAI Codex CLI (with the `xai` custom `model_providers` entry pointed
   at xAI's OpenAI-compatible endpoint) to xAI's own [Grok Build CLI](https://x.ai/news/grok-build-cli),
   installed via the vendor's install script and invoked in headless mode
   (`grok -p`) from `run_xai()` in both entrypoints.
2. **Model discovery.** Base the list of supported Grok models on what the
   Grok Build CLI supports at the pinned release. The Terraform `model:grok-*`
   label set and the `resolve_provider` `xai)` case-arm list stay in
   one-to-one correspondence (parent design decision 2) with each other, and
   are jointly synced to the CLI's supported set at implementation time.
3. **Fallback / error behaviour.** Fail loudly in the container preamble if
   `XAI_API_KEY` is unset (unchanged) or if `grok` is not on `PATH` (new —
   image-build-time bug rather than runtime, but the container still needs
   a clear message rather than a `command not found` from a mid-run
   invocation).
4. **Authentication.** Reuse the existing `XAI_API_KEY` secret and plumbing
   — no new secrets, no new workflow inputs. The switch must work in a
   fully headless, non-interactive CI context (no `sign in with your account`
   OAuth pop-up).

Design decisions the grooming comment explicitly flagged as needing
resolution are treated in the **Decisions** section below (invocation
shape → D3; model enumeration → D5; fallback → D3 & D4; authentication →
D4).

### Ambiguities and how they were resolved

Some Grok Build CLI details are not documented on the public
[announcement page](https://x.ai/news/grok-build-cli) or in the install
script at `https://x.ai/cli/install.sh` at design time (2026-08-30). Each
ambiguity is resolved either **at design time** (below) or **at
implementation time** (verified against `grok --help` and captured in the
implementing PR's description, matching the `codex --help` verification
convention already used by parent design decision 2 in
[`grok-developer-image-entrypoint.md`](grok-developer-image-entrypoint.md)).

- **Does the Grok Build CLI accept `XAI_API_KEY` for headless auth?**
  The public announcement says "sign in with your account" (interactive)
  and separately calls out headless mode (`-p`) "for running agents
  inside scripts and automations." The two together strongly imply an
  API-key or config-file-based auth path for headless use (an
  interactive OAuth flow inside `-p` would defeat the purpose), but the
  exact mechanism is not documented publicly.
  **Resolved at implementation time:** the implementer verifies against
  the pinned CLI release that (a) an env-var based auth path exists
  (most likely `XAI_API_KEY`; possibly `GROK_API_KEY` or similar), or
  (b) a documented non-interactive login sub-command exists analogous
  to `codex login --with-api-key`, and configures the preamble to use
  it. If **neither** path exists at the pinned release, the design is
  blocked — see Decision 4 for the human-escalation trigger.

- **Does the beta-access requirement (SuperGrok / X Premium Plus)
  apply to API-key access?** The announcement gates the beta on those
  subscriptions but does not say whether API-key access is
  independently gated. **Resolved at implementation time:** the
  implementer verifies against a real xAI account that the pinned
  `XAI_API_KEY` used by the reference deployment can drive `grok -p`
  end-to-end. If the API-key path is subscription-gated in a way that
  the reference account does not satisfy, escalate per Decision 4.

- **Which sub-command name and flag names does the CLI expose?** The
  announcement mentions only the `-p` headless mode flag. Concrete
  flag surface (model selection, sandbox mode, prompt input, model
  listing) is not documented publicly. **Resolved at implementation
  time** via `grok --help` at pinned version; the implementing PR
  records the exact flags used and their pinned-version syntax, same
  convention as parent design decision 2 for `codex exec --help`.

- **How does the CLI enumerate its supported models?** The `xai`
  models page at `docs.x.ai/docs/models` lists a superset of what
  makes sense for a coding agent (image / video / audio models are
  irrelevant here). The Grok Build CLI likely accepts a subset of
  text/coding-capable model IDs. **Resolved at implementation time**:
  the implementer runs `grok --help` (and `grok models list` or an
  equivalent sub-command if one exists) and picks the coding-capable
  subset — same policy the parent design already uses (grok-models.md
  ambiguity resolution: "the current coding-capable xAI lineup"). If
  the CLI does not expose a `list` sub-command, the implementer
  falls back to xAI's official model page and records the source in
  the PR description.

- **What sandbox / workspace-confinement flag does `grok -p` expose?**
  The announcement mentions worktree integrations and MCP but does
  not describe sandbox modes analogous to Codex's `--sandbox
  workspace-write`. **Resolved at implementation time**: the
  implementer uses whichever pinned-version flag confines writes to
  the workspace (`/home/agent/work` for the developer image;
  read-only for the reviewer image's structural no-write guarantee).
  If no equivalent flag exists at the pinned release, the reviewer
  image's runner still preserves its no-write posture through the
  token layer (Contents:read only) — same defence-in-depth argument
  the parent design already documents.

## Decisions

### Decision 1 — Switch the runtime for the `xai` provider arm; keep the shell of the multi-provider architecture untouched

**Decision.** `run_xai()` in both `docker/scripts/entrypoint.sh` and
`docker/reviewer/entrypoint.sh` is rewritten to invoke `grok` (the Grok
Build CLI binary) rather than `codex exec --config
model_provider="xai"`. `run_agent()`'s dispatch case, `resolve_provider`'s
`xai)` arm, and the preamble `xai)` key-validation arm are updated in
lock-step but not restructured. The provider layer itself (Anthropic /
OpenAI / xAI dispatch) is unchanged.

**Why.** The parent design's contract — "adding or swapping a provider is
a runner-function change, not an architectural pass" — was written for
exactly this case. Grok Build CLI is a first-party agentic harness for
Grok models; slotting it into the existing dispatch is a direct match for
the dispatch layer that was already validated by the OpenAI and xAI-via-
Codex rollouts.

**Alternatives considered.**

- **Keep the current Codex-with-xai-config path and add Grok Build CLI as
  a *second* xAI runtime, selected by a new label prefix or env var.**
  Rejected. Doubles the maintenance surface, doubles the auth footprint,
  and the parent design's fail-loud-on-ambiguous-input rule says two
  runtimes for one provider is exactly the "silently picks one" trap
  labels/flags should avoid.
- **Replace the whole `xai` arm with a raw HTTP client against
  `api.x.ai/v1`.** Rejected by parent design decision 1 (custom-loop
  path) — the whole point of picking a first-party agentic CLI is to
  avoid maintaining our own harness.
- **Wait for the Grok Build CLI to leave beta before switching.**
  Rejected as the default path: the issue asks for the switch now, and
  the CLI is available on the vendor's install script. Beta status *is*
  called out as an implementation-time escalation trigger — see
  Decision 4.

### Decision 2 — Install the Grok Build CLI at image build time in both Dockerfiles; pin by version if the vendor exposes one, else by a stable channel

**Decision.** Both `docker/Dockerfile` and `docker/reviewer/Dockerfile`
gain a build step that installs the Grok Build CLI from the vendor's
install script (`https://x.ai/cli/install.sh`) or from a directly-
downloaded binary artifact. The install runs before the `USER agent`
directive so the binary is on the root-owned system PATH (matching how
`gh`, `claude`, and `codex` are installed today).

The install method is pinned to a specific version if the install script
exposes a `VERSION=` env-var or `--version` flag (the script does support
a version-selection knob per the `x.ai/cli/install.sh` fetch — the
implementer records the exact syntax in the PR description). If no
version pin is available at implementation time, the install pins to a
stable release channel and the PR description records the exact channel
identifier chosen; a subsequent issue tracks tightening the pin.

The build step is added to both Dockerfiles in the same PR — same
convention as `CODEX_CLI_VERSION` / `CLAUDE_CODE_VERSION` (parent design
decision 5: "images ship all CLIs so a future runner refactor does not
need a Dockerfile edit").

**Why the vendor install script rather than a direct binary download.**
The install script handles OS/arch detection, checksum verification (per
the script content), and PATH configuration; a hand-rolled download
would replicate that logic in the Dockerfile with no reproducibility
gain. The script also has a documented fallback URL
(`storage.googleapis.com/grok-build-public-artifacts/cli`) if the primary
Cloudflare-fronted origin is unreachable.

**Alternatives considered.**

- **npm-install the CLI (like `claude` and `codex`).** Rejected — the
  Grok Build CLI is not published as an npm package at design time; the
  vendor's only supported install path is the `curl | bash` script.
- **Install from a GitHub release tarball.** Rejected — the vendor does
  not publish a public GitHub repo for the CLI at design time; the only
  first-party artifact source is `x.ai/cli` (via the install script).
- **Build a separate `docker/xai/` image.** Same rejection as parent
  design decision 5 ("per-provider images doubles the image matrix for
  no isolation win").

### Decision 3 — `run_xai()` shape: `grok -p` with system prompt prepended to the task prompt

**Decision.** `run_xai()` in `docker/scripts/entrypoint.sh` becomes (shape
— exact flag names verified at implementation time):

```bash
run_xai() {
    local prompt_file="$1"
    shift
    local user_prompt="$*"

    local system_prompt combined
    system_prompt="$(cat "${SCRIPTS_DIR}/prompts/${prompt_file}")"
    # Grok Build CLI's headless mode has no separate --system-prompt flag
    # (verified at implementation time via `grok --help`); prepend the
    # per-action system prompt to the task prompt with the same `---`
    # separator convention used by run_openai() and the previous
    # Codex-based run_xai().
    combined="${system_prompt}

---

${user_prompt}"

    # `grok -p` is the documented headless / scripting mode. --model
    # selects the specific Grok model. Sandbox flag (if the pinned
    # release exposes one) confines writes to the workspace.
    printf '%s\n' "$combined" | grok -p \
        --model "$AGENT_MODEL" \
        <workspace-sandbox-flag-if-supported> \
        -
}
```

The reviewer image's `run_xai()` mirrors this shape but honors the
reviewer image's structural no-write posture (no `git-askpass.sh`, no
push credentials in the image, Contents:read reviewer token — see
[`reviewer-container.md`](reviewer-container.md) decision 3). If the
pinned Grok Build CLI release does not expose a workspace-write
sandbox flag, the reviewer runner still preserves its no-write posture
via the token layer alone, and the implementing PR calls this out.

**Flag surface verification.** The exact `grok` sub-command (whether
headless mode is `grok -p`, `grok run -p`, `grok agent -p`, or another
form), the exact model-selection flag (`--model` vs `-m` vs a config-file
key), the stdin sigil (`-` vs implicit vs a `--input-file` alternative),
and the sandbox / workspace-confinement flag are all verified against
`grok --help` at the pinned CLI release before the PR merges. The
`run_xai()` body ships with the exact pinned syntax; the PR description
records the verified `grok --help` excerpt so a future reader can trace
the choice.

**`AGENT_MAX_TURNS` handling.** Best-effort, matching the policy the
parent design established for `run_openai()` and the previous
Codex-based `run_xai()`. If the pinned Grok Build CLI release exposes a
turn-cap flag equivalent to Claude Code's `--max-turns`, the runner
passes `AGENT_MAX_TURNS` to it; otherwise the runner sets no explicit
cap and the PR description documents the omission. Symmetric turn
semantics across providers remain out of scope (parent design
decision 4).

**Fallback: `grok` binary not on PATH.** Since the install step is in
the Dockerfile, this can only happen if the image build failed silently
— but the preamble adds a sanity `command -v grok >/dev/null 2>&1 || {
log "ERROR: grok binary not found on PATH — image build is broken"; exit
1; }` inside the `xai)` preamble arm so the failure mode is diagnostic
rather than a mid-run `command not found`.

**Alternatives considered.**

- **Write the combined prompt to a temp file and pass it as
  `--input-file`.** Rejected for the same reason parent design
  decision 2 in [`multi-provider-openai-runner.md`](multi-provider-openai-runner.md)
  rejected it: piping on stdin is the shape the existing runners use
  and it avoids tempfile-cleanup logic.
- **Share a single `run_headless_agentic_cli()` function
  parameterized by CLI name and flags.** Considered and rejected: the
  three runners (`run_anthropic`, `run_openai`, `run_xai`) are near-
  identical today but may diverge as providers evolve. Keeping them
  separate matches how `run_anthropic` vs. `run_openai` already coexist
  and lets each evolve without flag-parameterization gymnastics — same
  rationale as parent design decision 2 in `grok-developer-image-entrypoint.md`.

### Decision 4 — Preamble `xai)` arm requires `XAI_API_KEY`; the specific plumbing (env var, `grok login --with-api-key`, or config file) is verified at implementation time

**Decision.** The preamble `case "$AGENT_PROVIDER" in` block's `xai)` arm
keeps its `: "${XAI_API_KEY:?XAI_API_KEY is required}"` presence check.
The **body of that arm** — how the key gets from the env into a form the
`grok` CLI can consume for `grok -p` — is one of the three shapes below,
picked at implementation time based on what the pinned Grok Build CLI
release supports:

- **(a) The CLI reads `XAI_API_KEY` (or an equivalent named env var)
  directly.** The arm is a bare presence check; no login step is
  needed. This is the same shape the current (Codex-via-xai)
  `xai)` arm already has, and is the preferred path.
- **(b) The CLI has a documented non-interactive login sub-command
  analogous to `codex login --with-api-key`.** The arm calls it,
  piping the key on stdin: `printenv XAI_API_KEY | grok login
  --with-api-key` (exact sub-command name verified at implementation
  time). This is the Codex `openai)` arm's shape.
- **(c) The CLI reads its credential from a config file
  (`~/.grok/credentials.toml` or similar).** The Dockerfile bakes a
  static config-file stub that references `env_key = "XAI_API_KEY"`
  (matching the pattern the current `[model_providers.xai]` Codex
  block already uses); the preamble arm is a bare presence check.

**Verify-first rule.** The implementing PR must record which of (a),
(b), (c) shipped and cite the `grok --help` output or vendor doc snippet
that establishes it — same standard the parent design applies to
Codex flags.

**Escalation path.** If, at implementation time, **none** of (a) / (b)
/ (c) is available — i.e. the pinned Grok Build CLI release requires an
interactive OAuth flow (`sign in with your account`) even in `-p`
headless mode, with no supported way to pre-populate credentials for
CI — the design is blocked. The implementer:

1. Does not merge a broken `xai` arm — leaving the current Codex-based
   `run_xai()` in place is preferable to a runtime that cannot
   authenticate.
2. Applies `human-required` to Issue [#353](https://github.com/mfrancza/agentic-development-workflow/issues/353)
   and to the sub-issues that this design creates.
3. Comments on the parent issue with the specific `grok --help` output
   / vendor-doc snippet that establishes the blocker, and asks for
   guidance (options include: escalate to xAI for headless-auth
   support; defer the switch until the CLI supports it; keep the
   current Codex-based `xai` arm indefinitely).

**Beta-access sub-blocker.** The Grok Build CLI is documented as an
"early beta" requiring SuperGrok or X Premium Plus subscription. If
the API-key path is *also* subscription-gated in a way the reference
account does not satisfy, the same escalation path applies. Buying an
X Premium Plus subscription for the reference agent identity is a
billing decision that requires human input (per `AGENTS.md`'s
"Escalating to a human" list). This is documented here so the
implementer knows to escalate rather than silently attempt a purchase.

**Why validation happens in the preamble rather than at first `grok`
invocation.** Matches the fail-loud-on-ambiguous-input security default
in `AGENTS.md` and the existing pattern for `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`: cheap checks fail before any clone or API call, so
the workflow logs are diagnostic and no wasted work happens on the
`gh` side.

### Decision 5 — Model allowlist is baked in at image build time; synced to the CLI's supported set and Terraform labels in a matched change

**Decision.** `resolve_provider`'s `xai)` case-arm and the Terraform
`model:grok-*` label set are re-derived from what the pinned Grok Build
CLI release supports for coding tasks. Both are updated in the
implementing PR — matched change, one-to-one correspondence (parent
design decision 2). The current allowlist (`grok-3|grok-3-mini|grok-
code-fast-1`) is a lower bound; the implementer may add, replace, or
remove entries based on the CLI's supported set at pin time. If the
implementer changes the set, both the `resolve_provider` `xai)` arm and
the wildcard arm's "supported values" error message are updated in the
same commit — the case-arm list is the single source of truth, so drift
is diff-visible.

**Sourcing the list.** In order of preference:

1. `grok models list` (or an equivalent sub-command) at pinned CLI
   version. Recorded verbatim in the PR description.
2. If no such sub-command exists, `grok --help` output enumerating
   supported values for the `--model` flag.
3. If neither exposes the list, xAI's official [models page](https://docs.x.ai/docs/models)
   at pinned CLI version, filtered to text/coding-capable models. The
   PR description records the page's state (date + models listed) so
   the choice is auditable.

Whichever source ships, the PR description records it and the delta
from the current `grok-3 | grok-3-mini | grok-code-fast-1` allowlist —
same escape hatch that parent design decision 5 in `grok-models.md`
already documents.

**Runtime model enumeration is explicitly not done.** Options
considered and rejected:

- **Call `grok models list` at container startup and generate the
  allowlist dynamically.** Rejected: adds a per-container-run
  network dependency on `api.x.ai`, silently accepts a model rename
  that a static allowlist would fail loud on, and duplicates cost on
  every workflow event. The parent design already accepted the
  duplicated-case-arm cost per image.
- **Move the allowlist to Terraform only and let the container defer
  to what a valid label already implies.** Rejected: the entrypoint
  needs the list statically at container start for the
  fail-loud-on-unknown-model default, and the reviewer image needs
  it before it clones the repo, so a Terraform-only source would not
  work for the reviewer image.

### Decision 6 — Remove the now-dead `[model_providers.xai]` Codex config block from both Dockerfiles

**Decision.** The `RUN mkdir -p /home/agent/.codex && printf
'[model_providers.xai]\n…' > /home/agent/.codex/config.toml` step in
both Dockerfiles (baked in by Issue [#279](https://github.com/mfrancza/agentic-development-workflow/issues/279)
and Issue [#280](https://github.com/mfrancza/agentic-development-workflow/issues/280))
is removed in the same PR that installs the Grok Build CLI. Once
`run_xai()` no longer calls `codex exec`, the Codex `xai` model-provider
entry is dead configuration that will drift silently.

The `openai)` arm's Codex-native usage (`codex exec` against OpenAI's
built-in provider, `codex login --with-api-key` in the preamble) is
unchanged — Codex stays installed in both images for OpenAI models.

**Why remove rather than keep as a fallback.** Two runtimes for one
provider is exactly the fail-loud-on-ambiguous-input trap the parent
design's decision 2 already rejects. If the Grok Build CLI runner
regresses, a git revert to the Codex-based `run_xai()` is a one-line
change; keeping the block in-tree as a permanent fallback is not
necessary and invites the "two paths, silent divergence" antipattern.

**Alternatives considered.**

- **Keep the Codex `xai` block as a documented fallback selected by an
  env-var or label.** Rejected on the same grounds as Decision 1's
  "keep the current path and add Grok CLI as a second runtime"
  alternative.
- **Leave the block untouched (dead config).** Rejected: parent
  design's merge-friendly documentation rule and the general "no dead
  code" hygiene apply. Dead config that references a runtime path
  no code exercises is a review-slowing surprise for future
  maintainers.

### Decision 7 — Docs updates: mechanical, three call-sites

- **`AGENTS.md` provider/key mapping paragraph** — replace the current
  Grok blurb (`XAI_API_KEY` for xAI Grok models via Codex-with-
  `model_providers.xai`) with the Grok Build CLI runner: same env var,
  new runtime. Explicit: "Grok models are executed by the Grok Build
  CLI (`grok -p`), not by Codex."
- **`docs/design/grok-models.md`** — add a top-of-file amendment note
  (matching the amendment style already used in the same doc's
  Decision 2) pointing at this document for the current runner, so a
  future reader lands on the up-to-date design.
- **`docs/design/grok-developer-image-entrypoint.md`** — same
  amendment note style, pointing at this document.
- **`README.md`** — no user-visible change (`XAI_API_KEY` secret line
  stays); the only user-facing wording that mentions "Codex" as the
  Grok runtime is in `AGENTS.md`.

The merge-friendly documentation rules in `AGENTS.md` ("no
implementation-status notes in prose", "one fact per line") apply
unchanged — every edit is an in-place replacement of one bullet, not a
new list item.

## Out of scope

- **Other providers.** Anthropic and OpenAI arms are untouched.
- **Removing the Codex CLI from either image.** Codex still runs the
  `openai)` arm; this design only removes the Codex `xai` model-provider
  config.
- **New model families / providers beyond xAI.** Parent design's
  extension point is exercised again here; adding a Gemini / Bedrock /
  other provider stays a new-runner-function change.
- **Per-workflow or per-action Grok defaults.** Parent design's
  out-of-scope list; unchanged.
- **Grooming-agent routing labels emitting `model:grok-*`.** Parent
  design's out-of-scope list; the label picker stays Claude-only for
  the groomer's routing heuristic.
- **Prompt tuning per provider.** Parent design's out-of-scope list;
  prompts stay shared.
- **Symmetric `AGENT_MAX_TURNS` semantics across providers.** Parent
  design's out-of-scope list; best-effort matches the existing
  `run_openai` policy.
- **Cost tracking / routing policies.** Parent design's out-of-scope
  list; unchanged.
- **Removing the `XAI_API_KEY` secret plumbing in workflows or the
  `xai-api-key` input on the `run-agent` composite action.** Unchanged
  from the parent design; the same secret and plumbing feed the new
  runtime.
- **CI-level validation of the switch (a `model:grok-*` label on a
  real issue driven end-to-end through workflows).** Local
  `docker run` validation is in scope (the e2e sub-issue below);
  workflow-level CI validation stays out of scope, same policy the
  parent design already applied.

## Task breakdown and dependencies

The task split mirrors the parent design's shape: install-CLI-in-both-
images + Terraform labels + docs (task 1) is one PR that both entrypoint
tasks depend on; the developer-image entrypoint (task 2) and
reviewer-image entrypoint (task 3) are independent of each other and
run in parallel once task 1 lands; task 4 depends on all three and
exercises the full path via `docker run`.

| Issue | Task | Depends on |
|-------|------|------------|
| Issue [#354](https://github.com/mfrancza/agentic-development-workflow/issues/354) | Dockerfile install + Terraform + docs: install the Grok Build CLI in both `docker/Dockerfile` and `docker/reviewer/Dockerfile` per Decision 2 (pin by version if the vendor supports it; document the chosen pinning in the PR description). Remove the `[model_providers.xai]` Codex `config.toml` block from both Dockerfiles per Decision 6. Update Terraform `local.automation_labels` `model:grok-*` label set to whatever the pinned Grok Build CLI supports for coding tasks (Decision 5). Update `AGENTS.md` provider/key mapping paragraph and add amendment notes to `docs/design/grok-models.md` and `docs/design/grok-developer-image-entrypoint.md` per Decision 7. One atomic PR. | — |
| Issue [#355](https://github.com/mfrancza/agentic-development-workflow/issues/355) | Developer entrypoint: rewrite `run_xai()` in `docker/scripts/entrypoint.sh` per Decision 3 (`grok -p`, model flag, workspace-write sandbox if the pinned release exposes one, stdin input, system prompt prepended). Update the `xai)` preamble key-validation arm per Decision 4 — pick shape (a), (b), or (c) based on what the pinned CLI supports; document the choice and the `grok --help` output in the PR description. Add the `command -v grok` sanity check inside the `xai)` preamble arm. Update the `xai)` case-arm in `resolve_provider` and the wildcard arm's "supported values" error message to match the Terraform label set from Issue [#354](https://github.com/mfrancza/agentic-development-workflow/issues/354). Escalate to human per Decision 4 if none of shapes (a)/(b)/(c) is available. | Issue [#354](https://github.com/mfrancza/agentic-development-workflow/issues/354) (needs the CLI installed in the image and the Terraform label set to match) |
| Issue [#356](https://github.com/mfrancza/agentic-development-workflow/issues/356) | Reviewer entrypoint: apply the same set of changes as Issue [#355](https://github.com/mfrancza/agentic-development-workflow/issues/355) to `docker/reviewer/entrypoint.sh` — new `run_xai()` per Decision 3 (preserving the structural no-write guarantee: no `git-askpass.sh`, no push credentials, Contents:read token layer; workspace-write sandbox flag if the pinned CLI exposes one, otherwise defence-in-depth via the token layer alone). Update the `xai)` preamble key-validation arm to match the shape chosen in Issue [#355](https://github.com/mfrancza/agentic-development-workflow/issues/355). Update `resolve_provider` `xai)` case-arm and the wildcard arm's error message to match the Terraform label set from Issue [#354](https://github.com/mfrancza/agentic-development-workflow/issues/354). Add the `command -v grok` sanity check. | Issue [#354](https://github.com/mfrancza/agentic-development-workflow/issues/354) (same label-set coupling) |
| Issue [#357](https://github.com/mfrancza/agentic-development-workflow/issues/357) | End-to-end validation via `docker run`: build both images with the new install; then, using an `XAI_API_KEY` provisioned out of band and a reference xAI account: (1) developer container with `AGENT_MODEL=<a-grok-name>`, `XAI_API_KEY` unset — fails cleanly in the preamble with the "XAI_API_KEY is required" message before any clone; (2) same but with the key set — an existing action (e.g. `groom` on a fixture issue) completes end-to-end via the Grok Build CLI path; (3) `AGENT_MODEL=bogus` — the "Unknown model" message lists the updated Grok models alongside Claude and OpenAI models; (4) `AGENT_MODEL=sonnet` — routes to `run_anthropic` unchanged (regression check on the Anthropic path); (5) `AGENT_MODEL=<an-openai-name>` — routes to `run_openai` unchanged (regression check on the Codex path — verify Codex still authenticates via `codex login --with-api-key` and the `openai)` arm is untouched); (6) reviewer container with `AGENT_MODEL=<a-grok-name>` — a live PR gets a review from Grok Build CLI. Record each invocation + output in the PR description. Verify no `codex exec` call appears in the `xai)` code path (grep container log). | Issues [#354](https://github.com/mfrancza/agentic-development-workflow/issues/354), [#355](https://github.com/mfrancza/agentic-development-workflow/issues/355), [#356](https://github.com/mfrancza/agentic-development-workflow/issues/356) |

Issues [#355](https://github.com/mfrancza/agentic-development-workflow/issues/355) and [#356](https://github.com/mfrancza/agentic-development-workflow/issues/356) are independent of each other and can proceed in
parallel once Issue [#354](https://github.com/mfrancza/agentic-development-workflow/issues/354) lands. Issue [#357](https://github.com/mfrancza/agentic-development-workflow/issues/357) depends on all three so it can
exercise the full path.

Dependencies are recorded natively as GitHub blocked-by relationships
on the issues.
