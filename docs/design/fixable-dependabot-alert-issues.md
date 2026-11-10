# Design: Schedule issues for fixable Dependabot alerts without patch PRs

**Issue:** [#630](https://github.com/mfrancza/agentic-development-workflow/issues/630)
**Related designs:** [Auto-trigger agents](auto-trigger-agents.md), [Blocked-by dependencies](blocked-by-dependencies.md)

## Requirements as understood

Issue #630 asks for an opt-in scheduled producer of ordinary GitHub issues, not another dependency updater or implementer.
The PR owner's [explicit request](https://github.com/mfrancza/agentic-development-workflow/pull/872#discussion_r4519679820) also permits manual runs for replenishing batches, superseding the issue's schedule-only entry-point constraint; all other requirements remain unchanged.
The owner's [subsequent request](https://github.com/mfrancza/agentic-development-workflow/pull/872#discussion_r4520057992) requires reuse by adopter repositories, with each repository configuring its own schedule and open-PR limit.
An alert qualifies only while open, with a non-withdrawn advisory and a patched version, when Dependabot's associated update reports a repository-fixable failure and has not produced a security-update PR.
The motivating case is an npm transitive lockfile dependency with a patch available, where an unreachable local path dependency prevents Dependabot from preparing its own update.
Authentication failures, inaccessible private registries, missing patches, and withdrawn advisories must not become agent work.

Each issue must identify its alert, manifest, package, patched version, and Dependabot error, and receive `agent:groom`.
The producer never applies `do` or `agent:developer`.
Grooming makes the normal classification decision; only after `do` is applied can the existing developer transition run, automatically when `AUTO_TRIGGER_AGENTS.developer` is enabled or by the normal authorized label application otherwise.
The existing label gates, sender allowlist, developer-agent PR-author checks, prompts, and entrypoint dispatch remain unchanged.
This is additive functionality, not a replacement for working workflow expressions; there is no claimed runtime failure in those expressions to repair.

The maintainer's comment on Issue #630 additionally requires a configurable limit on open dependency-update PRs to protect reviewer capacity.
Grooming identifies permission approval as human-owned and asks for confirmed update-error APIs, stable alert identity, closed-issue semantics, and an explicit decision on automatic issue closure.

Ambiguities resolved here:

- Use repository variable `ENABLE_DEPENDABOT_ALERT_ISSUES`, default `false`, as the explicit opt-in.
- Suppress automatic recreation for both open and closed issues carrying the same producer marker; a human can reopen the existing issue deliberately.
- Do not automatically close previously created issues when alerts close; existing PR closing references and normal human triage own that lifecycle.
- Enforce reviewer capacity at issue admission, reserving slots for work not yet represented by a PR. A schedule alone cannot impose an atomic global PR-creation limit on humans or Dependabot; this limitation and the proposed counting policy require maintainer approval before rollout.
- Use explicit, tested repository-fixable error classes, not the absence of a PR as evidence that a code change is possible. Unsupported or ambiguous errors are skipped visibly, not guessed.

## Feasibility and evidence

Checked on November 9, 2026:

- GitHub's [Dependabot GraphQL reference](https://docs.github.com/en/graphql/reference/dependabot) exposes `RepositoryVulnerabilityAlert.dependabotUpdate`, whose `error` has `errorType`, `title`, and `body`, and whose `pullRequest` identifies the associated PR.
- The [security-advisory schema](https://docs.github.com/en/graphql/reference/security-advisories) supplies the alert vulnerability's `firstPatchedVersion.identifier` and its advisory's `withdrawnAt`. Do not substitute a patch from a different vulnerable range in the same advisory.
- The [Dependabot alerts REST reference](https://docs.github.com/en/rest/dependabot/alerts) supports App installation tokens with Dependabot alerts read permission and provides individual alert state/patch data. Its alert response is not an update-attempt error API; REST-only discovery cannot satisfy this feature.
- GitHub's [error documentation](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-errors) distinguishes missing update PRs from reported failures and identifies private-source authentication/access errors.
- Dependabot's [error serialization source at commit `2d40f1e40982f63393bb988b40aa34a7472d24fb`](https://github.com/dependabot/dependabot-core/blob/2d40f1e40982f63393bb988b40aa34a7472d24fb/common/lib/dependabot/errors.rb) maps local-path failures to `path_dependencies_not_reachable` and distinguishes registry/authentication failures. This is supporting evidence for classifier fixtures, not a promise that every updater error is surfaced unchanged by GitHub.
- Its [security-update helper at the same commit](https://github.com/dependabot/dependabot-core/blob/2d40f1e40982f63393bb988b40aa34a7472d24fb/updater/lib/dependabot/updater/security_update_helpers.rb) records `security_update_not_possible` with dependency-conflict details, separately from missing-patch and already-existing-PR outcomes.

A read-only `gh api graphql` probe against this repository accepted the complete proposed field set, including the associated PR, advisory withdrawal, and patched-version fields.
It returned repository ID `R_kgDORzgBhg`, zero open alerts, and `hasNextPage: false`.
Separate introspection confirmed `Repository.vulnerabilityAlert(number:)` for pre-write revalidation.
This establishes schema availability with the current session credential, **not** the permissions of a proposed reader App or a successful real-alert classification.
The update object has no attempt timestamp/history field: its current error is the available proxy for the most recent reported failed update, not proof of when it last ran.
Null update/error data must never be interpreted as a failed attempt.
An approved sandbox must supply real error-shape and credential evidence before enabling production.

## Decisions

### Decision 1 — Reusable scheduled and manual runs, default off

Add `.github/workflows/agent-dependabot-alert-issues-reusable.yml` with `workflow_call` and a thin repository-owned caller `.github/workflows/agent-dependabot-alert-issues.yml` with `schedule` at `23 3 * * 1` (weekly, UTC) and `workflow_dispatch` with no inputs.
An adopter installs its own caller on its default branch, calls the reusable workflow at a pinned upstream ref, and sets its own literal cron schedule in that caller; the weekly cron is this repository's default, not a requirement for every adopter.
GitHub's [schedule syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule) belongs in the caller's workflow YAML, not a runtime Actions variable or reusable-workflow input; changing a repository's cadence means changing its caller on the default branch.
Document a complete external caller example, including the schedule, input-free manual dispatch, explicit inputs and secrets, and upstream ref pinning; do not require adopters to copy the composite action or TypeScript implementation.
An authorized operator can manually run the caller after merging or closing open work to fill newly available capacity without waiting for its schedule.
Manual dispatch is not an opt-in override: both triggers use the same validation, eligibility, deduplication, capacity reservations, handoff, and failure behavior.
Do not add `repository_dispatch`, webhooks, or a new `AGENT_ACTION`.
The reusable job itself accepts only the caller's `schedule` and `workflow_dispatch` events, and checks the caller repository's exact `vars.ENABLE_DEPENDABOT_ALERT_ISSUES == 'true'` before checkout and token minting; a different caller cannot bypass these gates by invoking `workflow_call`.
The activity also validates its enabled input before any API call, so direct test invocation does not silently bypass opt-in.
Unrecognized enable values do not enable the feature; invalid capacity when enabled fails loudly before writes.

For both events, the reusable rejects non-default-branch refs at the job gate before checkout and token minting.
Operate on the caller repository: use its repository context for APIs, configuration, tokens, inventory and concurrency, and read any source evidence at its triggering `github.sha`, not the upstream helper commit.
If a caller checkout is needed, check out that SHA separately with `persist-credentials: false` and never execute caller code.
Resolve and check out upstream helpers separately using the existing required `helpers-ref` convention: repository-owned callers pass `github.sha`; external callers pass the same immutable full SHA used to select the reusable workflow.
Validate and resolve the ref, verify the helper checkout HEAD against the resolved SHA, and run the composite action from the upstream checkout, not the adopter's workspace.
Because the existing `helpers-ref` convention does not prove at runtime that the input matches the reusable's selected ref, document that matching the two pins is the caller's responsibility and statically check the supplied caller examples.
Explicitly pass the existing developer App credentials and the proposed reader App credentials as named `workflow_call` secrets; do not use `secrets: inherit` or add a PAT fallback.
Use `permissions: { contents: read }`, pinned external action SHAs, a ten-minute timeout, and repository-scoped concurrency `dependabot-alert-issues-${{ github.repository }}` with `cancel-in-progress: false` in the reusable job, shared by all callers and both triggers.
GitHub may replace an already pending run in this group; an operator can dispatch again or wait for the next schedule.
No PR code or package-manager commands run in this job.
Implement nontrivial logic in `.github/scripts/src/` and expose it through `.github/actions/schedule-dependabot-alert-issues/action.yml`, following the existing Octokit/activity conventions.

Alternatives: a new implementer bypasses the requested policy path; a webhook adds an unnecessary entry point; inline shell makes pagination, classification, and retry testing harder.
The composite action is a helper; the reusable workflow centralizes policy while each caller owns only its event schedule and wiring.

### Decision 2 — Separate security reading from the existing writer identity

**Proposal pending human approval:** provision a dedicated, repository-scoped reader GitHub App with Dependabot alerts read and Pull requests read, plus implicit Metadata read.
Pull requests read is for the associated PR lookup; no issue, contents, administration, organization, or alert-write grant is requested for this reader.
Store its credentials as `DEPENDABOT_READER_APP_ID` and `DEPENDABOT_READER_APP_PRIVATE_KEY`; mint its short-lived token through the existing `agent-token` action.
Mint a separate developer-agent token from the existing `DEVELOPER_APP_ID` / `DEVELOPER_APP_PRIVATE_KEY` for issue/label writes and ordinary issue/PR inventory.
Do not expand the developer or reviewer App's installation permissions.

The reader token is an explicit activity input used only for alert queries; the writer token is used for issue/PR APIs and existing repository content reads when source evidence is needed.
Neither token is placed in issue bodies or outputs; the new reader credential never enters a model container.
Do not put private keys in Terraform state or log raw API responses.
There is no PAT fallback or fallback to treating forbidden alert data as an empty collection.
Missing credentials, forbidden fields, or partial GraphQL errors fail the run before candidate publication.

Issue and label writes use the existing developer identity, whose login must already be authorized by the repository's existing `AGENT_ALLOWLIST`.
Do not add the reader identity to that allowlist, change the allowlist as part of implementation, or add a bypass to an existing gate.
Using the default `GITHUB_TOKEN` for these writes is rejected because [issue events it produces do not trigger downstream workflows](https://docs.github.com/en/actions/concepts/security/github_token).
Expanding the developer App would expose alert-reading privileges to all its model sessions; the separate mechanical reader limits that exposure at the cost of a human bootstrap step.

Copying alert details into an ordinary issue can broaden their visibility, particularly in public repositories.
Opt-in must explicitly acknowledge that disclosure and approve the body fields/redaction policy, not merely install the App.
Keep `human-required` on the parent/design PR and assign `mfrancza` until the permission, disclosure, and admission-limit decisions are reviewed.
This document does not authorize creating an App, granting scopes, setting secrets, or enabling the workflow.

### Decision 3 — Positive error classification, with revalidation before writes

Paginate `repository.vulnerabilityAlerts(first: 100, after: ..., states: OPEN)` to completion.
Normalize each result into repository ID, alert node ID/number, state, manifest filename/path, ecosystem/package, vulnerable requirements/range, advisory ID/withdrawal, patched version, and current update error/PR.
Build an eligibility function with a stable skip reason for every failed predicate:

| Predicate | Behavior |
| --- | --- |
| Alert is `OPEN`; advisory and vulnerability are present | Missing or non-open data is not eligible. |
| Advisory is not withdrawn | A withdrawal always excludes the alert. |
| The alert's vulnerability has a nonempty first patched version | No patch means no issue. The version is guidance, not an instruction to perform an unverified lockfile edit. |
| Update and nonempty typed error are present | A missing PR, disabled security updates, a pending attempt, or null error alone is insufficient. |
| No associated update PR exists | Exclude open and draft PRs; conservatively exclude closed/merged associated PRs too, rather than guess whether an old update can be retried. |
| Error is a supported repository-edit failure | Initially recognize `path_dependencies_not_reachable`, `dependency_file_not_parseable`, `dependency_file_not_resolvable`, and `security_update_not_possible`, subject to the evidence checks below. |
| No authentication/private-source blocker or unsupported source access is indicated | Private-source, credentials, inaccessible Git dependencies, transport, rate-limit, updater infrastructure, and unknown errors are excluded. Negative evidence overrides a positive error class. |

The path-dependency case must include an npm fixture in which the vulnerable transitive dependency has a patched version and the reported fetch failure concerns a local path dependency in the same manifest.
For supported error classes, validate the supplied error details and relevant manifest/lockfile source declarations by read-only content APIs at a captured default-branch SHA where necessary to establish a repository-edit repair path.
Read data only; do not run parsers that evaluate repository code, install packages, or attempt registry authentication in the scheduler.
An inaccessible external/private source is not a local path failure, and the presence of a patch does not establish access to its registry.
When source configuration or error text leaves that distinction uncertain, skip with `unverified-source-access` and surface a diagnostic count.
Use public/default registry evidence for the initial supported cases; adding authenticated private-source support requires a separately reviewed credential contract.
Other ecosystems are eligible only when a tested source/error adapter establishes the same evidence; do not silently reinterpret an unsupported ecosystem as npm.

Allowlisted error codes are maintained in code, not a repository variable that could authorize arbitrary failure classes.
Actual GitHub error payloads must confirm the fixture mappings before rollout; upstream error names alone are insufficient.
Freeform error text is supporting context, never an executable command or a sufficient positive classifier.
Grooming may still decide the repair is too large (`plan`) or needs a human; the scheduler does not promise a safe compatible upgrade.

Sort eligible candidates by severity descending and alert number ascending for deterministic admission.
Immediately before creation, refetch `vulnerabilityAlert(number:)`, rerun every predicate, recheck issue identity and capacity, and ensure any source evidence was read at the current default-branch SHA.
On read failures do not create from cached eligibility.
A state change after this final read is an unavoidable cross-API race; the next run must still recognize the created issue and never create another.

Alternatives: scraping the security UI is unsupported and credential-sensitive; title matching loses failure semantics; treating all errors as repairable would route credentials and infrastructure incidents to coding agents.

### Decision 4 — Durable per-alert identity, closed-issue tombstones, recoverable grooming

Use an exact hidden issue-body marker, for example:

```text
<!-- dependabot-alert-issue:v1 repository=R_kgDORzgBhg alert=42 -->
```

Repository node ID plus alert number is the identity, independent of package/version/title changes and repository renames.
Use a visible same-repository alert link as well.
Inventory issues in **all** states through paginated issue-list APIs, exclude PR objects, and parse exact marker lines rather than relying on eventually indexed search or mutable titles/labels.
Recognize exact markers even if the issue author later changes; a deliberate copied marker conservatively suppresses automation rather than creating another security issue.
Existing duplicate markers produce a warning and suppress further creation, not automatic deletion or merging.
The scheduler's concurrency group serializes its own runs; it cannot protect against humans deleting or altering the identity marker.

Create one issue with the marker and existing `dependency upgrade` label, then explicitly add `agent:groom` using the developer token.
The body contains a bounded title, alert number/link, manifest path, package/ecosystem, vulnerable range, first patched version, advisory/severity, and sanitized error type/title/body.
Include a fixed instruction to recheck current alert/package state, use only existing authorized access, and stop/escalate on credential requirements.
Clearly delimit external data; escape embedded markers, mentions, markup, and control sequences, redact credential-like values and URL userinfo/query secrets, and truncate error text with a link back to the alert.
Never publish raw update logs or registry secrets.
Do not label the generated issue `draft`, `do`, `plan`, or `agent:developer`; classification remains grooming's responsibility.

The existing issue-open auto-groom transition may race with the explicit label addition.
Both add the same label; do not remove/re-add it to force another event, and do not modify the working auto-trigger workflow.
If a run stops between issue creation and label application, the next run finds the same issue and repairs the missing handoff rather than creating another.
Before repairing, inspect current labels and paginated issue events: an existing `agent:groom` label or any historical application of it means grooming was already requested, even if it has since completed and removed the label.
Only an open, still-eligible marked issue with no such history receives the missing label; completed, failed-but-still-labeled, closed, or now-ineligible issues are not automatically re-groomed.
Historical-event lookup failures fail closed for this write.

Issue creation must not be blindly retried after a timeout/ambiguous response.
Stop the run and re-inventory on the next scheduled or manual run; if a create actually succeeded, its marker is the recovery record.
After confirmed creation, immediately add the identity to the in-memory set and reserve capacity before considering another candidate.

A closed issue remains a tombstone while its alert remains open, including the period after a fix merges but before alert state catches up.
A fixed/dismissed alert never qualifies even if its issue is absent.
Reopened alerts still map to the original issue; automatic reopening/recreation and automatic closure of old issues are out of scope.
Report open marked issues whose alerts are now closed in the run summary for human cleanup, without changing their labels or interrupting in-flight agents.

Alternatives: deduplicating only open issues recreates work after merge; package/advisory keys conflate distinct manifests/alerts; an external database or Actions cache is unnecessary and less durable than the issue itself.

### Decision 5 — Reviewer capacity uses admission reservations, not a new developer gate

Expose the caller repository's Actions variable `DEPENDABOT_ALERT_ISSUES_MAX_OPEN_PRS` with default `3` when unset or empty; each adopter configures it independently.
Pass the effective value into the reusable activity as a string and validate it there before any write; an explicit `0` must not fall back to `3`.
Accept only a non-negative integer; `0` pauses new admissions while permitting inventory and missing-groom-handoff recovery for already reserved issues.
Reject decimals, negatives, malformed strings, and unsafe integers before writes.

Compute capacity from fully paginated open PRs (drafts included) and all marked issues:

- Count every open PR authored by `dependabot[bot]`, every open PR labeled with the existing `dependency upgrade` label, and every open PR linked to a producer-marked issue. Count each PR once.
- Correlate producer PRs through same-repository closing references and the existing `agent/issue-{N}` branch convention; do not infer author eligibility or weaken any author check from this association.
- Reserve one additional slot for each open marked issue with no counted open PR representing it. Grooming, `plan`, blocked, and human-required issues still reserve capacity: they can turn into a PR later without another schedule.
- Thus `used = counted open PRs + unrepresented open marked issues`; admit only while `used < limit`, and reserve immediately after each confirmed issue creation.
- Never remove an existing reservation merely because this run finds its alert fixed. A human must close that issue, or its existing PR must close it normally, before that outstanding work stops occupying capacity.

Refresh PR/issue inventory before each admission, fail closed on incomplete inventory, and stop adding issues when capacity is exhausted.
For example, limit `3`, one Dependabot PR, and one marked issue awaiting grooming leave one slot, not two.
When that issue opens a PR, its reservation becomes its counted PR rather than consuming a second slot.
Two PRs for one issue count twice.
Lowering the limit never cancels agents or closes PRs; it pauses admissions until usage falls below the new value.

This is a conservative bound on **work admitted by this producer**, not a transactional cap on every future dependency PR in the repository.
Dependabot/humans can open PRs after the last inventory; humans can reopen closed issues or open multiple PRs per issue; unlabeled unrelated dependency PRs are not recognizable reliably.
A strict global cap would require shared admission at all PR writers, including changes outside this producer's scope.
Do not silently add a second implementation gate to pretend to provide that guarantee.
The maintainer must approve these semantics; if a hard global cap is required, keep opt-in off and revise the scope instead.

Alternatives: counting only current PRs lets several ungroomed issues overfill the reviewers later; creating unlimited issues and holding back `do` interferes with grooming; adding a new implementation queue/gate violates the requested unchanged developer path.

### Decision 6 — Configuration, observability, and controlled rollout

Add root and `agent-vars` module inputs `enable_dependabot_alert_issues` (boolean, default `false`) and `dependabot_alert_issues_max_open_prs` (integer, default `3`, validated non-negative), then publish the two Actions variables from that module.
Wire the root module, examples, and module documentation consistently.
Do not alter the actual deployment's opt-in, `AGENT_ALLOWLIST`, `AUTO_TRIGGER_AGENTS`, App grants, or branch-protection settings in this work.
Update adopter documentation with the external caller, per-repository cron and limit configuration, manual dispatch after capacity frees up, and the manual reader-App/bootstrap approval contract when implementation lands; explain that the Apps, secrets, existing label/allowlist setup, and opt-in must be provisioned and approved separately for each adopter.
Document both Terraform-managed variables and how adopters not using this Terraform module set the equivalent repository Actions variables; do not add copied lists of labels, actions, or triggers to `AGENTS.md` or `README.md`.

The run summary records counts for scanned, eligible, skipped by stable reason, existing-open, closed-tombstone, created, grooming-handoff-repaired, capacity-deferred, and stale open work, plus counted PRs/reservations/limit.
Log identifiers and safe reason codes, not raw security payloads.
Permission/schema/pagination/inventory failures are visible failed runs, never successful empty scans.
A failure after one confirmed write reports that partial progress and stops; the next scheduled or manual run resumes idempotently.

Rollout order: approve this design's human-owned decisions; merge the tested disabled implementation; provision/install the reader manually in an approved sandbox; validate real error and token behavior; then separately opt in the production repository.
Turning opt-in off prevents new producer runs but does not revoke an already queued/running developer job or cancel work already admitted.
Manual dispatch remains subject to the same opt-in and human-approved permissions and disclosure contract; it is not a backdoor around rollout approval.

## Out of scope

- Fixing packages in the scheduler, choosing final upgrade strategies, or guaranteeing every patched version is compatible.
- A second implementer, a new `AGENT_ACTION`, new developer/reviewer identities, or changes to existing workflow triggers, gates, allowlist behavior, or PR-author checks.
- Automatically providing credentials, probing private registries, making secrets available to agents, or changing deployments/permissions without human approval.
- Full support for every ecosystem/error combination, UI scraping, update-job history reconstruction, and triggering Dependabot retries.
- Auto-closing/reopening old issues, deleting duplicate issues, merging/closing existing PRs, or automatically cancelling already running work.
- A strict repository-global PR limit across independent writers, batching multiple alerts into one issue, and retroactively migrating unmarked historical issues.

## Validation and acceptance

- Unit-test every selection predicate and supported error mapping, especially the patched npm transitive/local-path failure; deny private authentication/access, unknown errors, missing update/error/patch, withdrawn advisory, and any associated PR state.
- Exercise pagination beyond one page for alerts, issues, issue events, and PRs; malformed/null data; partial GraphQL errors; denied credentials; changing alert/default-branch state; and content that attempts markup, marker, mention, credential, or shell injection.
- Reconcile twice against persistent mocked state: exactly one issue/one grooming request. Cover a successful create followed by label failure, ambiguous create response, completed grooming, a closed issue with a still-open alert, merged-fix alert lag, and reopening an alert.
- Verify capacity with open/draft Dependabot and agent PRs, reservations before grooming, PR/reservation replacement, multiple PRs per issue, closed issues with open PRs, limit `0`, lowering the limit, partial inventory failure, and more candidates than remaining slots.
- Statically assert this repository's weekly caller schedule and input-free manual dispatch, reusable event/default-off/default-branch pre-mint gates, shared non-cancelling concurrency, pinned actions, no new agent invocation, and no modifications to the existing allowlist/label/author checks.
- Exercise a second repository's caller with a different literal cron and open-PR limit, including `0` and invalid values; verify it inventories and writes only its own repository and shares neither capacity nor concurrency with another repository.
- Test an external caller without upstream helpers in its workspace: its pinned reusable and matching `helpers-ref` load upstream helpers, while source evidence comes from the caller's triggering SHA. Verify missing or unresolvable helper refs and checkout-SHA mismatches fail visibly, and statically check matching pins in the documented caller.
- Verify direct calls from other event types, disabled repositories, and non-default-branch dispatches cannot mint tokens or write, even when the caller omits its own gates; check that both named App secrets are passed explicitly.
- Verify manual runs use the same eligibility and admission rules: disabled and non-default-branch dispatches do not mint tokens or write, a full capacity creates nothing, and a dispatch after capacity frees admits only available slots without duplicates.
- For implementation touching `.github/`, run `cd .github/scripts && npm ci && npm run typecheck && npm test`; also run the repository's existing actionlint and Terraform formatting/validation paths as applicable.
- In an explicitly approved sandbox, demonstrate the read-only App can fetch a real failed update, the developer token produces one issue and `agent:groom` event, and no implementation occurs before `do`. With the existing auto-trigger flag on, normal grooming to `do` must reach the existing developer path; with it off, it must not auto-start. Do not change gates to make this test pass.
- Record run URLs, redacted actual error shapes, issue/PR identities, capacity snapshots, successive scheduled and manual results, and fix/close-lag behavior in the validation issue. The zero-alert schema probe is not a substitute for this evidence.

## Task breakdown

All implementation issues carry `draft` until this design PR merges.
Tasks A and B can proceed independently; subsequent dependencies are explicit native blocked-by relationships.
Human approval and sandbox provisioning are rollout prerequisites, not permission changes an implementation agent may perform.

| Issue | Task | Dependencies |
| --- | --- | --- |
| Issue #867 | A: Implement alert discovery, source-evidence adapters, and fail-closed eligibility with unit tests | None; independent of Issue #868 |
| Issue #868 | B: Add per-repository default-off Terraform configuration and adopter/bootstrap documentation, including caller schedule and limit | None; independent of Issue #867 |
| Issue #869 | C: Implement durable issue reconciliation, grooming recovery, and capacity reservations with tests | Issue #867 |
| Issue #870 | D: Wire the reusable workflow, scheduled/manual caller, and composite activity; add external-caller and workflow contract tests | Issue #867, Issue #868, Issue #869 |
| Issue #871 | E: Validate end-to-end scheduled and manual remediation, adopter isolation/configuration, permissions, deduplication, and reviewer capacity | Issue #867, Issue #868, Issue #869, Issue #870; human-approved sandbox |
