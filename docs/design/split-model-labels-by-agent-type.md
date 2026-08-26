# Design: Split Model Labels by Agent Type

**Issue:** [#44](https://github.com/mfrancza/agentic-development-workflow/issues/44)

## Summary

The repo currently uses three generic model labels — `model:opus`, `model:sonnet`,
`model:haiku` — which override `DEFAULT_CLAUDE_MODEL` identically for every agent
that processes an issue. This design adds per-agent-type variants
(`model:groom:opus`, `model:developer:sonnet`, etc.) so a single issue can assign
different models to different agent types, while the generic labels remain as an
issue-wide fallback default that keeps the common case simple.

## Requirements (from issue #44 and grooming Q&A)

1. **Per-agent-type model labels.** New labels follow the convention
   `model:<agent-type>:<model>` (e.g. `model:developer:opus`,
   `model:groom:haiku`). This naming was confirmed in the grooming Q&A.

2. **All active agent types are covered:** `groom`, `design`, `developer`,
   and `review`. Agents that respond to feedback on a developer-authored
   artifact — `fix-checks`, `respond-review`, and `fix-deployment` — are
   treated as the same type as the developer agent and resolved against
   `model:developer:*` labels. Confirmed in the grooming Q&A: "agents that
   are responding to feedback should use the same tag as the agent that
   generated the artifact (eg same tag used when authoring pr and responding
   to reviews of it)."

3. **Generic labels become the issue-wide fallback.** The existing
   `model:opus`, `model:sonnet`, and `model:haiku` labels are kept. They
   are now the "default for the issue" — a fallback that applies to all
   agents when no per-agent override is present. Confirmed in the grooming
   Q&A (Q3 answer: "Default for the issue").

4. **Resolution waterfall.** For any agent run: (a) use the per-agent label
   if present; (b) otherwise use the generic label if present; (c) otherwise
   use `vars.DEFAULT_CLAUDE_MODEL`.

## Design

### Decision 1: Per-agent naming — `model:<agent-type>:<model>`

**Decision:** Use `model:<agent-type>:<model>` as the label name pattern.

**Rationale:** Settled in the grooming Q&A. The `model:` prefix keeps all
model-related labels visually grouped in the GitHub label picker. The
`<agent-type>` segment uses the same identifiers as the `agent:*` trigger
labels (`groom`, `design`, `developer`, `review`), making the mapping
intuitive. A single colon separates the two name segments, consistent with
the existing `model:*` and `agent:*` conventions.

**Alternative considered:** `model:<agent-type>/<model>` or a slash
separator — rejected; it diverges from the colon-separator convention
already established by every other structured label in this repo.

### Decision 2: Generic labels as issue-wide fallback, not deprecated

**Decision:** Keep `model:opus`, `model:sonnet`, and `model:haiku` as
manually-applied issue-wide defaults. The grooming agent will emit
per-agent `model:groom:*` labels (e.g. `model:groom:haiku`) instead of
generic labels. Per-agent labels for other agent types are set manually
when a specific agent-type override is needed.

**Rationale:** The grooming agent knows it is performing a groom step, so
emitting a `model:groom:*` label is appropriate — it directly controls the
model for that step without inadvertently setting an issue-wide default for
all other agents. This makes the common case — one model for the whole
issue — still require only one label: the generic `model:*` label remains
available for humans to apply as an issue-wide default when desired.

**Alternative considered:** Make the grooming agent emit per-agent labels
for all four types instead of a generic one — rejected because the groomer
cannot reason about which agent types will process the issue or whether
they warrant different models.

**Alternative considered:** Deprecate and remove generic labels entirely,
requiring per-agent labels for every override — rejected; the common case
(one model for all agents) would require four labels instead of one, and
the grooming Q&A explicitly keeps them as the issue default.

### Decision 3: Feedback agents share the `developer` type

**Decision:** `agent-fix-checks`, `agent-respond-review`, and
`agent-fix-deployment` all resolve their model using `model:developer:*`
labels (with generic `model:*` fallback) from the originating issue.

**Rationale:** Settled in the grooming Q&A. All three actions handle
feedback on developer-agent work; using the same model type as the developer
agent is consistent and expected. It also avoids adding new agent-type
identifiers (`fix-checks`, `respond-review`) that users would need to know
about.

**Implementation note for fix-checks and respond-review:** These workflows
currently pass `vars.DEFAULT_CLAUDE_MODEL` to the container directly without
reading any issue labels. Gaining per-agent model support requires them to
look up the originating issue's labels. The issue number is extracted from
the PR body's `Closes #N` reference — the same pattern `agent-fix-deployment`
already uses (see `agent-fix-deployment.yml` "Resolve deployment to workflow
run + issue" step). If no `Closes #N` is found, fall through silently to
`DEFAULT_CLAUDE_MODEL`, matching current behavior.

### Decision 4: Two-tier validation — fail loud at each tier

**Decision:** Each workflow validates independently:
1. At most one `model:<agent-type>:*` label for the relevant agent type is
   present — fail loud if multiple.
2. At most one generic `model:*` label (a label whose name matches
   `model:[^:]+$` — no second colon) is present — fail loud if multiple.

A combination of one per-agent label and one generic label on the same issue
is valid and expected.

**Rationale:** Inherits the "fail-loud on ambiguous input" security default
documented in `AGENTS.md`. Users who accidentally apply two per-agent labels
of the same type get a clear error rather than silent ordering-dependent
behavior.

**jq filter pattern:** The generic-label tier uses `test("^model:[^:]+$")`
rather than `startswith("model:")`. The negated second-colon check prevents
per-agent labels from accidentally matching the generic tier if a workflow's
logic is ever reordered. The per-agent tier uses
`test("^model:<agent-type>:")`, e.g. `test("^model:developer:")`.

### Decision 5: Inline logic per workflow — no composite action

**Decision:** The updated two-tier model resolution is inlined in each
workflow's "Resolve model" step rather than extracted into a shared composite
action at `.github/actions/resolve-model`.

**Rationale:** Follows the precedent in the multi-provider-models design
(`docs/design/multi-provider-models.md`, Decision 2): "The case statement
is duplicated once per image … with a comment noting the twin." The resolution
logic is ~15 lines of shell per workflow. A composite action would require a
workspace checkout for the workflows that currently avoid one (the
`undraft-sub-issues` job in `agent-design.yml` deliberately skips checkout
for security reasons), adding risk without payoff. If the logic grows
substantially (e.g. a third fallback tier), extraction can be revisited.

**Alternative considered:** Composite action — rejected (see rationale above).

## New label inventory

Twelve new per-agent labels; existing generic labels are unchanged.

| Label | Agent type | Model |
|-------|-----------|-------|
| `model:groom:haiku` | groom | haiku |
| `model:groom:sonnet` | groom | sonnet |
| `model:groom:opus` | groom | opus |
| `model:design:haiku` | design | haiku |
| `model:design:sonnet` | design | sonnet |
| `model:design:opus` | design | opus |
| `model:developer:haiku` | developer | haiku |
| `model:developer:sonnet` | developer | sonnet |
| `model:developer:opus` | developer | opus |
| `model:review:haiku` | review | haiku |
| `model:review:sonnet` | review | sonnet |
| `model:review:opus` | review | opus |

## Affected workflows

| Workflow | Agent type | Label source | Behavior change |
|----------|-----------|-------------|----------------|
| `agent-implement.yml` | `developer` | issue | Check `model:developer:*` first, then `model:[^:]+$` |
| `agent-groom.yml` | `groom` | issue | Check `model:groom:*` first, then `model:[^:]+$` |
| `agent-design.yml` | `design` | issue | Check `model:design:*` first, then `model:[^:]+$` |
| `agent-fix-deployment.yml` | `developer` | issue (already resolved) | Check `model:developer:*` first, then `model:[^:]+$` |
| `agent-review.yml` | `review` | PR labels | Check `model:review:*` on PR first, then `model:[^:]+$` on PR |
| `agent-fix-checks.yml` | `developer` | issue (looked up from PR) | Add issue lookup via `Closes #N`; check `model:developer:*` then `model:[^:]+$` |
| `agent-respond-review.yml` | `developer` | issue (looked up from PR) | Add issue lookup via `Closes #N`; check `model:developer:*` then `model:[^:]+$` |

## Grooming agent: emit per-agent `model:groom:*` label

The grooming agent will be updated to emit `model:groom:haiku`,
`model:groom:sonnet`, or `model:groom:opus` instead of the generic
`model:haiku`, `model:sonnet`, or `model:opus`. This makes the groomer's
label step-specific — it directly controls the model used for the groom
step itself without implying an issue-wide default for other agents.

The skip condition in `agents/grooming/label-criteria.json` needs updating:
the groomer should skip only if a `model:groom:*` label is already present.
A generic `model:*` or other per-agent label on the issue should not block
the groomer from applying its own step-specific label (those are orthogonal).

The criteria file's `action` descriptions will be updated to emit
`model:groom:<model>` labels and to reflect that per-agent overrides can
coexist with manually-applied generic fallback labels.

## Out of scope

- **Per-agent-type default model at repo level** — a separate Actions variable
  per agent type (e.g. `DEFAULT_GROOM_MODEL`). `DEFAULT_CLAUDE_MODEL` remains
  the single final fallback for all agents.
- **New agent types beyond the current four** — additional types follow the
  same pattern when added.
- **Retroactive relabeling of open issues** — existing generic labels continue
  to work as the fallback tier without any migration.
- **Multi-provider model name support in per-agent labels** — the per-agent
  label format is provider-neutral (e.g. `model:developer:gpt-5-codex` works
  once the OpenAI runner from issue #75 lands), but no new provider-specific
  work is done here.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#147](https://github.com/mfrancza/agentic-development-workflow/issues/147) | Terraform: add 12 per-agent model labels; update `AGENTS.md` labels section and `terraform/variables.tf` description | — |
| [#148](https://github.com/mfrancza/agentic-development-workflow/issues/148) | Issue-based workflow model resolution: update `agent-implement.yml`, `agent-groom.yml`, `agent-design.yml`, `agent-fix-deployment.yml` to the two-tier waterfall | — |
| [#149](https://github.com/mfrancza/agentic-development-workflow/issues/149) | PR-based workflow model resolution: update `agent-review.yml`; add issue lookup + two-tier resolution to `agent-fix-checks.yml` and `agent-respond-review.yml` | — |
| [#150](https://github.com/mfrancza/agentic-development-workflow/issues/150) | Grooming criteria update: update `agents/grooming/label-criteria.json` to emit `model:groom:*` labels instead of generic `model:*` labels; update skip condition to block only on an existing `model:groom:*` label; update action descriptions | — |
| [#151](https://github.com/mfrancza/agentic-development-workflow/issues/151) | End-to-end validation: apply a per-agent label (e.g. `model:developer:haiku`) alongside a generic label (e.g. `model:sonnet`) on a test issue; confirm each agent run picks up the correct model; confirm the grooming agent emits a `model:groom:*` label rather than a generic label; confirm fallback when only generic label is present | Issues #147, #148, #149, #150 |

Issues #147–#150 are fully independent and can proceed in parallel. Issue #151
(end-to-end validation) depends on all four implementation tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
