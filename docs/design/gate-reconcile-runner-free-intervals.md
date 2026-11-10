# Design: Gate reconcile — runner-free scheduling and disabled-gate skips

**Issue:** [#892](https://github.com/mfrancza/agentic-development-workflow/issues/892)

## Summary

Replace the reusable sweep's runner-backed interval guard with a job-level
schedule predicate. Adopters list supported cron entries in their reconcile
caller; only the entry selected by their interval setting may allocate a runner,
and only while the protected approval gate is enabled. Manual reconcile and
backfill continue to bypass both scheduling conditions.

Prefer the issue's matching-cron option, retaining the Actions variable and
reusable input, but explicitly acknowledge the compatibility change: a finite
cron table cannot preserve the previous arbitrary-integer, elapsed-time
contract. Support 5, 10, 15, 20, 30, and 60 minutes, with the existing default of
10. Publish migration instructions and require real scheduled-run evidence
before declaring this implementation ready for release.

## Requirements as understood

Issue #892 reports an operational failure, not a lint diagnostic: in the 24 hours
before November 10, 2026, reconcile started 122 runs consuming roughly 274
runner-minutes, despite a disabled gate and a configured interval of 10 minutes.
There are no grooming comments or clarifying answers on the issue.

The existing implementation has a passing live-run history, but successful
completion does not establish the required no-runner behavior. Runtime evidence
inspected for this design includes:

- [Run 42738979675](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42738979675),
  scheduled at 01:53:51 UTC on November 10, 2026: `sweep / find-open-prs` executed
  setup and the interval shell on runner `GitHub Actions 1000022090`, while
  PR listing and `sweep / rerun` were skipped. The Jobs API reports a non-null
  runner ID for the former and no runner for the latter. This is an actual runner-backed
  skip, not an inference from YAML.
- [Run 42737921251](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42737921251),
  scheduled at 01:44:33 UTC the same day: discovery and four per-PR rerun jobs
  executed successfully. The issue reports that the gate was disabled during
  this period. The current token cannot read repository Actions variables
  (HTTP 403), so this design does not independently assert their historical
  values or reproduce the aggregate billing estimate.

The runtime defect is allocating a runner before deciding not to sweep.
Preserve the established publisher-rerun architecture in
[the job-check design](protected-approval-gate-job-check.md); do not replace it
or revisit gate policy.

The required outcome is:

- Scheduled events with the gate disabled or unset allocate no runner.
- With the gate enabled, matching schedule events sweep; nonmatching events
  allocate no runner, including at times when several cron entries coincide.
- `workflow_dispatch` still runs on demand, even when the gate is disabled or
  the interval setting is invalid. This resolves the apparent conflict between
  “skip when off” and “workflow_dispatch always runs” in favor of disabling
  **automatic** reconciliation only. Backfill retains its manual behavior.
- Contract tests cover job placement, schedule selection, and downstream matrix
  safety. Documentation describes the new behavior and migration.
- Real scheduled runs demonstrate disabled skips, enabled nonmatching skips,
  and an executed sweep. Static tests and manually injected event payloads alone
  do not satisfy that acceptance criterion.

## Decisions

### 1. Put the authoritative predicate on the reusable discovery job

Add `jobs.find-open-prs.if` to
`.github/workflows/protected-approval-gate-sweep-reusable.yml`. It must decide
before `runs-on` allocates a runner, with this logical shape:

```text
non-scheduled event
OR (
  caller repository ENABLE_PROTECTED_APPROVAL_GATE == 'true'
  AND event.schedule is nonempty
  AND event.schedule equals cron_table[interval-minutes or '10']
)
```

Use only the inherited `github` context, repository-level `vars`, and the
existing string input. Do not use step outputs, environment-level variables,
API lookups, shell arithmetic, or a new guard job. Implement the table as a
literal JSON object read by `fromJSON` in the job condition; unknown keys must
not match any schedule. An explicit nonempty schedule check prevents missing
values from accidentally comparing equal. Treat a manually set malformed or
unsupported interval as a fail-closed scheduled skip, not a fallback to a faster
frequency. Only an empty input defaults to 10.

Keeping policy in the reusable follows
[the invariant-gates design](move-install-invariant-workflow-gates.md). A
caller-only guard would leave older or custom callers able to allocate runners
unnecessarily. A duplicated caller predicate would introduce another mapping
to keep synchronized. The copied stub therefore needs the cron entries and
input forwarding, not its own copy of the policy expression.

Remove the `interval` step, discovery's `run` output, and the obsolete prior-run
lookup commentary. Discovery simply lists open PRs when admitted. Change the
`rerun` job condition to require successful discovery and a nonempty/non-`[]`
PR output before matrix expansion. A skipped discovery job must not evaluate
`fromJSON('')`; do not introduce `always()` to bypass dependency skipping.
Retain pagination, per-PR publisher lookup, timeout, matrix `fail-fast: false`,
and current permissions. `actions: write` remains necessary for publisher
reruns; removing the prior-run read does not justify changing access policy.

**Alternatives:** A step-level guard still allocates a runner. A preparatory
gate job does too. An external scheduler requires new infrastructure and
credentials. None is needed for this scope.

### 2. Use exact cron selection with a finite, documented interval set

The adopter reconcile stub contains these exact UTC entries:

| Setting / input | Matching `schedule` string |
|---|---|
| `5` | `*/5 * * * *` |
| `10`, or empty | `*/10 * * * *` |
| `15` | `*/15 * * * *` |
| `20` | `*/20 * * * *` |
| `30` | `*/30 * * * *` |
| `60` | `0 * * * *` |

All values divide an hour, avoiding misleading schedules such as `*/7`, whose
hour-boundary gap is not seven minutes. At minute zero several entries may
produce separate events; equality with `github.event.schedule`, not the current
clock or minute modulo, admits only the configured entry. The default remains
10, and the reusable's existing `interval-minutes` string input continues to be
forwarded from `ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES`.

Retain the adopter caller's existing concurrency group and
`cancel-in-progress: false`. Skipped runs can still appear in Actions, and the
existing pending-run replacement behavior is not changed or guaranteed away.
Scheduled delivery may be delayed or dropped. This is a wall-clock scheduling
cadence, **not** a minimum elapsed time since the last successful completion:
delayed events can run close together, and long sweeps or concurrency can make
actual execution less frequent. There is no additional runner-backed spacing
check.

**Alternatives:** Keeping every integer of at least 5 is not practical with a
small fixed cron table, and the previous elapsed-time guarantee cannot be
preserved by event-string matching. Changing the caller's single cron into the
setting (the issue's second option) is simpler and creates fewer workflow-run
records, but removes the variable entirely. Prefer the requested first option
with an explicit narrowed contract rather than silently claiming full backward
compatibility. There is no automatic fallback to the old paid guard. If real
scheduled-run validation disproves the matching-cron mechanism, revise this
design for review before choosing the single-cron alternative.

### 3. Validate the same contract in both Terraform entry points

Keep the resource name, Actions variable name, Terraform input name, default,
and reusable input name. In both `terraform/variables.tf` and
`terraform/modules/agent-vars/variables.tf`, validate membership in
`[5, 10, 15, 20, 30, 60]`. The root currently validates any integer at least 5;
the module currently has no equivalent validation. Both entry points must
reject unsupported values rather than publishing a setting that silently
disables scheduled reconciliation.

Update descriptions from “minimum interval” to “supported scheduled cadence,”
including the manual-dispatch exception. The module README must document the
supported set, empty Actions-input default, gate-disabled skip, exact cron
requirement, and the need to install the updated caller stub. Document direct
Actions-variable edits separately: unsupported strings skip without starting a
diagnostic runner, so troubleshooting must inspect the setting and caller.

**Alternatives:** Keeping broad Terraform validation would accept configurations
the workflow cannot honor. Silently rounding values, parsing noncanonical
strings, or defaulting invalid values to 10 would change operators' intended
frequency without visibility.

### 4. Treat adopter migration as a release-visible breaking change

Updating only the reusable reference is insufficient: an old caller with only
`*/5 * * * *` can no longer run scheduled reconciliation for the default 10.
Adopters must update their pinned reusable and copy the new schedule block in
the same change. Existing values outside the finite supported set must be
changed. Keep manual dispatch available throughout migration and document the
manual-only alternative of omitting `schedule` entirely.

The implementation updates `docs/adopting.md`, the relevant AGENTS.md behavior
entry, Terraform input descriptions, and the module README alongside their
respective changes. Existing historical design documents are not rewritten.
The repository's own caller schedule remains the responsibility of Issue #890:
do not add the cron table to it or undo manual-only operation. Review the latest
caller state before implementation and reconcile documentation with #890
without reverting its recovery guidance. No action or label inventories are
copied into AGENTS.md.

Ready-to-paste next-release upgrade text (also include in this design PR body
and subsequent implementation release notes):

> Breaking: Protected-approval-gate scheduled reconciliation now uses runner-free
> cron matching. When upgrading the sweep reusable, also replace your reconcile
> caller's schedule block with the six-entry block in docs/adopting.md.
> ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES (and interval-minutes) now
> supports only 5, 10, 15, 20, 30, or 60; empty still defaults to 10. Change any
> other value before upgrading. Scheduled sweeps run only when
> ENABLE_PROTECTED_APPROVAL_GATE is true. The setting selects a UTC cron cadence,
> not a minimum delay since the last successful sweep; delayed ticks can execute
> close together. Unsupported direct Actions-variable values skip scheduled
> sweeps. Manual reconcile and backfill still run regardless of gate or interval
> settings. Keeping only the old five-minute cron will not run the default
> ten-minute cadence. Remove schedule entirely for manual-only operation.

## Validation and evidence

### Contract checks

Add `.github/scripts/test/protected-approval-gate-sweep-contract.test.ts`, using
the repository's existing file-based Vitest convention. Assert the job-level
predicate's structure and literal mapping in the actual reusable, rather than
testing only a separately reimplemented boolean helper. Cover:

- Enabled, disabled, and unset gate values; schedule versus manual events.
- Empty/default input and each supported interval against every cron entry,
  including overlapping cron times. Unsupported, whitespace, fractional, zero,
  negative, and malformed inputs never match scheduled events.
- Removal of the interval step, prior-run API request, and `run` output.
- Successful, skipped, empty-result, and failed discovery paths cannot create an
  invalid matrix or start unintended rerun jobs.
- Exact parity between the JSON mapping and schedule entries extracted from the
  adopter Markdown stub, and between both Terraform supported-value sets.
- Existing backfill caller remains manual and requires no interval setting.

The workflow task adds reusable-specific assertions; the documentation task
extends them to the final copied stub and Terraform parity, so intermediate
tasks do not require changes to each other's files. Run the required
`.github/scripts` `npm ci`, `npm run typecheck`, and `npm test` for changes under
`.github/`; run configured workflow lint and Terraform format/validation checks
where available. No Terraform apply is part of this work.

### End-to-end release gate

Use an authorized scratch repository with an open PR and a working copy of the
existing publisher. Pin the candidate reusable commit and install the actual
documented caller on the scratch repository's default branch. Do not enable
this repository's schedule, alter branch protection, mint a new identity, or
spend against an unapproved account. If no authorized test installation is
available, request maintainer access on the validation task rather than changing
production settings or claiming the evidence exists.

Record the candidate SHA, caller YAML, resolved variable values, UTC timestamps,
run URLs, and Jobs API evidence for:

| Scenario | Required observation |
|---|---|
| Gate disabled; real scheduled tick | Discovery and reruns skipped, no allocated runner or executed setup steps |
| Gate enabled; interval 10; `*/5` tick | Same no-runner skip, even if other cron entries fire at that minute |
| Gate enabled; interval 10; `*/10` tick | Discovery executes and actually reruns the open PR's publisher |
| Gate enabled; alternate supported interval | Another real matching entry executes, with a different entry skipped |
| Unsupported direct setting | Scheduled tick skips without allocating a diagnostic runner |
| Manual reconcile while disabled/invalid | Discovery and publisher rerun execute despite scheduling settings |
| Manual backfill | Existing behavior preserved, including with no interval input |
| Empty open-PR set | No matrix parse error or per-PR runner |

Inspect runner IDs/names, step execution, and the new attempt of the targeted
publisher run; a green workflow conclusion alone proves none of these. Where
the platform exposes timing/usage data, attach it as corroboration, not as the
sole evidence: zero recorded billable milliseconds can coexist with an
allocated runner. No private token or secret belongs in the evidence.

GitHub documents multiple schedules and `github.event.schedule`, job-level
conditions, and preservation of the caller event payload in a reusable. These
are the basis for the design, not a substitute for observing the candidate on
real scheduled events. Clean up the scratch schedule and restore temporary
settings after validation. Only after matching-cron validation passes, comment
on Issue #891 with the run URLs as a candidate approach, explicitly noting that
it increases skipped workflow-run records and does not automatically satisfy
that issue's no-additional-runs constraint. Do not modify the fix-checks poll.

## Out of scope

- Removing, restoring, or otherwise changing this repository's schedule (#890).
- Changes to publisher, notifier, dispatcher, approval policy, preview checks,
  required checks, branch protection, tokens, App identities, or permissions.
- Fix-checks polling implementation or its scheduling contract (#891).
- Supporting arbitrary elapsed-minute intervals, custom cron strings through
  the variable, external scheduling services, or exact delivery guarantees.
- Eliminating skipped workflow-run records or redesigning pending-run handling.
- Running a production rollout or Terraform apply as part of this design PR.

## Task breakdown

| Issue | Task description | Dependencies |
|---|---|---|
| Issue [#893](https://github.com/mfrancza/agentic-development-workflow/issues/893) | Add reusable pre-runner schedule predicate, remove paid interval guard, protect matrix, update AGENTS.md, and add reusable contract tests | None; independent of Issue #894 |
| Issue [#894](https://github.com/mfrancza/agentic-development-workflow/issues/894) | Narrow both Terraform interval inputs to the supported set and update module reference documentation | None; independent of Issue #893 |
| Issue [#895](https://github.com/mfrancza/agentic-development-workflow/issues/895) | Publish adopter cron stub, migration/upgrade guidance, and cross-surface contract checks | Issues #893 and #894 |
| Issue [#896](https://github.com/mfrancza/agentic-development-workflow/issues/896) | Validate real scheduled skips, matching execution, and manual recovery end to end; publish evidence and notify Issue #891 | Issues #893, #894, and #895 |

## References

- [GitHub: schedule events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub: job-level conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)
- [GitHub: workflow_call event payload](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_call)
