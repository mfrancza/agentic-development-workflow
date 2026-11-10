# Design: Reviewer advisory threads and reply-only re-review

**Issue:** [#932](https://github.com/mfrancza/agentic-development-workflow/issues/932)
**Related designs:** [Reviewer re-review loop](re-review-loop.md), [review-response budget](cap-review-response-rounds.md), [publication safety](entrypoint-force-with-lease.md).

## Requirements as understood

Issue #932 asks for code-specific advisory findings to become tracked inline threads, and for a reasoned developer rejection to close an advisory without requiring a code change. There are no grooming comments or clarifying answers.

The runtime failure is observable on [PR #930](https://github.com/mfrancza/agentic-development-workflow/pull/930): review ID `5836958484` is `COMMENTED` and contains two advisory notes solely in its body, including the line-85 prompt concern. [Run 42759184852](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42759184852) completed the feedback gate but skipped authorization and the responder job. This is a behavioral failure despite the green run conclusion, not a workflow-schema hypothesis. Issue #932 also cites PR #902 as precedent.

The reviewer must put each anchorable advisory in the atomic review's `comments` array with an `Advisory:` prefix. The summary body retains the required model header and may contain general, unanchorable advice. Advisory-only reviews remain `COMMENT`; advisories never justify `REQUEST_CHANGES`.

On re-review, a developer-agent reply declining an advisory with a reason permits recording its thread ID in `$RESOLVE_THREADS_FILE` even with unchanged code. A reply establishing a bug, security problem, or broken agent run instead requires a new blocking finding explaining why. Blocking threads retain the current semantic fix requirement.

A successful reply-only responder session must trigger a real reviewer workflow when it posts new replies on the reviewer bot's threads. The review-response budget must advance for repeated reviews at the same SHA, preventing an endless disagreement loop.

### Ambiguities resolved

- “Specific code” means a valid inline anchor accepted by the existing atomic review API. Use an applicable diff line or range; do not invent an anchor to unrelated code. A specific location outside the available diff remains an explicitly located body note. Expanding GitHub's anchoring capabilities is outside this change.
- A qualifying pushback is a reply by the authenticated developer-agent PR author on the original `Advisory:` thread, explaining why the suggestion is declined. A bare refusal, unrelated reply, or quoted claim of identity does not qualify. Accepting the suggestion without implementing it does not qualify.
- The issue's reference to #901 means the implemented gate in `check-review-round-limit.ts`, introduced by PR #901 and specified by the budget design. That gate currently counts distinct SHAs; it cannot bound reply-only rounds without a narrowly defined accounting change.

## Current source contracts

`docker/reviewer/prompts/review.md` already requires a single atomic review, pinned `commit_id`, full paginated authenticated PR history, semantic resolution, and a mandatory clean-pass approval. Those contracts remain authoritative.

`docker/reviewer/entrypoint.sh` supplies GraphQL thread IDs and the latest 100 comments per thread. The prompt's fresh paginated REST reads provide complete comment history and original authors; do not infer the root from the truncated GraphQL comment window.

`action_respond_review` in `docker/scripts/entrypoint.sh` skips publication and re-review when HEAD is unchanged. Its changed-HEAD path publishes with the pinned lease and calls `request_rereview`. That requested-reviewers API is useful for humans but does not trigger the reviewer workflow.

`.github/workflows/agent-review.yml` subscribes to `pull_request_target: [labeled, synchronize]`. Authorization and PR lifecycle checks live in its reusable. Existing label application with the developer App token is the available trigger; no new webhook event is needed. Label definitions are in `terraform/modules/labels/main.tf`.

The response budget runs inside the shared per-PR branch-writing lock after freshness checks and before model preparation. Resolution remains a post-container workflow operation using the existing validated-ID resolver and workflow token. These boundaries are inherited from the linked designs.

## Decisions

### 1. Make advisory handling an explicit prompt contract

Update the critical rules, thread-resolution section, verdict section, anchoring guidance, examples, and workflow checklist together so they do not contradict one another.

New code-specific advisory comments start with literal `Advisory:`. Keep blocking comments distinct; merely containing that text in a quote or reply does not reclassify a blocking root. Historical unprefixed threads keep the semantic fix rule rather than being automatically treated as advisories.

For each original advisory root, inspect the full reply chain and current effective requirements. A reasoned decline by the developer-agent PR author clears that advisory: record the original GraphQL thread ID and suppress re-raising the same suggestion, including on later passes. Already-resolved decisions remain visible through the existing full-history reads. This is acceptance of optional advice being declined, not authority to waive required behavior or security rules. Existing authenticated maintainer-decision rules still apply.

If the reply exposes a blocking defect, record the old advisory for resolution and submit a new blocking finding in the same atomic review, linking the old thread and explaining the new evidence. Exempt this explicit replacement from the ordinary no-duplicate-open-thread rule. The new blocking finding follows existing anchor/body rules and verdict selection. Never silently upgrade an advisory while leaving its old thread open. A blocking thread with a decline alone stays open.

**Alternatives:** Body-only advice loses tracking, as the incident demonstrates. Developer-side unconditional resolution cannot make the required semantic distinction. New direct GraphQL writes from the reviewer would violate the established token split. Keep semantic judgment in the reviewer and resolution in the workflow.

### 2. Detect actual new replies and recycle the existing review label

Add a testable container helper, for example `docker/scripts/lib/reply-only-rereview.sh`, called only after a successful model session with unchanged HEAD.

The workflow supplies `REVIEWER_BOT_LOGIN` through an optional `reviewer-bot-login` run-agent input. The response reusable passes its existing first-party reviewer identity; the composite forwards it only for this purpose. Empty configuration disables automatic reply-only re-review with a diagnostic, preserving other actions and external callers. Keep repository-specific identity values out of prompts. In the reviewer prompt, identify the developer as the authenticated PR author with bot identity; this response workflow already restricts eligible PR authors.

Before invoking the responder, snapshot all inline comment IDs through fully paginated API reads into a temporary file. After successful completion, fetch all pages again. Qualifying replies must satisfy all of:

- Their numeric IDs are absent from the initial snapshot (timestamps alone are insufficient).
- Their API author is the authenticated bot PR author, matched case-insensitively.
- Their `in_reply_to_id` chain reaches an original root comment on this PR authored by `REVIEWER_BOT_LOGIN`, also matched case-insensitively.
- That root is still an unresolved review thread according to the paginated GraphQL thread query.

Detect replies to either advisory or blocking reviewer threads; whether the reply is a sufficient decline is a reviewer decision. Do not trigger for summary reviews, issue comments, old replies, edited comments, human replies, missing parent chains, or unrelated bot threads. Use files/stdin for full API data rather than large shell arguments. Snapshot failure disables this optional trigger and emits a warning; never interpret incomplete reads as an empty snapshot.

Before mutating labels, re-fetch live PR state: require open, non-draft, same-repository head, head SHA equal to the checkout SHA, `agent:review` present, and no `human-required`. Missing enrollment must not be restored automatically. If the head moved externally, skip this request with a diagnostic; the existing synchronize path handles enrolled pushes.

Remove `agent:review`, then re-apply it with the existing developer App `GH_TOKEN`, once per session regardless of reply count. A normal GITHUB_TOKEN must not be substituted. The labeled event reaches the existing allowlist and same-repository gates; no authorization changes are proposed. Call this after the existing marker-injection step so the new review sees finalized PR metadata. The changed-HEAD path retains publication-before-re-review and gets no label recycling.

API failures warn visibly without masking completed replies. If removal succeeds and re-add fails, log that enrollment was lost and the operator must re-apply `agent:review`; make one best-effort restoration attempt, not an unbounded loop. If the model fails, no automatic label request is made. Live guards reduce races but are not a transaction with human label edits; document the remaining outside-writer race.

**Alternatives:** The requested-reviewers endpoint alone has no subscribed event. Adding `review_requested`, `issue_comment`, a custom dispatch, or a polling workflow expands trigger and authorization surfaces unnecessarily. Unconditionally recycling after unchanged HEAD creates a loop on no-op sessions. A model-written “I replied” flag is weaker than observing new native comment IDs.

### 3. Extend the existing budget to count repeated same-SHA passes

This decision supersedes only the distinct-SHA deduplication portion of the budget design. Keep its configured maximum, default 8, `0` numerical-disable behavior, filtering, human reset epochs, live feedback rechecks, pause label, fail-closed accounting, escalation routing, and Nth-round stop semantics.

For eligible submitted automated reviews in the current epoch:

1. Deduplicate by native review ID, including dismissed submitted reviews as today.
2. Group by commit SHA and reviewer lane. A lane is the case-insensitive reviewer login plus the exact model from the existing leading `<!-- reviewer-model: … -->` header. Headerless reviews use one legacy lane per login. The header partitions an already eligible author's reviews; it never authenticates an author.
3. Count distinct review IDs per lane. For each SHA take the **maximum** lane count, then sum those maxima across SHAs.

Thus a two-model initial matrix at SHA A counts one round; the same models reviewing A again count two; a new SHA B adds one. Redelivering the same review ID changes nothing. Human and author reviews remain excluded. A review retry that creates another submitted review in the same lane consumes another round; retries with no new review consume none. No new machine marker, dispatch counter, or mutable PR-body state is required. Missing eligible SHA/timestamp/ID or contradictory duplicate-ID records fail accounting closed. Multiple or malformed model headers use the legacy lane with a warning rather than inventing new lanes.

Every successful full re-review includes the same resolved model lanes, so unchanged-HEAD disagreements advance the count. If model selection changes continually, counts can underrepresent invocations; changing model configuration is an external operator action, not part of this automatic loop. As with the original budget this is a response circuit breaker, not a lifetime cap on reviewer invocations. Sibling legs may advance counts before their peers finish; this is conservative and can pause early, never authorize extra responses beyond the observed count.

The existing feedback-first gate still permits clean completion at the threshold. When actionable feedback reaches N, no new responder container runs and therefore no further automatic reply-only label request originates. The existing human-required pause wins even at limit 0. Manual label requests and outside pushes retain existing behavior.

**Alternatives:** Keeping distinct SHAs permits an infinite same-SHA disagreement. Counting every submitted review independently is simpler but charges every sibling model as an extra round. Persisting a new review-cycle counter requires a new trustworthy state and recovery protocol. Maximum per existing model lane preserves ordinary matrix behavior while counting repeated passes.

Existing repeated reviews count immediately after rollout, potentially pausing a PR sooner. Update escalation text from “Reviewed commits” to “Review rounds,” the action/input descriptions, and operator guidance with examples and the existing human resume procedure. Do not silently rewrite old history or reset epochs.

### 4. Land the budget before enabling the trigger

The prompt work and budget work can proceed independently. The entrypoint trigger depends on the budget extension, preventing deployment of an unbounded same-SHA loop. Keep the current shared branch-writing lock and `cancel-in-progress: false`; the reviewer keeps its current queue policy. Resolution happens after the review posts, so a response event can race with resolution; live feedback revalidation remains necessary, and the numerical budget bounds repeated actionable races. No changes to which reviews trigger respond-review are included.

## Validation

Prompt contract tests must cover atomic advisory comments, literal prefix, summary body, unchanged COMMENT semantics, reasoned decline, no re-raise, blocking replacement, unchanged blocking resolution, and clean-pass approval. Verify prompts retain authenticated full-history reads and do not gain repo-specific identities.

Run the container helper in a shell harness with mocked `gh` and `git`, following `respond-review-push.test.ts`: new reply/no commit requests exactly one label cycle; no reply, old/edited reply, wrong author/root, human thread, resolved thread, failed model, missing identity, and changed HEAD do not. Exercise multi-page data and thread roots outside the GraphQL comment window. Cover removed enrollment, pause/closed/draft/fork/moved-head guards, API failures and partial remove/re-add recovery. Assert reply-only processing never pushes, calls `gh pr ready`, or substitutes a new publication lease; changed-HEAD publication tests remain green.

Budget tests cover multiple SHAs, sibling models, repeat passes at one SHA, redeliveries, dismissed reviews, absent/malformed headers, invalid IDs, full pagination, reset boundaries, clean threshold, actionable Nth-round pause, zero limit, and existing fail-closed/error repair behavior. Workflow contract tests verify identity forwarding and unchanged trust, author, freshness, and lock gates.

Implementation changes under `.github/` require `cd .github/scripts && npm ci && npm run typecheck && npm test`; shell changes also require `bash -n` and helper harness tests. A design-only PR changes no runtime files.

### Real workflow acceptance

The dependent validation issue must use a disposable same-repository scratch PR after implementation is available in trusted workflow/image source. Arrange authorized paid runs under the existing operator procedure; do not run head-authored workflow code with production secrets to shortcut rollout.

Record workflow URLs, review/comment/thread IDs, SHAs, model lanes, and observed budget values:

- Reviewer submits an atomic advisory-only COMMENT with an `Advisory:` inline root.
- Developer declines with a reason and posts a new reply without a commit; before/after HEAD is identical.
- Entrypoint cycles the enrolled label with the App identity, and a labeled reviewer workflow actually runs.
- Reviewer records the original thread ID; the workflow's resolver closes it. A later review does not re-raise that declined suggestion.
- With a deliberately persistent finding and a small approved test limit, repeated same-SHA passes increase the budget and stop new responders at N, with the existing single escalation and human resume behavior. Include a matrix case proving siblings count once per pass.
- A genuine blocking thread is not cleared solely by a decline; a newly demonstrated blocking defect replaces the advisory with an explained blocking finding.

Separate live observations from mocked error-path evidence. Restore scratch configuration and close disposable artifacts after recording results. This design PR does not claim those acceptance runs have already occurred.

## Out of scope

- Advisory-only approval counting and protected-approval-gate policy, including the discussion on PR #902.
- Changing which reviews trigger respond-review, tracked separately by Issue #931.
- App permissions, credentials, agent identity changes, branch protection, deployment settings, or automatic merging.
- New reviewer events, schedulers, direct model-side thread resolution, publication changes, or auto-enrollment of unlabeled PRs.
- Resolving blocking threads solely on developer disagreement or treating a developer reply as maintainer authority.
- A strict cap on paid reviewer invocations, cancellation of already-running legs, or fixing all external-writer races.

## Task breakdown and dependencies

| Issue | Task | Depends on |
| --- | --- | --- |
| Issue [#934](https://github.com/mfrancza/agentic-development-workflow/issues/934) | Reviewer advisory lifecycle prompt and contract tests | None |
| Issue [#935](https://github.com/mfrancza/agentic-development-workflow/issues/935) | Count repeated same-SHA review passes within the existing budget; tests and accounting documentation | None |
| Issue [#936](https://github.com/mfrancza/agentic-development-workflow/issues/936) | Detect reply-only responses, trigger enrolled re-review, wire reviewer identity, and test recovery/guards | Issue [#935](https://github.com/mfrancza/agentic-development-workflow/issues/935) |
| Issue [#937](https://github.com/mfrancza/agentic-development-workflow/issues/937) | Real scratch-PR end-to-end validation and evidence report | Issue [#934](https://github.com/mfrancza/agentic-development-workflow/issues/934), Issue [#935](https://github.com/mfrancza/agentic-development-workflow/issues/935), Issue [#936](https://github.com/mfrancza/agentic-development-workflow/issues/936) |

The prompt and budget tasks are independent. The trigger task must land after the budget task. The validation task depends on every implementation task. Native blocked-by edges mirror the table; all children remain `draft` until the design merges.
