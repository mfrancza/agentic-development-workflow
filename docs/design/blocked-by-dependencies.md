# Design: Respect blocked-by dependencies in agent workflows and auto-trigger

**Issue:** [#299](https://github.com/mfrancza/agentic-development-workflow/issues/299)

## Summary

Teach the SDLC automation to read the native GitHub blocked-by relationships
so that:

1. `agent-implement.yml` and `agent-design.yml` **fail loudly** when they
   are asked to run against an issue that still has open blockers — a
   misapplied `agent:developer` / `agent:design` label is a mistake, not a
   silent skip.
2. `agent-auto-trigger.yml` **withholds `agent:developer`** at the two
   developer transitions (`issues.labeled do`, `issues.unlabeled draft`)
   while blockers remain open, and marks the deferred issue with a new
   `blocked` label so the state is visible and machine-readable.
3. A new `auto-developer-unblock` job in `agent-auto-trigger.yml` fires on
   `issues.closed`, walks the closing issue's `blocking` list, and applies
   `agent:developer` to any newly-unblocked issue that had been deferred —
   keeping the sub-issue tree self-driving with no manual re-labeling.

No agent container, prompt, or entrypoint changes. The developer-agent App
already has the Issues (R/W) scope required to read the dependency
endpoints and to add/remove labels.

## Requirements (from issue #299 grooming Q&A)

1. **Fail-loud preflight.** `agent-implement.yml` and `agent-design.yml`
   query `GET repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` and
   exit non-zero (red run, not a `skip`) when any blocker is open. The
   grooming notes explicitly call this out: a human or agent applying the
   trigger label to a blocked issue is a mistake that should be visible.
2. **Trigger-time deferral.** The auto-trigger jobs `auto-developer-do`
   and `auto-developer-undraft` check the same endpoint before applying
   `agent:developer`, and **genuinely withhold** the label — not
   apply-and-let-preflight-skip — when blockers remain. This preserves the
   `labeled` event for the un-block cascade to re-fire later.
3. **Unblock cascade.** On `issues.closed`, walk `GET
   repos/{owner}/{repo}/issues/{n}/dependencies/blocking` on the closed
   issue and, for each blocked issue whose remaining blockers are now all
   closed and which is groomed-ready (see Decision 3), apply
   `agent:developer` to start implementation.
4. **Event-consumption trap avoidance (issue #284).** GitHub does not emit
   a `labeled` event when `--add-label` is applied to a label that is
   already present. Requirement 2 must therefore **not** apply
   `agent:developer` and rely on the preflight to skip — that would
   consume the one-shot event and permanently strand the cascade. The
   design must record the deferred state in a way the cascade can
   re-drive.

## Decisions

### Decision 1: A new `blocked` marker label records the deferred state

**Decision.** Add a Terraform-managed `blocked` label (grey, matching the
`draft` visual convention) applied by transitions #3 and #4 in
`agent-auto-trigger.yml` when the target issue has open blockers. Its
semantics: "auto-trigger deferred pending blocker closure; the un-block
cascade will apply `agent:developer` once all blockers close." The
un-block cascade removes `blocked` and applies `agent:developer` in the
same job.

**Why this works.** Requirement 4 rules out the "apply the label and let
the preflight skip" pattern because `agent:developer` becomes a
non-event-emitting attribute of the issue and the cascade has no way to
re-fire it. A separate marker label is the smallest state change that
satisfies both (a) the trap avoidance and (b) the need for the cascade to
identify which issues it should re-drive.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| No marker: cascade re-evaluates every un-drafted / `do` issue on every close | Requires post-hoc reconstruction of "was this issue previously eligible for transition #3 or #4?" — un-drafted sub-issues no longer carry `draft`, and transition #4 has no `do` requirement, so eligibility is un-observable at query time. A cascade that treats every open, non-`draft` issue as eligible would spuriously label random human-opened issues. |
| Marker on `agent:*` namespace (e.g. `agent:blocked`) | The `agent:*` prefix in this repo means "route this to the named agent" (per AGENTS.md **Labels**); the `blocked` marker does the opposite (routes away from any agent). Reusing the prefix would mislead readers. |
| Persistent ledger file (e.g. `.github/blocked-issues.json`) | Stateful cross-run persistence in an otherwise stateless workflow surface; label state is already the convention this repo uses to record SDLC position (`draft`, `human-required`). |
| Re-apply `agent:developer` in the cascade regardless of trap | Would silently no-op when the label is already present (the issue #284 trap) and fail to un-block. |

The `blocked` label is Terraform-managed alongside `draft` — same visual
weight, same lifecycle (applied by automation, removed by automation),
and both signal "this issue is currently ineligible for implementation."

### Decision 2: Unblock cascade lives in `agent-auto-trigger.yml`

**Decision.** Add a sixth job `auto-developer-unblock` to
`agent-auto-trigger.yml`, triggered by `issues.closed`, gated on
`fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true` (the same switch
that gates transitions #3 and #4), sender-allowlisted per the repo-wide
standard, and doing the fan-out to blocked issues.

**Why this file.** The existing auto-trigger workflow already houses
"apply the next-stage `agent:*` label at each SDLC transition" — that is
exactly what the cascade does, on the transition `issue closes →
downstream implementation starts`. Operators reading
`docs/design/auto-trigger-agents.md` and `agent-auto-trigger.yml` should
find all developer-label-application logic in one place. Splitting the
cascade into a separate workflow would require the reader to correlate
two files and duplicate the sender-allowlist, gate-lookup, and
token-mint boilerplate.

The fan-out (one closed issue → N unblock candidates) is a shape
difference from the five existing transitions (each 1→1) but does not
justify a separate workflow: the fan-out is bounded (at most a handful of
issues per close), and the composite action that does the work (see
Decision 4) hides the fan-out inside a single step.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| New workflow `agent-unblock-cascade.yml` | Extra file for what is conceptually one more transition in the auto-trigger pipeline; duplicates the `AUTO_TRIGGER_AGENTS` gate lookup, `AGENT_ALLOWLIST` sender gate, and token-mint pattern from the sibling workflow. |
| Cascade job inside `agent-pr-merged.yml` (which already runs on `pull_request.closed`) | Two problems: (a) issues can close from paths other than PR-merge (manual close, `Fixes #N` via CLI); a PR-closed trigger misses those. (b) `agent-pr-merged.yml` is a permanent-security-exception file per AGENTS.md — it runs on `pull_request.closed` with no checkout and must stay purely mechanical; adding blocked-by-endpoint fan-out would push it toward the "workspace code execution" the exception guards against. |
| Cascade in the un-draft job of `agent-design.yml` | That job fires only on design-PR merge — it misses non-design PRs that close blocking issues, and it fires at the wrong granularity (whole design tree, not per-blocker). |

### Decision 3: "Groomed-ready" test uses the `blocked` marker, not `do`

**Decision.** The unblock cascade applies `agent:developer` to an issue
if and only if the issue currently carries the `blocked` label (plus:
open, no `agent:developer` yet, no existing `agent/issue-{N}` PR, and no
`draft`). The `blocked` label is the sufficient evidence that the
auto-trigger previously deferred an `agent:developer` application on
this issue — no `do`-label test is needed, and none is applied.

**Why not require `do`.** The issue text describes "groomed ready" as
"`do`, not `draft`, still open, no existing agent PR." But transition
#4 (`issues.unlabeled draft`) — the un-draft cascade after a design-PR
merges — applies `agent:developer` **without** requiring `do`: design
sub-issues typically carry only `enhancement` after un-drafting (see
issue #292's actual labels). If the unblock cascade required `do`, it
would fail to re-drive the exact scenario that motivated this issue
(sub-issues #288–#292: a design sub-issue tree whose e2e-validation task
was blocked by four implementation sub-issues).

Using the `blocked` marker as the sole eligibility signal keeps the
cascade symmetric with the two deferral paths: whichever transition set
`blocked` also arranged for the un-block cascade to clear it and apply
`agent:developer`. Human-opened issues that happen to be blocked-by
something but were never routed through auto-trigger will not carry
`blocked` and will not be labeled by the cascade.

### Decision 4: Two shared TypeScript activities under `.github/scripts/`

**Decision.** Add two composite actions + activities, following the
existing pattern (`check-draft-label`, `find-existing-pr`, …):

- **`check-blockers`** — inputs: `token`, `repo`, `issue-number`;
  outputs: `blocked` (`"true"|"false"`), `open-blockers` (JSON array of
  `{number, url, title}` for use in error messages). Wraps `GET
  /repos/{repo}/issues/{n}/dependencies/blocked_by` and filters to open
  blockers. Used by the fail-loud preflight (Decision 5) and by the
  trigger-time gate (Decision 6).
- **`find-newly-unblocked`** — inputs: `token`, `repo`, `closed-issue-number`;
  outputs: `unblocked` (JSON array of issue numbers). Given the
  just-closed issue, walks `GET
  /repos/{repo}/issues/{n}/dependencies/blocking`, and for each returned
  issue checks: has `blocked` label, is open, has no `agent:developer`
  label, has no open `agent/issue-{N}` PR, and its own remaining
  `blocked_by` list is now empty (all closed). Returns the survivors.

Both activities live under `.github/scripts/src/` with unit tests under
`.github/scripts/test/`, per the **Workflow Activity Conventions** in
AGENTS.md. Both meet the shell-vs-TypeScript threshold (API-response
parsing, conditional branching, fan-out) that AGENTS.md requires for
moving logic out of inline `run:` blocks.

**Why two activities, not one.** The two callers do different things
with the endpoint results — the preflight surfaces blocker numbers in a
`::error::` message, and the cascade selects re-drivable issues from a
fan-out list. Combining them would produce a Swiss-army composite action
whose input/output shape is dominated by a discriminator flag. Keeping
them separate keeps each activity's unit-test surface small and its
`if:` predicates in the calling workflow trivial.

**Endpoint availability.** Grooming notes ask whether the
`dependencies/blocked_by` and `dependencies/blocking` REST endpoints are
stable in this repo's GitHub plan. Confirmed with a live call against
the current issue tree (`gh api
repos/mfrancza/agentic-development-workflow/issues/292/dependencies/blocked_by`
returns four open blockers as expected). The endpoints ship with GitHub
Issues sub-issues support, are available on public repos, and are the
same source of truth GitHub's UI uses. Implementation tasks can rely on
them without a GraphQL fallback.

### Decision 5: Preflight is fail-loud, no `skip` output

**Decision.** In both `agent-implement.yml` and `agent-design.yml`, add a
**Preflight: fail if blockers are open** step that runs
`./.github/actions/check-blockers` and, if `blocked == "true"`, exits
non-zero with an `::error::` message listing the open blockers by
number and title. The step runs after the existing `find-existing-pr` and
`check-draft-label` preflights (which are `skip`-emitting) and before
`resolve-model` / `run-agent`.

**Placement rationale.** `find-existing-pr` and `check-draft-label`
represent expected states (PR already exists; issue is still in the
design phase) and correctly `skip`. Open blockers on a triggered issue
represents a **mistake** — either a human applied `agent:developer` to
an issue that should not yet run, or an auto-trigger race allowed the
label to arrive despite Decision 6. In either case the run should be red
so the operator (or the agent that mislabeled) sees the error, and so a
retry after the blocker closes is a re-labeling event that flows through
the normal SDLC path.

**Preflight ordering.** The draft-check comes first (draft is a stronger
signal — the design isn't merged yet, so blocker state is moot) and
correctly skips. Blocker-check comes after and fails. The existing
`find-existing-pr` check remains first because a re-triggered
already-implemented issue should be a silent skip regardless of blocker
state.

**Alternative considered — soft-skip on blocked.** Would match the
draft-check pattern. Rejected: skipping a wrongly-triggered run hides
the mistake; requirement 1 explicitly calls for a red run.

### Decision 6: Auto-trigger developer gates apply `blocked` instead of `agent:developer`

**Decision.** In `agent-auto-trigger.yml`, both `auto-developer-do` and
`auto-developer-undraft` jobs gain a `check-blockers` step immediately
after minting the token. If `blocked == "true"`, the job's final step
applies the `blocked` label (instead of `agent:developer`) and exits
success. If `blocked == "false"`, the job applies `agent:developer` as
today.

**Why apply the `blocked` label from the auto-trigger, not from a
preflight in agent-implement.** Requirement 4 (the #284 trap) forces the
withholding to happen at the label-application site: if
`agent:developer` were applied and then the preflight failed loudly, the
issue would end up carrying `agent:developer` permanently, and the
un-block cascade could never re-fire it. Applying `blocked` instead
solves both concerns: the deferred state is recorded, and
`agent:developer` remains "available" for the cascade to apply.

**Why not a fail-loud gate here.** Applying `blocked` in the
auto-trigger is a normal, expected outcome for design sub-issue trees
(the whole point of the cascade). It is not a mistake, so the auto-trigger
succeeds. The fail-loud path only fires when a human or agent **manually**
applies `agent:developer` to a blocked issue — that is Decision 5.

**Why not gate `agent:design` too.** The grooming notes explicitly leave
this open. Answer: no. Reasons:

- The auto-trigger for design fires on `issues.labeled plan`. The
  grooming agent applies `plan`; the design agent then creates
  sub-issues. In practice, a `plan` issue is a root (its blockers, if
  any, are typically resolved before it is groomed), so blocked design
  runs are rare.
- Requirement 1 already covers the mistake case: if someone does apply
  `agent:design` to a blocked issue, the preflight in
  `agent-design.yml` (Decision 5, applied symmetrically to both
  workflows) fails loud with no wasted container run — the credit-burn
  risk this issue guards against is absent because the preflight fails
  before the agent container starts.
- Adding a `blocked` gate on the design auto-trigger, plus a cascade
  path that re-fires `agent:design`, would double the auto-trigger
  surface and Terraform label semantics for no observed use case.
  `blocked` remains a developer-only marker; if a future design pattern
  produces blocked design issues, this decision can be revisited.

The preflight in `agent-design.yml` (Decision 5) is retained as
defence-in-depth for the manual-application case.

### Decision 7: Sender-allowlist gate stays on the unblock cascade

**Decision.** `auto-developer-unblock` gates on
`contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)`,
same as transitions #1–#4. The sender of `issues.closed` is whoever
closed the issue (typically the human maintainer who merged the closing
PR, or the developer-agent App bot for issues auto-closed by "Closes
#N" markers on a merged PR).

**Consequence.** For the cascade to fire, the closer must be in
`AGENT_ALLOWLIST`. This is already true for the maintainer accounts and
the developer-agent bot per current Terraform. If a non-allowlisted
triage collaborator closes an issue, the cascade silently does not fire
— the operator's remedy is to manually remove `blocked` and apply
`agent:developer` on the affected issue, or to re-close the issue as
themselves.

**Why keep the gate.** The repo-wide security default (AGENTS.md
**Repo-specific security defaults** → "Allowlist gating on label
senders") applies verbatim: closing an issue is a triage-permission
action; without the sender check a non-allowlisted collaborator could
trigger `agent:developer` applications (and downstream container runs
that spend credits) by closing an issue.

**Alternative considered.** Drop the sender gate on the cascade because
the `blocked`-label eligibility check already restricts the surface to
issues automation deferred. Rejected: the security bar for
label-application under an agent identity is repo-wide policy, not
per-transition — dropping it here would create an inconsistency the
next reviewer would have to re-derive.

## Interaction with existing designs and edge cases

- **Interaction with `auto-trigger-agents.md` (Decision 6).** Transitions #3
  and #4 in `agent-auto-trigger.yml` implement the deferral described in
  Decision 6 of this document. The workflow-level design — how the
  `check-blockers` composite action is wired into both jobs and how the two
  conditional label-application steps are structured — is documented in
  [`docs/design/auto-trigger-agents.md`](auto-trigger-agents.md) Decision 6.
  Read both Decision 6 entries together for the complete picture: this
  document explains *why* the pattern is required and what alternatives were
  ruled out; `auto-trigger-agents.md` Decision 6 explains *how* it is
  implemented in the workflow YAML.
- **Interaction with issue #284's draft-guard fix.** Transitions #1 and
  #3 already skip when `draft` is present. This design adds no new
  `draft`-related behavior to those transitions. Transition #4
  (un-draft) already fires on `draft` removal; this design adds a
  `check-blockers` step **after** the trigger fires but **before**
  applying `agent:developer`. When both `draft` and blockers are
  present, `draft` removal fires transition #4, the blocker check
  detects open blockers, and `blocked` is applied. When the last
  blocker later closes, the cascade removes `blocked` and applies
  `agent:developer` — matching the expected un-block behavior for
  design sub-issues.
- **Auto-close chains.** If the last blocker's PR closes multiple
  issues in one merge (e.g. `Closes #A` `Closes #B`), GitHub fires one
  `issues.closed` event per issue. Each cascade run walks its own
  closed-issue's `blocking` list. Concurrent runs against overlapping
  candidate sets are safe: `find-newly-unblocked` re-queries
  `blocked_by` on each candidate to confirm all blockers are closed at
  observation time; a race between two concurrent cascades on the same
  candidate ends in one applying `agent:developer` (the label emits a
  `labeled` event) and the other observing that the label is already
  present (`--add-label` is a no-op with no second event) — the
  candidate's `blocked` removal is also idempotent.
- **`blocked` on manually-triaged issues.** Humans can apply `blocked`
  by hand as a "hold this for later" marker, and it will short-circuit
  the developer auto-trigger the same way. This is an intentional
  side-benefit; the label's Terraform description documents both the
  automated and manual use.
- **Re-open of a closed blocker after cascade fires.** If a blocker
  re-opens after cascade fires and applies `agent:developer`, the
  agent-implement preflight (Decision 5) fails loud on the next
  triggered run for that issue — the deferred state is not
  automatically restored (that would require reversing an
  `agent:developer` application, which is out of scope). Operators can
  remove `agent:developer` and re-apply `blocked` manually.
- **Multiple `model:*` label handling stays unchanged.** The unblock
  cascade only applies `agent:developer`; downstream `agent-implement`
  resolves the model per its existing logic. No new model-selection
  path is introduced.

## Out of scope

- **Blocked-by deferral for `agent:design`.** The failing preflight in
  Decision 5 covers the mistake case; the auto-trigger gate and cascade
  path are developer-only per Decision 6. Revisit if a real workload
  produces blocked design issues.
- **Blocked-by deferral for `agent:groom` and `agent:review`.** Grooming
  runs on `issues.opened`, before any dependency relationships would
  exist. Review runs on PR-open, not issue events; PR dependencies are a
  different concept (GitHub does not expose PR-level blocked-by via the
  same endpoints). Both are out of scope for this issue.
- **Automatic re-deferral when a closed blocker re-opens.** Handling
  requires either persistent state or reversing a completed
  `agent:developer` application (which may have already triggered a
  container run). Documented as a manual operator step above.
- **UI or comment breadcrumbs when the cascade fires.** Nice-to-have,
  but the existing GitHub timeline already records the `blocked` →
  `agent:developer` label transition with actor and timestamp; adding
  bot comments doubles the notification surface for no new information.
- **Cost telemetry on deferred-then-triggered runs.** Same rationale as
  the parent auto-trigger design's out-of-scope: operators toggle the
  `developer` switch off if spend spikes.
- **GraphQL fallback.** The REST endpoints are confirmed live (Decision
  4). No fallback required.
- **A dedicated auto-trigger identity for the new cascade job.** Reuses
  the developer-agent App identity, per parent design Decision 3.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#300](https://github.com/mfrancza/agentic-development-workflow/issues/300) | Terraform: add `blocked` label to `local.automation_labels` (grey, description covering both auto-deferral and manual "hold for later" semantics); update AGENTS.md **Labels** section with a `blocked` bullet and extend the **Auto-trigger gates** table with the marker-label deferral behavior for the `developer` gate; document the new `dependencies/blocked_by` and `dependencies/blocking` endpoint dependencies in AGENTS.md and README.md as appropriate. | — |
| [#301](https://github.com/mfrancza/agentic-development-workflow/issues/301) | `.github/actions/check-blockers/action.yml` + `.github/scripts/src/check-blockers.ts` + tests: composite action wrapping the `dependencies/blocked_by` endpoint, returning `blocked` (`"true"|"false"`) and `open-blockers` (JSON of `{number,url,title}` for error messages); Vitest coverage of "no blockers", "all blockers closed", "one open blocker", "multiple open blockers", "endpoint 404 fails loud". | — |
| [#302](https://github.com/mfrancza/agentic-development-workflow/issues/302) | `.github/actions/find-newly-unblocked/action.yml` + `.github/scripts/src/find-newly-unblocked.ts` + tests: composite action for the cascade — given `closed-issue-number`, returns JSON array of newly-unblocked issue numbers that (a) have the `blocked` label, (b) are open, (c) have no `agent:developer` label, (d) have no open `agent/issue-{N}` PR, and (e) have no remaining open blockers. Vitest coverage of empty `blocking` list, mixed still-blocked/newly-unblocked list, candidate already carrying `agent:developer` (skipped), candidate with an existing agent PR (skipped). | Issue #300 |
| [#303](https://github.com/mfrancza/agentic-development-workflow/issues/303) | Preflight fail-loud: add `check-blockers` step to `agent-implement.yml` and `agent-design.yml` (after the existing `find-existing-pr` and `check-draft-label`), exit non-zero with `::error::` listing open blockers when `blocked == "true"`. | Issue #301 |
| [#304](https://github.com/mfrancza/agentic-development-workflow/issues/304) | Auto-trigger deferral: modify `auto-developer-do` and `auto-developer-undraft` jobs in `agent-auto-trigger.yml` to run `check-blockers` after the token mint; when `blocked == "true"`, apply the `blocked` label instead of `agent:developer` and exit success. Update `docs/design/auto-trigger-agents.md` with a "Decision 6: blocked-by deferral for the developer transitions" section that cross-references this doc. | Issues #300, #301 |
| [#305](https://github.com/mfrancza/agentic-development-workflow/issues/305) | Auto-trigger unblock cascade: add job `auto-developer-unblock` to `agent-auto-trigger.yml` triggered by `issues.closed`, gated on `fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true` and the `AGENT_ALLOWLIST` sender check, using `find-newly-unblocked` to enumerate re-drivable issues and applying `agent:developer` + removing `blocked` on each. Add the new event type to the top-level `on: issues:` list. Update `docs/design/auto-trigger-agents.md` with the sixth-transition section. | Issues #300, #302 |
| [#306](https://github.com/mfrancza/agentic-development-workflow/issues/306) | End-to-end validation: build a fresh sub-issue tree modelled on the #288–#292 shape (four leaf tasks blocking one e2e-validation task) and, with all auto-trigger gates on, confirm: (a) design-PR merge un-drafts all five but only the four unblocked leaves get `agent:developer`; the e2e task gets `blocked`; (b) closing the last leaf-implementation PR fires the cascade and the e2e task receives `agent:developer` exactly once; (c) manually applying `agent:developer` to a blocked issue produces a red `agent-implement` run with the expected `::error::` message; (d) manually applying `agent:design` to a blocked plan issue produces a red `agent-design` run with the same treatment. | Issues #303, #304, #305 |

Issues #301 and #302 are independent of each other (different endpoints,
different outputs) and can proceed in parallel with #300. Issue #303
needs only #301; #304 needs #300 and #301; #305 needs #300 and #302.
Issue #306 is the final integration gate.

Dependencies are recorded natively as GitHub blocked-by relationships on
the issues.
