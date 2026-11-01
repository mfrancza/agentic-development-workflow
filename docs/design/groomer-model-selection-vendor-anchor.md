# Design: Groomer model selection — vendor anchor and doc-drift fixes

**Issue:** [#696](https://github.com/mfrancza/agentic-development-workflow/issues/696)

## Requirements as understood

Issue #696 bundles two problems. The first is **documentation drift** that
survived PR #567 (`014e7c5`, 2026-10-04), which expanded grooming to cover all
three provisioned providers:

- The `model:<name>` bullet in `AGENTS.md` still describes the grooming agent as
  emitting "always one of the three tier aliases, never a generic series tag or
  a pinned snapshot". The three-alias statement is now wrong — the actual
  `agents/grooming/label-criteria.json` lineup carries 14 `model:*` entries
  (3 Anthropic tier aliases + 4 OpenAI labels + 7 Grok labels), and the
  authoritative guidance for picking among them lives in
  [`docs/model-guidance.md`](../model-guidance.md).
- Issue #461 criterion 7 ("confirm `label-criteria.json` still lists exactly
  the three tier aliases") was written against the pre-#567 invariant. The
  evidence comment on #461 (2026-10-27) notes the criterion fails as written
  even though no refresh PR regressed anything.

The second is a **policy question** about how the groomer should pick a model
when a repository has configured `DEFAULT_MODEL` / `DESIGN_DEFAULT_MODEL` to a
non-Anthropic provider. [`docs/model-guidance.md`](../model-guidance.md) step 2
of "Provider selection during grooming" still says "retain Anthropic as the
fallback", so a repository that has set `DEFAULT_MODEL = gpt-5.6-terra` would
still be groomed to `model:opus` / `model:sonnet` / `model:haiku`. Because any
generic `model:*` label beats `DEFAULT_MODEL` in the resolution waterfall, the
configured preference would never apply to groomed issues.

The maintainer resolved the policy question in a grooming comment on this
issue:

> Let's revise the instructions for the grooming agent to use models from the
> same vendor as the configured for the default if it thinks the task is more
> or less complex than the default model is suitable for. Include adding a
> default grooming model to the configuration in the scope.

Translated into design intent:

1. The grooming agent's selection should be **anchored to the vendor** of the
   configured repository default, not to Anthropic.
2. Within that vendor, the groomer only emits a `model:*` label when the
   task's complexity differs from the anchor model's tier. If the task fits
   the anchor tier, the groomer leaves the issue unlabeled so the configured
   default governs the downstream runs.
3. A new `GROOM_DEFAULT_MODEL` Terraform/Actions variable (parallel to
   `DESIGN_DEFAULT_MODEL`) lets a maintainer set a grooming-specific default
   without disturbing `DEFAULT_MODEL`. The grooming workflow prefers
   `GROOM_DEFAULT_MODEL` when set and falls through to `DEFAULT_MODEL`
   otherwise. The vendor-anchor rule reads from the same effective value.

The present repository state after PR #752 (merged 2026-11-01) is
`default_model = "sonnet"` and `design_default_model = "opus"`, both
Anthropic. The groomer's current Anthropic-only selection therefore matches
the current anchor vendor by coincidence; this design makes the alignment
explicit and durable across future `DEFAULT_MODEL` changes.

This is a policy and documentation enhancement. The AGENTS.md bullet is being
updated because its content is factually wrong against the current
`label-criteria.json`, not because a passing workflow is being replaced; the
groom workflow and `resolve-model` activity continue to behave as they do
today when `GROOM_DEFAULT_MODEL` is unset.

## Decisions

### 1. Vendor-anchored grooming selection with no-label-when-matched

When no `model:*` label is already present on the issue, the groomer resolves
the **anchor model** as `GROOM_DEFAULT_MODEL || DEFAULT_MODEL` (same precedence
as the workflow fallback), infers its vendor
(`anthropic` / `openai` / `xai`) via the same `claude-*`-prefix /
explicit-allowlist rules the entrypoints use, and classifies the task's
complexity against the Task-Class Matrix in
[`docs/model-guidance.md`](../model-guidance.md).

Behavior from there:

- If the task's capability class matches the anchor model's class, the groomer
  **does not emit a `model:*` label**. The downstream workflows then fall
  through the generic / per-agent resolution waterfall to the anchor model
  via `DEFAULT_MODEL` (or `DESIGN_DEFAULT_MODEL` for design), honoring the
  configured preference.
- If the task's capability class differs from the anchor's class, the groomer
  emits exactly one same-vendor label from that task's Task-Class Matrix row.
  For an Anthropic anchor that is `sonnet` and a mechanical task class, this
  is `model:haiku`; for an OpenAI `gpt-5.6-terra` anchor and a plan task, this
  is `model:gpt-5.6-sol`.

The capability-class mapping used for the "matches" check is the Cross-Vendor
Class Table (`.github/scripts/data/model-classes.json` and the mirror section
in `docs/model-guidance.md`). This is the same table the review pairing
resolver already consumes; reusing it keeps grooming aligned with the rest of
the model-selection surface.

**Alternatives considered.** Option (c) in the issue (keep Anthropic fallback,
document that grooming overrides configured defaults) was rejected by the
maintainer's answer. Emitting the anchor's own label when the task matches was
rejected because any generic `model:*` label beats `DEFAULT_MODEL` in the
resolution waterfall, so re-emitting it would be redundant noise and would
make a later `DEFAULT_MODEL` change invisible to already-groomed issues.
Selecting across vendors on price alone was rejected because it duplicates
guidance already settled by `docs/model-guidance.md` and the maintainer's
answer explicitly scopes selection to the configured vendor.

### 2. Add `GROOM_DEFAULT_MODEL` as a parallel to `DESIGN_DEFAULT_MODEL`

A new `groom_default_model` Terraform input, exposed as the
`GROOM_DEFAULT_MODEL` Actions variable, lets a repository set a
grooming-specific default without changing `DEFAULT_MODEL`. The variable
follows the same shape and semantics as `design_default_model` added in
[Issue #670](https://github.com/mfrancza/agentic-development-workflow/issues/670):

- `string`, defaulting to `""` (empty), so repositories that omit the input
  continue to use `DEFAULT_MODEL` with no change.
- The `github_actions_variable` resource uses `count = var.groom_default_model
  == "" ? 0 : 1` so Terraform never creates an empty-string Actions variable
  (GitHub rejects those with HTTP 422).
- `terraform/modules/agent-vars` adds the variable, resource, and an
  `output "groom_default_model_variable_name"` that is `null` when the
  variable is not created.

The grooming reusable workflow changes `default-model: ${{ vars.DEFAULT_MODEL
}}` to `default-model: ${{ vars.GROOM_DEFAULT_MODEL || vars.DEFAULT_MODEL }}`,
following the exact pattern `agent-design.yml` already uses for
`DESIGN_DEFAULT_MODEL`. External consumers that have not set
`GROOM_DEFAULT_MODEL` keep their current behavior because the `||` operator
treats the absent-or-empty variable as falsy and falls through.

The anchor used by the groom prompt is **the same effective string** that is
passed to `resolve-model`. The container prompt reads this value from an
explicit env var (see Decision 4) rather than re-deriving it, so the policy
and the model actually running the groomer never disagree.

**Alternatives considered.** Overloading `DEFAULT_MODEL` to carry grooming
preferences was rejected because the maintainer asked for a dedicated
grooming default. Making the variable required or non-empty-by-default was
rejected because that would force every external consumer into a migration
before they can call the updated reusable workflow. Picking the anchor from
`AGENT_MODEL` inside the container was rejected because `AGENT_MODEL` is
influenced by per-agent `model:groom:*` labels; the anchor must come from the
workflow-level variables so it is stable regardless of per-run overrides.

### 3. Set this repository's `groom_default_model` to `haiku`

Grooming is a short, bounded classification pass: read the issue, read
`label-criteria.json` and `docs/model-guidance.md`, apply labels, and post one
comment. The current `DEFAULT_MODEL = sonnet` runs grooming on Sonnet, which
is more capability than the groomer needs. Setting `groom_default_model =
"haiku"` for this repository runs grooming on Haiku (Anthropic, same vendor
as `DEFAULT_MODEL`) and leaves the vendor anchor on Anthropic for the
label-selection step.

Because the anchor's **class** is now `haiku`, the vendor-anchor rule emits
`model:sonnet` or `model:opus` only when the task is clearly beyond mechanical
work, and emits nothing when the task is well-suited to Haiku. This matches
the task-class matrix guidance and makes the configured preference visible on
downstream runs.

**Alternatives considered.** Leaving `groom_default_model` unset was rejected
because the maintainer's grooming comment explicitly includes "adding a
default grooming model to the configuration in the scope." Setting
`groom_default_model = "sonnet"` was considered — it preserves the current
runtime cost — but it collapses to a no-op relative to `DEFAULT_MODEL` and
does not exercise the new mechanism in production. Choosing a different
vendor was rejected because the current `DEFAULT_MODEL` is Anthropic;
mismatching the grooming anchor from the implementation anchor would create
confusing cross-vendor labels on every issue.

### 4. Update the groom prompt and model-guidance.md to describe the new policy

The groom prompt (`docker/scripts/prompts/groom.md`) step 3 is rewritten to:

1. Preserve any existing `model:*` label (unchanged).
2. Resolve the anchor from an explicit env var the workflow passes in
   (`GROOM_VENDOR_ANCHOR_MODEL` — the same string the workflow fed into
   `resolve-model` as `default-model`), infer its vendor via the same
   `claude-*`-prefix / explicit-allowlist rules documented in
   [`docs/model-guidance.md`](../model-guidance.md) § "Provider Notes".
3. Classify the task using the Task-Class Matrix row for the issue's
   dominant task class. If the task's class matches the anchor's class
   (via the Cross-Vendor Class Table), emit no `model:*` label. Otherwise
   emit the single same-vendor label named in that matrix row.
4. If the anchor-inferred provider is not known to the container (unknown
   model identifier), fall back to posting a `question` and skip model
   selection, consistent with the existing "if preferences conflict, ask"
   stance.

`docs/model-guidance.md` § "Provider selection during grooming" step 2 is
rewritten to describe the vendor-anchor policy; the current "retain Anthropic
as the fallback" sentence is removed. A new short paragraph in § "Repo
Defaults" documents `GROOM_DEFAULT_MODEL` next to `DEFAULT_MODEL` and
`DESIGN_DEFAULT_MODEL`.

The grooming comment the agent posts on each run must now record **the
anchor model, its inferred vendor, the task class, and whether a label was
applied or omitted** — the current "provider, task class, and reason" line
is extended with the anchor to make the policy decision auditable from the
issue comments.

**Alternatives considered.** Deriving the anchor from `AGENT_MODEL` inside
the prompt was rejected (see Decision 2). Rewriting the entire
`label-criteria.json` to encode the vendor-anchor rule per label was rejected
because the criteria file is already a flat per-label description; the
anchor is a cross-label policy belonging in the prompt and the guidance doc.

### 5. Fix the AGENTS.md `model:<name>` bullet drift

The bullet is rewritten to describe the current multi-provider grooming
behavior and point at [`docs/model-guidance.md`](../model-guidance.md) rather
than restating the tier list in prose. The sentence "always one of the three
tier aliases, never a generic series tag or a pinned snapshot" is removed;
in its place, a one-sentence summary names the three provider families whose
labels appear in `label-criteria.json` and defers to the guidance doc for
selection rules. The reference to the vendor-anchor policy also lives here
so a reader does not need to open the guidance doc to see which
Actions variable governs grooming.

**Alternatives considered.** Deleting the groomer-behavior sentence entirely
was rejected because readers of AGENTS.md expect a one-line summary of what
each `model:*` label does; keeping the summary but pointing at the guidance
doc is the pattern used elsewhere in AGENTS.md (per the "Volatile facts live
at their sources" rule).

### 6. Retarget #461 criterion 7

Criterion 7 is updated to assert the current post-#567 invariant: that
`label-criteria.json` lists **exactly** the labels pre-provisioned by
`terraform/modules/labels/main.tf` under the three vendor families, in step
with any provider refresh PR. The precise shape of the assertion is written
as a cross-check against the Terraform-managed label set so a future refresh
cannot drift the criterion again. The existing evidence comments on #461
already describe the current lineup; the criterion edit lets the validation
task close cleanly after the Anthropic refresh PR lands.

**Alternatives considered.** Dropping criterion 7 entirely was considered but
rejected because the sweep is still a useful regression check — now against
the broader label set — and existing evidence comments reference it. Writing
a new sibling criterion was rejected because the issue is already open and
blocked by the stale wording; editing in place is the smallest change that
unblocks it.

## Out of scope

- Changing the resolution-waterfall tie-breaking for existing `model:*`,
  `model:<agent-type>:*`, or `REVIEWER_MODELS` labels. Those tiers continue
  to beat `GROOM_DEFAULT_MODEL` / `DEFAULT_MODEL` as they do today.
- Enabling, disabling, or editing `REVIEW_MODEL_PAIRING`. This design does
  not touch reviewer behavior.
- Retroactive relabeling of already-groomed open issues. The new policy
  applies to future grooming runs; existing labels are preserved by the
  "skip when any `model:*` label is present" rule the groomer already
  enforces.
- Introducing a cross-vendor "equivalence" mapping beyond the Cross-Vendor
  Class Table already consumed by the pairing resolver. If a future tier is
  added to one vendor and not another, the Task-Class Matrix remains the
  source of truth for grooming's per-row selection.
- Changing how the entrypoint infers the provider from the resolved model
  name, or the `resolve_provider()` allowlists for OpenAI and xAI.
- Terraform `apply` from an implementation PR. The repo keeps its existing
  Terraform CI workflow and operator-controlled apply.
- Any change to the Anthropic refresh validation task's non-criterion-7
  scope on Issue #461.

## Task breakdown

The first task adds the plumbing; the policy, prompt, and docs updates then
build on it. The AGENTS.md drift fix and the #461 criterion-7 amendment are
independent of the plumbing and can land in parallel. The tfvars opt-in and
the end-to-end validation close the loop after the plumbing is reviewable.

| Issue | Task | Dependencies |
|---|---|---|
| Issue #775 | Add `GROOM_DEFAULT_MODEL` Terraform input, agent-vars resource and output, module README entries, and reusable-workflow `default-model` fallback + explicit anchor env var passthrough. Add Vitest coverage mirroring the existing `DESIGN_DEFAULT_MODEL` tests. | — |
| Issue #776 | Rewrite `docs/model-guidance.md` § "Provider selection during grooming" step 2 to describe the vendor-anchor rule, add a `GROOM_DEFAULT_MODEL` entry under § "Repo Defaults", and update `docker/scripts/prompts/groom.md` step 3 to read the anchor env var, use the Cross-Vendor Class Table, and emit a label only when the task class differs from the anchor's class. Extend the grooming-comment template to record the anchor model, vendor, task class, and label outcome. | Issue #775 |
| Issue #777 | Rewrite the `model:<name>` bullet in `AGENTS.md` to describe current multi-provider grooming and point at `docs/model-guidance.md` instead of restating the tier list; remove the "always one of the three tier aliases" sentence. | — |
| Issue #778 | Retarget Issue #461 criterion 7 to assert the current post-#567 label-criteria lineup against the Terraform-managed label set rather than the obsolete three-alias invariant, and link the updated criterion to the `label-criteria.json` and `docs/model-guidance.md` sources. | — |
| Issue #779 | Set `groom_default_model = "haiku"` in `terraform/terraform.tfvars` to opt this repository into the new mechanism and keep grooming cheap while anchoring on Anthropic. | Issue #775 |
| Issue #781 | End-to-end validation: run `terraform validate` / `plan` with the new variable, exercise the grooming container locally against representative Anthropic / OpenAI / xAI anchor values, confirm the groomer emits no label when the task matches the anchor class and emits the correct same-vendor label when it does not, and verify that AGENTS.md, `docs/model-guidance.md`, `docker/scripts/prompts/groom.md`, and Issue #461 criterion 7 all describe the same policy. | Issues #775, #776, #777, #778, #779 |
