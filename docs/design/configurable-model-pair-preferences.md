# Design: Configurable design/implementer → reviewer model-pair preferences

**Issue:** [#450](https://github.com/mfrancza/agentic-development-workflow/issues/450)

**Related designs:**
- [`docs/design/split-model-labels-by-agent-type.md`](split-model-labels-by-agent-type.md) — establishes the `model:<agent-type>:*` waterfall this design extends.
- [`docs/design/pr-workflow-model-resolution.md`](pr-workflow-model-resolution.md) — wires the reviewer workflow into the two-tier resolver; this design adds a third tier below the labels.
- [`docs/design/multi-provider-models.md`](multi-provider-models.md) — provider-inference and API-key routing that the pairing logic must respect.
- [`docs/model-guidance.md`](../model-guidance.md) — cross-vendor capability-tier table this design promotes to a source-of-truth data file consumed by the pairing resolver.
- Issue [#449](https://github.com/mfrancza/agentic-development-workflow/issues/449) (multi-reviewer support) — this design is standalone; see **Decision 6** for the extension point.

## Summary

Add a **pairing tier** to the reviewer's model-resolution waterfall that picks a review model based on the authoring model of the PR. The default policy is *different-vendor, same capability class* — an Anthropic-sonnet-authored PR defaults to review by the comparable OpenAI or xAI model. Explicit `model:review:*` and generic `model:*` labels on the PR retain their existing precedence; the pairing tier only fires when both label tiers are empty. When the preferred pairing cannot be satisfied (vendor key missing, class has no cross-vendor entry), a deterministic fallback chain kicks in and every deviation is logged loudly.

## Requirements as understood

From the issue body ([#450](https://github.com/mfrancza/agentic-development-workflow/issues/450)) and the grooming Q&A:

1. **Pairing policy exists and defaults to different-vendor-same-class.** A change authored by an Anthropic sonnet-class model defaults to review by an OpenAI or xAI sonnet-class model, and vice versa. Rationale (verbatim from the issue): "same-model review shares the author's blind spots; cross-vendor review at comparable capability gives independent perspective without a cost-class jump."

2. **Cross-vendor capability-class mapping is a single source of truth.** A maintained equivalence table with rows for each class (haiku-class / sonnet-class / opus-class) and one entry per vendor. Natural home: `docs/model-guidance.md` — which already carries the "Cross-vendor capability tiers at a glance" table (line 172 of that file). The pairing resolver must consume the same data the doc renders; copies drift.

3. **Configuration surface is Terraform-managed with an opt-in fail-safe default.** Following the `AGENT_ALLOWLIST` / `AUTO_TRIGGER_AGENTS` pattern, the pairing preferences live in a Terraform variable that is exposed as a JSON-encoded repo-level Actions variable. All keys default to a safe no-op (pairing disabled) so a fresh repo behaves exactly as it does today.

4. **Per-PR override via existing `model:review:*` labels takes precedence.** The two-tier waterfall implemented in [#149](https://github.com/mfrancza/agentic-development-workflow/issues/149) stays intact; the pairing tier slots in *below* both label tiers and *above* `DEFAULT_MODEL`.

5. **Detection of the authoring model at review time.** The reviewer workflow needs to know which model authored the PR under review. The implement/design runs know their resolved model when they open the PR; the pairing resolver reads it back on the review pass.

6. **Degradation is fail-safe and logged.** When the preferred vendor's API key is absent, or the class has no current entry for the preferred vendor, the resolver falls back through a deterministic chain: same-class alternative vendor → same-vendor different model (only if the operator opts in) → `DEFAULT_MODEL`. Every deviation from the ideal pick is logged in the workflow output. The resolver **never silently returns the same model as the author** unless the configured policy is explicitly `same-model`.

7. **Interaction with #449 (multi-reviewer).** The pairing policy generalises to selecting a reviewer *set* when N > 1 reviewers are configured. This design implements the single-reviewer case standalone (per grooming decision) and leaves an explicit extension point for #449.

### Ambiguities resolved

- **Cross-repo dependency ordering with #449.** The issue body notes a potential `blocked_by` relationship. Resolved as: **standalone** — the pairing resolver is a pure function `(authoringModel, policy, availableProviders, classTable) → reviewerModel`. When #449 lands, that function becomes the per-slot picker for the reviewer set; no re-architecture. See **Decision 6**.
- **Where the class table lives.** `docs/model-guidance.md` already documents cross-vendor tier equivalence in prose. Resolved as: **single JSON data file** at `.github/scripts/data/model-classes.json` is the source of truth; `docs/model-guidance.md` gains a new subsection that links to the file and renders the same content in prose. See **Decision 3**.
- **How the authoring model is recorded on the PR.** Resolved as: **HTML-comment marker in the PR body** injected by the developer/design entrypoint after the agent opens the PR. See **Decision 4**.

## Design

### Decision 1 — Add a pairing tier to the reviewer's model waterfall (below labels, above `DEFAULT_MODEL`)

**Decision.** Extend the `resolve-model` composite action's waterfall for `agent-type: review` to:

1. **Per-agent tier** — `model:review:*` label on the PR (existing).
2. **Generic tier** — `model:*` label on the PR (existing).
3. **Pairing tier** — new. When `review_model_pairing.enabled == true` and the PR body carries an `authored-by-model` marker (see **Decision 4**), compute the pairing pick using the configured policy (**Decision 2**).
4. **`DEFAULT_MODEL`** — existing final fallback.

The pairing tier is inserted only for `agent-type: review`; issue-driven workflows are unaffected. When the tier is disabled (default), the resolver behaves exactly as it does today.

**Rationale.** The grooming notes call out this exact insertion point: "adds a policy-derived default *below* explicit labels, above `DEFAULT_MODEL`." Splitting the pairing pick into its own tier keeps the label-based override semantics intact — an operator who wants pinned reviewer selection continues to add a `model:review:*` label to the PR, and the pairing tier stays out of the way. Placing the tier above `DEFAULT_MODEL` means the pairing policy is the effective default whenever it is enabled and the authoring model is discoverable — which is the point of the feature.

**Alternative considered — inline the pairing pick into a new composite action.** Rejected. `resolve-model` is already the single choke-point for reviewer model selection (per [#149](https://github.com/mfrancza/agentic-development-workflow/issues/149)); forking it doubles the number of places a reviewer wanting to trace the resolved model has to look. Extension via a new tier keeps one waterfall.

**Alternative considered — apply the pairing pick to `DEFAULT_MODEL` itself (i.e. compute an effective default per-PR).** Rejected. `DEFAULT_MODEL` is repo-wide and is the terminal fallback across all agent workflows; making it per-PR blurs its contract. The pairing tier is scoped to `agent-type: review` where it belongs.

### Decision 2 — Configuration surface: single Terraform object variable, opt-in

**Decision.** Add a Terraform variable `review_model_pairing` (object type) in `terraform/variables.tf`, exposed via `terraform/modules/agent-vars/main.tf` as a JSON-encoded repo-level Actions variable `REVIEW_MODEL_PAIRING`. Default:

```hcl
variable "review_model_pairing" {
  description = "Reviewer model-pair preferences. When enabled, the agent-review workflow picks a reviewer model based on the authoring model of the PR (recorded in the PR body by the developer/design agent). Explicit model:review:* / model:* labels on the PR take precedence. See docs/design/configurable-model-pair-preferences.md for the resolver semantics and docs/model-guidance.md for the cross-vendor class table."
  type = object({
    enabled           = bool
    policy            = string        # "different-vendor-same-class" | "same-vendor-same-class" | "same-model" | "explicit-map" | "off"
    preferred_vendors = list(string)  # tie-breaking order for "different-vendor-same-class"; also drives the "same-vendor-different-model" fallback vendor sequence
    explicit_map      = map(string)   # author-model → reviewer-model; consulted only when policy == "explicit-map"
    fallback_chain    = list(string)  # ordered fallbacks when the primary policy pick is not satisfiable; supported entries: "different-vendor-same-class", "same-vendor-different-model", "default-model"
  })
  default = {
    enabled           = false
    policy            = "different-vendor-same-class"
    preferred_vendors = ["openai", "xai", "anthropic"]
    explicit_map      = {}
    fallback_chain    = ["default-model"]
  }
}
```

**Rationale.** One object variable keeps the Terraform surface small and mirrors `auto_trigger_agents`, the closest existing precedent. `enabled = false` by default satisfies the "fail-safe when unset" convention from the grooming notes — the feature is dormant until an operator explicitly flips it on. Every knob is a Terraform-managed value, not a magic env-var default: the fallback chain, the vendor tie-breaker order, and the explicit map are all reviewable via `terraform plan`.

The `preferred_vendors` list is the tie-breaker when `different-vendor-same-class` yields more than one candidate. It also serves as the vendor sequence for `same-vendor-different-model` fallback (which vendor's fallback ladder to walk when even the same-vendor different-model pick has to reach across an available-vendor boundary — rare but worth defining).

**Alternative considered — separate Terraform variables per knob (`review_pairing_enabled`, `review_pairing_policy`, …).** Rejected. Five siblings is more noise than one object; the object shape is also self-documenting when JSON-encoded into `REVIEW_MODEL_PAIRING`.

**Alternative considered — encode the policy as GitHub Actions inputs on `agent-review.yml` instead of a repo-level variable.** Rejected. Per-workflow inputs would require the caller stub to know the policy, defeating the "one repo-wide setting" ergonomic that `DEFAULT_MODEL` already provides.

**Alternative considered — allow policy override via a PR label like `pair-policy:same-vendor`.** Deferred. The `model:review:*` label already covers the "override the pick on this specific PR" case; a per-PR *policy* override adds surface without a clear use case. Can be added later if operators ask for it.

### Decision 3 — Cross-vendor capability class: single JSON data file as source of truth

**Decision.** Create `.github/scripts/data/model-classes.json` as the source of truth for cross-vendor equivalence. Shape:

```json
{
  "classes": {
    "haiku": {
      "anthropic": ["haiku", "claude-haiku-4-5"],
      "openai":    ["gpt-5.6-luna"],
      "xai":       ["grok-4.3", "grok-build-0.1"]
    },
    "sonnet": {
      "anthropic": ["sonnet", "claude-sonnet-4-5"],
      "openai":    ["gpt-5", "gpt-5.6-terra"],
      "xai":       ["grok-4.20-0309-non-reasoning", "grok-4.5"]
    },
    "opus": {
      "anthropic": ["opus"],
      "openai":    ["gpt-5.6-sol", "o3"],
      "xai":       ["grok-4.20-0309-reasoning", "grok-4.20-multi-agent-0309", "grok-4.6"]
    }
  },
  "modelToClass": {
    "haiku": "haiku",
    "sonnet": "sonnet",
    "opus": "opus",
    "claude-haiku-4-5": "haiku",
    "claude-sonnet-4-5": "sonnet",
    "gpt-5": "sonnet",
    "gpt-5.6-luna": "haiku",
    "gpt-5.6-terra": "sonnet",
    "gpt-5.6-sol": "opus",
    "o3": "opus",
    "grok-4.3": "haiku",
    "grok-4.20-0309-non-reasoning": "sonnet",
    "grok-4.5": "sonnet",
    "grok-4.6": "opus",
    "grok-4.20-0309-reasoning": "opus",
    "grok-4.20-multi-agent-0309": "opus",
    "grok-build-0.1": "haiku"
  }
}
```

**Semantics of the two sections.**

- `classes[class][vendor]` is a **forward-only** listing of models known to belong to that class for that vendor. The first entry is the **canonical pick** — the model the pairing resolver names when it needs to pick one representative for `(class, vendor)`. Additional entries recognise alternative model IDs as members of the same class (so an author label `claude-sonnet-4-5` still resolves to sonnet-class). A model MAY appear under more than one `class` if a future update to `docs/model-guidance.md` legitimately places it in multiple tiers; this is not an error. No model in the current class table is dual-class — every vendor entry in the JSON belongs to exactly one class, matching the doc's tier assignments.
- `modelToClass` is the **authoritative reverse lookup**: given any model ID, it returns the single class the resolver treats it as. If a future model becomes dual-class, `modelToClass` records the resolved class (the one the pairing use case prefers). Loaders in `.github/scripts/src/lib/model-classes.ts` MUST use `modelToClass` — never a reverse-iteration of `classes` — for author-model → class resolution.

Extend `docs/model-guidance.md` with a new "Cross-vendor class table" section that renders the same data in Markdown, prefaced by: "This section mirrors `.github/scripts/data/model-classes.json`; edit the JSON and refresh this section in the same PR." If a future model becomes a member of more than one class, that section MUST include a short paragraph naming the model, listing every class it appears under in the JSON, and stating which class `modelToClass` resolves it to and why. JSON itself does not support comments, so the human-readable resolution lives in the doc rather than in the data file. No such paragraph is required today because no model is currently dual-class; the mechanism is retained so future dual-class entries have a well-defined documentation home.

Add a Vitest unit test at `.github/scripts/test/model-classes.test.ts` (tests live under `test/`, not next to the source — the repo's `vitest.config.ts` uses `include: ["test/**/*.test.ts"]`, so a file placed alongside the source under `src/lib/` would be silently excluded from CI) with the following checks (the class table is small and static, so hand-rolled assertions are enough):

1. **Canonical picks are mapped consistently.** For every `(class, vendor)` pair, the *first* entry in `classes[class][vendor]` (the canonical pick) MUST appear as a key in `modelToClass` and MUST map to that same `class`. This catches the "canonical pick and reverse lookup disagree" bug without prohibiting dual-class membership for non-canonical entries.
2. **`modelToClass` is a superset of every entry in `classes`.** Every model listed anywhere in `classes[*][*]` MUST appear as a key in `modelToClass`. Missing keys mean the reverse lookup can't resolve an author model that the forward table advertises.
3. **Dual-class entries are intentional, not stray.** For any model that appears in more than one `classes[class][vendor]` list, `modelToClass` MUST map it to one of those classes (never to a third class it isn't listed under). Any model that is a dual-class member MUST also be named in the "Cross-vendor class table" paragraph in `docs/model-guidance.md` — the test iterates the dual-class model set derived from the JSON and greps the doc for each name. This is the JSON → doc consistency check called out in the design. No models are dual-class today, so the check is a no-op against the current JSON; it becomes active the first time a future edit adds the same model ID to two `classes[class][vendor]` lists.
4. **Canonical picks in the JSON agree with the "Alternatives" column in the doc.** For each class row, the first entry per vendor in the JSON MUST appear in the corresponding doc row's Alternatives cell.

The test does NOT verify that every model listed in `classes` maps back to that same class via `modelToClass` — that would make dual-class membership an error rather than a documented exception.

**Rationale.** The class table is consumed at runtime by the pairing resolver (a TypeScript activity) and at read-time by humans skimming `docs/model-guidance.md`. Keeping both readers pointed at one JSON file is the "volatile facts live at their sources" convention from `AGENTS.md` applied to a new source. A JSON file is trivially importable in TypeScript (`import * as data from "./data/model-classes.json"`), unit-testable, and reviewable in a diff. Markdown-as-source with a parser was considered and rejected — Markdown parsing at CI time is fragile and every table edit becomes a doc-formatting exercise. JSON's lack of comment support is a real constraint: the design accepts it and puts human-readable exceptions in the companion doc, keeping the JSON parseable by `import * as data from "./data/model-classes.json"` without a preprocessing step.

The initial class assignments align with the existing "Cross-vendor capability tiers at a glance" table in `docs/model-guidance.md` (line 172): the "Alternatives" column already lists which OpenAI/xAI models substitute for `model:haiku` / `model:sonnet` / `model:opus`. The JSON file captures those mappings machine-readably. Every model in the current doc is assigned to a single tier — for example, `grok-4.6` appears only in the "High capability" row (line 178) and is placed in `classes.opus.xai` with `modelToClass["grok-4.6"] = "opus"`, matching the doc's description ("broadest capability / Best for complex cross-cutting tasks", line 71). The dual-class mechanism described above is retained for the future case where a doc edit legitimately places a model in more than one tier; if that happens, the resolution must be documented in the new `docs/model-guidance.md` section, and the Vitest test (check 3) enforces it.

**Alternative considered — hand-maintained TypeScript constant.** Rejected. TypeScript constants are less approachable for non-developers reviewing a class-table change; JSON is more portable.

**Alternative considered — derive the JSON from `docs/model-guidance.md` at CI build time.** Rejected. Markdown table parsing introduces a dependency and a build step for a table that changes once per quarter.

### Decision 4 — Record authoring model as an HTML-comment marker in the PR body (entrypoint-injected)

**Decision.** After the developer/design agent opens the PR, the entrypoint (`docker/scripts/entrypoint.sh`) fetches the PR body, prepends (or updates) a marker line, and writes the body back with `gh pr edit --body-file`. Marker format:

```
<!-- authored-by-model: <resolved-model> -->
```

The line is idempotent: on `respond-review` / `fix-checks` / `fix-deployment` re-runs, the entrypoint re-writes the marker if the value changed (an unusual case — model overrides between runs are rare but possible), otherwise leaves the body untouched.

The reviewer workflow parses the marker with the same "read the PR body" API call the `find-linked-issue` activity already makes (see [#360](https://github.com/mfrancza/agentic-development-workflow/issues/360)); a small `find-authored-by-model` activity (or a helper extraction from `find-linked-issue`) returns `{ proceed, authoring_model }`. Regex: `/<!--\s*authored-by-model:\s*([^\s>]+)\s*-->/i`.

**Rationale.**

- **Entrypoint injection, not prompt instruction.** Asking the agent to write the marker itself is unreliable — Claude/Codex/Grok will sometimes omit or paraphrase it. The entrypoint knows `AGENT_MODEL` deterministically and can guarantee the marker is present regardless of agent compliance.
- **HTML comment in the PR body.** The PR body is durable and already parsed for `Closes #N` by `resolve-deployment` / `find-linked-issue`; the marker uses the same channel. HTML comments render invisibly in the GitHub UI, so the marker does not clutter the PR page.
- **No new labels.** A `authored-by:<model>` label per model name would require Terraform provisioning of new labels every time the model list changes (haiku/sonnet/opus × three vendors, plus every generic series tag and pinned snapshot). The label picker is already crowded; a body marker adds zero label-picker rows.

**Alternative considered — one `authored-by:<provider>` label with 3 possible values** (anthropic / openai / xai). Rejected: it captures the vendor but not the class, so the pairing resolver still needs to look up the class elsewhere. The body marker gives full model information in one place.

**Alternative considered — write the model into an artifact / job output.** Rejected. Artifacts don't survive across workflow runs, so the reviewer workflow (a separate run triggered later) can't read them. Job outputs have the same lifetime.

**Alternative considered — record the model in a machine-readable JSON block instead of a plain marker.** Rejected as over-engineered for a single field. If additional metadata is ever needed, the marker syntax can be extended (`<!-- agent-meta: {...} -->`) without breaking the existing pattern.

**Marker-preservation guidance in the prompts.** Update the prompt files (`docker/scripts/prompts/implement.md`, `design.md`, `respond-to-review.md`, `respond-to-checks.md`, `fix-deployment.md`) with a one-line note: "the `<!-- authored-by-model: … -->` marker in the PR body is machine-generated; do not remove it when editing the body." This is belt-and-braces — the entrypoint re-injects the marker on every run anyway.

### Decision 5 — Fallback chain and degradation semantics

**Decision.** The pairing resolver evaluates the primary policy first, then walks `review_model_pairing.fallback_chain` in order. Supported chain entries:

- `"different-vendor-same-class"` — pick any same-class model from a different vendor whose API key is set, honouring `preferred_vendors` order.
- `"same-vendor-different-model"` — pick the other same-vendor entry in the same class (e.g. `sonnet` → `claude-sonnet-4-5`), if one exists. Never returns the same model as the author.
- `"default-model"` — fall through to `vars.DEFAULT_MODEL`.

If the primary policy is already `"different-vendor-same-class"`, that entry is not repeated in the chain — the primary pick already covered it. If none of the fallback entries yield a satisfiable model, the resolver returns `DEFAULT_MODEL` as an implicit terminal fallback and logs a `WARNING`.

**API-key availability** is a workflow-side signal: the reviewer workflow computes `available-providers` from the presence of `secrets.ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` (an empty string means unset) and passes the list into `resolve-model`. The pairing library treats an absent provider as if it had no entries in the class table. This matches the reviewer entrypoint's existing per-provider key validation (`docker/reviewer/entrypoint.sh` lines 245-269).

**Loud logging.** Every deviation from "primary policy pick succeeded" is emitted via `core.warning()` — visible in the workflow annotations and the run summary. The resolver never silently returns the author's model unless `policy == "same-model"`.

**Edge case: `DEFAULT_MODEL == authoringModel`.** The word "silently" in Requirement 6 is load-bearing: returning the author's model with a loud log line is acceptable; returning it with no signal is not. When the implicit terminal `DEFAULT_MODEL` fallback fires and `DEFAULT_MODEL` resolves to the same model as `authoringModel` (e.g. both are `sonnet` because the repo default matches the PR's author), the resolver MUST emit `core.error()` — not just `core.warning()` — and include the string `"DEFAULT_MODEL equals authoring model; reviewer will share the author's blind spots"` in the annotation. This is a soft failure (the resolver still returns `DEFAULT_MODEL`, the review still runs), but `core.error()` surfaces the condition in the workflow summary and in the PR checks pane so operators notice and can either widen the fallback chain, set additional provider keys, or apply an explicit `model:review:*` label. In all other cases where a fallback is taken, `core.warning()` remains the correct level.

**Rationale.** The grooming notes require: "fall back to same-vendor different-model, then `DEFAULT_MODEL`; fail-safe and logged, never silently same-model unless configured." The three-entry supported chain covers the enumerated fallbacks and lets the operator narrow the ladder if they want (e.g. `fallback_chain = ["default-model"]` skips the same-vendor fallback entirely and lands on the repo default whenever the pairing pick misses).

**Alternative considered — hard-code the fallback chain in the resolver.** Rejected. Different operators have different tolerances: some want the "prefer any cross-vendor pick even if class doesn't match" behaviour, some want strict fail-to-default. A configurable chain accommodates both without prompt-engineering the resolver.

**Alternative considered — treat "same-vendor-different-model" as returning the author's model when only one model exists in the class.** Rejected — that's the forbidden silent-same-model case. When no different model exists in the same vendor's class, the entry is skipped and the resolver moves on.

### Decision 6 — Standalone for single-reviewer; explicit extension point for #449

**Decision.** Implement this design as a **single-reviewer** pairing default. Structure the pairing logic as a pure function:

```typescript
export function selectReviewerModel(
  authoringModel: string,
  policy: PairingPolicy,
  availableProviders: readonly string[],
  classTable: ClassTable,
): {
  model: string;
  source:
    | "primary"
    | "fallback:different-vendor-same-class"
    | "fallback:same-vendor-different-model"
    | "fallback:default-model";
  warnings: string[];
}
```

The `source` values mirror the fallback-chain entry names from **Decision 5** verbatim, so a caller (or a log-line reader) can trace the returned model back to the configured `fallback_chain` without a translation layer. `"primary"` means the configured `policy` succeeded on its first pick; every other value names the fallback-chain entry that produced the model. When the primary policy is itself `"different-vendor-same-class"` and it succeeds, `source` is `"primary"` (not `"fallback:different-vendor-same-class"`) — the fallback labels are reserved for picks made after the primary attempt failed.

This function is called once by `resolve-model` today. When [#449](https://github.com/mfrancza/agentic-development-workflow/issues/449) lands N reviewers, the multi-reviewer workflow will call `selectReviewerModel` once per slot with a per-slot `policy` (e.g. slot 1: `"different-vendor-same-class"`, slot 2: `"same-vendor-same-class"`). The pure-function shape lets the pairing computation compose without change.

**Rationale.** The grooming notes require an explicit disposition: "The plan should explicitly decide: implement as a standalone single-reviewer pairing default (with a clean extension point for #449), or declare a hard dependency and sequence accordingly." Sequencing this behind #449 would gate a useful default (cross-vendor review for the single-reviewer case) on a larger, more speculative design; the pure-function decomposition means #449 can add multi-reviewer support without re-plumbing the pairing tier.

**Extension point contract** documented in `docs/design/configurable-model-pair-preferences.md` (this file): when #449's design lands, it must consume `selectReviewerModel` unchanged and layer per-slot policy on top. Any refactor that breaks that contract must update this doc.

### Decision 7 — Documentation updates land with the workflow-wiring PR

**Decision.** In the sub-issue that wires the pairing tier into `agent-review.yml` (**Task 5** below), update in the same PR:

- `AGENTS.md` — the `model:<agent-type>:<name>` label bullet gains a sentence noting that the reviewer waterfall now includes a pairing tier below the generic label tier, gated on `REVIEW_MODEL_PAIRING.enabled`.
- `AGENTS.md` — a new bullet under the Actions-variable list documents `REVIEW_MODEL_PAIRING` (shape, default, effect).
- `README.md` — a subsection under "Reproduce this yourself" pointing operators at the Terraform variable and explaining the opt-in.
- `docs/model-guidance.md` — the "Cross-vendor class table" section added in **Task 1** gains a "Consumed by" note referencing this design.
- `terraform/modules/agent-vars/README.md` — a paragraph describing the new Actions variable.

**Rationale.** `AGENTS.md`'s "Keeping Documentation Current" section makes docs-in-the-same-PR the standard; bundling the doc updates with the workflow-wiring PR (rather than the Terraform PR) ensures the docs describe the merged state accurately at every point.

## Out of scope

- **Per-PR policy overrides via labels** (e.g. `pair-policy:same-vendor`). The existing `model:review:*` label already covers per-PR model pinning; a per-PR policy toggle is deferred until operators ask for it.
- **Cost-aware pairing.** The pairing resolver is capability-driven, not cost-driven. Operators who want the cheapest same-class pick can achieve it by reordering `preferred_vendors` (e.g. put `xai` first). A dedicated cost policy is out of scope.
- **Retrieving the authoring model from git-log or PR author metadata.** The developer bot identity does not encode the model. The body marker is the authoritative record; PRs opened before the marker convention lands will fall through to `DEFAULT_MODEL` on review (documented in the doc-update sub-issue).
- **Multi-reviewer selection semantics.** Handled by [#449](https://github.com/mfrancza/agentic-development-workflow/issues/449); this design only preserves the extension point.
- **Modifying `docker/reviewer/entrypoint.sh` beyond consuming the resolved `AGENT_MODEL`.** The pairing pick is computed workflow-side by `resolve-model`; the reviewer container continues to receive one `AGENT_MODEL` value and does no additional pairing work.
- **Provisioning new tier aliases (e.g. `model:sonnet-class`).** Class membership is a resolver-internal concept keyed off the JSON file; no new user-facing label vocabulary is introduced.
- **Backfilling the marker on already-open PRs.** The first review pass on an unmarked PR will log the missing marker and fall through to `DEFAULT_MODEL`; operators can add a `model:review:*` label manually to override. A one-shot backfill script is not planned.
- **Cross-repo pairing (design in one repo, review in another).** All pairing is scoped to the current repository.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|------------|
| [#469](https://github.com/mfrancza/agentic-development-workflow/issues/469) | Add `.github/scripts/data/model-classes.json` with the initial class table (haiku/sonnet/opus × three vendors) plus a shared TypeScript loader `.github/scripts/src/lib/model-classes.ts` and a Vitest unit test at `.github/scripts/test/model-classes.test.ts` (matching the repo's `vitest.config.ts` `include: ["test/**/*.test.ts"]` pattern) implementing the four hand-rolled assertion groups from Decision 3 (canonical-pick consistency, `modelToClass` superset, dual-class intentionality, JSON ↔ doc cross-check). Add a "Cross-vendor class table" section to `docs/model-guidance.md` that mirrors the JSON. | — |
| [#470](https://github.com/mfrancza/agentic-development-workflow/issues/470) | Add `review_model_pairing` Terraform variable in `terraform/variables.tf`; wire it through `terraform/main.tf` to `terraform/modules/agent-vars/main.tf` as a JSON-encoded `REVIEW_MODEL_PAIRING` Actions variable. Update `terraform/terraform.tfvars.example` with a commented example, and `terraform/modules/agent-vars/README.md`. | — |
| [#472](https://github.com/mfrancza/agentic-development-workflow/issues/472) | Extend `docker/scripts/entrypoint.sh` to inject / refresh the `<!-- authored-by-model: … -->` marker in the PR body after `action_implement`, `action_design`, `action_respond_review`, `action_fix_checks`, and `action_fix_deployment`. Add a shared `inject_authored_by_marker` helper. Add a one-line preservation note to each affected prompt file in `docker/scripts/prompts/`. | — |
| [#474](https://github.com/mfrancza/agentic-development-workflow/issues/474) | Add `.github/scripts/src/lib/model-pair.ts` implementing `selectReviewerModel(authoringModel, policy, availableProviders, classTable)` as a pure function with unit tests at `.github/scripts/test/model-pair.test.ts` (matching the repo's `vitest.config.ts` `include: ["test/**/*.test.ts"]` pattern) covering all policies, all fallback-chain entries, missing keys, missing class entries, `same-model` policy, `explicit-map` policy, and the empty-marker case. Extend `.github/scripts/src/resolve-model.ts` and `.github/actions/resolve-model/action.yml` with `pairing-policy`, `authoring-model`, `available-providers` inputs; the pairing tier only fires for `agent-type: review`. Extend existing Vitest tests. | Issue #469 |
| [#475](https://github.com/mfrancza/agentic-development-workflow/issues/475) | Add a small `.github/actions/find-authored-by-model` composite (or extract a shared PR-body regex helper alongside `find-linked-issue`) that reads the marker off the PR body. Wire the new activity into `agent-review.yml` / `agent-review-reusable.yml`: pass `pairing-policy: ${{ vars.REVIEW_MODEL_PAIRING }}`, `authoring-model: ${{ steps.author.outputs.model }}`, `available-providers: ${{ steps.providers.outputs.list }}` to the `resolve-model` composite. Compute `available-providers` from the presence of each `secrets.*_API_KEY`. Update `AGENTS.md`, `README.md`, `terraform/modules/agent-vars/README.md`, and the "Cross-vendor class table" section of `docs/model-guidance.md` in the same PR. | Issues #470, #472, #474 |
| [#476](https://github.com/mfrancza/agentic-development-workflow/issues/476) | End-to-end validation: on a test issue, apply `model:developer:opus`, run the developer agent, verify the PR body carries `<!-- authored-by-model: opus -->`; enable `REVIEW_MODEL_PAIRING` with `policy: different-vendor-same-class` and `preferred_vendors: ["openai", "xai", "anthropic"]`; apply `agent:review` and confirm the reviewer runs on `gpt-5.6-sol` (or the xAI fallback if the OpenAI key is unset). Then apply `model:review:sonnet` on the same PR and confirm the label pick wins. Then disable the OpenAI key in a test-mode workflow-dispatch run and confirm the fallback chain resolves to an xAI opus-class model. Finally, unset the marker on a PR (or use a pre-marker PR) and confirm the reviewer falls through to `DEFAULT_MODEL` with a loud warning. | Issues #469, #470, #472, #474, #475 |

Issues #469, #470, and #472 are independent and can proceed in parallel. Issue #474 depends on #469 (JSON schema and loader). Issue #475 depends on #470 (Actions variable exists), #472 (marker is being written), and #474 (resolver accepts the new inputs). Issue #476 depends on all five implementation tasks.

Dependencies are recorded natively as GitHub `blocked_by` relationships on the issues.
