# Design: Move install-invariant workflow gates out of caller boilerplate

**Issue:** [#629](https://github.com/mfrancza/agentic-development-workflow/issues/629)

## Summary

Published reusable workflows will own the event, state, feature-flag, and
label-presence rules that are part of the product contract. Adopter-owned
caller workflows will retain only guards that must run before `uses:` and
values that genuinely vary by installation.

The boundary is deliberately not “move every `if:` inward”:

- groom, design, and implement callers keep their owned-label equality guard,
  so applying a second label cannot start another reusable invocation while a
  run for the routing label is queued;
- the `pull_request_target` review caller keeps the same-repository head guard,
  so a fork event never starts a secret-bearing called workflow;
- respond-review and PR-close callers keep the developer-bot equality, because
  that login varies by installation;
- all other invariant predicates are evaluated by first-stage gate jobs in the
  reusable workflows, before downstream jobs acquire concurrency locks or mint
  App tokens.

The public caller examples and static workflow-contract tests will be updated
with the workflows so the supported installation surface cannot drift.

## Requirements as understood

Issue #629 asks to reduce the event-driven caller stubs to installation
configuration rather than making every adopter reproduce product policy.
Specifically:

- invariant event, state, review-label disjunction, actionable-conclusion,
  and `AUTO_TRIGGER_AGENTS` predicates belong in the published workflows;
- developer-agent login, image pin, and the subscribed CI workflow name remain
  installation values;
- the review caller must reject fork-headed `pull_request_target` events before
  invoking the reusable;
- a label event that does not belong to a caller must not create an invocation
  capable of displacing a queued run in the same concurrency group;
- reusable concurrency must therefore remain job-level and occur only after
  the reusable's gate has accepted the event;
- caller stubs, published reusable workflows, and `docs/adopting.md` must stay
  consistent;
- the repeated `repo`, `default-model`, `helpers-ref`, and secret mappings must
  be evaluated, not assumed to be removable merely because their spelling is
  repeated.

The grooming comment resolves the main ambiguity in favor of preserving
pre-`uses:` guards that prevent an unwanted invocation, while moving invariant
policy inward. There were no further clarifying answers and Issue #629 has no
open blockers.

This is an ergonomics and ownership refactor, not a correction of broken
runtime behavior. The existing workflows have passing live-run history; no
runtime failure is claimed and none of their accepted-event behavior is to be
replaced. This distinction satisfies the repository rule against presenting a
static preference as a fix for working code.

## Current boundary and target boundary

| Workflow | Caller guard after this change | Reusable-owned gate |
|---|---|---|
| groom | event label is `agent:groom` | issue is open |
| design run | event label is `agent:design` | issue is open and design mode is selected |
| design undraft | none | merged, same-repo `design/issue-*` PR |
| implement | event label is `agent:developer` | issue is open |
| review | PR head repository equals the base repository | PR is open and event is either `agent:review` labeled or synchronize with that label present |
| respond-review | PR author equals the configured developer-bot login | review author differs from PR author, plus the existing author allowlist and feedback checks |
| PR closed | PR author equals the configured developer-bot login | existing linked-issue extraction and label removal checks |
| auto-trigger | none; developer-bot login is an input | event/action routing, branch/author eligibility, draft guards, and the appropriate `AUTO_TRIGGER_AGENTS` flag |
| fix-checks | none beyond the install-specific `workflow_run.workflows` subscription | fail-closed policy presence, actionable conclusion, check-to-PR resolution, and canonical check-name authorization |

The owned-label guards in the first three agent callers are intentionally
duplicated product tokens. GitHub concurrency allows only one pending member of
a group; a later invocation may replace the existing pending member even with
`cancel-in-progress: false`. Rejecting unrelated label events before `uses:` is
the strongest guarantee that those events cannot participate in this behavior.
The open-state checks do not need that placement: an accepted routing-label
event can enter the reusable, fail its gate, and never reach the locked job.

## Decisions

### Decision 1 — Use reusable gate jobs ahead of locked work jobs

Each affected reusable will have a first-stage job whose job-level `if:`
evaluates its invariant predicate. Existing authorization can be combined with
that stage where doing so remains clear, or depend on a small routing gate.
Every expensive or mutating job will depend on the gate and require a successful
result. Its existing job-level concurrency declaration stays on that downstream
job.

For dual-mode design, the design and undraft paths keep separate gates and work
jobs. An undraft event must not run the design allowlist path, and the undraft
job's existing no-checkout security property remains unchanged.

Alternatives considered:

- **Put the predicate and concurrency on the same job.** Rejected because job
  concurrency admission is precisely the boundary that must not be reached by
  a rejected event.
- **Move concurrency to workflow level.** Rejected: a workflow-level group is
  acquired before any job can evaluate the reusable gate and recreates the
  queued-run displacement risk called out in Issue #629.
- **Rely only on trigger filters.** Rejected: GitHub trigger syntax cannot
  express issue-label values, PR label presence, open state, or the complete
  conclusion policy.

### Decision 2 — Preserve only security- and queue-critical caller guards

The three routing-label callers retain only equality with their owned label.
Review retains only
`github.event.pull_request.head.repo.full_name == github.repository`. Respond
to review and PR-close retain only developer-bot equality. The self-review
inequality moves to the reusable, where `review-author` and `pr-author` already
provide a defense-in-depth comparison. All other listed conditions move inward.

Alternatives considered:

- **Remove every caller `if:`.** Rejected because it weakens the fork boundary
  for `pull_request_target`, loses the install-specific identity gate, and lets
  unrelated label events create queue-relevant calls.
- **Keep all current caller predicates as defense in depth.** Rejected because
  adopters would still own duplicated policy and could silently miss future
  product changes. Defense in depth is retained where the outer boundary has a
  distinct security or scheduling function, not as wholesale duplication.
- **Pass booleans calculated by the caller.** Rejected because this changes the
  spelling but leaves policy in copied caller YAML.

### Decision 3 — Collapse auto-trigger event routing into one reusable call

The auto-trigger caller will invoke the reusable once for the union trigger and
pass the developer-bot login as an explicit input. The reusable will inspect the
original caller event context and select at most one transition:

1. a routing gate identifies the matching event/action/label combination and
   checks the relevant `AUTO_TRIGGER_AGENTS` key;
2. the existing transition job depends on that gate and performs its draft,
   branch/author, blocker, or mutation behavior;
3. auto-review compares the PR author to the developer-login input in addition
   to accepting `agent/` and `design/` branches.

The six-transition inventory remains visible in the reusable, but callers no
longer dispatch a trusted `transition` string or repeat the same secret map six
times. Event-derived issue and PR numbers are read from `github.event`; the
reusable does not trust a caller to classify the event.

Alternatives considered:

- **Keep six calls and move each `if:` inward.** Rejected because every source
  event would start six called workflows, most containing only skipped jobs,
  and the caller would still repeat the input and secret wiring six times.
- **Add a caller job that computes a transition output.** Rejected because the
  routing contract would remain adopter-owned and add a runner job before the
  reusable.
- **Retain `transition` as the authoritative input.** Rejected for event-driven
  callers because a copied stub can pass a transition inconsistent with its
  event. If backward compatibility requires the input during one release, it
  may be deprecated, but it must not bypass the reusable's event gate.

### Decision 4 — Move fix-checks policy gating and resolution into the reusable

The install-specific CI workflow name remains in
`on.workflow_run.workflows`. The reusable will own the non-empty
`FIX_CHECKS_ALLOW` check, actionable conclusions for both delivery types, and
the existing `resolve-check-pr` activity. Resolution becomes an unlocked gate
job. The agent work job depends on `proceed == 'true'` and alone owns the
per-PR concurrency group.

The caller therefore no longer checks out this repository's action merely to
resolve the event, and it does not pass resolved PR/SHA values. The poll caller
continues to use its already-resolved matrix entries and the same reusable work
path; the public contract must distinguish event-delivery mode from poll mode
without weakening `FIX_CHECKS_ALLOW` as a universal fail-closed boundary.

Alternatives considered:

- **Keep resolution in the caller because event payload fields are presumed
  unavailable.** Rejected: called workflows execute with the caller's event
  context, while explicit inputs remain appropriate only for values produced
  by caller jobs or by the polling matrix. A regression test will lock this
  assumption to the supported contract.
- **Acquire a generic workflow-level lock before resolving the PR.** Rejected
  because the PR number is not known yet and unrelated failures would contend.

### Decision 5 — Reduce redundant inputs selectively; keep explicit secrets

The reusable uses `github.repository` rather than a caller-provided `repo`, and
reads `vars.DEFAULT_MODEL` (or `vars.DESIGN_DEFAULT_MODEL ||
vars.DEFAULT_MODEL`) for the standard fallback. Event identifiers are read from
the event where the reusable itself now owns event routing. Inputs remain for
image pins, retention overrides, assignee/reviewer configuration, bot login,
poll-produced values, and other genuine installation or mode-specific data.

`helpers-ref` remains required. The runtime incident documented in
`docs/design/helper-checkout-job-workflow-sha-context.md` and AGENTS.md showed
that deriving the called workflow ref from `github.job_workflow_sha` evaluated
empty and silently checked out the default branch. Repetition is preferable to
reintroducing that trust-anchor failure.

Secret maps also remain explicit for each distinct reusable call. Replacing
them with `secrets: inherit` would expose every caller secret to the called
workflow and is not available across every cross-repository ownership shape.
The repeated names are a visible least-privilege capability grant, not an
install-invariant predicate. Collapsing auto-trigger to one call removes its
sixfold repetition without broadening secret access.

Alternatives considered:

- **Use `secrets: inherit` everywhere.** Rejected on least-privilege and
  portability grounds.
- **Infer `helpers-ref`.** Rejected by the cited runtime evidence and existing
  repository convention.
- **Keep `repo` and default model inputs for symmetry.** Rejected because they
  duplicate stable contexts/variables and let callers accidentally disagree
  with the repository in which the event is executing. Specialized fallback
  overrides can remain inputs only where there is a demonstrated consumer need.

### Decision 6 — Test the public YAML contract, including negative paths

Static contract tests will parse caller and reusable YAML and assert:

- the exact minimal caller guards listed in the boundary table;
- invariant predicates exist in the correct reusable gate jobs;
- concurrency is absent at workflow level and absent from gate jobs;
- locked/mutating jobs depend on accepted gates;
- the review same-repo guard remains in every documented and repository caller;
- auto-trigger has one call and fix-checks keeps only the workflow-name
  subscription outside;
- removed inputs are absent from both callers and `workflow_call` contracts;
- explicit secret grants and required `helpers-ref` remain present.

The end-to-end validation also exercises representative positive and negative
events in a disposable test repository or controlled workflow dispatch
harness: owned vs. unrelated labels, open vs. closed issues, fork vs. same-repo
review, synchronize with/without `agent:review`, disabled auto-trigger flags,
and actionable vs. successful check conclusions. A queue test will hold one
run, queue a second valid run, then deliver an unrelated label event and prove
the queued valid run is not replaced.

Alternatives considered:

- **Rely on actionlint only.** Rejected because it validates syntax, not gate
  placement, queue behavior, or event-context values.
- **Only test accepted events.** Rejected because the purpose of the refactor
  is preserving where rejected events stop.

## Compatibility and rollout

This changes the published `workflow_call` surface and should ship in a normal
versioned release with a migration note. Repository-owned callers and
`docs/adopting.md` change atomically with the reusables. Where an input can be
retained harmlessly for one release, it may be accepted as deprecated, but the
new reusable-owned gate must be authoritative immediately. Removed required
inputs must not be removed from a released reusable before all examples and
internal callers are updated.

The documentation will explain why the few remaining caller guards must not be
deleted, especially the review fork guard, owned-label queue guard, bot-login
guard, `workflow_run.workflows` subscription, and `helpers-ref` trust anchor.
It will not copy trigger or label inventories into AGENTS.md; authoritative
workflow and Terraform sources remain the source of truth.

## Out of scope

- Changing event subscriptions themselves, except simplifying caller job
  routing beneath the existing subscriptions.
- Changing label names, `AGENT_ACTION` values, model-selection precedence,
  App permissions, branch protection, or the allowlist policy introduced by
  Issue #649.
- Replacing `helpers-ref` or weakening its resolve/check-out/verify bootstrap.
- Changing fix-checks canonical-name authorization or polling semantics.
- Moving concurrency to workflow level or changing existing concurrency group
  keys and cancellation policy.
- Introducing a new GitHub App identity, secret broker, or bundled installation
  workflow.
- Backporting the new contract to already-published tags.

## Task breakdown

| Issue | Task description | Dependencies |
|---|---|---|
| Issue [#732](https://github.com/mfrancza/agentic-development-workflow/issues/732) | Refactor label-routed, review, respond-review, PR-close, and design-undraft reusables and callers to use pre-lock invariant gates and the minimal caller guards in Decisions 1 and 2 | — |
| Issue [#733](https://github.com/mfrancza/agentic-development-workflow/issues/733) | Refactor auto-trigger to one event-driven reusable call with internal transition/flag routing and one developer-login input | — |
| Issue [#734](https://github.com/mfrancza/agentic-development-workflow/issues/734) | Move fix-checks delivery gating and check-to-PR resolution into the reusable while preserving the polling path and per-PR post-gate lock | — |
| Issue [#735](https://github.com/mfrancza/agentic-development-workflow/issues/735) | Simplify shared reusable inputs, update explicit caller wiring and `docs/adopting.md`, and add static public-contract regression tests | Issues [#732](https://github.com/mfrancza/agentic-development-workflow/issues/732), [#733](https://github.com/mfrancza/agentic-development-workflow/issues/733), and [#734](https://github.com/mfrancza/agentic-development-workflow/issues/734) |
| Issue [#736](https://github.com/mfrancza/agentic-development-workflow/issues/736) | Run end-to-end positive, negative, fork-boundary, and queued-run validation for the complete caller/reusable contract | Issues [#732](https://github.com/mfrancza/agentic-development-workflow/issues/732), [#733](https://github.com/mfrancza/agentic-development-workflow/issues/733), [#734](https://github.com/mfrancza/agentic-development-workflow/issues/734), and [#735](https://github.com/mfrancza/agentic-development-workflow/issues/735) |
