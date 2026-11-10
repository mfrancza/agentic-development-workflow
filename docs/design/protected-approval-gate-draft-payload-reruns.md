# Design: Protected approval gate — rerun a publisher that evaluated the gate

**Issue:** [#860](https://github.com/mfrancza/agentic-development-workflow/issues/860)

## Requirements as understood

Issue #860 reports a runtime failure after the draft-first publication change in
Issue #835: opening a draft, editing its body, and marking it ready can create
several publisher runs with identical `created_at` values. A review dispatcher
that chooses the first matching run can replay a draft event whose gate jobs
skip, leaving the evaluated run's failing check stale after sufficient approvals.
The issue's grooming notes identify the shared rerun helper, publisher job guards,
and the documentation and live-validation paths; they introduce no further
product requirements or unanswered questions.

The runtime evidence is PR [#857](https://github.com/mfrancza/agentic-development-workflow/pull/857),
head `ea9f48d48a595ab590045e895ec57ac41fbea35f`, on 2026-11-09:

- Publisher [42691293494](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42691293494)
  replayed the draft `edited` payload; attempt 3 skipped both gate jobs.
- Publisher [42691293994](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42691293994)
  has the same creation timestamp, `20:15:56 UTC`; attempt 1 ran the preview
  job and failed with one qualifying approval against a threshold of two.
- After the maintainer's approval, dispatcher
  [42700266101](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42700266101)
  selected `42691293494`, leaving the other run's check stale. The attempt-specific
  jobs API confirms the skipped-versus-failed distinction; a later successful
  attempt of `42691293994` does not invalidate that incident evidence.

The fix must select an evaluated publisher on the current head regardless of
same-second API ordering, ignore old heads, retain a fallback when no evaluated
run exists, and cover preview and enforcing names with Vitest tests. It must
preserve trusted `pull_request_target` execution without checking out or executing
PR-head code. Add this transition to Issue #763's review-event validation item 5.

## Existing architecture and boundaries

The [job-check design](protected-approval-gate-job-check.md), especially Decisions
2–7, settles publication, trust, permissions, and event routing. The dispatcher
calls `src/rerun-publisher-for-pr.ts`, which calls `src/lib/rerun-publisher.ts` under
`.github/scripts/`. The same helper serves departed-SHA sibling reconciliation in
`src/check-protected-approval-gate.ts`. Both callers should receive the corrected
selection policy without changing the helper's signature or structured result union.

The sweep reusable has its own shell implementation of latest-run selection; it
does not call this helper. This design fixes the dispatcher and shared TypeScript
callers. Sweep parity is separate work; the existing scheduled sweep must not be
described as guaranteed recovery from this particular draft-payload ambiguity.

## Decisions

### 1. Select an evaluated run; retain the publisher's event draft guard

Prefer the issue's first proposed solution. Read live PR metadata, identify runs
on that head, and inspect their jobs before selecting a rerun. The publisher's
workflow, trigger set, check names, concurrency, helper checkout, and draft guards
remain as defined in the existing job-check design.

**Alternative: fetch live draft state inside the publisher.** This could make a
draft event rerun evaluate a now-ready PR, but changes publisher job scheduling
and draft behavior, and cannot change the workflow YAML retained by existing
runs. Selecting an already-evaluated run directly addresses the observed stale
check and can repair existing runs without replacing their publisher workflow.

**Alternative: sort by run ID alone.** A deterministic tie break does not establish
that the selected payload ever evaluated the gate. Job evidence must determine
eligibility before recency determines preference.

### 2. Current-head eligibility, deterministic ranking, and bounded fallback

Implement the following policy inside `rerunPublisher`:

1. Fetch the PR with `pulls.get` and capture its live `head.sha`. Do not use the
   notifier's historical SHA or infer the head from a branch name.
2. Paginate `listWorkflowRuns` for the specified publisher and event
   `pull_request_target`, retaining the existing `pull_requests[].number` identity
   check. Require `run.head_sha` to equal the captured live head. Missing identity
   or SHA is not sufficient evidence; do not broaden matching to SHA alone, since
   multiple PRs can share one head.
3. Rank matching runs by `created_at` descending, with numeric run ID descending
   for equal timestamps. Process timestamp groups, including groups crossing page
   boundaries, so a page boundary cannot reintroduce the same-second bug. Once a
   timestamp group contains an eligible run, no older group needs examination.
4. List each candidate's jobs using the latest-attempt filter (`filter: latest`),
   paginating jobs. A run is preferred if a job named exactly
   `protected-approval-gate` or `protected-approval-gate (preview)` completed with
   `success` or `failure`. Failure is essential: that is the stale check to refresh.
   Skipped, queued, running, cancelled, or unrelated jobs do not demonstrate a
   completed gate evaluation. Accept either gate mode, because configuration can
   change between the original run and its rerun.
5. Rerun the highest-ranked preferred run. If the complete search finds no
   preferred run, rerun the highest-ranked current-head matching run, even if both
   gate jobs skipped. If no current-head match exists, return `no-prior-run`.
   Call `reRunWorkflow` only once; preserve `rerun-triggered` and `api-error` results.

The phrase “existing fallback” is ambiguous alongside “old heads are ignored.”
Here it preserves the latest matching-run rerun when job evidence yields no
preferred candidate, **within the current-head boundary**. It never replays an
old-head run merely because the current head has no publisher. Same-second
fallback ties use the explicit ID ordering above rather than unspecified API order.
The skipped-only fallback does not promise to refresh a gate: there is no known
evaluated run to repair in that case.

**Alternative: return the first eligible API entry.** Rejected because tied
entries are not a stable recency order. **Alternative: scan every job of every
repository run.** Rejected: filter identity and head first, then inspect candidate
jobs in recency groups. Workflow pagination remains necessary for quiet PRs and
for establishing that no eligible run exists; API listing limits remain a boundary.

### 3. API failures are not evidence that every gate skipped

Wrap live-head lookup, workflow listing, job listing, and rerun errors into the
existing `api-error` result. Do not silently choose a fallback after incomplete
job evidence or attempt another run after a rejected rerun. Existing callers log
warnings without publishing an approving result; preserve that behavior. Log the
selected run and whether selection used evaluated-job preference or fallback so
operators can distinguish successful dispatch from guaranteed gate evaluation.

Re-fetch the live head immediately before triggering the selected run. If it
changed during discovery, return `api-error` with a diagnostic and do not rerun
the old head. A push after that final read remains an ordinary distributed race;
its synchronize publisher is responsible for the new head. Rerun rejection for a
busy run retains existing warning behavior; this fix adds no retry loop.

**Alternative: treat read failures as no eligible run.** Rejected because missing
evidence would recreate the arbitrary-run selection failure under API errors.
No token permissions, approval rules, or protected identities change.

### 4. Documentation and validation ship with the implementation

Update the dispatcher description in `AGENTS.md`, the routing description in
`protected-approval-gate.md`, and Decision 5 plus the shared-helper discussion in
`protected-approval-gate-job-check.md` to reference this selection contract.
Document the TypeScript helper's sibling caller and the separate sweep boundary.
Update dispatcher/publisher comments that promise “latest” unconditionally without
changing workflow expressions or triggers. These documentation edits belong in
the implementation PR so the described behavior and code land together.

Extend the Issue #763 row and review-event acceptance item in the job-check design
to include draft opening → marker edit → ready, with unchanged head and same-second
publisher runs. Update Issue #763's own item 5 to include this case; existing
validation cases remain intact. The final task below provides focused runtime
validation without duplicating all of Issue #763.

## Validation

Vitest coverage must exercise:

- Equal timestamps, API-first run skipped both jobs, another run evaluated the
  gate: rerun the evaluated run, for both preview and enforcing names.
- Newer old-head evaluated runs ignored; only old-head runs yields `no-prior-run`.
- Multiple evaluated runs: newest timestamp wins; equal timestamps use run ID.
- Latest attempt controls eligibility; an earlier successful attempt does not
  qualify a latest skipped attempt. Unrelated/skipped/incomplete jobs do not qualify.
- Workflow pages and timestamp ties across pages, paginated jobs, null PR arrays,
  and a separate PR sharing the same SHA.
- No preferred run: current-head fallback; no matching run: no rerun.
- API failures at each read/write boundary, changed head before dispatch, and no
  second rerun after rejection.
- Existing departed-SHA sibling behavior with updated mock shapes and current-head
  lookups, preserving independent sibling targeting and existing diagnostics.

Run `npm ci && npm run typecheck && npm test` in `.github/scripts` before committing
implementation changes, as required by `AGENTS.md`. Live validation records run
IDs, attempts, event actions, head SHAs, job conclusions, dispatcher selection,
and the resulting current-head check. A green dispatcher alone is insufficient.

## Out of scope

- Changing approval counting, gate enablement, branch protection, App permissions,
  credentials, check names, or publisher trust and checkout behavior.
- Unifying the shell sweep with the TypeScript helper or changing sweep cadence.
- Repairing missing `pull_requests` associations or expired/unavailable historical
  runs, automatic retry/backoff, or deleting stale check runs.
- Changing the draft-first marker publication contract from Issue #835.
- Enabling the enforcing gate to run tests. Validate preview under existing
  settings; enforcing live validation waits for separately authorized configuration
  or an already-enabled scratch environment.

## Task breakdown

Dependencies are recorded as native GitHub blocked-by relationships.

| Issue | Task | Dependencies |
|-------|------|--------------|
| Issue #918 | Implement current-head, evaluated-job publisher selection, regression tests, and accompanying behavior documentation; extend Issue #763 item 5. | None |
| Issue #919 | End-to-end validation of draft → edit → ready review reruns on a scratch PR, recording actual selected run and refreshed check. | Issue #918 |

The implementation and its behavior documentation form one coherent change. The
validation task depends on that complete change; there are no independent
implementation tasks requiring parallel work.
