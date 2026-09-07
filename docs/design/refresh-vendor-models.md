# Design: Refresh currently available models for all vendors

**Issue:** [#448](https://github.com/mfrancza/agentic-development-workflow/issues/448)

**Parent designs (already-settled decisions this doc references rather than re-argues):**

- [`multi-provider-models.md`](multi-provider-models.md) — one-to-one Terraform-label ↔ entrypoint-allowlist rule; explicit allowlists for OpenAI and xAI.
- [`anthropic-model-labels.md`](anthropic-model-labels.md) — three-tier Anthropic label taxonomy (tier aliases, generic series tags, pinned snapshots); pattern-based `claude-*` provider routing so ad-hoc pinned labels also route at runtime.
- [`grok-build-cli.md`](grok-build-cli.md) — xAI Grok label set is sourced from `grok models` at the pinned Grok Build CLI version.
- [`split-model-labels-by-agent-type.md`](split-model-labels-by-agent-type.md) — per-agent `model:<agent-type>:<name>` label taxonomy is pre-provisioned for the four agent types (`developer`, `groom`, `design`, `review`).
- [`agent-usage-guidance.md`](agent-usage-guidance.md) — grooming agent picks only from the three Anthropic tier aliases (never a generic series tag or a pinned snapshot).

## Requirements as understood

Issue #448 asks for a periodic audit and refresh of the model sets provisioned across all three providers (Anthropic, OpenAI, xAI), retiring discontinued models and adding new ones, while preserving `DEFAULT_MODEL="sonnet"` and the floating tier-alias behavior. The refresh is bounded by the parent designs above — this issue does not re-open any of them; it applies their existing structure to today's vendor lineups.

Places that must stay in one-to-one sync (per the multi-provider and per-agent-label designs):

- [`terraform/modules/labels/main.tf`](../../terraform/modules/labels/main.tf) — the `model:*` label set (Anthropic tier aliases + generic series tags + pinned snapshots; OpenAI flat allowlist; xAI Grok flat allowlist; per-agent `model:<agent>:*` variants where applicable).
- [`docker/scripts/entrypoint.sh`](../../docker/scripts/entrypoint.sh) — `resolve_provider()` case-arms for the developer image (Anthropic covered by the pattern `sonnet|opus|haiku|claude-*`; OpenAI and xAI enumerated explicitly).
- [`docker/reviewer/entrypoint.sh`](../../docker/reviewer/entrypoint.sh) — same `resolve_provider()` shape in the reviewer image; the two are kept diff-visibly identical (see Issue [#384](https://github.com/mfrancza/agentic-development-workflow/issues/384) for the drift failure mode).
- [`docs/model-guidance.md`](../model-guidance.md) — tier summary, cross-vendor cost analysis, and task-class matrix rows must reflect the refreshed lineup and pricing.
- [`agents/grooming/label-criteria.json`](../../agents/grooming/label-criteria.json) — refreshed only if the groomer's tier-selection semantics change (e.g. if Anthropic introduces a fourth tier the grooming agent must pick from). Purely refreshing which snapshot each alias resolves to does not touch this file.

Retired-label safety is part of the refresh, not a follow-up: for every label the refresh removes, open issues carrying that label must have it removed first (before `terraform apply` destroys it). The precedent is the grok-3 retirement (see Issue [#356](https://github.com/mfrancza/agentic-development-workflow/issues/356), the 2026-08-30 rev 6 change log entry in [`docs/model-guidance.md`](../model-guidance.md)).

### Ambiguities and how they were resolved

- **How much of the current lineup should be verified against live vendor docs?** The issue is explicit that vendor availability is checked at implementation time, not assumed from the issue. Each provider task therefore starts with a fresh vendor-doc read (see Decision 2) and produces the label deltas in that same PR. The design does not encode a target model list.
- **One atomic refresh PR or one PR per provider?** Split per provider (see Decision 3). Same-file conflicts across the three provider PRs are section-scoped (each provider owns disjoint blocks in Terraform, disjoint case-arms in the entrypoints, and disjoint doc sections) and reviewer-friendly.
- **Does `agents/grooming/label-criteria.json` need updating?** Only if the refresh changes tier semantics — e.g. if Anthropic adds a fourth tier the groomer should choose from. A snapshot-only rev (haiku-4-5 → haiku-4-6) does not touch it. This is a conditional bit of the Anthropic task, not a separate one.
- **Is a `model:fable` label added if Anthropic's Fable series ships a new snapshot?** No — the current guidance ([`docs/model-guidance.md`](../model-guidance.md) Tier Summary "Note on Fable") explicitly does not provision Fable "because no use case has been identified that Opus does not already cover." This design does not revisit that decision; if a use case emerges the implementer files a follow-up issue.
- **Should retired labels be kept in Terraform in a "deprecated" state for backwards compatibility?** No — the parent designs treat the Terraform label set as authoritative, and unlabelled runtime routing already accepts any `claude-*` name for Anthropic. For OpenAI and xAI, retired labels fail loudly on unknown-model at runtime (which is the intended signal), and the retired-label sweep ensures no open issue is stranded by the removal.

## Decisions

### Decision 1 — Refresh policy is per-provider, driven by live vendor docs at implementation time

For each provider, the implementing sub-issue's first step is to read the vendor's current model documentation and produce a proposed delta (add / remove / keep) against the current Terraform label set. The delta is captured in the sub-issue's PR description so a human reviewer can sanity-check "this list looks right for August 2026" without having to independently read the vendor page.

- **Anthropic** — [`https://docs.anthropic.com/en/docs/about-claude/models/overview`](https://docs.anthropic.com/en/docs/about-claude/models/overview). Tier aliases (`sonnet`/`opus`/`haiku`) are preserved unconditionally (parent design's decision 1 in [`anthropic-model-labels.md`](anthropic-model-labels.md)); generic series tags and pinned snapshots are refreshed to the current lineup, dropping series that are no longer available on the API. `resolve_provider`'s `sonnet|opus|haiku|claude-*` pattern arm does not change — new Anthropic snapshots route through the same wildcard by construction (this is the payoff of parent [`anthropic-model-labels.md`](anthropic-model-labels.md) decision 2).
- **OpenAI** — [`https://platform.openai.com/docs/models`](https://platform.openai.com/docs/models). Flat allowlist refreshed against the current lineup; both entrypoints' `openai)` case-arm and the wildcard "supported values" error message are updated in the same PR to match Terraform.
- **xAI (Grok)** — [`https://docs.x.ai/docs/models`](https://docs.x.ai/docs/models) **plus** `grok models` invoked against the pinned Grok Build CLI version currently in both Dockerfiles ([`docker/Dockerfile`](../../docker/Dockerfile) / [`docker/reviewer/Dockerfile`](../../docker/reviewer/Dockerfile) — read at implementation time). The CLI-listed set is the operative one, because the entrypoints invoke models through that CLI. If the CLI list and the vendor docs disagree, the CLI list wins for the label set, and the discrepancy is called out in the PR description.

**Alternatives considered.**

- **(a) Encode target model lists in this design doc.** Rejected — the issue explicitly requires implementation-time verification. Any list this doc contained would be stale by the time it landed and would license the implementer to skip the live check.
- **(b) Automate the audit via a scheduled workflow that scrapes vendor docs.** Rejected as out of scope. Vendor doc pages are unstructured HTML; a maintainable scraper is more surface area than a periodic manual refresh justifies, especially given how rarely the refresh runs (this is the second one — grok-3 retirement was the first). Revisit only if the refresh cadence increases.
- **(c) Add a lint job that fails CI if `resolve_provider` and the Terraform label set disagree.** Deferred to a follow-up (mentioned in Out of scope). It is not strictly needed for the refresh itself, and Issue [#384](https://github.com/mfrancza/agentic-development-workflow/issues/384) is the tracking ticket for that drift-detection idea.

### Decision 2 — Retired-label sweep is a mandatory prerequisite of each provider PR

For every label the refresh removes, the sweep runs *before* the Terraform destroy applies. Precedent: grok-3 retirement, Issue [#356](https://github.com/mfrancza/agentic-development-workflow/issues/356), PR [#365](https://github.com/mfrancza/agentic-development-workflow/pull/365).

Concretely, each provider task's PR description records the sweep result: for each label that would be destroyed by `terraform apply`, list any open issues still carrying it, then either remove the label from those issues (documenting the replacement chosen) or explain why removal is safe. The command in the issue-scope grooming notes is the canonical form:

```bash
gh issue list --repo mfrancza/agentic-development-workflow --state open \
  --label "model:<retired-label>" --json number,title
```

**Why in-PR rather than in a separate task.** The sweep window has to close before `terraform apply` runs. Splitting it into a preceding task creates a race: an open issue can be re-labeled between the sweep task landing and the destroy task landing. Executing the sweep in the same PR that removes the label — and re-running it as the last check before merge — closes that window.

**PRs (both agent and human) count.** A retired label on an open PR gets the same treatment. Grok pattern also applies: closed issues/PRs are not swept (GitHub prevents label mutations on closed items in the ways that would matter, and stale historical labels on closed issues are harmless).

### Decision 3 — Split the refresh into one PR per provider (parallel-safe)

Three implementation tasks — Anthropic, OpenAI, xAI — plus one end-to-end validation task that depends on all three. Each provider task is one atomic PR touching the same set of files (Terraform, both entrypoints, `docs/model-guidance.md`), but in **disjoint sections** of each file:

| File | Anthropic PR touches | OpenAI PR touches | xAI PR touches |
|---|---|---|---|
| `terraform/modules/labels/main.tf` | Anthropic tier-alias/generic/pinned blocks (roughly lines 73–178 of today's file) | `model:gpt-*` / `model:o*` blocks (roughly lines 180–199) | `model:grok-*` blocks (roughly lines 201–233) |
| `docker/scripts/entrypoint.sh` | Nothing structural — pattern arm covers new snapshots (verify wildcard error string is still accurate) | `openai)` case-arm + wildcard error string | `xai)` case-arm + wildcard error string |
| `docker/reviewer/entrypoint.sh` | Same as developer entrypoint (mirror) | Same as developer entrypoint (mirror) | Same as developer entrypoint (mirror) |
| `docs/model-guidance.md` | Anthropic Tier Summary + pricing rows + task-class matrix Anthropic-default column | OpenAI Tier Summary + pricing rows + task-class matrix cross-vendor-alternatives OpenAI entries | xAI Tier Summary + pricing rows + task-class matrix cross-vendor-alternatives Grok entries |
| `agents/grooming/label-criteria.json` | Only if Anthropic ships a new grooming-selectable tier (Fable stays out per current guidance); typically untouched | Untouched (groomer never picks OpenAI) | Untouched (groomer never picks xAI) |

The three PRs can proceed in parallel. Conflicts, if any, are section-scoped and mechanical to resolve. The e2e validation task explicitly waits for all three so it can exercise the full refreshed lineup.

**Alternatives considered.**

- **(a) One atomic PR for all three providers.** Rejected: bigger diff, harder review, and the vendor-doc-verification steps for the three providers are independent so bundling them buys nothing.
- **(b) Serialize the three (each provider blocks the next).** Rejected: no dependency between the provider deltas; serializing just slows the refresh.
- **(c) Extract the vendor-doc audit into a preceding "propose deltas" task that all three implementation tasks depend on.** Rejected as ceremony — the audit and the apply are naturally one PR per provider. A separate audit task would just produce an issue comment that the implementation task re-reads.

### Decision 4 — `agents/grooming/label-criteria.json` is untouched by a snapshot-only refresh

The groomer's tier-selection rules are documented against the tier aliases (`model:haiku` / `model:sonnet` / `model:opus`), not against specific snapshots. Refreshing which snapshot each alias resolves to does not change any groomer decision, so the criteria file is not touched by this refresh unless one of the providers ships a genuinely new tier the groomer should pick from.

The current guidance already excludes Fable from grooming picks ([`docs/model-guidance.md`](../model-guidance.md) Tier Summary "Note on Fable"). If Fable's cost-benefit shifts, that is its own design; this design does not open it.

**Alternatives considered.**

- **(a) Refresh the criteria file every time regardless.** Rejected — churn without effect; violates the merge-friendly documentation guidance (one fact per line, do not reflow neighboring lines).
- **(b) Expand the criteria to cover OpenAI and xAI tiers.** Rejected: parent design [`agent-usage-guidance.md`](agent-usage-guidance.md) decision 6 explicitly keeps grooming Anthropic-only. Cross-vendor picks are operator-driven overrides.

### Decision 5 — Per-agent `model:<agent-type>:*` labels stay on the three tier aliases

The per-agent label taxonomy pre-provisions `model:<agent-type>:{haiku,sonnet,opus}` for the four agent types (`developer`, `groom`, `design`, `review`) — a total of twelve labels. This design does not add per-agent variants for generic series tags, pinned snapshots, OpenAI models, or Grok models.

Rationale: the parent [`split-model-labels-by-agent-type.md`](split-model-labels-by-agent-type.md) design deliberately bounded the per-agent surface to the three tier aliases so the Terraform label picker stays curated (12 labels rather than 12 × N provider models). Extending it is a separate design if a use case emerges (e.g. per-agent pinning for reproducible-run experiments). Ad-hoc per-agent labels are not supported by the runtime — unlike Anthropic snapshot IDs, per-agent labels must be pre-provisioned to affect resolution.

### Decision 6 — Single consolidated Change Log entry, written by the validation task

The refresh produces one Change Log entry in `docs/model-guidance.md`, added by the validation task (#461) rather than by any of the three provider tasks. The entry covers the Anthropic, OpenAI, and xAI deltas together and mirrors the 2026-08-30 rev 6 pattern (which was itself a single entry for a whole-provider refresh).

Rationale: the three provider PRs run in parallel, so no single provider PR has visibility into the other two providers' final label deltas. The validation task naturally runs after all three merge (its dependency edge already exists per the table above) and has that full visibility. Consolidating also guarantees a complete revision entry — under a per-provider-PR alternative, whichever provider PR happens to miss its Change Log line would leave that provider's changes unrecorded.

**Alternatives considered.**

- **(a) Each provider PR adds its own sub-entry.** Rejected: three parallel PRs prepending Change Log entries to the same list are a mechanical merge-conflict source, and if any one PR omits its entry the revision history is silently incomplete. Adds coordination cost without a corresponding benefit.
- **(b) The xAI PR alone owns the entry (as this doc originally proposed).** Rejected: xAI-first-among-equals is arbitrary, xAI has no visibility into the other two providers' final deltas when its PR opens (they may merge before or after), and if the xAI task lands first its entry cannot describe deltas that do not yet exist.
- **(c) No Change Log entry at all (rely on git history / PR descriptions).** Rejected: the rev 6 precedent establishes a Change Log entry as the operative record of a refresh, and future readers should not have to reconstruct three PRs' worth of deltas from git history.

## Out of scope

- **New model providers** (Gemini, Bedrock, on-prem, …). Adding a fourth provider is a new-runner-function design, not a model refresh.
- **Introducing a `model:fable` label** (or any other Anthropic tier the groomer would pick). Current guidance excludes it; revisiting is a separate design.
- **Automating the vendor-doc audit** (scheduled scraper, GitHub App that watches vendor changelogs, etc.). Deferred; this refresh is manual and periodic.
- **Terraform ↔ entrypoint drift lint.** Deferred to Issue [#384](https://github.com/mfrancza/agentic-development-workflow/issues/384). The e2e validation task in this refresh covers correctness *for this refresh*; a standing lint is a separate design.
- **Extending per-agent `model:<agent-type>:*` labels beyond tier aliases.** Parent design decision; not revisited here.
- **`DEFAULT_MODEL` change.** Preserved at `"sonnet"` per issue notes. Revisiting the default is a separate design.
- **Bumping the pinned Grok Build CLI version** in either Dockerfile. The xAI refresh may reveal a new CLI version publishes a new model set — bumping the CLI is a separate design (its own reproducibility, sandbox, and flag-surface implications).
- **Prompt tuning per new model.** Prompts stay shared per the parent multi-provider design's out-of-scope list.
- **Cost tracking / routing policies.** Same as above.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|---|---|---|
| Issue [#458](https://github.com/mfrancza/agentic-development-workflow/issues/458) | Anthropic model refresh: audit against [docs.anthropic.com](https://docs.anthropic.com/en/docs/about-claude/models/overview) at implementation time; update the Anthropic block of `terraform/modules/labels/main.tf` (tier aliases preserved; generic series tags and pinned snapshots refreshed against the current lineup); verify both entrypoints' `sonnet\|opus\|haiku\|claude-*` pattern arm still covers everything and refresh the wildcard "supported values" error message if the enumeration changes; refresh the Anthropic Tier Summary, pricing rows, and task-class matrix Anthropic-default cells in `docs/model-guidance.md`; run the retired-label sweep per Decision 2 for any label the PR destroys, and record the results in the PR description; touch `agents/grooming/label-criteria.json` only if a new grooming-selectable tier appears (typically untouched — see Decision 4). One atomic PR. | — |
| Issue [#459](https://github.com/mfrancza/agentic-development-workflow/issues/459) | OpenAI model refresh: audit against [platform.openai.com](https://platform.openai.com/docs/models) at implementation time; update the OpenAI block of `terraform/modules/labels/main.tf` (flat allowlist refreshed against the current lineup, retiring discontinued models); update both entrypoints' `openai)` case-arm and the wildcard "supported values" error message to match Terraform exactly (per parent design one-to-one rule; see Issue [#384](https://github.com/mfrancza/agentic-development-workflow/issues/384) for the drift failure mode); refresh the OpenAI Tier Summary, pricing rows, and task-class matrix OpenAI-alternative cells in `docs/model-guidance.md`; run the retired-label sweep per Decision 2 for any label the PR destroys, and record the results in the PR description. One atomic PR. | — |
| Issue [#460](https://github.com/mfrancza/agentic-development-workflow/issues/460) | xAI Grok model refresh: audit against [docs.x.ai/docs/models](https://docs.x.ai/docs/models) **plus** `grok models` invoked against the pinned Grok Build CLI version currently in both Dockerfiles at implementation time (the CLI-listed set is the operative one — see Decision 1); update the xAI block of `terraform/modules/labels/main.tf`; update both entrypoints' `xai)` case-arm and the wildcard "supported values" error message to match Terraform exactly; refresh the xAI Tier Summary, pricing rows, and task-class matrix Grok-alternative cells in `docs/model-guidance.md`; run the retired-label sweep per Decision 2 for any label the PR destroys, and record the results in the PR description. One atomic PR. Do **not** bump the pinned Grok Build CLI version (out of scope). The consolidated Change Log entry for this refresh is added by the validation task (#461) rather than here, so all three providers' deltas land in a single revision entry (see Decision 6). | — |
| Issue [#461](https://github.com/mfrancza/agentic-development-workflow/issues/461) | End-to-end validation of the refreshed lineup: (1) `terraform plan` against the merged state shows exactly the intended label deltas and no other churn; (2) both images build and boot successfully with a representative sample of the refreshed labels (one new Anthropic label — tier alias, generic series tag, and pinned snapshot; one new OpenAI label; one new Grok label); (3) an `AGENT_MODEL=bogus` run in each image produces a "supported values" error that enumerates the current lineup from all three providers; (4) `DEFAULT_MODEL="sonnet"` still resolves to a running Anthropic call; (5) verify no open issues still carry a destroyed label (the sweep from each provider task closed cleanly and did not regress between merges); (6) confirm `agents/grooming/label-criteria.json` still lists exactly the three tier aliases (unless a task in this refresh explicitly changed it per Decision 4); (7) add a single consolidated Change Log entry to `docs/model-guidance.md` covering the Anthropic, OpenAI, and xAI deltas from tasks #458/#459/#460, mirroring the 2026-08-30 rev 6 pattern (per Decision 6). Record all validation steps and their output in the PR description. | Issues #458, #459, #460 |

Tasks #458, #459, and #460 can proceed in parallel — they touch disjoint sections of the same files (see Decision 3 table). The implementer is responsible for rebasing onto `main` before opening each PR. Task #461 depends on all three so it can exercise the full refreshed lineup end-to-end.

Dependencies are recorded natively as GitHub blocked-by relationships on the issues.
