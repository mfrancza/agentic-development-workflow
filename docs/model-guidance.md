# Model Guidance

This document is the **single source of truth** for tier selection in this repository. Humans apply
it when labeling issues manually or reviewing a labeled issue. The grooming agent reads it at run
time when selecting a `model:*` label. All other documents that discuss model tiers link back here
rather than duplicating the guidance.

---

## Tier Summary

The `model:*` labels in this repo span three providers: **Anthropic**, **OpenAI**, and **xAI
(Grok)**. The grooming agent applies only Anthropic tier aliases (see Decision 6 in
`docs/design/agent-usage-guidance.md`); OpenAI and xAI labels are applied manually or by
operator override at the issue level.

### Anthropic tier aliases (grooming-agent picks)

The three Anthropic tier aliases resolve to the latest snapshot of their respective series at run
time. The table below documents the current stable series floor for each alias and the intended
use cases. Pricing is per 1 million tokens; see the Cross-Vendor Cost Analysis section for the
full billing context.

| Tier alias | Series floor | When to reach for it | Latency / cost (per 1M tokens) | Repo-standard default? |
|---|---|---|---|---|
| `model:haiku` | claude-haiku-4-5 series | Trivial, mechanical changes where the implementation path is unambiguous and no design decisions are required. Examples: a single typo fix, updating one config value, adding or correcting a brief doc note, a one-line code change. | Fastest; $1.00 input / $5.00 output — roughly 5× cheaper than Sonnet on input; suitable for high-volume or latency-sensitive work | No |
| `model:sonnet` | claude-sonnet-5 series | Non-trivial but well-scoped work: implementing a well-specified feature, a straightforward bug fix, a dependency upgrade with obvious next steps, or any `do`-labeled issue that requires more than mechanical effort but does not call for architectural reasoning. | Balanced latency; $2.00 input / $10.00 output; the right pick for the large middle band of typical implementation tasks | **Yes — repo default** |
| `model:opus` | claude-opus-5 series | Complex, design-heavy, or under-specified work requiring deep reasoning, cross-cutting analysis, or careful trade-off evaluation. Examples: high-level design for new features, non-trivial refactors that span multiple components, new agent types, security-sensitive changes, or any issue where the agent must reason about scope before it can begin implementing. | Highest Anthropic capability; $5.00 input / $25.00 output; use when reasoning quality matters more than speed or cost | No |

**Note on Fable.** A fourth Anthropic tier (`claude-fable-5` series, $10.00/$50.00 per 1M) exists
as of 2026; no `model:fable` label is provisioned because no use case has been identified that
Opus does not already cover. Revisit if Opus-class throughput becomes a bottleneck.

**Resolution.** An unqualified tier alias (`model:sonnet`, `model:opus`, `model:haiku`) resolves
to the latest snapshot of its series at the time the workflow runs. For pinned-reproducibility
needs, use a generic series tag (`model:claude-sonnet-4-5`) or a snapshot ID
(`model:claude-sonnet-4-5-20250929`). The grooming agent always emits tier aliases — never pinned
IDs — so that the running model advances with the series without requiring label maintenance.

### OpenAI models (manual selection only)

OpenAI models are available for issue-by-issue override via `model:*` labels but are not selected
by the grooming agent. The GPT-5.6 line (launched July 2026) has three distinct tiers with
materially different price points; treat them as separate sub-tiers when picking a label. The `o3`
model is a reasoning-specialized model whose effective cost depends heavily on how many internal
reasoning tokens the task triggers.

| Model label | When to reach for it | Latency / cost (per 1M tokens) | Analogous Anthropic tier |
|---|---|---|---|
| `model:gpt-5.6-luna` | Fast, cost-sensitive tasks; mechanical or exploratory work where low cost is the primary requirement | Fastest GPT-5.6 variant; $0.20 input / $1.20 output — cheapest label in the repo across all providers | ≈ `model:haiku` |
| `model:gpt-5` | General-purpose OpenAI tasks comparable in scope to a typical sonnet-class issue | $1.25 input / $10.00 output | ≈ `model:sonnet` |
| `model:gpt-5.6-terra` | Balanced OpenAI tasks requiring stronger capability than `gpt-5` | $2.00 input / $12.00 output | ≈ `model:sonnet` (stronger) |
| `model:gpt-5.6-sol` | High-demand OpenAI tasks; capability comparison against `model:opus` | Premium GPT-5.6 variant; $5.00 input / $30.00 output | ≈ `model:opus` |
| `model:o3` | Tasks requiring structured multi-step chain-of-thought reasoning: math-heavy, algorithmic, or architecture-level decomposition | Base $2.00 input / $8.00 output, but **internal reasoning tokens are billed at output rates** — effective cost is typically 3×–10× the base depending on task complexity | ≈ `model:opus` (reasoning-specialized) |

### xAI (Grok) models (manual selection)

The xAI labels provisioned in this repo are sourced from `grok models` at Grok Build CLI v1.0.13
(the pinned version in both Dockerfiles as of Issue [#356](https://github.com/mfrancza/agentic-development-workflow/issues/356)).
Grok models are executed by the Grok Build CLI (`grok --prompt-file /dev/stdin`), not by Codex;
the CLI reads `XAI_API_KEY` directly from the process environment.

| Model label | When to reach for it | Notes |
|---|---|---|
| `model:grok-4.20-0309-non-reasoning` | Default grok model; general-purpose coding and reasoning tasks | Default model at CLI v1.0.13 |
| `model:grok-4.20-0309-reasoning` | Tasks benefiting from explicit chain-of-thought reasoning | Reasoning variant of grok-4.20-0309 |
| `model:grok-4.20-multi-agent-0309` | Multi-agent orchestration and complex agentic task decomposition | Optimized for multi-agent workflows |
| `model:grok-4.3` | General-purpose xAI tasks; stable mid-tier model | Stable release |
| `model:grok-4.5` | General-purpose xAI tasks; newer than grok-4.3 | |
| `model:grok-4.6` | Latest general-purpose xAI model; broadest capability | Best for complex cross-cutting tasks |
| `model:grok-build-0.1` | Build-specialized tasks; coding-focused | Specialized for code generation and build tasks |

**Pricing.** xAI pricing changes frequently; verify against [docs.x.ai/docs/models](https://docs.x.ai/docs/models)
before provisioning large-scale runs. As of August 2026, grok-4.6 standard input is $2.00/1M
(cached input $0.50/1M — a 75% discount for cache-eligible prefixes).

---

## Cross-Vendor Cost Analysis

This section provides normalized cost benchmarks, billing-plan details, and a cross-vendor
comparison to support model selection decisions when cost is a factor.

### Pricing reference (per 1M tokens, August 2026)

All prices are USD. API pricing changes frequently; verify against the official provider pricing
pages before provisioning large-scale runs.

| Model label | Provider | Input ($/1M) | Output ($/1M) | Notes |
|---|---|---|---|---|
| `model:gpt-5.6-luna` | OpenAI | $0.20 | $1.20 | Cheapest GPT-5.6 variant; cheapest label in repo across all providers |
| `model:haiku` (claude-haiku-4-5) | Anthropic | $1.00 | $5.00 | |
| `model:gpt-5` | OpenAI | $1.25 | $10.00 | |
| `model:sonnet` (claude-sonnet-5) | Anthropic | $2.00 | $10.00 | Repo default |
| `model:gpt-5.6-terra` | OpenAI | $2.00 | $12.00 | |
| `model:o3` (base rate only) | OpenAI | $2.00 | $8.00 | Effective cost 3×–10× higher; see note |
| `model:opus` (claude-opus-5) | Anthropic | $5.00 | $25.00 | |
| `model:gpt-5.6-sol` | OpenAI | $5.00 | $30.00 | |
| `claude-fable-5` (no repo label) | Anthropic | $10.00 | $50.00 | No label provisioned |

**o3 effective cost note.** The `o3` base rate covers user-visible input and output tokens only.
Internal chain-of-thought (reasoning) tokens are generated before the visible output and billed at
the output rate. For complex reasoning tasks, total token consumption — and therefore total cost —
is typically 3× to 10× the base-rate estimate. Set `AGENT_MAX_TURNS` conservatively and monitor
token logs when running `model:o3` on agentic tasks.

### Normalized task benchmark

To compare models across providers on a common scale, the **standard coding task** benchmark is
defined as: **20,000 input tokens** (system prompt + context + instructions) and **5,000 output
tokens** (code + comments + summary). This represents a mid-size agentic implementation run.
Actual token counts vary by issue complexity; use this benchmark for order-of-magnitude comparison,
not precise budgeting.

| Model label | Input cost | Output cost | Total per standard task | Cross-vendor rank (cheapest first) |
|---|---|---|---|---|
| `model:gpt-5.6-luna` | $0.004 | $0.006 | **$0.010** | 1 — cheapest across all providers |
| `model:haiku` | $0.020 | $0.025 | **$0.045** | 2 |
| `model:gpt-5` | $0.025 | $0.050 | **$0.075** | 3 |
| `model:o3` (base, no reasoning overhead) | $0.040 | $0.040 | **$0.080** | 3–5 (variable; see note) |
| `model:sonnet` (repo default) | $0.040 | $0.050 | **$0.090** | 4 |
| `model:gpt-5.6-terra` | $0.040 | $0.060 | **$0.100** | 5 |
| `model:opus` | $0.100 | $0.125 | **$0.225** | 6 |
| `model:gpt-5.6-sol` | $0.100 | $0.150 | **$0.250** | 7 |
| `claude-fable-5` (no label) | $0.200 | $0.250 | **$0.450** | 8 — no label provisioned |

**o3 benchmark range.** The $0.080 figure uses only base tokens (no reasoning overhead). For tasks
that trigger moderate reasoning, effective cost is $0.24–$0.40 per standard task (3–5×); for
heavy reasoning tasks it can reach $0.40–$0.80 (5–10×), making `model:o3` comparable to or
exceeding `model:opus` in cost while offering a different capability profile (structured
chain-of-thought vs. broad contextual reasoning).

### Billing plans and discounts

All three providers offer cost-reduction mechanisms layered on top of the base rates above.

| Mechanism | Anthropic | OpenAI | xAI |
|---|---|---|---|
| **Prompt cache** | Cache hits billed at **10% of the base input rate**; cache write at 25%. Effective for large system prompts or repeated tool schemas. | Cached input typically ~50% discount (model-dependent); check model-specific docs. | grok-4.6 cached input: $0.50/1M vs $2.00/1M standard — a 75% discount for cache-eligible prefixes. |
| **Batch API** | **50% discount** on both input and output for requests that tolerate ≤24-hour turnaround. | **50% discount** for asynchronous batch requests. | Not publicly documented as of 2026-08-30. |
| **Combined (cache + batch)** | Stackable: a cached-input batch request pays ~5% of the base input rate and 50% of the base output rate — up to ~55% total savings on a cache-heavy workload. | Similar stacking applies; verify per model. | n/a |

**Practical guidance for this repo's workload types:**

- **Grooming runs** — High frequency, repeated system-prompt structure. Anthropic prompt caching
  captures most of the system-prompt tokens at 10% input cost; effective haiku cost drops from
  $0.045 to roughly $0.025 per standard task. Enable caching on grooming runs first.
- **Batch-mode evaluation or doc pipelines** — Workloads that tolerate ≤24-hour turnaround (e.g.
  a nightly evaluation run over many issues) benefit from the batch 50% discount. Running
  haiku-class tasks in batch is the lowest-cost option across all providers ($0.045 × 50% = ~$0.022).
- **o3 reasoning tasks** — Reasoning tokens are not cache-eligible on the standard path; cost
  is bounded only by `AGENT_MAX_TURNS`. Set a conservative cap and monitor token logs; a
  mis-tuned o3 run can cost more than an Opus run on the same task.
- **xAI cached input** — grok-4.6's cached input rate ($0.50/1M) undercuts even Anthropic Haiku's
  standard input rate ($1.00/1M) for workloads with a large, repeated context prefix. Use
  `model:grok-4.6` for context-heavy tasks where the cache-eligible prefix is large and stable.

### Cross-vendor capability tiers at a glance

| Capability tier | Best-value pick per tier (Aug 2026) | Alternatives |
|---|---|---|
| **Fast / cheap** (mechanical tasks, docs-only) | `model:gpt-5.6-luna` — $0.010/task | `model:haiku` ($0.045/task) |
| **Balanced** (most `do` issues, typical implementation) | `model:sonnet` — $0.090/task (repo default) | `model:gpt-5` ($0.075/task), `model:gpt-5.6-terra` ($0.100/task) |
| **High capability** (`plan` issues, cross-cutting, under-specified) | `model:opus` — $0.225/task | `model:gpt-5.6-sol` ($0.250/task), `model:o3` (variable) |

**Apply cross-vendor picks only when there is a specific reason** — capability evaluation, provider
redundancy testing, or a cost experiment. The grooming agent and the repo-wide default remain
Anthropic-only. This table supports operator-driven label overrides, not routine grooming.

---

## Task-Class Matrix

The table below maps each task class (classification labels the grooming agent already applies,
plus concrete common flavors) to the recommended tier and lists all suitable models across all
vendors with per-task cost estimates. Cost figures use the normalized standard coding task
benchmark (20,000 input + 5,000 output tokens) defined in the Cross-Vendor Cost Analysis section.
The *Anthropic default* column is what the grooming agent picks; the *Cross-vendor alternatives*
column supports operator-driven label overrides when cost or provider diversity is a factor.
The *Example issue* column links to a closed issue from this repo's history where that tier was
applied and the PR merged cleanly. Where a task class can fall into more than one tier, the
driving factor is noted in the *Notes* column.

**Cost/task key:** All figures use the standard 20k-input / 5k-output token benchmark. Figures
marked † are variable; see the o3 benchmark note in the Cross-Vendor Cost Analysis section.
Cross-vendor alternatives are listed cheapest-first within the same capability tier.

| Task class | Anthropic default | Anthropic cost/task | Cross-vendor alternatives (cost/task, cheapest first) | Example issue | Notes |
|---|---|---|---|---|---|
| `bug` — single-file or single-component, scoped fix | `model:sonnet` | $0.090 | `model:gpt-5` $0.075, `model:gpt-5.6-terra` $0.100 | [#284](https://github.com/mfrancza/agentic-development-workflow/issues/284), [#263](https://github.com/mfrancza/agentic-development-workflow/issues/263), [#276](https://github.com/mfrancza/agentic-development-workflow/issues/276) | The implementation path is clear; sonnet handles typical bug fixes efficiently. |
| `bug` — single-line syntax / typo fix | `model:haiku` | $0.045 | `model:gpt-5.6-luna` $0.010 | [#243](https://github.com/mfrancza/agentic-development-workflow/issues/243) | Empty `${{ }}` expression in a YAML comment — purely mechanical, no design decisions. |
| `bug` — cross-cutting, multi-component | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | [#299](https://github.com/mfrancza/agentic-development-workflow/issues/299) | Respecting blocked-by dependencies across fail-loud, deferral, and cascade paths required cross-cutting design; carried both `bug` and `plan` labels. |
| `enhancement` — docs-only | `model:haiku` | $0.045 | `model:gpt-5.6-luna` $0.010 | [#117](https://github.com/mfrancza/agentic-development-workflow/issues/117), [#224](https://github.com/mfrancza/agentic-development-workflow/issues/224), [#161](https://github.com/mfrancza/agentic-development-workflow/issues/161) | Pure documentation edits with no logic changes. Exception: docs that touch security-sensitive prose (auth, token handling) should use `model:sonnet`. |
| `enhancement` — well-specified feature | `model:sonnet` | $0.090 | `model:gpt-5` $0.075, `model:gpt-5.6-terra` $0.100 | [#302](https://github.com/mfrancza/agentic-development-workflow/issues/302), [#301](https://github.com/mfrancza/agentic-development-workflow/issues/301), [#280](https://github.com/mfrancza/agentic-development-workflow/issues/280) | New composite actions, runner support, and Terraform plumbing — implementation paths were clear from the issue description. |
| `enhancement` — cross-cutting refactor | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | [#299](https://github.com/mfrancza/agentic-development-workflow/issues/299) | Multi-component changes that span workflow, entrypoint, TypeScript activities, and Terraform. |
| `enhancement` — new agent type | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | [#41](https://github.com/mfrancza/agentic-development-workflow/issues/41), [#32](https://github.com/mfrancza/agentic-development-workflow/issues/32) | New agent types inherently require design decisions about scope, identity, and integration; always `plan`-class work. |
| `dependency upgrade` | `model:sonnet` | $0.090 | `model:gpt-5` $0.075, `model:gpt-5.6-terra` $0.100 | [#30](https://github.com/mfrancza/agentic-development-workflow/issues/30) | Typical version bumps are well-specified; sonnet is sufficient. If the upgrade involves a breaking-change migration across many files, consider `model:opus`. |
| `do` — mechanical (typo, single config value, comment) | `model:haiku` | $0.045 | `model:gpt-5.6-luna` $0.010 | [#243](https://github.com/mfrancza/agentic-development-workflow/issues/243), [#228](https://github.com/mfrancza/agentic-development-workflow/issues/228) | If `do` and clearly trivial, haiku is appropriate. When in doubt between haiku and sonnet, prefer sonnet. |
| `do` — typical scoped implementation | `model:sonnet` | $0.090 | `model:gpt-5` $0.075, `model:gpt-5.6-terra` $0.100 | [#304](https://github.com/mfrancza/agentic-development-workflow/issues/304), [#302](https://github.com/mfrancza/agentic-development-workflow/issues/302), [#263](https://github.com/mfrancza/agentic-development-workflow/issues/263) | The large majority of `do` issues fall here — non-trivial but well-specified. |
| `plan` — high-level design / architecture | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | [#262](https://github.com/mfrancza/agentic-development-workflow/issues/262), [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275), [#202](https://github.com/mfrancza/agentic-development-workflow/issues/202) | Design documents require cross-cutting analysis and trade-off reasoning; opus is almost always the right pick for `plan`. |
| `plan` — bounded validation / E2E test | `model:sonnet` | $0.090 | `model:gpt-5` $0.075, `model:gpt-5.6-terra` $0.100 | [#139](https://github.com/mfrancza/agentic-development-workflow/issues/139), [#57](https://github.com/mfrancza/agentic-development-workflow/issues/57) | E2E validation plans are scoped and procedural; sonnet handles them well despite carrying the `plan` label. |
| Docs-only enhancement (sub-flavor) | `model:haiku` | $0.045 | `model:gpt-5.6-luna` $0.010 | [#117](https://github.com/mfrancza/agentic-development-workflow/issues/117), [#161](https://github.com/mfrancza/agentic-development-workflow/issues/161) | Subtype of docs-only enhancement — updating `AGENTS.md` or `README.md` for a limitation note or label description. |
| Single-file config bump (sub-flavor) | `model:haiku` | $0.045 | `model:gpt-5.6-luna` $0.010 | [#225](https://github.com/mfrancza/agentic-development-workflow/issues/225) | Adding `.editorconfig` or updating a single Terraform variable — pure mechanical change. |
| Cross-cutting refactor (sub-flavor) | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | [#299](https://github.com/mfrancza/agentic-development-workflow/issues/299) | Multi-component refactors that touch workflow, entrypoint, activities, and infrastructure simultaneously. |
| New agent type (sub-flavor) | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | [#41](https://github.com/mfrancza/agentic-development-workflow/issues/41), [#202](https://github.com/mfrancza/agentic-development-workflow/issues/202) | Any issue that adds a new agent identity, container image, or entrypoint dispatch path. |
| `code review` — targeted (single file, small diff) | `model:haiku` | $0.045 | `model:gpt-5.6-luna` $0.010 | | Mechanical correctness scan of a single-file or small isolated change; no cross-component reasoning required. |
| `code review` — standard (multi-file PR) | `model:sonnet` | $0.090 | `model:gpt-5` $0.075, `model:gpt-5.6-terra` $0.100 | | Standard PR review evaluating correctness, style, AGENTS.md compliance, and test coverage across multiple files. |
| `code review` — architectural / security-sensitive | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | | Cross-cutting reviews, security-sensitive changes (auth, secrets, tokens), or reviews that require system-wide trade-off reasoning. |
| `design` — scoped feature design | `model:sonnet` | $0.090 | `model:gpt-5` $0.075, `model:gpt-5.6-terra` $0.100 | | Design for a bounded, well-specified feature where requirements are clear and scope is limited to one or two components. |
| `design` — system / architectural design | `model:opus` | $0.225 | `model:o3` $0.080–$0.800†, `model:gpt-5.6-sol` $0.250 | [#262](https://github.com/mfrancza/agentic-development-workflow/issues/262), [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275) | Cross-cutting system design, new subsystem architecture, or design work requiring broad contextual reasoning across multiple components. Overlaps with `plan` — high-level design. |

---

## Evidence

### Anthropic model capability tiers

Anthropic publishes model capability descriptions, latency profiles, and benchmark results on the
[Anthropic model documentation page](https://docs.anthropic.com/en/docs/about-claude/models/overview).
The three tier aliases track these tiers:

- **Haiku** — Anthropic's "fastest and most compact" model family, optimized for near-instant
  responsiveness and high-throughput tasks where cost and latency matter more than reasoning depth.
- **Sonnet** — Anthropic's "best combination of speed and intelligence" family, designed as the
  general-purpose default for the majority of production tasks. Anthropic's own recommendation is
  to start here for most use cases.
- **Opus** — Anthropic's "most capable" family, oriented toward tasks requiring "complex analysis,
  research, and strategic planning." Highest capability, higher cost and latency.

These descriptions come from Anthropic's published model cards and are the primary justification
for the tier → task-class mapping in the matrix above. Do not over-index on any single benchmark
score; use the tier descriptions as the mental model and treat benchmarks as order-of-magnitude
corroboration.

### SWE-Bench Verified (coding benchmark)

[SWE-Bench Verified](https://www.swebench.com/) measures the fraction of real GitHub issues an
agent can resolve end-to-end — an ecologically valid proxy for the kind of agentic coding work
this repo performs. Anthropic's published SWE-Bench Verified scores (see model documentation
linked above) show a consistent ordering across tiers: Opus outperforms Sonnet on harder
multi-file issues; Sonnet substantially outperforms Haiku on all but the simplest single-file
tasks. The practical implication: for issues that require reading and modifying multiple files or
reasoning about architecture, the tier gap is real and measurable. For single-file mechanical
changes the gap collapses, making Haiku cost-effective.

### MMLU-Pro (general reasoning benchmark)

[MMLU-Pro](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro) evaluates broad reasoning and
knowledge. Anthropic's published MMLU-Pro scores (available on the model documentation page)
confirm the same tier ordering as SWE-Bench. The practical implication for this repo: Opus is
meaningfully stronger when an issue requires the agent to reason about scope, weigh trade-offs,
or interpret an ambiguous specification — that is, exactly the conditions that trigger `model:opus`
in the task-class matrix above.

### Community sources

No stable community source (Anthropic engineering blog posts, "how we use Claude" write-ups from
other public projects) was identified at time of writing that met the bar for longevity required
to link from a reference document. This section will be updated if a durable source is found.

### Repo history (last ~50 closed issues)

**Reproducible query:**

```bash
gh issue list \
  --repo mfrancza/agentic-development-workflow \
  --state closed \
  --limit 50 \
  --json number,title,labels,closedAt
```

To see issues by tier:

```bash
# Opus-labeled issues
gh issue list --repo mfrancza/agentic-development-workflow \
  --state closed --limit 50 --label "model:opus" \
  --json number,title,labels

# Sonnet-labeled issues
gh issue list --repo mfrancza/agentic-development-workflow \
  --state closed --limit 50 --label "model:sonnet" \
  --json number,title,labels

# Haiku-labeled issues
gh issue list --repo mfrancza/agentic-development-workflow \
  --state closed --limit 50 --label "model:haiku" \
  --json number,title,labels
```

**Summary of findings (sampled 2026-08-30, issues #184–#334):**

Across the last ~50 closed issues with `model:*` labels, the tier assignments produced the
following pattern: `model:opus` was applied to 11 issues, all of which carried `plan` or
combined `bug`+`plan` labels and represented cross-cutting design, new agent types, or
multi-component refactors (examples: #299, #275, #262, #202, #177, #145, #82, #41, #32);
every opus-labeled PR merged cleanly with no `human-required` escalation attributable to
model underperformance. `model:sonnet` was applied to roughly 25+ issues — the large majority
of `do`-labeled enhancements and scoped bug fixes (examples: #304, #302, #301, #284, #280,
#279, #278, #276, #263) — all of which merged cleanly. `model:haiku` was applied to 7–8 issues
that were all documentation-only, single-line syntax fixes, or single-file config additions
(examples: #243, #228, #225, #224, #161, #117); all merged cleanly. Three `plan`-labeled
issues carried `model:sonnet` instead of `model:opus` (#139, #99, #57) — inspection shows
these were bounded E2E validation and test-fixture plans, not architectural design work, and
all three succeeded. The one dependency-upgrade issue in the sample (#30) predates the
grooming label system and carried no `model:*` label; the task-class matrix assigns it to
`model:sonnet` by default. Zero issues required escalation due to a tier mismatch; the
boundary decisions validated by history are: `plan` → opus (with the bounded-validation
exception), `do`+trivial → haiku, everything else → sonnet.

---

## Decision Heuristics

A groomer or a human can apply these rules in ten seconds:

- **`plan` issues are almost always `model:opus`.** The exception is a bounded, procedural plan
  (E2E validation, test fixture planning) — those can use `model:sonnet`.
- **`do` + clearly mechanical = `model:haiku`.** Mechanical means: one value changed, a comment
  added or corrected, a typo fixed, a single config file updated with no logic. If you are not
  certain, use `model:sonnet`.
- **`do` + non-trivial = `model:sonnet`.** This is the majority of all `do` issues.
- **Cross-cutting always escalates to `model:opus`.** If the change touches more than two
  distinct subsystems (e.g. workflow + entrypoint + TypeScript activities + Terraform), use opus
  regardless of whether the issue is labeled `do` or `plan`.
- **Ambiguity escalates.** An under-specified issue whose scope the agent must reason out before
  implementing belongs on opus, not sonnet, even if the eventual implementation turns out to be
  small.
- **Security-sensitive changes use `model:sonnet` at minimum; prefer `model:opus`.** Changes to
  auth flows, token handling, branch-protection rules, or secret management warrant the higher
  tier.
- **Docs-only changes are `model:haiku` unless they touch security prose.** Updating `AGENTS.md`
  to document a limitation, adding a README subsection, or correcting a doc note is haiku work.
  Docs that explain token scopes, App permission models, or security defaults should use sonnet.
- **When in doubt between haiku and sonnet, prefer sonnet.** The cost difference is small; a
  failed or low-quality haiku run costs more in rework than the token savings.
- **When in doubt between sonnet and opus, prefer sonnet for `do` and opus for `plan`.** For
  `do` issues the implementation path should already be clear; if it isn't, the issue may need
  re-grooming.
- **Do not change a `model:*` label that is already present.** A human or a previous run has
  made a deliberate choice. Only override if you can articulate a specific reason (e.g. the
  issue has been significantly expanded in scope since the label was applied).

---

## Provider Notes

The tier aliases (`model:haiku`, `model:sonnet`, `model:opus`) and all guidance in this document
are **Anthropic-specific**. They resolve via the provider-inference logic in `docker/scripts/entrypoint.sh`
to the latest snapshot of the corresponding claude series.

OpenAI and xAI (Grok) models use flat `model:*` labels (e.g. `model:o3`,
`model:grok-4.6`) with no tier-alias vocabulary. The cross-provider label system and
provider inference are documented in:

- [`docs/design/multi-provider-models.md`](design/multi-provider-models.md) — how the
  entrypoint maps model names to provider API keys; operator guidance for using non-Anthropic
  models.
- [`docs/design/grok-models.md`](design/grok-models.md) — xAI Grok provider integration,
  `XAI_API_KEY` plumbing, and Grok label conventions.

The grooming agent applies only Anthropic tier aliases. Analogous tiers for OpenAI and xAI models
(e.g. "which OpenAI model is roughly equivalent to `model:sonnet`?") are documented in the
Cross-Vendor Cost Analysis section above; the design rationale for keeping grooming
Anthropic-only is in
[`docs/design/agent-usage-guidance.md`](design/agent-usage-guidance.md) decision 6.

---

## Change Log

- **2026-08-30 (rev 5)** — Updated xAI label set: replaced retired `model:grok-3` /
  `model:grok-3-mini` / `model:grok-code-fast-1` labels (which routed to grok-4.3) with the
  current Grok Build CLI v1.0.13 model list (`model:grok-4.3` through `model:grok-build-0.1`).
  Removed stale grok-4.3-effective cost rows from the normalized benchmark and task-class matrix.
  Addresses [Issue #356](https://github.com/mfrancza/agentic-development-workflow/issues/356)
  (reviewer entrypoint Grok Build CLI migration; same label refresh as Issue #354/#355 deferred to
  this PR by [PR #365](https://github.com/mfrancza/agentic-development-workflow/pull/365)).

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
