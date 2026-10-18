# Design: Adjust Repository Model Preferences

**Issue:** [#669](https://github.com/mfrancza/agentic-development-workflow/issues/669)

## Requirements as understood

Issue #669 asks to change this repository's model policy in three ways:

1. use the current OpenAI sonnet-tier model as the repo-wide default;
2. use an opus-tier model for the design agent; and
3. run corresponding OpenAI and xAI reviewers in parallel.

The grooming comments identify `gpt-5.6-terra` as the current OpenAI
sonnet-tier default and ask whether the reviewer request means a parallel
multi-vendor set, which Grok model to select, and whether design should use
`gpt-5.6-sol` or the premium `gpt-6-astra`. No later comment answers those
questions, so this design resolves them from the repository's authoritative
guidance and existing configuration:

- `default_model` becomes `gpt-5.6-terra`.
- Design uses `gpt-5.6-sol`. The task-class matrix in
  [`docs/model-guidance.md`](../model-guidance.md) names it as the normal
  OpenAI model for plans and design, while `gpt-6-astra` is an escalation
  candidate rather than an automatic default.
- `reviewer_models` becomes `["gpt-5.6-terra", "grok-4.6"]`. This is a
  two-reviewer set, consistent with grooming's interpretation and the
  existing `REVIEWER_MODELS` matrix fan-out. The same guidance names
  `gpt-5.6-terra` and `grok-4.6` for standard multi-file code review.

The first and third settings already have Terraform inputs. The design-agent
preference does not: `agent-design.yml` currently passes `vars.DEFAULT_MODEL`
as its final fallback, so changing the global default alone would also make
design run on Terra. Issue-level `model:design:*` labels are overrides for
individual issues, not a durable repository preference.

This is a policy/configuration enhancement, not a response to a workflow
runtime failure. No passing workflow expression is being replaced because of
a schema or lint warning.

## Decisions

### 1. Add a design-specific repository fallback

Add a nullable/empty-by-default Terraform input named `design_default_model`
and publish it through `terraform/modules/agent-vars/` as the repository
Actions variable `DESIGN_DEFAULT_MODEL`. The repository's
`terraform/terraform.tfvars` sets it to `gpt-5.6-sol`.

The `agent-design.yml` caller passes
`${{ vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL }}` to the reusable
workflow's existing `default-model` input. The reusable workflow and shared
`resolve-model` action remain unchanged. Resolution therefore becomes:

1. `model:design:*` label;
2. generic `model:*` label;
3. `DESIGN_DEFAULT_MODEL` when configured, otherwise `DEFAULT_MODEL`.

Keeping the fallback selection in the trusted caller also preserves the
reusable workflow's external-consumer interface: callers continue to supply a
single `default-model`, and no upstream-repository variable is implicitly read
inside the reusable.

**Alternatives considered.** Applying `model:design:gpt-5.6-sol` to every
design issue was rejected because labels are per-issue overrides and the
requested policy must apply automatically to future issues. Hard-coding
`gpt-5.6-sol` in workflow YAML was rejected because repository policy belongs
in Terraform-managed Actions variables. A map covering defaults for all agent
types was rejected as unnecessary scope: Issue #669 requests only a distinct
design default, while the remaining agents should continue to share
`DEFAULT_MODEL`.

### 2. Preserve existing override precedence and backward compatibility

`DESIGN_DEFAULT_MODEL` is only the design workflow's final fallback. Existing
per-agent and generic issue labels keep their precedence, including arbitrary
provider-specific values accepted by the resolver. The Terraform variable
defaults to an empty string and the workflow expression falls back to
`DEFAULT_MODEL`, so repositories that consume these workflows without setting
the new value retain their current behavior.

The implementation updates the root and module variable declarations, module
wiring, Actions-variable resource and output, examples, module documentation,
and repository guidance describing the resolution waterfall. Focused tests or
static assertions should cover both a configured design default and the empty
backward-compatible path.

**Alternatives considered.** Making the new variable required was rejected
because it would impose an unrelated migration on every consumer. Inserting a
new tier into the shared `resolve-model` activity was rejected because the
activity already receives the correct final fallback as an input; teaching it
about repository variables would couple reusable logic to one caller's policy.

### 3. Configure reviewers through `reviewer_models`, not labels or pairing

Set the existing repo-specific `reviewer_models` value to
`["gpt-5.6-terra", "grok-4.6"]`. The established reviewer-set waterfall gives
`model:review:*` PR labels higher precedence and otherwise fans out every entry
in `REVIEWER_MODELS` in parallel. Both entrypoints and the run-agent action
already route `gpt-*` to OpenAI and the provisioned `grok-4.6` identifier to
xAI, forwarding only the matching provider key.

No new labels, resolver behavior, workflow topology, or provider routing are
needed. `review_model_pairing` remains disabled: it selects a single reviewer
relative to the authoring model and is not the requested fixed two-reviewer
set.

**Alternatives considered.** New `model:review:gpt-*` and
`model:review:grok-*` labels were rejected because labels are per-PR overrides,
whereas `REVIEWER_MODELS` already represents the repo-wide set. Pairing policy
was rejected because it produces a contextual single-model fallback rather
than two reviewers. `grok-4.5` was considered because the class table groups it
with sonnet-tier models, but `docs/model-guidance.md` recommends `grok-4.6` for
standard multi-file code review; task-specific review guidance wins over the
generic capability-class grouping.

### 4. Apply all repo policy values together after the new variable exists

The repo configuration task changes `default_model`,
`design_default_model`, and `reviewer_models` in one reviewable
`terraform/terraform.tfvars` update. It depends on the design-default
infrastructure so `terraform validate` and `terraform plan` never encounter an
unknown input. Applying remains the operator-controlled Terraform workflow;
the implementation does not bypass it with `gh variable set`.

**Alternatives considered.** Splitting each value into its own issue was
rejected because the three values form one requested policy and a partial
apply would produce a surprising mixed state. Directly mutating GitHub Actions
variables was rejected because Terraform is their source of truth.

## Out of scope

- Per-agent defaults for grooming, development, conflict resolution, check
  repair, deployment repair, or review response.
- New model labels, changes to grooming's model-selection behavior, or
  retroactive relabeling of open issues.
- Changes to provider inference, API-key permissions, container entrypoints,
  prompts, reviewer identity, or reviewer matrix semantics.
- Enabling or changing `REVIEW_MODEL_PAIRING`.
- Re-evaluating the model catalog, capability classes, pricing, or vendor
  availability beyond the checked-in guidance used to resolve this issue.
- Applying Terraform from an implementation PR or changing branch protection.

## Task breakdown

| Issue | Task | Dependencies |
|---|---|---|
| [#670](https://github.com/mfrancza/agentic-development-workflow/issues/670) | Add the backward-compatible `DESIGN_DEFAULT_MODEL` Terraform/Actions-variable plumbing, wire the design caller's fallback, update operator/repository documentation, and add focused validation. | — |
| [#671](https://github.com/mfrancza/agentic-development-workflow/issues/671) | Set this repository's default, design, and parallel reviewer model preferences in `terraform/terraform.tfvars`. | Issue #670 |
| [#672](https://github.com/mfrancza/agentic-development-workflow/issues/672) | End-to-end validation: validate/plan Terraform and verify default, design-label override, legacy fallback, and two-provider reviewer fan-out behavior. | Issues #670 and #671 |

The first task establishes the reusable capability. The configuration task
then opts this repository into it. The final task depends on both and validates
the complete policy without applying or merging changes itself.
