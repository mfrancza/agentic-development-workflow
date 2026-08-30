# Model Guidance

This document is the **single source of truth** for tier selection in this repository. The grooming
agent reads it at run time when selecting a `model:*` label; humans apply it when labeling issues
manually or reviewing a labeled issue. Every other document that discusses model tiers links back
here rather than duplicating the guidance.

---

## Tier Summary

The three Anthropic tier aliases resolve to the latest snapshot of their respective series at run
time. The table below documents the current stable series floor for each alias and the intended
use cases.

| Tier alias | Series floor | When to reach for it | Rough latency / cost profile | Repo-standard default? |
|---|---|---|---|---|
| `model:haiku` | claude-haiku-4 series | Trivial, mechanical changes where the implementation path is unambiguous and no design decisions are required. Examples: a single typo fix, updating one config value, adding or correcting a brief doc note, a one-line code change. | Fastest; lowest token cost (~5–10× cheaper per token than Sonnet; suitable for high-volume or latency-sensitive work) | No |
| `model:sonnet` | claude-sonnet-4 series | Non-trivial but well-scoped work: implementing a well-specified feature, a straightforward bug fix, a dependency upgrade with obvious next steps, or any `do`-labeled issue that requires more than mechanical effort but does not call for architectural reasoning. | Balanced; moderate latency, mid-range cost; the right pick for the large middle band of typical implementation tasks | **Yes — repo default** |
| `model:opus` | claude-opus-4 series | Complex, design-heavy, or under-specified work requiring deep reasoning, cross-cutting analysis, or careful trade-off evaluation. Examples: high-level design for new features, non-trivial refactors that span multiple components, new agent types, security-sensitive changes, or any issue where the agent must reason about scope before it can begin implementing. | Highest capability; highest latency and cost; use when the quality of reasoning is more important than speed or token budget | No |

**Resolution.** An unqualified tier alias (`model:sonnet`, `model:opus`, `model:haiku`) resolves
to the latest snapshot of its series at the time the workflow runs. For pinned-reproducibility
needs, use a generic series tag (`model:claude-sonnet-4-5`) or a snapshot ID
(`model:claude-sonnet-4-5-20250929`). The grooming agent always emits tier aliases — never pinned
IDs — so that the running model advances with the series without requiring label maintenance.

---

## Task-Class Matrix

The table below maps each task class (classification labels the grooming agent already applies,
plus concrete common flavors) to the recommended tier. The *Example issue* column links to a
closed issue from this repo's history where that tier was applied and the PR merged cleanly. Where
a task class can fall into more than one tier, the driving factor is noted in the *Notes* column.

| Task class | Recommended tier | Example issue | Notes |
|---|---|---|---|
| `bug` — single-file or single-component, scoped fix | `model:sonnet` | [#284](https://github.com/mfrancza/agentic-development-workflow/issues/284), [#263](https://github.com/mfrancza/agentic-development-workflow/issues/263), [#276](https://github.com/mfrancza/agentic-development-workflow/issues/276) | The implementation path is clear; sonnet handles typical bug fixes efficiently. |
| `bug` — single-line syntax / typo fix | `model:haiku` | [#243](https://github.com/mfrancza/agentic-development-workflow/issues/243) | Empty `${{ }}` expression in a YAML comment — purely mechanical, no design decisions. |
| `bug` — cross-cutting, multi-component | `model:opus` | [#299](https://github.com/mfrancza/agentic-development-workflow/issues/299) | Respecting blocked-by dependencies across fail-loud, deferral, and cascade paths required cross-cutting design; carried both `bug` and `plan` labels. |
| `enhancement` — docs-only | `model:haiku` | [#117](https://github.com/mfrancza/agentic-development-workflow/issues/117), [#224](https://github.com/mfrancza/agentic-development-workflow/issues/224), [#161](https://github.com/mfrancza/agentic-development-workflow/issues/161) | Pure documentation edits with no logic changes. Exception: docs that touch security-sensitive prose (auth, token handling) should use `model:sonnet`. |
| `enhancement` — well-specified feature | `model:sonnet` | [#302](https://github.com/mfrancza/agentic-development-workflow/issues/302), [#301](https://github.com/mfrancza/agentic-development-workflow/issues/301), [#280](https://github.com/mfrancza/agentic-development-workflow/issues/280) | New composite actions, runner support, and Terraform plumbing — implementation paths were clear from the issue description. |
| `enhancement` — cross-cutting refactor | `model:opus` | [#299](https://github.com/mfrancza/agentic-development-workflow/issues/299) | Multi-component changes that span workflow, entrypoint, TypeScript activities, and Terraform. |
| `enhancement` — new agent type | `model:opus` | [#41](https://github.com/mfrancza/agentic-development-workflow/issues/41), [#32](https://github.com/mfrancza/agentic-development-workflow/issues/32) | New agent types inherently require design decisions about scope, identity, and integration; always `plan`-class work. |
| `dependency upgrade` | `model:sonnet` | [#30](https://github.com/mfrancza/agentic-development-workflow/issues/30) | Typical version bumps are well-specified; sonnet is sufficient. If the upgrade involves a breaking-change migration across many files, consider `model:opus`. |
| `do` — mechanical (typo, single config value, comment) | `model:haiku` | [#243](https://github.com/mfrancza/agentic-development-workflow/issues/243), [#228](https://github.com/mfrancza/agentic-development-workflow/issues/228) | If `do` and clearly trivial, haiku is appropriate. When in doubt between haiku and sonnet, prefer sonnet. |
| `do` — typical scoped implementation | `model:sonnet` | [#304](https://github.com/mfrancza/agentic-development-workflow/issues/304), [#302](https://github.com/mfrancza/agentic-development-workflow/issues/302), [#263](https://github.com/mfrancza/agentic-development-workflow/issues/263) | The large majority of `do` issues fall here — non-trivial but well-specified. |
| `plan` — high-level design / architecture | `model:opus` | [#262](https://github.com/mfrancza/agentic-development-workflow/issues/262), [#275](https://github.com/mfrancza/agentic-development-workflow/issues/275), [#202](https://github.com/mfrancza/agentic-development-workflow/issues/202) | Design documents require cross-cutting analysis and trade-off reasoning; opus is almost always the right pick for `plan`. |
| `plan` — bounded validation / E2E test | `model:sonnet` | [#139](https://github.com/mfrancza/agentic-development-workflow/issues/139), [#57](https://github.com/mfrancza/agentic-development-workflow/issues/57) | E2E validation plans are scoped and procedural; sonnet handles them well despite carrying the `plan` label. |
| Docs-only enhancement (sub-flavor) | `model:haiku` | [#117](https://github.com/mfrancza/agentic-development-workflow/issues/117), [#161](https://github.com/mfrancza/agentic-development-workflow/issues/161) | Subtype of docs-only enhancement — updating `AGENTS.md` or `README.md` for a limitation note or label description. |
| Single-file config bump (sub-flavor) | `model:haiku` | [#225](https://github.com/mfrancza/agentic-development-workflow/issues/225) | Adding `.editorconfig` or updating a single Terraform variable — pure mechanical change. |
| Cross-cutting refactor (sub-flavor) | `model:opus` | [#299](https://github.com/mfrancza/agentic-development-workflow/issues/299) | Multi-component refactors that touch workflow, entrypoint, activities, and infrastructure simultaneously. |
| New agent type (sub-flavor) | `model:opus` | [#41](https://github.com/mfrancza/agentic-development-workflow/issues/41), [#202](https://github.com/mfrancza/agentic-development-workflow/issues/202) | Any issue that adds a new agent identity, container image, or entrypoint dispatch path. |

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
`model:grok-code-fast-1`) with no tier-alias vocabulary. The cross-provider label system and
provider inference are documented in:

- [`docs/design/multi-provider-models.md`](design/multi-provider-models.md) — how the
  entrypoint maps model names to provider API keys; operator guidance for using non-Anthropic
  models.
- [`docs/design/grok-models.md`](design/grok-models.md) — xAI Grok provider integration,
  `XAI_API_KEY` plumbing, and Grok label conventions.

The grooming agent applies only Anthropic tier aliases. Cross-provider tier mapping (e.g.
"which OpenAI model is roughly equivalent to claude-sonnet-4?") is deferred pending a concrete
operational need; see the decision rationale in
[`docs/design/agent-usage-guidance.md`](design/agent-usage-guidance.md) decision 6.

---

## Change Log

- **2026-08-30** — Initial version. Tier summary, task-class matrix, evidence (Anthropic model
  docs, SWE-Bench Verified, MMLU-Pro, bounded ~50-issue repo history), decision heuristics,
  and provider notes written per
  [issue #334](https://github.com/mfrancza/agentic-development-workflow/issues/334) and the
  design in [`docs/design/agent-usage-guidance.md`](design/agent-usage-guidance.md) decisions 1–3.
