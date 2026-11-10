# Design: Cap review/response rounds per PR and escalate to human-required

**Issue:** [Issue #773](https://github.com/mfrancza/agentic-development-workflow/issues/773)
**Related designs:** [Re-review loop](re-review-loop.md), [respond-review self-trigger guard](respond-review-self-trigger-guard.md), [shared branch concurrency](shared-branch-concurrency-group.md), and [multi-reviewer agents](multi-reviewer-agents.md).

## Requirements as understood

Issue #773 asks for a configurable circuit breaker in the automated review/response loop, not a change to review quality standards. At the limit, `respond-review` must avoid starting its container, apply `human-required`, notify configured humans through assignment, and leave a useful PR comment. `MAX_REVIEW_ROUNDS` must be Terraform-managed, documented, and tested. Operators must be able to deliberately resume work.

The grooming comment identifies counting, integration, configuration, and tests as design questions; it contains no further human answers or constraints. This design resolves those questions below. In particular, a "round" means a reviewed commit, not a successful response-container execution, and removing `human-required` is the explicit reset. Human reviews do not implicitly bypass the budget.

### Runtime evidence

The issue reports 16 reviewer runs and approximately 13 review/response cycles on PR #767 on **November 1, 2026**, without a pause for human assessment. Inspection of the live PR and Actions history confirms the runtime loop, rather than a linter/schema concern:

- [PR #767](https://github.com/mfrancza/agentic-development-workflow/pull/767) has 16 reviewer-App review submissions across 15 distinct commit SHAs, from 19:00:26 to 20:38:56 UTC; most are now `DISMISSED`, interspersed with developer-App replies.
- The same branch, `agent/issue-759`, has 16 successful `agent-review` runs between [run 41339315286](https://github.com/mfrancza/agentic-development-workflow/actions/runs/41339315286), created at 18:58:20 UTC, and [run 41347754030](https://github.com/mfrancza/agentic-development-workflow/actions/runs/41347754030), created at 20:36:48 UTC. Green individual runs did not bound the aggregate loop.
- The final recorded reviewer submission is an approval. This does not contradict the issue's observation that the loop was still running when reported: the failure being addressed is the unbounded sequence before eventual convergence, not a claim that this PR never converged.

These are the runtime-failure grounds for adding a gate to the working response workflow, as required by `AGENTS.md` § Reverting or replacing code with a passing live-run history. Existing trigger expressions, helper checkout/ref resolution, author authorization, and publication behavior are not being replaced.

## Decisions

### 1. Count distinct reviewed commits from submitted automated reviews

**Superseded accounting:** [Decision 3](reviewer-advisory-threads.md#3-extend-the-existing-budget-to-count-repeated-same-sha-passes) replaces distinct-SHA deduplication with review-ID and lane accounting. The remaining budget, reset, and escalation contracts below still apply.

Read all pages of `pulls.listReviews` for the current PR. Count distinct non-empty `commit_id` values among reviews submitted during the current budget epoch by the configured automated reviewer identities. Keep `APPROVED`, `COMMENTED`, `CHANGES_REQUESTED`, and `DISMISSED` submissions with a non-null `submitted_at`; exclude pending reviews. Dismissal must not refund a round. Exclude the live PR author's reviews, so developer thread replies cannot consume the budget. Human reviews do not count.

The composite/reusable contract includes an optional JSON `reviewer-logins` list, defaulting to the current known reviewer identities already admitted by the response authorization gate: `mfrancza-reviewer-agent[bot]`, `Copilot`, `copilot-pull-request-reviewer[bot]`, and `github-copilot[bot]`. Compare logins case-insensitively. An adopting caller with another reviewer App supplies its login explicitly. This list is for accounting only: membership never authorizes a trigger, and the existing allowlist gate remains mandatory. Do not infer identities from review body headers, model markers, or arbitrary `[bot]` suffixes.

Count across the PR history, not just reviews whose SHA equals today's head. New pushes, rebases, force-pushes, and reopening the same PR do not reset the budget. A separate PR starts its own budget; PR number is the durable key even if a branch name is reused. A missing SHA on an otherwise eligible submitted review is a counting error, not an ignored round.

**Alternatives:** Actions-run counts include skipped, failed-before-review, and duplicate deliveries and introduce an Actions API dependency. Raw review counts charge multi-model matrix reviews separately. An entrypoint/body counter creates mutable state and races with other PR-body writers. Distinct reviewed SHAs are inspectable, already available, and collapse matrix reviews and reruns of the same commit into one round.

**Tradeoff:** This bounds evolving review/response cycles, not every model invocation. Repeated reviews of an unchanged SHA cost one round. It is not a strict dollar, elapsed-time, or container-attempt cap. Counting successful response completions would require a separate ledger and is not the metric selected here.

### 2. Stop at the Nth reviewed commit, but never escalate a clean review

Use `MAX_REVIEW_ROUNDS=8` by default; `0` disables the numerical cap. Parse an unset or whitespace-only value as 8. Accept only a trimmed decimal non-negative safe integer; reject negatives, fractions, signs, non-numeric values, and unsafe integers with a visible activity failure and no container execution. Do not use expression truthiness to substitute the default, since `0` is meaningful.

For actionable feedback, if the epoch count is **greater than or equal to N**, escalate instead of starting another response. With N=1 the first actionable automated review pauses before a response; with N=8, reviews on commits 1–7 can lead to responses, and actionable feedback on commit 8 pauses. This explicitly interprets "stops after round N" as stopping after the Nth review completes, not permitting N responses plus one more review. Historical PRs already above the limit stop on their next actionable event.

The existing stale-SHA, PR-state, self-author, and clean-feedback rules still win. An approval or empty/header-only comment with zero unresolved threads does not cause a new escalation merely because the budget is exhausted. A commented review with body content beyond the reviewer header is actionable even without threads and passes through the same budget gate; submitted commented reviews by configured automated reviewers count by distinct reviewed commit SHA, including when a response only declines the advice. A human review while under budget can receive a response; a human review at the threshold does not bypass it. `CHANGES_REQUESTED` still counts as actionable without inline threads. Preserve the documented fail-open feedback-query semantics; the new counting gate has its own fail-closed error policy.

**Alternatives:** Allow N responses and block the next would shift the requested threshold and require a response ledger. An automatic human-review bypass could restart spending accidentally when a human simply adds feedback. Both are rejected in favor of a visible reviewed-commit threshold and explicit reset.

### 3. Removing human-required starts a new budget epoch

The epoch starts at PR creation, or at the latest GitHub `unlabeled` issue event for `human-required` whose actor has API `type: User`. Fetch every page of the PR's issue-events endpoint and choose the latest qualifying event by timestamp and event ID. A bot removal is not a reset. This uses GitHub-controlled label history, not a marker that an ordinary PR-body edit could forge. Label removal is already a repository-authorized operation; it does not replace the existing review-author allowlist.

Only reviews submitted strictly after that reset timestamp count. Equal timestamps are on the old side of the boundary; document this conservative one-second resolution rule. Also skip an actionable triggering review submitted at or before the boundary, including workflow reruns of old human reviews. A current `human-required` label always pauses `respond-review`, even when the numeric limit is 0. This deliberately gives the label pause semantics for this action; it does not change the conflict resolver's distinct `conflicts-escalated` gate.

**Impact on other escalations:** This pause also applies when an agent or human added `human-required` for an unrelated reason, such as a merge decision needing human input. Today an authorized maintainer review can trigger a response on such a PR while the label remains; after this change it cannot, even below the round limit or in unlimited mode. The human must first address the original escalation, remove the label, and obtain a fresh authorized review; removing the label also resets the round budget. A pre-existing label below the threshold produces a clear skip log, not a round-limit comment. At or above the threshold the existing notification-repair rule still applies; the presence of the label alone does not prove which escalation caused it.

The reset is limited to accounting: it neither triggers a workflow nor runs an old review. The operator reviews the escalation, removes `human-required`, and obtains a new review, either by removing/reapplying `agent:review` through the existing authorized labeled path, or by pushing a deliberate update while `agent:review` remains present. A new authorized human review can also trigger a response under the new budget. Other escalation labels must be handled according to their own runbooks; removing this label is not a universal remediation.

**Alternatives:** Reset on every push defeats the cap. Reset on any human review makes ordinary feedback an implicit spending authorization. A mutable comment baseline needs additional recovery logic. Native label-removal history provides a manual, auditable reset without another workflow or persistent counter.

### 4. Enforce inside the existing serialized work job

Add a TypeScript activity and thin composite action named `check-review-round-limit`, rather than putting API parsing in shell or expanding the read-only `feedback-gate` into a mutation job. Keep the `feedback-gate → authorize → respond-review` job structure and the existing `agent-branch-pr-<N>` / `cancel-in-progress: false` concurrency group unchanged.

Within the authorized work job, after verified helper checkout and developer-token minting, but before model resolution, log-directory preparation, or `run-agent`:

1. Fetch the live PR. Closed/merged PRs skip. Recheck that the triggering review is not by the PR author and that its non-empty commit SHA still matches the live head, not just the event's head snapshot. Rerun the existing feedback decision with current data so a queue delay cannot turn settled feedback into a new escalation.
2. Read live labels, the triggering review's server-side submission time, and (when needed) reset events and review history. A missing trigger review or unprovable epoch/count is a visible failure with no container execution. In unlimited mode skip the historical count fetch, but still honor the pause label and reset/replay guard.
3. Return `proceed=true` only for current actionable feedback that is not paused and is below the cap (or unlimited). Otherwise return `proceed=false` with a precise reason and, when known, `round-count`, `limit`, and `epoch` outputs. On threshold, perform the escalation below.
4. Guard every container/model preparation step with the explicit `proceed == 'true'` output. Retain existing artifact handling. Do not change the entrypoint, reviewer image, or push/lease safeguards.

The reusable takes `max-review-rounds` as an optional string defaulting to empty; the repository caller passes `vars.MAX_REVIEW_ROUNDS`. Do not evaluate an upstream repository's variable in lieu of the adopting caller's configuration. Pass review ID and live PR number through typed action inputs, never interpolate review text into shell.

**Alternatives:** A caller-only gate acts on stale snapshots. A gate outside the lock races other responses. An entrypoint-only gate starts a container unnecessarily and requires image rollout. The work-job activity is the narrowest serialized, authenticated boundary.

The existing lock does not cover humans or reviewer jobs. Re-fetch labels/head immediately before escalation or allowing the container; if the head changed, skip as stale. If the pause/reset epoch changed during collection, recollect once, then fail without a container if it changes again. This avoids claiming transactional safety against outside writers. Already-running containers cannot be canceled by applying the label.

### 5. Escalate once per epoch, with repairable side effects

Use the already-minted developer-App token to add `human-required`, assign humans, and upsert a PR conversation comment. No new App permissions, secrets, workflow token write scopes, branch-protection changes, or agent identities are required.

The comment includes the reviewed-commit count and limit, the epoch/reset boundary, live head SHA, triggering review link, workflow-run link, and a bounded summary of unresolved threads. Fetch all GraphQL thread pages to report the total, with at most 20 thread links and file paths and an omitted-count note. Do not copy arbitrary thread bodies. If thread enumeration fails, state "unresolved thread summary unavailable" and link to the PR review UI; never claim there are zero. Top-level requested changes with no threads are identified as such.

Use a versioned marker such as `<!-- review-round-limit:v1 epoch=initial -->`, or the native reset event ID in place of `initial`, solely to deduplicate the notification. Only recognize comments whose API author matches the live bot PR author; the caller already restricts this path to developer-authored PRs. Paginate comment lookup. Matching text from other authors cannot suppress or modify notification. Never edit the PR body or its model marker.

Apply the label first, then attempt assignments and upsert the comment. Label/comment write failures fail the activity visibly and never allow the container. Retrying an already-paused PR at or above its limit repairs a missing comment and retries assignments; a paused PR below threshold simply skips without manufacturing a round-limit notification. A comment created successfully but a later failure must be updated, not duplicated. Every paused-path log states whether the label was already present and whether the numerical threshold is reached or disabled, without guessing why an existing label was applied. It explains that a human must resolve the original escalation, remove the label, and obtain a fresh authorized review. A new epoch may get a new notification; old comments remain an audit trail.

Expose optional reusable `escalation-assignee` and JSON `admin-assignees` inputs. The repository caller passes `vars.ADMIN_ASSIGNEES`; an adopter may also pass an existing `ESCALATION_ASSIGNEE` value using `escalation-assignee`. There is no new Terraform-managed `ESCALATION_ASSIGNEE` variable. Combine the explicit login and admin entries, expand same-organization teams with the existing `expandTeamRefs` helper and optional resolver credential, and deduplicate logins case-insensitively. Mint a resolver token in the work job only when team expansion is needed; the authorize job's token does not survive that job.

Assign valid available candidates without replacing existing assignees, respecting GitHub's assignee capacity. Log and include in the comment any missing configuration, skipped team, invalid/unassignable login, or capacity overflow. Assignment failure is best-effort and must not undo the pause or suppress the comment. No organization owner, team slug, or PR author is guessed as a human fallback. With valid configured candidates the acceptance behavior includes assignment; deployments without one still pause and visibly say whom the operator needs to configure.

**Alternatives:** Comments without deduplication spam on retries. Reusing the PR body conflicts with concurrent writers. Failing open after a read or label error restarts the runaway loop. Failing assignment as a prerequisite to labeling makes the spending bound depend on notification configuration. The selected ordering keeps the safety stop independent of best-effort routing.

### 6. Terraform and documentation are part of the feature

Add `max_review_rounds` (number, default 8, integer and non-negative validation) to both the root Terraform inputs and `terraform/modules/agent-vars/variables.tf`; pass it through `terraform/main.tf`, and publish `MAX_REVIEW_ROUNDS` with `tostring` in the module's `main.tf`. Mirror the runtime safe-integer bound in Terraform validation. Include 8 and unlimited examples in the module README and `terraform/terraform.tfvars.example`.

Update `AGENTS.md` and `README.md` alongside implementation to explain the metric, the Nth-review boundary, fallback behavior before Terraform is applied, and assignment configuration. For label/action/trigger behavior, including the pause for unrelated escalations and human-led resume, reference the authoritative sources rather than copying that information. Update `docker/scripts/prompts/respond-to-review.md` to make the pause and human-led resume clear to the responding agent. Record that this gate does not stop a reviewer run on an external push, a queued reviewer matrix leg, or another independently enabled branch-writing action.

## Failure policy and verification

| Condition | Required result |
| --- | --- |
| Unset limit; counts 7, 8, 9 | Treat as 8; allow, escalate, escalate for actionable feedback |
| Limit 1; first actionable bot-reviewed SHA | Label/comment/assignment attempts; no container |
| Limit 0; no pause label | No numerical stop; existing authorization/feedback/replay guards still apply |
| Existing `human-required`, including limit 0 | Skip; repair threshold notification if applicable; never clear label automatically |
| Label from an unrelated escalation, actionable human review, below threshold or limit 0 | Skip with explicit pre-existing-label reason and resume guidance; no round-limit comment or container |
| Unrelated label resolved and removed, then fresh authorized review | New epoch; normal feedback and budget gates apply |
| Clean approval/comment at any count | Existing clean-feedback skip; no new escalation |
| Duplicate reviews, multiple models, dismissed reviews, pagination | One round per eligible SHA in epoch; dismissed submissions retained; all pages included |
| Human review, developer reply, unknown bot, pending review | Does not increase accounting; does not gain authorization or bypass a pause |
| Human removes label, followed by fresh review | New epoch; old submissions excluded; same SHA may count anew |
| Old triggering review rerun after reset | Skip; cannot spend the reset budget |
| Missing/deleted review data, review/event fetch error, malformed config | Visible failure, no model/container; never silently interpret as zero |
| Thread-summary or assignment failure | Pause remains; warning/comment describes unavailable details or routing |
| Label/comment write failure or queue race | No container; visible failure or stale skip; rerun repairs notification |

Unit tests must inject API dependencies and separate pure filtering/threshold logic from orchestration. Cover reset events by humans versus bots, equal timestamps, case-insensitive identity matching, rebase/force-push history retention, new PR isolation, repeat notification, spoofed markers, partial writes, team expansion failures, and bounded summary formatting. Workflow-contract tests assert placement after authorization and inside the existing lock, live feedback revalidation, explicit skip guards, caller input wiring, trusted helper checkout, and unchanged review-author gates.

Implementation PRs touching `.github/` run `npm ci && npm run typecheck && npm test` in `.github/scripts`; Terraform changes run the existing formatting/validation checks. This design-only PR creates no runtime behavior and does not require a production configuration apply.

## Out of scope

- Changing reviewer prompts, model selection, findings, thread-resolution policy, or approval/merge requirements.
- A lifetime hard cap on all paid invocations, retries of an unchanged SHA, wall-clock duration, or actual completed responder executions.
- Pausing all agent actions or changing `agent-review` triggers; already-running/queued reviewer work may finish, and external pushes can still request reviews.
- A new scheduler, automatically resuming after a timeout, implicit human-review bypass, historical comment backfill, or automated limit tuning.
- Changing App permissions, branch protection, publication leases, or storing authoritative counters in PR bodies.
- Direct container invocations outside the response workflow; enforcement here is an Actions boundary, not a new entrypoint contract.

## Task breakdown and dependencies

| Issue | Task | Depends on |
| --- | --- | --- |
| Issue [#861](https://github.com/mfrancza/agentic-development-workflow/issues/861) | Activity/composite: counting, reset epochs, live feedback revalidation, escalation/assignment and notification repair, with unit tests | None |
| Issue [#862](https://github.com/mfrancza/agentic-development-workflow/issues/862) | Terraform: manage MAX_REVIEW_ROUNDS and document configuration/defaults | None |
| Issue [#863](https://github.com/mfrancza/agentic-development-workflow/issues/863) | Integrate the activity into the authorized serialized response job; add workflow regressions, pause diagnostics, responder prompt and operational documentation | Issue #861, Issue #862 |
| Issue [#864](https://github.com/mfrancza/agentic-development-workflow/issues/864) | End-to-end validation of the capped loop, unlimited mode, clean completion, partial failures, and human resume | Issue #861, Issue #862, Issue #863 |

Issues #861 and #862 can proceed independently. Issue #863 wires their contracts without modifying the entrypoint or reviewer trigger. Issue #864 depends on every implementation task. Native blocked-by dependencies mirror this table; all sub-issues remain `draft` until this design PR merges.

E2E validation uses a maintainer-approved disposable same-repository agent PR, not PR #767 or a production runaway loop. Record the before/after review IDs, SHAs, counts, labels, assignment, single notification, and workflow URLs. Demonstrate N=2 permits a response to the first reviewed SHA but starts no container at the second actionable SHA; reruns do not duplicate the comment. Exercise clean approval at the threshold, N=0 with/without the pause label, a human reset plus fresh review, stale queued deliveries, matrix duplicate reviews, and notification/assignment failures. Use mocks or a fixture harness for API failures that cannot safely be induced live. Any live limit change, Terraform apply, or paid model run requires the maintainer's approval; restore test configuration and report simulated versus observed outcomes separately.

## API references

- [GitHub: list pull request reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request) documents submitted review metadata and pagination.
- [GitHub: issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#unlabeled) documents native label-removal actor, timestamp, ID, and label fields; the issue-events API supports PRs.
- Repository source contracts: `.github/workflows/agent-respond-review.yml`, `.github/workflows/agent-respond-review-reusable.yml`, `.github/scripts/src/check-reviewer-feedback.ts`, `.github/scripts/src/lib/expand-team-refs.ts`, `terraform/modules/labels/main.tf`, and `docker/scripts/entrypoint.sh`.
