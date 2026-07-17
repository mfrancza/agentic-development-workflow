# Design: Multi-provider Terraform and workflow updates

**Issue:** [#82](https://github.com/mfrancza/agentic-development-workflow/issues/82)

**Parent:** [#75](https://github.com/mfrancza/agentic-development-workflow/issues/75) — see [`multi-provider-models.md`](multi-provider-models.md).

## Summary

Land the Terraform and workflow half of multi-provider support: rename the
Anthropic-branded `default_claude_model` / `DEFAULT_CLAUDE_MODEL` /
`CLAUDE_MODEL` names to the provider-neutral `default_model` / `DEFAULT_MODEL`
/ `AGENT_MODEL`, pre-provision `model:*` labels for the OpenAI models added to
the explicit allowlist, and thread both provider API keys through every agent
workflow so the container sees whichever key is set. This is the config /
plumbing half of #75; the entrypoint / runner half lives in #80 and #81.

## Requirements (from issue #82 and the parent design doc)

Issue #82 spells out four concrete deliverables, all of which trace back to
decisions already settled in [`multi-provider-models.md`](multi-provider-models.md):

1. **Terraform variable rename** — `default_claude_model` /
   `DEFAULT_CLAUDE_MODEL` become `default_model` / `DEFAULT_MODEL`, no
   compatibility shim (parent decision 3). `terraform.tfvars.example` is
   updated in the same pass.
2. **Terraform `model:*` labels for each OpenAI model in the explicit
   allowlist** — labels and allowlist stay one-to-one (parent decision 2).
   The exact OpenAI models are chosen at implementation time against
   OpenAI's current lineup (parent requirement 4).
3. **All agent workflows pass `DEFAULT_MODEL`, `AGENT_MODEL`,
   `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` to the container** — absent
   secrets simply arrive empty; the container validates the selected
   provider's key conditionally (parent decision 4).
4. **Documentation** — `gh secret set OPENAI_API_KEY` documented in the
   README secrets section, and AGENTS.md / README refreshed per *Keeping
   Documentation Current* to reflect the new variable / env-var names and
   the added secret.

### Resolved ambiguity: how many workflows is "all"?

The issue body and grooming notes say "all five agent workflows". The repo
currently has seven workflow files that build and run the agent image:
`agent-implement`, `agent-groom`, `agent-design`, `agent-fix-checks`,
`agent-fix-deployment`, `agent-respond-review`, and `agent-review`. The
"five" count predates the designer agent (#68) landing, and the parent
design's requirement 1 wording ("every developer-image action ... and the
reviewer image") is explicitly inclusive. **This design treats "all" as
literal: every workflow that runs a container image is updated.** Reviewer
image and designer workflow are not carve-outs — leaving either behind would
create a broken subset (e.g. a reviewer run on a `model:gpt-*` PR would fail
because `OPENAI_API_KEY` wouldn't be in scope).

## Decisions

Decisions that are already settled by the parent design doc — the runner
dispatch, the explicit model→provider map, the rename policy with no
compatibility shim, the "both keys always passed, container validates
conditionally" contract, the single-image-ships-both-CLIs approach — are
referenced, not re-argued. What follows is the decisions specific to the
Terraform / workflow / docs slice.

### Decision 1: land the rename as a single atomic PR, coordinate with #80 by merge timing

The rename crosses two independently-mergeable boundaries: Terraform (the
`vars.DEFAULT_MODEL` Actions variable and the `default_model` input) and
workflow YAML (`vars.DEFAULT_CLAUDE_MODEL` → `vars.DEFAULT_MODEL` in seven
files, plus `CLAUDE_MODEL` → `AGENT_MODEL` in the env-var pass-through). If
Terraform lands first, workflows read a now-missing Actions variable and
resolve `vars.DEFAULT_CLAUDE_MODEL` to the empty string (silent
misbehaviour). If workflows land first, they reference
`vars.DEFAULT_MODEL` before Terraform creates it (same failure mode).

Three options were considered:

- **(a) One atomic sub-issue covering Terraform + all workflows + docs**
  *(chosen)*. One PR, one `terraform apply`, one merge — no window in
  which the two halves disagree. This is the shape the parent design doc
  already assumed ("All five workflows and both entrypoints change together
  in one PR"), just scoped to the non-entrypoint half.
- **(b) Split into a Terraform-only sub-issue and a workflows-only
  sub-issue with a strict merge order.** Adds a broken window between
  merges — during that window every workflow silently reads an empty
  model name. Rejected: the fail-loud-on-ambiguous-input security default
  in AGENTS.md is specifically about *not* letting an empty / missing
  input silently propagate.
- **(c) Temporary shim in workflows that falls back
  `vars.DEFAULT_MODEL || vars.DEFAULT_CLAUDE_MODEL`.** Adds a shim the
  parent design explicitly rejected (decision 3: "no compatibility shims;
  the repo is the only consumer"). Rejected.

Coordination with **#80** (entrypoint `CLAUDE_MODEL` → `AGENT_MODEL`
rename): #80 renames the env var the container reads; #82 renames the env
var the workflow passes. Between the two merges one side will pass a name
the other doesn't recognise. Because both PRs are small and touch disjoint
files, the mitigation is merge-timing: both PRs must be review-ready before
either merges, and they merge in immediate succession (either order —
whichever lands first breaks runs for the few minutes until the other
lands). The parent design doc's grooming note calls this out explicitly.
An alternative — folding #80 and #82 into a single PR — was considered and
rejected because it would double the review surface and cross two agents'
scopes (the entrypoint and workflow changes touch different parts of the
codebase, are reviewed against different concerns, and are natural PR-sized
units on their own).

### Decision 2: separate the OpenAI `model:*` labels into their own sub-issue

Adding `model:*` labels is purely additive Terraform (`local.automation_labels`
gains entries; `github_issue_label.automation` picks them up via `for_each`).
It touches only `terraform/main.tf` and does not depend on — or block — any
other file in this scope. It also carries a small implementation-time
research task (surveying OpenAI's current model lineup) that shouldn't
gate the rename.

Alternative: bundle labels into the atomic rename PR from decision 1. Rejected
— the rename PR is already large (seven workflows plus Terraform plus docs);
labels can review and land in parallel.

The label set the sub-issue lands is not fixed by this design (per parent
decision 2 and requirement 4 — models useful for software tasks, chosen
against OpenAI's current lineup). The sub-issue body directs the
implementer to enumerate OpenAI's current coding-capable chat models
(GPT-5 family, GPT-4.1 family, and o-series reasoning models as of the
implementation date), pick the subset intended to be routable via
`model:*`, and add one label per chosen model. Each label's `description`
follows the existing convention (e.g. *"Run agents on this issue with
OpenAI GPT-5 (overrides DEFAULT_MODEL)."*) — note the rename from
`DEFAULT_CLAUDE_MODEL` in the description text too.

### Decision 3: workflow secret plumbing — always pass both keys, unconditionally

Every workflow's `Run agent` (or `Run reviewer agent`, `Run grooming agent`,
etc.) step gains one env line and one `-e OPENAI_API_KEY` in the `docker run`
command:

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  OPENAI_API_KEY:    ${{ secrets.OPENAI_API_KEY }}
  # ... other envs ...
run: |
  docker run --rm \
    -e ANTHROPIC_API_KEY \
    -e OPENAI_API_KEY \
    ...
```

An absent `OPENAI_API_KEY` repository secret resolves to the empty string in
`${{ secrets.OPENAI_API_KEY }}` — GitHub Actions does not fail the expression
for a missing secret, it just returns empty. The container gets
`OPENAI_API_KEY=` (empty), which the entrypoint (per parent decision 4) only
validates when the selected model routes to the OpenAI provider. This
matches the "workflows pass both secrets unconditionally — absent secrets
simply arrive empty" contract from the parent design.

Alternative: gate `OPENAI_API_KEY` behind a conditional
(`if env.OPENAI_API_KEY != ''`). Rejected because the conditional would
have to live at the workflow level (before the container starts), and it
would either duplicate the model→provider map into every workflow YAML
(fragile) or unnecessarily add complexity without changing behaviour (the
container-side validation is the single source of truth per parent
decision 4).

The same env line is added to **all seven** workflows — designer and
reviewer included — since a `model:*` label on a designer issue or a
reviewer PR must be able to route to OpenAI too.

### Decision 4: also rename `CLAUDE_MAX_TURNS` → `AGENT_MAX_TURNS` where it appears

Parent decision 3 groups the `CLAUDE_MAX_TURNS` rename with the
`CLAUDE_MODEL` rename. Repo-wide grep at design time: no workflow file
currently references `CLAUDE_MAX_TURNS` (workflows rely on the
container's internal default of `100`). The rename shows up only in
container-side code (#80's scope) and in one AGENTS.md sentence and one
README snippet listing the optional env vars. This design covers the
docs half of that rename; the container-side half is #80.

If any workflow gains a `CLAUDE_MAX_TURNS: ${{ ... }}` reference between
now and the implementation of this sub-issue, the implementer renames it
to `AGENT_MAX_TURNS` in the same pass.

### Decision 5: README updates — one new secret line and a batch rename

The README secrets section (§3) gains one line:

```bash
# Required for OpenAI-model runs (agent-implement / agent-groom / etc.
# invoked with a model:<openai-name> label). Optional if only Anthropic
# models are used — workflows pass both secrets and the container
# validates only the provider actually selected for the run.
gh secret set OPENAI_API_KEY --body "<openai api key>"
```

Every other README / AGENTS.md occurrence of `DEFAULT_CLAUDE_MODEL`,
`CLAUDE_MODEL`, or `default_claude_model` is renamed in the same PR:

- `AGENTS.md`: the `Optional: CLAUDE_MODEL ...` line, the `model:*` label
  description "overrides `DEFAULT_CLAUDE_MODEL`", the
  reviewer-image env line, and the *Keeping Documentation Current*
  bullet naming Terraform variables.
- `README.md`: the setup command block referencing `default_claude_model`
  in `terraform.tfvars`, the "Terraform will publish `AGENT_ALLOWLIST`
  and `DEFAULT_CLAUDE_MODEL`" bullet, the local-run `docker run`
  snippets showing `-e CLAUDE_MODEL="sonnet"`, and the status bullet
  listing repo-level Actions variables.

The merge-friendly documentation guidance in AGENTS.md ("no
implementation-status notes in prose", "prefer bullets over numbered
lists", "one fact per line") applies to every edit — the rename is a
mechanical find-and-replace, not an occasion to restructure surrounding
prose.

## Out of scope

- **Entrypoint changes** — `run_agent()` dispatch, provider inference, and
  container-side conditional key validation live in #80. This sub-tree
  only renames the env var passed into the container; the container-side
  consumer of that name is #80's contract.
- **Codex CLI in the Dockerfiles** — #81.
- **Reviewer entrypoint runner dispatch** — #83.
- **End-to-end validation across providers** — parent design's #84. The
  e2e sub-issue here (task 3) only validates the plumbing this design
  covers: variable / env-var / secret names reach the container in every
  workflow. Cross-provider agent runs are #84's remit.
- **Choice of specific OpenAI models** — deliberately deferred to the
  label sub-issue's implementer per parent decision 2. This design does
  not enumerate them.
- **Compatibility shims of any kind** — parent decision 3.
- **Per-workflow default-model overrides** ("use `haiku` for grooming") —
  parent design's out-of-scope list; unchanged here.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#167](https://github.com/mfrancza/agentic-development-workflow/issues/167) | Terraform + all seven workflows + docs: `default_model` / `DEFAULT_MODEL` / `AGENT_MODEL` rename, `OPENAI_API_KEY` pass-through, README `gh secret set` line, AGENTS.md / README refresh. One atomic PR. | — (coordinate merge timing with #80) |
| [#168](https://github.com/mfrancza/agentic-development-workflow/issues/168) | Terraform: add `model:*` labels for each OpenAI model in the explicit allowlist. Enumerate OpenAI's current coding-capable lineup at implementation time (parent decision 2). | — |
| [#169](https://github.com/mfrancza/agentic-development-workflow/issues/169) | End-to-end validation of the plumbing: confirm every workflow passes `DEFAULT_MODEL` / `AGENT_MODEL` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` to the container in a real run; `terraform plan` clean after label additions; docs match rendered behaviour. | #167, #168 |

Issues #167 and #168 are independent and can proceed in parallel — #167
touches workflow YAML + `variables.tf` + `main.tf`'s
`github_actions_variable.default_claude_model` block; #168 touches only
`main.tf`'s `local.automation_labels` map. Issue #169 depends on both
landing, and its execution assumes #80 has also landed (so `AGENT_MODEL`
is actually consumed by the container).

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
