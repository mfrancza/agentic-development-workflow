# Design: Check reviewer-bot freshness after the response lock

**Issue:** [#839](https://github.com/mfrancza/agentic-development-workflow/issues/839)
**Related:** [shared branch concurrency](shared-branch-concurrency-group.md), [review-response budget](cap-review-response-rounds.md), [self-trigger protection](respond-review-self-trigger-guard.md).

## Requirements as understood

Issue #839 asks respond-review to discard an obsolete reviewer-agent review only after acquiring the existing branch-writing lock. Compare the triggering review's `commit_id` with a newly fetched PR head, rather than comparing two snapshots from the same event. Human feedback must survive intervening pushes. A head-lookup error must not itself suppress a response. Tests must cover stale/current bot reviews, stale human reviews, and lookup failure; implementation must update AGENTS.md MVP Workflow step 5.

The [grooming comment](https://github.com/mfrancza/agentic-development-workflow/issues/839#issuecomment-6742349566) asks for design across the feedback gate, serialized job, identity distinction, and tests. It supplies no additional behavioral requirements or human answers.

This changes code with successful live-run history to fix an observed runtime failure, as required by AGENTS.md. On [PR #834](https://github.com/mfrancza/agentic-development-workflow/pull/834), [run 42560290110](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42560290110) logged identical feedback-gate inputs `c94dc54a8defb1a89825a7203c920a7ad7f25b10` at 04:10:16 UTC on 2026-11-09. Its work job started at 04:14:07, invoked the model at 04:15:10, and published `2b830da..b27f374`. The triggering bot review (review ID 5821569357) was on `c94dc54`; the run acted on its successor `2b830da`. The issue's maintainer example is equally important: review ID 5821538121 on `69bb0ca` requested npm removal before the responder started on `c94dc54`. That feedback must remain actionable. These are actual effects, despite the run's successful conclusion, rather than a schema or lint hypothesis.

### Current implementation and additional integration requirement

The caller `.github/workflows/agent-respond-review.yml` passes event `head-sha` and `review-commit-id` to its reusable. The reusable executes `check-reviewer-feedback` before authorization and before the `respond-review` job's `agent-branch-pr-<N>` lock. The shared feedback helper rejects any author on a SHA mismatch.

The current tree also contains a post-lock `check-review-round-limit` activity. Its `makeDependencies().feedback` calls the same helper with a live head and live review. Therefore removing only the pre-lock comparison is insufficient: this second call would still reject a stale human review. Both uses must lose the generic stale-SHA rule, while budget, pause, authorization, and actionable-feedback behavior remain governed by their existing designs.

## Decisions

### 1. One dedicated freshness activity inside the serialized work job

Add `check-review-freshness` as a TypeScript activity and thin composite action, following AGENTS.md activity and portable-working-directory conventions. Place it immediately after the existing four-step trusted helper bootstrap in the `respond-review` job, before minting the developer token, escalation preparation, or review-round accounting. All job steps execute after the concurrency slot is acquired; this is the first business check, rather than literally the first bootstrap step.

Inputs are the workflow token, repository owner/name, PR number, review ID, review author, and optional review commit ID. Use the existing explicit reusable inputs; do not read event payload fields inside the reusable. Fetch the live head with Octokit `pulls.get`. Compare it with the triggering `review-commit-id`, never with the caller's event `head-sha`. Return `proceed` and log the reason. No model, container, PR comment, label, or assignment is needed to skip.

Alternatives considered: extending the pre-lock feedback gate still leaves queue delay; moving the rule into the container spends setup and build resources and requires new container plumbing; embedding it in the review-round gate couples optional freshness failure to intentionally mandatory accounting. A small separate activity makes its timing and fail-open policy directly testable without changing the accounting contract.

### 2. Identify only the repository reviewer bot

Match `mfrancza-reviewer-agent[bot]` case-insensitively. All model/matrix reviewer legs share this identity. Human authors and all other logins pass freshness checking regardless of SHA. Do not infer eligibility from a `[bot]` suffix, account type, authorization allowlist, or the accounting-only `reviewer-logins` input.

The issue says “reviewer bot,” and the source `agent-review.yml` supports re-review on same-repository `synchronize` while `agent:review` remains present. It does not establish that Copilot or arbitrary allowlisted bots always replace stale findings. Applying this rule to all `DEFAULT_REVIEWERS` would therefore risk dropping feedback without a replacement. A configurable bot-identity policy is deferred; external consumers using another reviewer identity retain responses rather than silently losing them. This decision changes neither identity nor authorization configuration.

### 3. Freshness failure is fail-open; other gates retain their own policies

| Condition | Freshness result |
| --- | --- |
| Repository reviewer bot; non-empty review SHA differs from fetched live head | `proceed=false`; log PR, review ID, author, reviewed SHA, and live SHA, explicitly saying stale bot review skipped after lock acquisition |
| Same bot; reviewed SHA equals live head | `proceed=true` |
| Human, Copilot, or another login; any reviewed SHA | `proceed=true`; no freshness lookup necessary |
| Missing/blank review commit ID | Warn and `proceed=true` |
| Live-head fetch throws, or returns missing/blank head | Warn and `proceed=true`; never substitute the event head |

Validate ordinary action identifiers as usual; fail-open is limited to inability to establish freshness, not malformed workflow configuration or failed trusted bootstrap. Do not use blanket `continue-on-error`: emit an explicit true output on handled lookup failures so downstream conditions work.

A true output means continue to the existing review-round gate, not unconditional model execution. Its mandatory PR/review/accounting reads still fail closed under the accepted budget design. A transient failure of the new lookup followed by successful accounting allows normal progress; a persistent outage can still block accounting. Preserve this distinction in tests and documentation rather than weakening accounting to satisfy freshness fail-open.

The round gate's later comparison between two live PR snapshots detects changes *during accounting*. Keep it: that safety check is different from rejecting a human review merely because its original commit is old. Humans still pass when the live head is stable even if their review predates it.

### 4. Remove the old rule completely from shared feedback logic

Delete the stale-SHA branch from `src/lib/check-reviewer-feedback.ts`; remove SHA fields from its internal input type, entrypoint reads, and both internal callers (including `check-review-round-limit.ts`). Keep the remaining check order: PR open, self-author exclusion, state dispatch, unresolved threads, then approval-only fallback. Preserve all existing error policies for those checks.

Retain the optional public `head-sha` and `review-commit-id` inputs on the `check-reviewer-feedback` composite as deprecated no-ops for callers at a newer helper ref. Retain optional reusable `head-sha` as a deprecated no-op for compatibility, but stop passing it from this repository's caller and to the feedback action. Keep reusable `review-commit-id` active for the new freshness action and retain the caller binding. Describe these distinctions in input descriptions; no stale rule remains in the pre-lock activity. Removing public inputs outright was rejected to avoid gratuitous reusable/action interface churn.

### 5. Gate all work after freshness and preserve established locks

Require `steps.review-freshness.outputs.proceed == 'true'` on developer-token minting, assignee detection/resolver minting (combined with its existing condition), and the review-round gate. Subsequent issue lookup, model selection, log preparation, and container launch must require both freshness and the existing round-limit `proceed` output; retain their other conditions. Keep artifact upload under `always()` and tolerate absent logs as today.

Add workflow contract assertions for placement after trusted verification, use of the read-only workflow token, explicit review SHA/author bindings, and conditions on all downstream preparation. A skip must not reach escalation side effects or model preparation. No added permissions or secrets are required.

Retain the reviewer and branch-writer groups independently, including `cancel-in-progress: false` for the response job. The accepted [shared concurrency design](shared-branch-concurrency-group.md) already settles placement and pending-slot limitations. A shared reviewer/responder lock is explicitly excluded by the parent issue. This fix rejects obsolete bot events after waiting; it does not prevent reviews from becoming obsolete or guarantee replacement delivery if labels are removed or a reviewer fails. Humans and other external writers can still move the branch after the lookup; publication safeguards remain independent.

## Documentation and out of scope

Update AGENTS.md step 5 in the implementation documentation task: remove the stale-SHA bullet from the feedback activity's ordered list; describe bot-only live freshness after lock acquisition and before accounting; explicitly preserve human feedback, missing-value fail-open, and the separate fail-closed accounting policy. Link this design. No operator setting or README setup change is needed. Historical designs remain historical; do not rewrite their past decisions.

Out of scope:

- Combining reviewer/responder concurrency groups, changing queue delivery, or adding a durable queue.
- Changing re-review triggers, bot identities, authorization, credentials, permissions, or branch protection.
- Budget thresholds, epoch/reset rules, pause/escalation policy, or broadening accounting fail-open.
- Resolving/rewriting stale review threads, suppressing selected findings within an otherwise actionable review, or changing the model prompt.
- Publication/force-with-lease changes from issue #770, or a new lock against human/external writers.
- Implementing the fix in this design PR or running model-backed experiments as part of writing the design.

## Verification and rollout

Unit tests for the new activity must cover the four acceptance cases, missing review/head values, case-insensitive bot identity, non-matching bot/Copilot passthrough, and log contents. Assert head retrieval is invoked at execution time and that a failed lookup returns a true output without relying on an event head fallback.

Update shared-feedback tests to show unequal legacy SHAs cannot suppress human feedback. Exercise the real round-limit dependency adapter with an old human review and stable live head, plus a current bot review, to ensure no hidden shared-helper skip survives. Retain existing feedback fallback, authorization, pause, budget, and accounting-error regressions. Test a transient freshness lookup failure followed by successful accounting separately from a mandatory accounting failure.

Run `cd .github/scripts && npm ci && npm run typecheck && npm test` for implementation changes, and the repository actionlint check for modified workflow/action YAML. Use workflow contract tests to verify unchanged concurrency, helper provenance, and freshness gating. The final dependent task validates a controlled queued-run scenario and records event SHA, reviewed SHA, post-lock live SHA, run URLs, and whether model preparation ran. Use a safe test repository or maintainer-coordinated scratch PR without changing production configuration or protections; do not deliberately create spend or hold a production lock without coordination. API-failure injection belongs in the deterministic harness, not a production permissions change.

Deployment follows ordinary reviewed merges; external consumers adopt the helper/workflow version as usual. A stale bot skip is successful with a clear reason; it does not close threads or clear labels. Rollback reverts the implementation changes together, restoring the previous behavior without infrastructure migration.

## Task breakdown and dependencies

| Issue | Task | Dependencies |
| --- | --- | --- |
| [#912](https://github.com/mfrancza/agentic-development-workflow/issues/912) | Implement the freshness activity, remove generic SHA suppression from both feedback call paths, wire post-lock gating, and add unit/adapter/workflow tests atomically. | None |
| [#913](https://github.com/mfrancza/agentic-development-workflow/issues/913) | Update AGENTS.md step 5 to document the new order, identity scope, and separate failure policies. | None; parallel with implementation |
| [#914](https://github.com/mfrancza/agentic-development-workflow/issues/914) | Validate the integrated queued bot/human scenarios and failure behavior end to end; record evidence against every acceptance criterion. | [#912](https://github.com/mfrancza/agentic-development-workflow/issues/912) and [#913](https://github.com/mfrancza/agentic-development-workflow/issues/913) |

The first two tasks are independent and may proceed in parallel. The validation task is blocked by both; native blocked-by edges mirror the table.
