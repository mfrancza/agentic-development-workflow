# Design: Allow multiple reviewer agents to be specified

**Issue:** [#449](https://github.com/mfrancza/agentic-development-workflow/issues/449)
**Parent designs:** [code-review-agent.md](code-review-agent.md) (Issue #27),
[reviewer-container.md](reviewer-container.md) (Issue #39),
[re-review-loop.md](re-review-loop.md) (Issue #41),
[reviewer-supersede-stale-verdict.md](reviewer-supersede-stale-verdict.md) (Issue #267),
[split-model-labels-by-agent-type.md](split-model-labels-by-agent-type.md) (Issue #44),
[pr-workflow-model-resolution.md](pr-workflow-model-resolution.md) (Issue #149).

## Requirements as understood

Issue #449 asks that a PR enrolled via `agent:review` be reviewable by more
than one reviewer agent, so that a single PR can receive independent reviews
from — for example — different models or different vendors. Today the flow
runs exactly one reviewer container per push: the `agent-review` workflow
resolves a single model via the two-tier waterfall in `resolve-model`
(`model:review:*` → generic `model:*` → `vars.DEFAULT_MODEL`) and runs
`docker/reviewer/` once.

The issue's grooming Q&A (recorded on the issue) makes four design questions
explicit and asks that they be resolved before implementation begins:

1. **Configuration surface** — how to name the reviewer set; whether it
   lives in Terraform, as a repo-level Actions variable, or both; whether the
   set is overridable per-PR via labels.
2. **Identity** — whether all reviewers post under the existing
   `reviewer-agent` App identity (disambiguated by model in the body) or
   whether distinct GitHub Apps are warranted; interaction with the
   `agent-respond-review` review-author gate and the thread-resolution
   handoff.
3. **Loop semantics** — how the re-review loop, the stale-verdict supersede
   from #267, the terminal `APPROVE` condition, and the respond-review
   dispatch guard behave when there are N reviewers instead of one.
4. **Cost controls** — N reviewers multiplies review spend per push; the
   feature must be opt-in and fail-safe when unset.

Grooming also asks the design to leave a hook for a future "pair policy"
(the model-pair preference issue) that would auto-populate the reviewer set
from the implementer model rather than requiring explicit configuration —
without implementing that policy here.

### Ambiguities resolved

- **What is a "reviewer" in the set?** A `(model, provider)` tuple. Provider
  is inferred from the model name by `resolve_provider()` in
  [`docker/reviewer/entrypoint.sh`](../../docker/reviewer/entrypoint.sh),
  exactly as it is today. This design does not introduce a separate
  per-reviewer provider field.
- **Does "multiple reviewers" imply distinct GitHub Apps?** No — see
  Decision 2. The design keeps a single reviewer App identity and
  disambiguates by model in the review body. Distinct Apps remain a future
  option that this design does not preclude.
- **Does the terminal condition require unanimous `APPROVE`?** In practice
  yes: the loop guard in `agent-respond-review.yml` needs to prevent a
  developer-agent response only when the just-submitted event carries no
  actionable feedback. That check is per-review (approve + zero unresolved
  threads), and it naturally composes across N reviewers without a global
  "all reviewers approved" quorum computation. See Decision 4.
- **Grooming notes ask whether developer responds "once per reviewer or to
  the union of findings".** Per-review dispatch is retained; the developer
  container already reads the whole PR's outstanding thread state when it
  runs, so a per-review trigger effectively acts on the union. Adding a
  synthetic "batch complete" event has no basis in GitHub's event model.
  See Decision 4.

## Decisions

### Decision 1 — Configuration surface: Terraform-managed `REVIEWER_MODELS` list, per-PR label override, single-reviewer fallback

**Decision.** Introduce a new Terraform variable
`reviewer_models` (list of strings) that lands as a JSON-encoded repository
Actions variable **`REVIEWER_MODELS`**, provisioned by the existing
`terraform/modules/agent-vars/` module. Default: `[]` (feature disabled;
single-reviewer mode preserved).

**Reviewer-set resolution** for a given `agent-review` run, in order:

1. **Per-PR label override.** If the PR carries one or more
   `model:review:*` labels, the reviewer set is exactly those labels — one
   reviewer per label. Two `model:review:opus` and `model:review:gpt-5`
   labels on a PR produce two reviewers (Opus + GPT-5). This is a
   deliberate relaxation of today's single-`model:review:*` fail-loud rule
   (see the compatibility note below).
2. **Repo-wide list.** Otherwise, if `vars.REVIEWER_MODELS` is non-empty,
   use its list verbatim. This is the multi-reviewer opt-in.
3. **Single-reviewer fallback.** Otherwise, resolve a single reviewer by
   the existing two-tier waterfall (generic `model:*` on the PR →
   `vars.DEFAULT_MODEL`). Exactly the behavior in place today. This makes
   the feature strictly additive on repos that never set
   `REVIEWER_MODELS`.

**Rationale.** Following the `AGENT_ALLOWLIST` / `AUTO_TRIGGER_AGENTS` /
`CODE_REVIEWERS` pattern (Terraform variable → JSON-encoded Actions
variable) keeps configuration in the same place operators already look for
per-workflow policy and preserves fail-safe-when-unset semantics — an
un-set variable renders as `''`, and workflows guard with the standard
`vars.REVIEWER_MODELS != ''` shape before invoking `fromJSON()`. Preserving
the single-reviewer waterfall as the fallback means this design ships as an
opt-in with zero behavior change for repos that do not adopt it.

**Alternatives considered.**

- **Comma-separated string Actions variable, no Terraform.** Rejected on
  consistency grounds: every other multi-value knob in the repo
  (`AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, `CODE_REVIEWERS`,
  `AUTO_TRIGGER_AGENTS`) is JSON-encoded via Terraform. A raw comma string
  also invites shell-escaping bugs in the workflow layer.
- **Repo variable only; no per-PR override.** Rejected as too coarse.
  Grooming explicitly asks for per-PR override, and reviewers are exactly
  the kind of ad-hoc-per-PR choice that operators want to make from the
  PR UI (e.g. "this PR is architectural — add Opus for this one").
- **Per-PR override only; no repo default.** Rejected because it forces
  every PR that wants multi-reviewer to carry N labels; the common case
  (same reviewer set for every PR) should be one Terraform edit.
- **Per-reviewer opt-in map keyed by model (`REVIEWER_ENABLE`).** Rejected
  as premature. A list is enough for the MVP; a map (with per-reviewer
  toggles, timeouts, cost limits) can layer on later without changing the
  workflow contract.
- **Extend `AUTO_TRIGGER_AGENTS`** with a `reviewer_models` sub-key.
  Rejected: `AUTO_TRIGGER_AGENTS` is specifically about auto-labelling
  gates, not runtime configuration for a workflow that has already
  triggered.

**Compatibility note.** The current `resolve-model` action fails loudly
when more than one `model:review:*` label is present on a PR (Tier-1
single-match rule in `resolve-model.ts`). This design changes that
constraint for the `review` agent type only: multiple `model:review:*`
labels now specify a reviewer set. Generic `model:*` labels retain their
single-match rule; per-agent labels for other agent types
(`model:developer:*`, `model:groom:*`, `model:design:*`) also retain
their single-match rule.

**Pair-policy hook (out-of-scope future work).** The model-pair preference
issue is described as building on this one. A future "pair policy" activity
would compute a reviewer set from the PR's implementer model
(e.g. Anthropic implementer → OpenAI + xAI reviewers). It slots into the
waterfall above as a new tier between (2) and (3): the pair policy is
consulted when no per-PR override is present and no `REVIEWER_MODELS` is
set. This design deliberately does not add the tier itself; the resolver
activity is designed to accept a future `pair-policy` input without a
breaking change.

### Decision 2 — Identity: single reviewer App, model disambiguated in the review body

**Decision.** All reviewer containers, regardless of matrix leg or model,
post their reviews under the existing `mfrancza-reviewer-agent[bot]` App
identity. Each review body must lead with a machine-parseable header
identifying the model, of the form:

```
<!-- reviewer-model: <AGENT_MODEL> -->
### Review by `<AGENT_MODEL>`

<review body follows>
```

The HTML comment lets downstream automation (and future policies such as
per-model dismissal or per-model thread grouping) recognise the model
without changing the visible content; the visible heading disambiguates
the review at a glance in the PR UI when multiple reviewers post against
the same head SHA.

**Rationale.** Provisioning one GitHub App per model is a per-operator
setup cost (a fresh App per model, private key rotation, allowlist entries)
that outweighs the benefit — the workflow already keys off `commit_id` and
review timestamp for uniqueness, and the review body is under our control
for the disambiguating header. Keeping one identity also means:

- The `agent-respond-review` review-author gate
  ([`.github/workflows/agent-respond-review.yml`](../../.github/workflows/agent-respond-review.yml))
  does not need per-model allowlist entries; the existing entry
  (`mfrancza-reviewer-agent[bot]`) covers all matrix legs.
- The thread-resolution hand-off in
  [`agent-review-reusable.yml`](../../.github/workflows/agent-review-reusable.yml)
  is unchanged in shape — the workflow's `GITHUB_TOKEN` resolves threads
  that any matrix leg recorded for resolution.
- The `viewer.login` lookup in the reviewer entrypoint and in
  `dismiss-stale-reviewer-reviews` returns one login value across all
  legs; the existing verify-a-review-exists check in
  `docker/reviewer/entrypoint.sh` (matching `user.login == REVIEWER_LOGIN`
  and `commit_id == HEAD_SHA`) continues to succeed for the leg that just
  ran, because it counts reviews and does not require uniqueness.

**Alternatives considered.**

- **One GitHub App per model** (e.g. `reviewer-agent-anthropic`,
  `reviewer-agent-openai`, `reviewer-agent-xai`). Rejected for MVP:
  operator cost is real (each App requires manual creation, private-key
  secret, allowlist update) and the disambiguation problem it solves is
  addressable in the review body. Nothing in this design blocks a future
  design from introducing per-model Apps — the reviewer-set resolver
  could be extended with a `{model, app-id, app-key}` tuple and the
  matrix leg could pick the right token source.
- **Distinct App per provider, not per model.** Same operator burden with
  less disambiguation; rejected on the same grounds.
- **Suffix the review body but not lead with a heading.** Rejected because
  the disambiguation must be visible in GitHub's PR-review summary card,
  which shows the first line of the body.

### Decision 3 — Workflow shape: matrix fan-out inside `agent-review-reusable.yml`

**Decision.** Refactor `agent-review-reusable.yml` so the existing single
`review` job becomes a matrix job. A new preflight job (or a preflight
step in the same job before the matrix expansion) computes the reviewer
set once per workflow run and emits it as a JSON array; the matrix
consumes it via `strategy.matrix.include: ${{ fromJson(needs.resolve.outputs.set) }}`.
Each matrix leg carries out the full existing per-leg chain:

1. Mint a reviewer-agent installation token (each leg mints its own; the
   short-lived token cost is negligible and keeps leg failures isolated).
2. `dismiss-stale-reviewer-reviews` — see Decision 5 for the amended
   filter.
3. `run-agent` with `image-tag: agent-reviewer:ci` and per-leg
   `output-dir`/`resolve-threads-file` paths (per-leg output isolation:
   `${{ runner.temp }}/reviewer-output-${{ strategy.job-index }}`).
4. `upload-artifact` — log artifact name includes the model name so both
   legs' logs are individually downloadable
   (`agent-logs-review-pr-<N>-<model>-run-<run_id>-<attempt>`; the model
   name is passed through `env:` and slugified in a shell step to keep
   Actions-filename-safe characters).
5. `resolve-review-threads` — reads the leg's own resolve-threads file
   only, using the workflow `GITHUB_TOKEN` (unchanged from today).

**Matrix job strategy.** `fail-fast: false` so one reviewer's failure does
not cancel the others (each reviewer is independent; a Claude API outage
for one provider must not silence another provider's review). Concurrency
group remains per-PR at the workflow level; matrix legs share the group
because they belong to one workflow run.

**Empty-set guard.** If the reviewer-set resolver returns an empty array
(should not happen because the fallback always yields at least
`vars.DEFAULT_MODEL`), the preflight fails loudly with an `::error::`
message. Silent no-op would leave a labelled PR with no reviewer at all —
worse than the loud failure the repo prefers for ambiguous input.

**Alternatives considered.**

- **Loop inside the reviewer container.** Rejected: a single container
  running N models serialises the work (increasing wall-clock latency),
  couples all N reviewers to one runner OOM/timeout, and complicates
  per-model log capture. Matrix legs give parallelism, isolation, and
  per-leg logs for free.
- **Separate workflow files per reviewer.** Rejected: N workflow files
  duplicate the trust-model checks that today live once in the caller
  stub; the drift risk is high, and the operator would need to enable N
  workflows.
- **A caller stub that invokes the reusable N times with different
  inputs.** Rejected on the same duplication grounds; the matrix does
  exactly this within one reusable.

### Decision 4 — Loop semantics with N reviewers

Four sub-decisions, all of which fall out of "each reviewer is
independent, keyed on head SHA":

**4a. Terminal condition — per-reviewer independent verdicts.** Each
matrix leg posts its own verdict for the current head SHA. There is no
synchronization between legs and no quorum check inside the workflow.
The re-review loop terminates when there is nothing left to trigger it:
either the human removes `agent:review`, the developer stops pushing, or
every subsequent event carries no actionable feedback and the respond-
review guard skips.

**Rationale.** A cross-leg quorum ("dispatch developer only when N of M
reviewers request changes") would require a new synchronization point
that GitHub's event model does not provide. The existing per-review
dispatch, augmented with the guard below, gives the desired behavior for
free: a clean-approval event by any reviewer with no outstanding threads
skips the developer; a changes-requested event by any reviewer wakes the
developer to address the finding.

**4b. Respond-review dispatch guard — stale-SHA skip.** Update
[`check-reviewer-feedback`](../../.github/scripts/src/check-reviewer-feedback.ts)
to accept the PR's current head SHA as an input and to skip immediately
when the incoming `review.commit_id` does not match. This addresses the
multi-reviewer race:

- Reviewer A posts CHANGES_REQUESTED at T1 for HEAD_SHA<sub>1</sub>.
- `agent-respond-review` starts; the developer fixes and pushes
  HEAD_SHA<sub>2</sub> at T3.
- Reviewer B's review event (posted at T2 against HEAD_SHA<sub>1</sub>)
  was queued behind A's respond-review by the per-PR concurrency group
  (`cancel-in-progress: false`). It fires at T4; its `commit_id` is
  HEAD_SHA<sub>1</sub>, which no longer matches HEAD_SHA<sub>2</sub> →
  skip cleanly.

The guard is defensive in the single-reviewer case too (a manual push in
the window between review and dispatch produces the same race) and
tightens the loop without disturbing the existing decision flow.

Feed the head SHA from the caller stub via a new
`inputs.head-sha: ${{ github.event.pull_request.head.sha }}` on the
reusable and threading it through the `check-reviewer-feedback`
composite. Fail-open on any error resolving the head SHA — the existing
guard already fails open on its API errors and this addition follows
the same posture.

**4c. Stale-verdict supersede (#267) generalises via SHA filter.** The
existing `dismiss-stale-reviewer-reviews` action dismisses CHANGES_REQUESTED
reviews authored by the reviewer bot. With N legs all under one identity,
a naive dismissal would delete a sibling leg's just-posted verdict for
the current head SHA. Amend the dismissal filter to also require
`commit_id !== HEAD_SHA` before dismissing. In effect, dismiss only
CHANGES_REQUESTED reviews that are stale in the strict sense (posted
against an earlier head SHA), never a fresh sibling review on the
current head. Add `head-sha` as a required input to the
`dismiss-stale-reviewer-reviews` composite action and thread it through
the reusable. This preserves the intent of #267 (stop reviewer hedging
because a stale blocking verdict is still on file) while making the
behavior safe under matrix concurrency.

The #267 prompt-level clarification in
[`docker/reviewer/prompts/review.md`](../../docker/reviewer/prompts/review.md)
also needs a small extension: when a sibling reviewer has already posted
a verdict against the same head SHA under the same bot identity, that
verdict is not "my prior verdict" — each leg evaluates the diff
independently and posts its own verdict. Include the current
`AGENT_MODEL` in the prompt context (already available via the entrypoint
context header) and instruct the prompt to attribute prior same-SHA
reviews to the sibling model.

**4d. Respond-review dispatch remains per-review, not per-push.** The
alternative would be to trigger the developer once per push (after all N
reviewers finish) rather than once per review event. GitHub emits no
"all reviewers submitted" event, so per-push aggregation would require
either polling or a debouncing timer — both add complexity for little
gain. The per-review dispatch, plus the stale-SHA guard from 4b, plus
the existing "zero unresolved threads" skip, cover the observed cases
cleanly:

- Multiple approvals in quick succession — each fires, each skips on
  zero-unresolved-threads.
- Mixed approve + changes-requested — the changes-requested fires the
  developer; the approval skips.
- Reviewer posts after the developer's fix push has already superseded
  the reviewed SHA — stale-SHA guard skips.

### Decision 5 — Cost controls: opt-in, per-reviewer accounted, no hard cap

**Decision.**

- **Opt-in.** `REVIEWER_MODELS` defaults to `[]`; no PR sees more than
  one reviewer until an operator sets it (or applies multiple
  `model:review:*` labels to a specific PR). This matches the
  `AGENT_ALLOWLIST` / `AUTO_TRIGGER_AGENTS` fail-safe-when-unset
  convention.
- **No hard per-PR cap.** The upper bound is the size of
  `REVIEWER_MODELS` (an operator-controlled Terraform edit) or the
  number of `model:review:*` labels a human chooses to apply. A soft
  warning is logged when the resolved set has more than 3 reviewers
  ("Resolved reviewer set has N reviewers; each push will fan out to N
  parallel review passes and spend ~N× review cost").
- **Spend visibility.** Every reviewer container already logs its
  resolved model and provider (see
  [`docker/reviewer/entrypoint.sh`](../../docker/reviewer/entrypoint.sh)
  around the `Model: ${AGENT_MODEL}` log line). With per-leg log
  artifacts named after the model, per-model cost attribution from
  the token-usage lines in `container.log` requires no new tooling.

**Alternatives considered.**

- **Hard cap enforced in the resolver.** Rejected: a workflow-level hard
  cap encourages operators to work around it (e.g. cycle the label
  between pushes) rather than accept the underlying cost. A soft warning
  makes the tradeoff visible; a hard cap makes it opaque.
- **Per-reviewer enablement toggle map** (`REVIEWER_ENABLE`). Rejected as
  premature (see Decision 1 alternatives).

### Decision 6 — Documentation touch-ups

- **`AGENTS.md`** — extend the `agent:review` label bullet with a short
  description of the reviewer-set resolution (per-PR label override →
  `REVIEWER_MODELS` → single-tier waterfall → `vars.DEFAULT_MODEL`),
  including the note that multiple `model:review:*` labels on a PR now
  define a reviewer set (a deliberate relaxation of the previous
  single-`model:review:*` fail-loud rule). Add `REVIEWER_MODELS` to the
  Terraform-managed Actions variables list under **Keeping Documentation
  Current**. Add a one-sentence note that all reviewer containers post
  under the single reviewer App identity, disambiguated by a
  `### Review by <model>` header in each review body.
- **`README.md`** — mention `reviewer_models` in the setup section
  alongside `agent_allowlist`, `code_reviewers`, and
  `auto_trigger_agents`, with a note that the default (empty list)
  preserves single-reviewer behavior.
- **`terraform/modules/agent-vars/README.md`** — describe the new
  variable and its JSON-encoded Actions counterpart, following the
  existing entries for `agent_allowlist`, `admin_assignees`,
  `code_reviewers`, and `auto_trigger_agents`.
- **`docs/design/re-review-loop.md`** — add an **Amended (Issue #449)**
  note under Decision 3 recording that the loop guard now also gates on
  `review.commit_id == head_sha` and pointing readers to this document
  for the multi-reviewer context.
- **`docs/design/reviewer-supersede-stale-verdict.md`** — add an
  **Amended (Issue #449)** note under Decision 2 recording that
  dismissal now also filters on `commit_id != HEAD_SHA` and pointing
  readers to this document for the multi-reviewer context.

## Out of scope

- **Pair policy / model-pair implementer-to-reviewer selection.** This
  design leaves the resolver structure open to a future pair-policy tier
  (Decision 1) but does not implement it.
- **Distinct GitHub App identities per model or per provider.** Decision 2
  keeps the single reviewer App identity; a per-model App is a possible
  future evolution that this design does not block, but does not build.
- **Quorum-based dispatch semantics** ("wait for M of N approvals before
  dispatching"). Decision 4a keeps per-review dispatch; a quorum layer
  would require a new event-aggregation mechanism outside GitHub's
  native model.
- **Auto-removing `agent:review` on terminal APPROVE from all reviewers.**
  Orthogonal to this design; the label lifecycle is handled by whoever
  removes it (human today, potentially automation in a future issue).
- **Per-reviewer timeouts / cost caps** beyond the soft warning in
  Decision 5. A future map-shaped configuration can add these without a
  breaking change.
- **Cross-PR reviewer selection policies** (e.g. rotate reviewers by
  weekday, spread cost across a team). All out of scope; the design
  provides the mechanism, not the policies.
- **Per-model thread grouping in the GitHub UI.** GitHub does not offer
  per-author thread grouping; the disambiguation is purely textual (see
  Decision 2).
- **Changes to the reviewer container's read-only clone posture,
  no-write guarantee, or provider inference.** All preserved as-is.

## Task breakdown

Sub-issues are single-PR-sized. The tasks are largely independent files
(Terraform, a new activity, the workflow refactor, two existing activity
amendments, a prompt edit, docs); the end-to-end validation depends on
the workflow refactor, both activity amendments, and the prompt edit.

| Issue | Task | Depends on |
|-------|------|-----------|
| [#462](https://github.com/mfrancza/agentic-development-workflow/issues/462) | Terraform: add `reviewer_models` variable + `REVIEWER_MODELS` Actions variable in `terraform/modules/agent-vars/` per Decision 1; extend `terraform/variables.tf`, `terraform/main.tf`, `terraform/terraform.tfvars.example`, and the module `README.md` | — |
| [#464](https://github.com/mfrancza/agentic-development-workflow/issues/464) | New `resolve-reviewer-set` composite action + TypeScript activity + Vitest tests per Decision 1: applies the waterfall (per-PR `model:review:*` labels → `REVIEWER_MODELS` → single-reviewer fallback via existing waterfall → `DEFAULT_MODEL`); output is a JSON `[{model}]` array shaped for `strategy.matrix.include` | — |
| [#465](https://github.com/mfrancza/agentic-development-workflow/issues/465) | Amend `dismiss-stale-reviewer-reviews` to require a `head-sha` input and only dismiss CHANGES_REQUESTED reviews whose `commit_id !== head-sha` per Decision 4c; extend tests to cover the sibling-leg race case | — |
| [#466](https://github.com/mfrancza/agentic-development-workflow/issues/466) | Amend `check-reviewer-feedback` to accept a `head-sha` input and skip immediately when `review.commit_id !== head-sha` per Decision 4b; thread the head SHA through `agent-respond-review.yml` and the reusable; extend tests | — |
| [#467](https://github.com/mfrancza/agentic-development-workflow/issues/467) | Reviewer prompt (`docker/reviewer/prompts/review.md`) update per Decisions 2 and 4c: every review body leads with `<!-- reviewer-model: <AGENT_MODEL> --> ### Review by <AGENT_MODEL>`; sibling-SHA verdicts by the same bot identity are attributed to the sibling model and do not bias the current pass | — |
| [#468](https://github.com/mfrancza/agentic-development-workflow/issues/468) | Refactor `agent-review-reusable.yml` to a matrix per Decision 3: preflight `resolve-reviewer-set`, matrix job with `fail-fast: false`, per-leg output/resolve-threads paths, per-leg log artifact names, soft warning when the set has >3 reviewers; thread `head-sha` through to `dismiss-stale-reviewer-reviews` | Issue #464, Issue #465 |
| [#471](https://github.com/mfrancza/agentic-development-workflow/issues/471) | Documentation per Decision 6: `AGENTS.md` (label bullet, `REVIEWER_MODELS` in the doc-update list, single-App identity note), `README.md` (Terraform variable), `terraform/modules/agent-vars/README.md` (new variable), and **Amended (Issue #449)** notes on `docs/design/re-review-loop.md` and `docs/design/reviewer-supersede-stale-verdict.md` | Issue #462, Issue #466, Issue #468 |
| [#473](https://github.com/mfrancza/agentic-development-workflow/issues/473) | End-to-end validation on a real PR with `REVIEWER_MODELS=["sonnet", "gpt-5"]`: apply `agent:review`, verify two parallel review passes post under one bot identity with the `### Review by <model>` header; push a fix and confirm both reviewers re-review the new SHA; confirm stale reviews from the prior SHA are dismissed while fresh sibling reviews are not; verify the respond-review stale-SHA guard skips stale review events; verify per-PR label override (`model:review:opus` + `model:review:gpt-5`) supersedes the repo variable | Issue #465, Issue #466, Issue #467, Issue #468 |

Issues #462, #464, #465, #466, and #467 can proceed in parallel — each
touches an independent surface (Terraform module, new activity, two
existing activities, one prompt file). Issue #468 depends on the resolver
activity (#464) existing and on the dismissal activity's amended input
shape (#465). Issue #471 depends on the final workflow shape being
merged, so that the documentation reflects the shipped state. Issue #473
exercises the full multi-reviewer loop end-to-end and is expected to
feed small fixes back into the implementation tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
