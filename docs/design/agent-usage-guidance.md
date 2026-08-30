# Design: Agent Usage Guidance Guidelines

**Issue:** [#262](https://github.com/mfrancza/agentic-development-workflow/issues/262)

## Summary

Produce a single, evidence-backed repo document that codifies which model
tier the agents should use for which type of task, then wire that document
into the grooming agent's decision loop and the repo-wide defaults. The
guidelines are the source of truth for both humans (who apply `model:*`
labels manually or read the doc when reviewing a labeled issue) and the
grooming agent (which selects a tier alias when no `model:*` label is
already present).

Today the tier-selection rules live only inside
[`agents/grooming/label-criteria.json`](../../agents/grooming/label-criteria.json)
as short prose per label. They are terse, undocumented in provenance
(no citations, no examples, no repo history), and duplicated across the
three `model:*` entries. That has worked so far because there are only
three tiers and one grooming agent, but the issue explicitly asks for a
written guidance artifact so future maintainers (and future models) can
understand *why* a tier is preferred and not just *when*.

## Requirements (from issue #262 and its grooming Q&A)

1. **Guidance is evidence-backed.** The document must draw on published
   model benchmarks (Anthropic's own model card, SWE-Bench Verified,
   MMLU-Pro, HumanEval, etc.), on this repo's own model-label history
   (which tier was applied to which issue class and whether it succeeded),
   and on the opinions of trustworthy engineering sources (Anthropic docs,
   community write-ups).
2. **A guidance document exists.** The artifact is a Markdown file in the
   repo — not just prose scattered across `AGENTS.md`, prompt files, and
   the criteria JSON.
3. **Defaults are aligned.** The repo-wide `DEFAULT_MODEL` Actions
   variable and any per-workflow default value in
   `.github/workflows/agent-*.yml` are reviewed against the guidance and
   updated if the current setting disagrees.
4. **Grooming agent uses the guidance.** The grooming criteria file
   and/or the `groom.md` prompt is updated so the agent reads the guidance
   at run time and applies it when selecting a `model:*` label.

The issue body is one sentence; the grooming Q&A comment infers a
three-phase scope (research → document → configure → wire in). I treat
that inferred scope as the working brief because it matches what "create
guidance guidelines" plainly means in this repo's vocabulary. Where the
Q&A comment leaves choices open, decisions are called out below.

## Design

### Decision 1: One repo-level Markdown file, not per-label JSON prose

**Decision.** Create a new document at
[`docs/model-guidance.md`](../model-guidance.md) that is the single
source of truth for tier selection. The
[`agents/grooming/label-criteria.json`](../../agents/grooming/label-criteria.json)
`model:*` entries stay short — one-line description plus a pointer to
the guidance doc — so the JSON does not drift against the doc and the
doc has room for evidence, examples, and history.

**Alternatives considered.**

- *Grow the criteria JSON in place.* The `criteria` field of each
  `model:*` entry would become a paragraph with embedded examples and
  benchmark citations. Rejected: JSON is a poor host for prose with
  links, tables, and multi-line examples; every criteria change becomes
  a JSON-escaping chore; and the file is loaded verbatim into the
  grooming prompt, so expanding it inflates every grooming run's token
  count linearly.
- *Fold the guidance into `AGENTS.md`.* Rejected: `AGENTS.md` is already
  the omnibus conventions doc, and the merge-friendly notes at its
  bottom explicitly warn against adding large blocks of prose that
  future PRs will conflict on. A dedicated `docs/model-guidance.md`
  behaves like the design docs already do — one topic per file, cleanly
  linkable from many places.
- *Put it under `agents/` next to `label-criteria.json`.* Rejected: the
  document is not agent-only. Humans applying `model:*` labels manually
  are a first-class audience; `docs/` is where repo-wide policy docs
  already live.

The location `docs/model-guidance.md` mirrors the placement of
`docs/design/*.md` — repo-level context that both agents and humans
read.

### Decision 2: Structure of the guidance document

The document is not freeform — this design fixes its top-level shape so
the grooming agent can rely on stable anchors. Required sections:

1. **Tier summary.** A short table with columns *Tier alias*, *Series
   floor* (the current stable series each alias resolves to at time of
   writing), *When to reach for it*, *Rough latency/cost profile*, and
   *Repo-standard default?*. The `model:sonnet` row is marked as the
   repo default; the other two are exceptions.
2. **Task-class matrix.** A table from *task class* to *tier*, with an
   example issue from this repo's history for each row. Task classes
   are drawn from the classification labels the grooming agent already
   applies (`bug`, `enhancement`, `dependency upgrade`, `do`, `plan`)
   plus a small set of concrete flavors (e.g. "docs-only enhancement",
   "single-file config bump", "cross-cutting refactor", "new agent
   type"). The example column is populated by the research task and
   linked by issue number, so a reader can click through and see the
   tier working (or not) in practice.
3. **Evidence.** A short section citing:
   - Anthropic's public model card / docs for capability tier
     descriptions and cost-latency data.
   - One public coding-focused benchmark (SWE-Bench Verified) and one
     general-knowledge benchmark (MMLU-Pro or a successor) as
     order-of-magnitude anchors, not as precise decision inputs. The
     document explicitly warns against over-fitting on any single
     benchmark score.
   - This repo's model-label-to-outcome history for the last N closed
     issues (measurement task, decision 3 below), summarised as a
     paragraph — not a per-issue log.
   - One or two community sources (Anthropic engineering blog posts,
     "how we use Claude" write-ups from other public projects). The
     research task picks these; this design does not pre-pick citations
     so we do not link to a source that has since gone stale.
4. **Decision heuristics.** A short bulleted list a groomer (or a
   human) can read in ten seconds: e.g. "if in doubt between two
   tiers, pick the smaller one for `do` issues and the larger one for
   `plan` issues"; "docs-only changes are always haiku unless they
   touch security-sensitive prose"; "any issue that will produce a
   design doc is opus".
5. **Provider notes.** A short section that acknowledges the tier
   aliases are Anthropic-specific and points at
   [`docs/design/multi-provider-models.md`](multi-provider-models.md)
   for the cross-provider label story. Explicitly out of scope for this
   design (see decision 6).
6. **Change log.** A dated bullet list of guidance updates (initial
   version; any later revision). Not a git-log substitute — this
   captures *why* the guidance shifted (e.g. "moved 'dependency
   upgrade' from sonnet to haiku after 10/10 haiku PRs merged
   cleanly"), which is the fact humans actually need when the guidance
   moves under them.

This is a *shape*, not a filler-in-the-blanks template. The research
task has latitude to reorganize within the section, add subsections,
or drop a section if its content is trivially empty (e.g. no revisions
yet → no change log entry beyond "initial version"). But the six named
sections are the contract other files link to, so their headings must
exist verbatim.

### Decision 3: Repo history is measured, not narrated

**Decision.** The research task pulls the last ~50 closed issues
(bounded so the query does not sprawl), records for each: the labels
present at close, whether the resulting PR merged, whether a human had
to intervene (as evidenced by `human-required` or a request for changes
that agents could not resolve), and the model tier that ran. It
summarises the findings in a paragraph in the *Evidence* section of the
guidance doc — not as a raw table dump. The raw query and the summary
paragraph both live in the doc; the query is reproducible.

**Rationale.** The historical signal is genuinely useful (this design's
own quick scan already showed `plan`-labeled issues almost always got
opus, `do`-labeled issues almost always got sonnet, with a handful of
`haiku` picks that were correctly trivial). Codifying it as a bounded,
reproducible query means future revisions can rerun the same
measurement rather than argue about it. Bounding at ~50 keeps the
sample large enough to catch tier-mismatch patterns without producing
a table that is out of date the moment it lands.

**Alternative considered.** A rolling automated dashboard that keeps
the measurement live — rejected as out of scope; the guidance doc is
policy, and policy does not need per-day telemetry. If the pattern
shifts materially, a maintainer reruns the query and updates the doc.

### Decision 4: Grooming agent reads the guidance doc at run time

**Decision.** Extend `docker/scripts/prompts/groom.md` step 3 with an
additional read of `docs/model-guidance.md` (the same file every
grooming run has in its working directory after checkout). The
grooming criteria JSON keeps its short `criteria` field but adds a
`guidance` field per `model:*` entry with the exact pointer text
("See `docs/model-guidance.md` — Tier summary and Task-class matrix"),
so the criteria file is still self-describing without duplicating the
doc's contents.

**Rationale.** The grooming prompt already directs the agent to
`agents/grooming/label-criteria.json` and to fetch the issue's current
labels; adding one more Read is a token-cheap way to give it the full
task-class matrix and the decision heuristics. The `model:*` skip
condition (any existing `model:*` label wins) stays exactly as it is —
the guidance doc's role is to inform the initial pick, not to override
human choices.

**Why not embed the guidance in the criteria JSON.** Already argued in
decision 1 — inflates every run's prompt and duplicates the doc.

**Why not point at the doc from the prompt only and skip the criteria
change.** The criteria file is the reference humans open first when
they want to know "what does the groomer look at"; leaving no reference
to the guidance doc in it creates a confusing split.

### Decision 5: Repo-wide default stays `sonnet`; per-workflow defaults are audited but not preemptively changed

**Decision.** The audit task confirms that the repo-wide `DEFAULT_MODEL`
Actions variable value ("sonnet", set in
[`terraform/variables.tf`](../../terraform/variables.tf)) aligns with the
guidance and leaves it in place. The audit checks the eight workflow
files under `.github/workflows/agent-*.yml` that pass `DEFAULT_MODEL`
through to the container (`agent-implement`, `agent-groom`,
`agent-design`, `agent-review`, `agent-resolve-conflicts`,
`agent-fix-checks`, `agent-fix-deployment`, `agent-respond-review`) and
records — as a bulleted paragraph in the guidance doc's *Provider notes*
or a new *Repo defaults* subsection — the current default for each
workflow and whether it matches the guidance. If any workflow's default
disagrees with the guidance (none does today), the audit task opens a
follow-up issue rather than changing the default in the same PR as the
guidance doc.

**Rationale.** Changing a workflow default is a policy change that
should stand on its own PR, not ride in on a docs-and-guidance PR — the
review conversation for a default change is about cost and latency
trade-offs, not about writing quality. Auditing without changing keeps
this PR reviewable and gives a maintainer a clean handle if they want
to promote a different tier per workflow later.

**Alternative considered.** Introduce per-workflow default Actions
variables (e.g. `DEFAULT_GROOM_MODEL`, `DEFAULT_REVIEW_MODEL`) so the
guidance can pin different defaults per stage. Rejected as premature:
issue [#44](https://github.com/mfrancza/agentic-development-workflow/issues/44)'s
per-agent `model:*:*` label design already covers per-agent overrides
at the issue level. Adding another layer of per-agent defaults before
that design's sub-issues (#147–#151) even land would be duplicative
and confusing.

### Decision 6: Anthropic tiers only; cross-provider mapping deferred

**Decision.** The guidance doc is written in terms of the three
Anthropic tier aliases (`model:haiku`, `model:sonnet`, `model:opus`)
and treats the cross-provider label story
([`docs/design/multi-provider-models.md`](multi-provider-models.md),
[`docs/design/grok-models.md`](grok-models.md)) as a see-also link
rather than expanding tier semantics across providers.

**Rationale.** The grooming agent only ever picks tier aliases (settled
by decision 4 of
[`docs/design/anthropic-model-labels.md`](anthropic-model-labels.md)),
so the tier-alias framing is exactly the framing the grooming agent
needs. OpenAI and xAI model IDs do not share a tier vocabulary, and
inventing one would either be a per-provider policy call (which
belongs in a separate design) or would tie one provider's model naming
to another's release cadence (which drifts).

**Alternative considered.** A "provider-neutral" tier taxonomy (e.g.
`tier:fast`, `tier:balanced`, `tier:reasoning`) with per-provider
mappings. Rejected: the tier aliases already play that role for
Anthropic, and no comparable operational need exists for the OpenAI
or xAI runners today (they are used opportunistically for capability
comparison, not as the day-to-day default). Revisit when a
non-Anthropic provider becomes a serious default candidate.

## Out of scope

- **Per-workflow default model changes.** The audit is in scope
  (decision 5); actually changing a default is a separate PR.
- **Per-agent `model:*:*` labels.** Covered by
  [`docs/design/split-model-labels-by-agent-type.md`](split-model-labels-by-agent-type.md);
  its sub-issues (#147–#151) remain the vehicle for that work. The
  guidance doc references them but does not implement or block on
  them.
- **Cross-provider tier taxonomy.** See decision 6.
- **Automated benchmark ingestion.** The document cites benchmarks by
  URL and interpretation, not by an ingested score table that has to
  be kept fresh.
- **A live tier-mismatch dashboard.** See decision 3; the historical
  measurement is a one-shot summary, not an ongoing telemetry stream.
- **Retroactive relabeling of open issues.** The guidance applies going
  forward; existing labels are left alone.
- **`AGENTS.md` restructuring.** The Labels section of `AGENTS.md`
  gains a one-line pointer to `docs/model-guidance.md` (part of the
  wire-up task), but the existing tier-alias descriptions there stay
  as-is — the guidance doc is the deep-dive, `AGENTS.md` is the index.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#334](https://github.com/mfrancza/agentic-development-workflow/issues/334) | Research + write `docs/model-guidance.md` per decisions 1–3 (tier summary, task-class matrix populated with real issue examples, evidence section including a bounded ~50-issue repo-history summary, decision heuristics, provider notes, change log). Document the reproducible history query in the evidence section. | — |
| Issue [#336](https://github.com/mfrancza/agentic-development-workflow/issues/336) | Wire the guidance into the grooming agent: add a `guidance` field to each `model:*` entry in `agents/grooming/label-criteria.json` pointing at `docs/model-guidance.md`, and update `docker/scripts/prompts/groom.md` step 3 so the agent reads the guidance doc alongside the criteria file when selecting a `model:*` label. Preserve the existing "if any `model:*` label is present, skip" behavior. | #334 |
| Issue [#337](https://github.com/mfrancza/agentic-development-workflow/issues/337) | Audit repo-wide and per-workflow defaults against the guidance (decision 5). Confirm `DEFAULT_MODEL=sonnet` is aligned. For each of the eight `.github/workflows/agent-*.yml` files, record the current default in a *Repo defaults* subsection of the guidance doc. If any default disagrees with the guidance, open a follow-up issue rather than changing it here. Add a one-line pointer to `docs/model-guidance.md` from the Labels section of `AGENTS.md` and from `README.md`. | #334 |
| Issue [#340](https://github.com/mfrancza/agentic-development-workflow/issues/340) | End-to-end validation: open a test issue with no `model:*` label, apply `agent:groom`, verify the groomer applies the tier alias the guidance predicts for that issue's class. Open a second test issue with a pre-applied `model:*` label and verify the groomer does not overwrite it. Attach the two runs' log artifacts to the validation PR / comment. | #336, #337 |

Issue #334 is on the critical path; #336 and #337 are independent of
each other but both depend on the doc existing. #340 validates the
whole loop.

Dependencies are recorded natively as GitHub blocked-by relationships
on the issues.
