# Model Guidance

This document is the **single source of truth for tier selection** in this repository.
Humans use it when labeling issues, and the grooming agent reads it alongside
[`label-criteria.json`](../agents/grooming/label-criteria.json) and its
[`groom prompt`](../docker/scripts/prompts/groom.md).

**Reviewed September 12, 2026.** The authoritative **provisioned model inventory** is
[`automation_labels` in Terraform](../terraform/modules/labels/main.tf), not the examples here.
Vendor availability is a separate question: a provisioned label does not guarantee that a
vendor still serves that model. The developer and reviewer `resolve_provider()` functions are
the runtime routing authorities; see [Provider Notes](#provider-notes).

## Tier Summary

The groomer selects only `model:haiku`, `model:sonnet`, or `model:opus`.
Named OpenAI, xAI, and Claude models are **operator overrides**, not additional grooming tiers.
The rationale for Anthropic-only grooming remains
[Decision 6 of the usage-guidance design](design/agent-usage-guidance.md).

### Anthropic tier aliases (grooming-agent picks)

| Tier alias | Series used for this pricing review | When to reach for it |
|---|---|---|
| `model:haiku` | Claude Haiku 4.5 | Clearly mechanical changes: typo, comment, single config value, or a small documentation correction with no research or design decisions. If uncertain, choose Sonnet. |
| `model:sonnet` | Claude Sonnet 5 | Non-trivial but well-specified implementation, scoped debugging, or a straightforward dependency upgrade. This remains the repository default. |
| `model:opus` | Claude Opus 5 | Deep reasoning, architectural design, cross-cutting refactors, new agent types, security-sensitive changes, ambiguous scope, or issues classified `plan`. Highest capability among the three grooming choices, not the entire vendor catalog. |

Aliases float with the Claude Code CLI; the repository passes them through rather than pinning
these series. A generic series label such as `model:claude-haiku-4-5` floats within that series;
only a dated snapshot such as `model:claude-haiku-4-5-20251001` pins a specific model version.
Check the vendor's availability before choosing an older snapshot from Terraform.

The [current Anthropic overview][anthropic-models] also describes models outside these grooming
tiers, including Fable 5.1. It now recommends starting with Opus 5 for most workloads.
**Sonnet is this repository's cost-conscious policy, not Anthropic's current default recommendation.**
Do not extend grooming to additional families just because the vendor offers them.

### OpenAI models (manual selection)

The repository's September refresh ([PR #547](https://github.com/mfrancza/agentic-development-workflow/pull/547))
provisions the GPT-5.6 family and GPT-6 Astra. The removed `model:gpt-5` and `model:o3` labels
are not active recommendations or accepted OpenAI routing choices here.
Use [OpenAI's current model guidance][openai-models] and task-specific evaluations when choosing:

- `model:gpt-5.6-luna`: a low-cost candidate for mechanical work and narrowly bounded checks.
- `model:gpt-5.6-terra`: a candidate for routine implementation and standard review.
- `model:gpt-5.6-sol`: a candidate for demanding coding and cross-component reasoning.
- `model:gpt-6-astra`: an escalation candidate for the hardest end-to-end implementation,
  architectural design, or review when a cheaper model fails your quality bar.

These are workload analogies, **not demonstrated equivalence** to Anthropic tiers.
Astra costs 2.5× Sol for the normalized token budget below; evaluate whether fewer retries or
better outcomes justify the premium rather than selecting it for every `plan` issue.

### xAI (Grok) models (manual selection)

The [September audit, PR #546](https://github.com/mfrancza/agentic-development-workflow/pull/546)
confirmed the repository's Grok Build CLI inventory. Refer to Terraform for the exact label set
and the [Dockerfiles](../docker/Dockerfile) ([reviewer](../docker/reviewer/Dockerfile)) for the CLI pin.
The CLI default and the vendor's recommended model are not necessarily the same.
[xAI currently recommends Grok 4.6 for coding and general text work][xai-models].

- `model:grok-build-0.1`: build-focused, bounded coding experiments at a low output rate.
- `model:grok-4.3` or `model:grok-4.20-0309-non-reasoning`: lower-cost routine implementation candidates.
- `model:grok-4.20-0309-reasoning`: a reasoning-enabled candidate for diagnosis and design.
- `model:grok-4.20-multi-agent-0309`: an operator experiment for decomposition-heavy work;
  selecting the model does not create additional repository agent identities or workflow jobs.
- `model:grok-4.5`: an alternative when its lower cached-input rate matters for a stable prefix.
- `model:grok-4.6`: the vendor-recommended starting point for an xAI coding evaluation,
  including complex work; its standard input/output rates equal Grok 4.5's.

## Cross-Vendor Cost Analysis

### Sources and assumptions

Rates were re-read from official sources on **September 12, 2026**:

- [Anthropic model pricing, caching, batch, and long-context billing][anthropic-pricing].
- [OpenAI API pricing (Standard and Batch)][openai-pricing], with model-specific conditions for
  [GPT-5.6 Sol][openai-sol] and [GPT-6 Astra][openai-astra].
- [xAI model prices][xai-models], [batch/priority pricing][xai-pricing], and
  [Batch API support and turnaround][xai-batch].

All rates below are **USD per one million tokens**, first-party API, standard service tier,
short-context requests. They are not subscription prices or guarantees of the CLI's actual bill.
The alias rows use the Claude series in the Tier Summary, not every older provisioned snapshot.
The table is a dated comparison, not a second model registry.

### Pricing reference and normalized task benchmark

The illustrative token budget is **20,000 uncached input tokens + 5,000 output tokens**:

`cost = (20,000 × input rate + 5,000 × output rate) / 1,000,000`

This is arithmetic, **not a measured average agent run or a performance benchmark**.
It excludes cache writes, tool/search charges, retries, and additional billed reasoning tokens.
Count all turns of an agent run, not just the initial prompt; tokenizers also differ across models.
The cached-input column is informational and is **not** used in the uncached cost calculation.

| Model label | Input $/1M | Cached input $/1M | Output $/1M | Cost per normalized task |
|---|---|---|---|---|
| `model:gpt-5.6-luna` | $0.20 | $0.02 | $1.20 | $0.0100 |
| `model:grok-build-0.1` | $1.00 | $0.20 | $2.00 | $0.0300 |
| `model:grok-4.3` | $1.25 | $0.20 | $2.50 | $0.0375 |
| `model:grok-4.20-0309-non-reasoning` | $1.25 | $0.20 | $2.50 | $0.0375 |
| `model:grok-4.20-0309-reasoning` | $1.25 | $0.20 | $2.50 | $0.0375 |
| `model:grok-4.20-multi-agent-0309` | $1.25 | $0.20 | $2.50 | $0.0375 |
| `model:haiku` | $1.00 | $0.10 | $5.00 | $0.0450 |
| `model:grok-4.5` | $2.00 | $0.30 | $6.00 | $0.0700 |
| `model:grok-4.6` | $2.00 | $0.50 | $6.00 | $0.0700 |
| `model:sonnet` | $2.00 | $0.20 | $10.00 | $0.0900 |
| `model:gpt-5.6-terra` | $2.00 | $0.20 | $12.00 | $0.1000 |
| `model:gpt-5.6-sol` | $4.00 | $0.40 | $20.00 | $0.1800 |
| `model:opus` | $5.00 | $0.50 | $25.00 | $0.2250 |
| `model:gpt-6-astra` | $10.00 | $1.00 | $50.00 | $0.4500 |

**Price conditions:** Sonnet 5's $2/$10 rate is now standard; Anthropic canceled the previously
announced September 1, 2026 increase. Sol's $4/$20 pricing is promotional, available at least
through **November 21, 2026**; re-check before budgeting beyond that date.
Haiku is **2× cheaper** than Sonnet at the listed input/output rates, not 5×.

**Long context:** xAI's listed models charge 2× input, cached input, and output at **≥200k prompt
tokens**, for the entire request. OpenAI's listed family uses 2× input/cache rates and 1.5×
output for prompts **>272k input tokens**. Claude Sonnet 5 and Opus 5 include their 1M context
at standard token rates; do not apply a blanket long-context multiplier across vendors or
assume every model has a 1M context window. Consult model-specific limits before a large run.

### Billing mechanisms and practical implications

| Mechanism | Anthropic grooming series | Provisioned OpenAI family | xAI |
|---|---|---|---|
| Prompt cache | Hits cost 0.1× base input; 5-minute writes cost **1.25×**, not 0.25×; 1-hour writes cost 2×. | Listed hits cost 0.1× base input (90% discount); listed writes cost 1.25×. | Use the model-specific cached column: Grok 4.5 is 85% below base input, Grok 4.6 is 75% below. |
| Batch API | 50% off input/output for eligible asynchronous requests. | Listed Batch rates are 50% of Standard. | Documented: 20% off for Grok 4.3 and the three provisioned Grok 4.20 variants; other models have no listed batch discount. Check acceptance per model. |
| Cache plus batch | Discounts stack; account for cache creation and expiry. | Use the explicit Batch cached/write rates, not an assumed discount. | Batch discounts apply to cached and reasoning tokens too, where the model is eligible. |

The entrypoints run interactive CLI tool loops, not Batch API jobs. Batch savings require a
separate asynchronous workload; this document does not enable caching or batching in workflows.
Repeated grooming prompts may be cache candidates, but minimum prefix length, cache lifetime,
cache-write charges, and actual hit rates determine savings. Do not assume the whole prompt hits.

For an illustrative **all-input-cache-hit** Haiku request with no cache creation cost, the same
token budget costs `$0.002 + $0.025 = $0.027`, not $0.025. Uncached Haiku Batch costs $0.0225;
Luna Batch costs $0.0050 for the same budget, so Haiku Batch is not the cheapest option here.
Grok 4.5 and 4.6 all-hit examples cost $0.036 and $0.040 respectively: useful for comparing
stable-prefix workloads, not proof that either has the lowest total cost per successful issue.

Choose by measured completion quality, total billed tokens, latency, and retry rate. Price alone
does not establish a best-value capability tier, and a vendor switch is an operator decision.

## Task-Class Matrix

The Anthropic column is the **grooming policy**, not an instruction to replace an existing label.
Cross-vendor entries are representative evaluation candidates, not exhaustive inventory or
benchmark-proven substitutes. Compare their token costs in the single pricing table above.
Task complexity matters more than file count: documentation research and a one-file security
change are not automatically mechanical work.

| Task class | Anthropic default | Operator alternatives to evaluate | Selection boundary |
|---|---|---|---|
| `do` — mechanical; typo, single value, small doc correction | `model:haiku` | `model:gpt-5.6-luna`, `model:grok-build-0.1` | No research, ambiguity, or design decisions; otherwise use Sonnet. |
| `bug` — scoped diagnosis and fix | `model:sonnet` | `model:gpt-5.6-terra`, `model:grok-4.3` | A small diff alone does not make diagnosis trivial. |
| `enhancement` / `do` — typical scoped implementation | `model:sonnet` | `model:gpt-5.6-terra`, `model:grok-4.6`, `model:grok-4.20-0309-non-reasoning` | Clear requirements and a bounded implementation path. |
| `dependency upgrade` | `model:sonnet` | `model:gpt-5.6-terra`, `model:grok-4.5` | Escalate breaking migrations with architectural trade-offs to Opus. |
| Documentation audit, pricing research, bounded validation without `plan` | `model:sonnet` | `model:gpt-5.6-terra`, `model:grok-4.6` | Research is non-mechanical even if only Markdown changes; ambiguous scope needs Opus. |
| `plan` — design, architecture, or validation planning | `model:opus` | `model:gpt-5.6-sol`, `model:grok-4.20-0309-reasoning` | Matches the criteria's `plan` rule; a human may deliberately choose a cheaper model for a procedural plan. |
| Cross-cutting refactor or under-specified bug / enhancement | `model:opus` | `model:gpt-5.6-sol`, `model:grok-4.6` | Multiple interacting components or unresolved trade-offs. |
| New agent type or decomposition-heavy design | `model:opus` | `model:gpt-5.6-sol`, `model:grok-4.20-multi-agent-0309` | Model selection does not change workflow topology or permissions. |
| Hardest long-horizon implementation or system design | `model:opus` | `model:gpt-6-astra`, `model:gpt-5.6-sol`, `model:grok-4.6` | Evaluate Astra as a premium escalation, not an automatic default. |
| Code review — targeted mechanical check | `model:haiku` | `model:gpt-5.6-luna`, `model:grok-build-0.1` | Small, isolated change with no security or cross-component implications. |
| Code review — standard multi-file PR | `model:sonnet` | `model:gpt-5.6-terra`, `model:grok-4.6` | Correctness, tests, and repository conventions. |
| Code review — architectural / security-sensitive | `model:opus` | `model:gpt-5.6-sol`, `model:gpt-6-astra`, `model:grok-4.6` | Human review remains necessary where required; model capability is not authorization. |
| Design — bounded feature specification without `plan` | `model:sonnet` | `model:gpt-5.6-terra`, `model:grok-4.6` | If classified `plan`, use the `plan` row instead. |

## Evidence

[Anthropic's current overview][anthropic-models], [OpenAI's model guidance][openai-models],
and [xAI's model guidance][xai-models] support the workload descriptions, not a universal
cross-vendor ranking. This repository has no controlled evaluation demonstrating that the
September models are interchangeable at a given tier.

The previous SWE-bench Verified and MMLU-Pro discussion did not identify model versions,
scores, or comparable agent harnesses. It is not evidence that every Opus beats every Sonnet
or that the quality gap disappears on single-file changes. Use task-representative evaluations
with fixed prompts, tool budgets, and success criteria before changing defaults.

### Repository history (descriptive, not a success benchmark)

Reproduce a rolling sample with:

```bash
gh issue list --repo mfrancza/agentic-development-workflow \
  --state closed --limit 50 --json number,title,labels,closedAt
```

On **September 12, 2026**, the 50 returned closed issues included 7 carrying `model:sonnet`,
6 carrying `model:opus`, 1 carrying `model:haiku`, 1 carrying `model:gpt-5.6-sol`, and 35 with
no model label. Examples include scoped work on #492 (Sonnet), an adoption-doc correction
on #496 (Haiku), and the vendor-refresh issue #448 (Opus).
These are issue-label observations, not verified execution models or clean-merge outcomes.
Labels can change, closed issues need not have merged PRs, and per-agent overrides can change
which model actually runs. The earlier August sample is historical, not a current evaluation.

## Decision Heuristics

- **Preserve intentional choices.** If any generic label matching `^model:[^:]+$` exists,
  the groomer must not add, remove, or replace it. This includes named vendor models and snapshots.
- **Per-agent overrides may coexist.** A label such as `model:review:opus` alone does not block
  selection of one generic tier alias. Preserve all existing per-agent labels too.
- **When selecting, emit exactly one generic alias:** mechanical → Haiku; scoped, non-trivial
  work → Sonnet; design-heavy, cross-cutting, security-sensitive, ambiguous, or `plan` → Opus.
- **When unsure, prefer Sonnet over Haiku.** Documentation-only is not synonymous with trivial.
- **Manual exceptions are not grooming rules.** A human may override a bounded procedural plan
  to Sonnet; the groomer preserves it rather than creating an exception to the criteria.

## Provider Notes

The tier-alias vocabulary is Anthropic-specific; the operator guidance spans all three providers.
Read `resolve_provider()` in the [developer entrypoint](../docker/scripts/entrypoint.sh) and
[reviewer entrypoint](../docker/reviewer/entrypoint.sh) for accepted model names and key validation.
Anthropic names route to Claude Code, OpenAI names to Codex, and xAI names to Grok Build CLI.
The repository accepts the `claude-*` namespace but uses explicit allowlists for OpenAI and xAI;
routing acceptance is not proof of vendor availability or account access.

Terraform still contains legacy Claude series/snapshot labels that current Anthropic docs mark
retired on the first-party API. They are not recommendations here. Consult the
[vendor deprecation page][anthropic-deprecations] before using a historical label; refreshing that
inventory and checking affected open issues belongs to the vendor-refresh work, not this pricing review.
Models present only in a vendor catalog are not automatically provisioned in this repository.

## Repo Defaults

The configured fallback remains `sonnet` in
[`terraform/variables.tf`](../terraform/variables.tf), exported by the
[`agent-vars` module](../terraform/modules/agent-vars/main.tf).
It is a fallback, not evidence that every workflow always runs Sonnet, and operators can change it.

For exact label sources and fallback wiring, read the
[caller and reusable workflows](../.github/workflows/) and
[`resolve-model` activity](../.github/scripts/src/resolve-model.ts).
Where enabled, resolution checks the relevant per-agent label first, then a generic label,
then the configured default; duplicates fail at the tier being evaluated.
Issue-driven runs read issue labels; review reads **PR labels**. The two feedback workflows
resolve developer labels from the linked issue, falling back when none is linked.
Conflict resolution passes the configured default directly rather than resolving model labels.

For intentional Astra implementation plus Opus review, keep `model:gpt-6-astra` and
`model:review:opus` on the issue (and any design sub-issues), and put `model:review:opus`
on the PR too: an issue's review override alone is not read by the reviewer workflow.

[anthropic-models]: https://platform.claude.com/docs/en/models/overview
[anthropic-pricing]: https://platform.claude.com/docs/en/about-claude/pricing
[anthropic-deprecations]: https://platform.claude.com/docs/en/about-claude/model-deprecations
[openai-models]: https://developers.openai.com/api/docs/guides/latest-model
[openai-pricing]: https://developers.openai.com/api/docs/pricing
[openai-sol]: https://developers.openai.com/api/docs/models/gpt-5.6-sol
[openai-astra]: https://developers.openai.com/api/docs/models/gpt-6-astra
[xai-models]: https://docs.x.ai/developers/models
[xai-pricing]: https://docs.x.ai/developers/pricing
[xai-batch]: https://docs.x.ai/developers/advanced-api-usage/batch-api

---

## Change Log

Entries below record changes at their original dates; historical model lists and prices are not
current selection guidance.

- **2026-09-12 (rev 8)** — End-to-end review for Issue #564 against Terraform and official
  vendor sources. Consolidated pricing and recomputed normalized costs; corrected cache-write,
  batch, long-context, and promotional-price assumptions. Added research and premium-escalation
  task boundaries, distinguished vendor advice from repository policy, and replaced unsupported
  benchmark/outcome claims with a dated descriptive sample. Aligned grooming preservation rules
  with generic/per-agent labels and kept `plan` → Opus consistent with the criteria.

- **2026-09-12 (rev 7)** — xAI Grok model audit (Issue #460): confirmed `grok models` at Grok
  Build CLI v1.0.13 is unchanged from the rev 6 refresh — 7 text/coding models
  (`grok-4.20-0309-non-reasoning`, `grok-4.20-0309-reasoning`, `grok-4.20-multi-agent-0309`,
  `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-0.1`) with no additions or retirements.
  No discrepancy between the Grok Build CLI v1.0.13 model list and the vendor docs at
  [docs.x.ai/docs/models](https://docs.x.ai/docs/models). No label changes to
  `terraform/modules/labels/main.tf` or entrypoint arms (already in sync). Added grok-4.5
  cached input pricing ($0.30/1M; 85% discount vs $2.00/1M standard input) to Tier Summary,
  pricing reference, billing-plan table, practical guidance, and cross-vendor notes, per vendor
  docs update confirmed at implementation time. Retired-label sweep: no labels retired; sweep
  is a no-op (0 open issues carry any of the 7 Grok labels).
  Addresses [Issue #460](https://github.com/mfrancza/agentic-development-workflow/issues/460).

- **2026-08-30 (rev 6)** — Updated xAI label set: replaced retired `model:grok-3` /
  `model:grok-3-mini` / `model:grok-code-fast-1` labels (which routed to grok-4.3) with the
  current Grok Build CLI v1.0.13 model list (`model:grok-4.3` through `model:grok-build-0.1`).
  Removed stale grok-4.3-effective cost rows from the normalized benchmark and task-class matrix.
  Addresses [Issue #356](https://github.com/mfrancza/agentic-development-workflow/issues/356)
  (reviewer entrypoint Grok Build CLI migration; same label refresh as Issue #354/#355 deferred to
  this PR by [PR #365](https://github.com/mfrancza/agentic-development-workflow/pull/365)).

- **2026-08-30 (rev 5)** — Added *Repo Defaults* section auditing the repo-wide `DEFAULT_MODEL = "sonnet"` setting and all eight `agent-*.yml` per-workflow defaults against the guidance. All confirmed aligned; no follow-up issues opened. Added cross-links to this document from the `model:<name>` entry in `AGENTS.md` and from the `model:<name>` bullet in `README.md`. Addresses [issue #337](https://github.com/mfrancza/agentic-development-workflow/issues/337).

- **2026-08-30 (rev 4)** — Added `code review` and `design` task classes to the Task-Class Matrix.
  Code review rows cover three sub-flavors (targeted/haiku, standard/sonnet,
  architectural-security-sensitive/opus); design rows cover scoped feature design (sonnet) and
  system/architectural design (opus). Addresses
  [PR #350](https://github.com/mfrancza/agentic-development-workflow/pull/350) reviewer feedback.

- **2026-08-30 (rev 3)** — Expanded Task-Class Matrix to include all vendors. Each row now shows
  the Anthropic grooming default with its cost/task figure and cross-vendor alternatives (OpenAI
  and xAI labels, cheapest-first within the same capability tier). Added introductory key
  explaining the benchmark and the † notation for variable o3 costs. Addresses
  [PR #350](https://github.com/mfrancza/agentic-development-workflow/pull/350) reviewer feedback.

- **2026-08-30 (rev 2)** — Expanded Tier Summary to cover all provisioned providers: added OpenAI
  (`gpt-5.6-luna/terra/sol`, `gpt-5`, `o3`) and xAI (`grok-3`, `grok-3-mini`, `grok-code-fast-1`,
  noting retirement and grok-4.3 redirect). Updated Anthropic series floors to current
  (haiku-4-5 / sonnet-5 / opus-5). Added Cross-Vendor Cost Analysis section with per-token
  pricing reference, normalized standard-task benchmark ($0.010–$0.450/task range), billing-plan
  and discount summary (prompt cache, batch API), and cross-vendor capability-tier comparison
  table. Addresses [PR #350](https://github.com/mfrancza/agentic-development-workflow/pull/350)
  reviewer feedback.

- **2026-08-30** — Initial version. Tier summary, task-class matrix, evidence (Anthropic model
  docs, SWE-Bench Verified, MMLU-Pro, bounded ~50-issue repo history), decision heuristics,
  and provider notes written per
  [issue #334](https://github.com/mfrancza/agentic-development-workflow/issues/334) and the
  design in [`docs/design/agent-usage-guidance.md`](design/agent-usage-guidance.md) decisions 1–3.
