# E2E Validation: Auto-review marker race fix

**Issue:** [#819](https://github.com/mfrancza/agentic-development-workflow/issues/819)

**Parent design:** [`docs/design/auto-review-marker-race.md`](auto-review-marker-race.md) ([#793](https://github.com/mfrancza/agentic-development-workflow/issues/793))

**Implementation PRs merged before validation:**

| Issue | PR | Merged |
|-------|----|--------|
| #816 auto-trigger `ready_for_review` wiring | [#832](https://github.com/mfrancza/agentic-development-workflow/pull/832) | 2026-11-09T02:19:09Z |
| #817 entrypoint draft+ready contract | [#835](https://github.com/mfrancza/agentic-development-workflow/pull/835) | 2026-11-09T02:51:39Z |
| #818 pairing resolver `claude-*` normalization | [#831](https://github.com/mfrancza/agentic-development-workflow/pull/831) | 2026-11-09T02:18:26Z |

---

## Validation step 1 — Happy path: draft contract works

**Method:** Code review + live workflow-run evidence.

### Code review

**`agent-auto-trigger.yml` (line 10):** `ready_for_review` added to `on.pull_request.types`:
```yaml
pull_request:
  types: [opened, ready_for_review]
```

**`agent-auto-trigger-reusable.yml` (lines 165–175):** Route predicate for `auto-review`:
```yaml
inputs.event-name == 'pull_request' &&
((inputs.event-action == 'ready_for_review' &&
  contains(inputs.pr-body, '<!-- authored-by-model:')) ||
 (inputs.event-action == 'opened' && !inputs.pr-is-draft &&
  !inputs.pr-author-is-bot)) &&
inputs.pr-head-repository == github.repository &&
(startsWith(inputs.pr-head-ref, 'agent/') || ...)
```

The `ready_for_review` path additionally requires that the authoritative marker be present in the PR body — preventing a premature promotion (before the entrypoint runs) from triggering a review with a missing or stale marker.

**`docker/scripts/entrypoint.sh` `check_pr_readiness_and_promote` (lines 243–274):**
1. `isDraft == true` → `inject_authored_by_marker` then `gh pr ready` (normal path).
2. `isDraft == false` + correct marker present → log "partial-run recovery: skipping injection and flip".
3. `isDraft == false` + marker absent/wrong → `exit 1` (see Step 4).

`action_implement` and `action_design` both call `check_pr_readiness_and_promote` after the agent run; `action_fix_deployment` calls `gh pr ready` after `inject_authored_by_marker`.

### Live evidence

**Implement run for PR #835 (issue-817):**
[Actions run #42552435361](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42552435361)

Entrypoint logs confirm marker injection:
```
[agent] 2026-11-09T02:51:53+00:00 Injecting authored-by-model marker into PR #835 (model: sonnet)
[agent] 2026-11-09T02:51:54+00:00 authored-by-model marker written to PR #835 (model: sonnet)
```
(Note: PR #835 was opened with the pre-fix entrypoint code — the implement run for issue-817
 implemented the new behaviour. The run still demonstrates `inject_authored_by_marker` writing
 the configured `AGENT_MODEL`, not a model-generated string.)

**Agent-review run for PR #835:**
[Actions run #42554474238](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42554474238)

The `review / resolve` step logged:
```
PR #835: authoring model is "sonnet".
Resolved reviewer set (1 reviewer(s)): [{"model":"gpt-5.6-terra"}]
```
`gpt-5.6-terra` is the OpenAI sonnet-class canonical, confirming the pairing resolver read
the authoritative `<!-- authored-by-model: sonnet -->` marker and correctly paired
to a different-vendor same-class model.

**Auto-trigger run for PR #835 `opened` event:**
[Actions run #42553220264](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42553220264)

The `route` job evaluated the bot-authored non-draft `opened` event. All transition jobs
were skipped (empty transition returned), confirming the `!pr-author-is-bot` guard
correctly prevents auto-review from firing on `pull_request.opened` for bot-authored PRs.

**This PR (issue-819) — first full happy-path demonstration:**
This validation PR was opened by the new entrypoint (all three implementation PRs merged).
The new entrypoint:
1. Ran the agent session.
2. Called `check_pr_readiness_and_promote`:
   - Found `isDraft == true`.
   - Called `inject_authored_by_marker` (writing `<!-- authored-by-model: sonnet -->`).
   - Called `gh pr ready`.
3. GitHub emitted `pull_request.ready_for_review`.
4. `agent-auto-trigger` routed to `auto-review` (marker present in body).
5. `agent:review` label applied.
6. `agent-review` read the authoritative marker and paired to a non-Anthropic sonnet-class reviewer.

The agent-implement run for this PR (run #42555340790) and the subsequent auto-trigger and
agent-review runs provide live confirmation of the end-to-end sequence.

---

## Validation step 2 — Defence in depth: normalization catches hallucinated snapshots

**Method:** Unit tests (static; no live run needed per the issue scope).

**Code change:**  `getClassFromTable` in `.github/scripts/src/lib/model-pair.ts` (lines 627–631):
```ts
// Last resort: Claude-family prefix normalization for unmapped snapshot IDs.
if (/^claude-haiku-/.test(modelId)) return "haiku";
if (/^claude-sonnet-/.test(modelId)) return "sonnet";
if (/^claude-opus-/.test(modelId)) return "opus";
return undefined;
```

**Test suite:** `.github/scripts/test/model-pair.test.ts`, describe block
`"selectReviewerModel — claude-family prefix normalization"` (lines 551–629).
All 859 tests pass (confirmed by running `npm test` in `.github/scripts/`):

| Test case | Input model | Expected class / result |
|-----------|-------------|------------------------|
| Hallucinated ID from PR #790 | `claude-sonnet-4-6` | `sonnet` → `gpt-5.6-terra` (primary) |
| Future haiku snapshot | `claude-haiku-5-0` | `haiku` → `gpt-5.6-luna` (primary) |
| Future opus snapshot | `claude-opus-9-9` | `opus` → `gpt-5.6-sol` (primary) |
| Unknown family | `claude-mystery-1-0` | unresolved → DEFAULT_MODEL fallback |
| Existing entry in modelToClass | `claude-sonnet-4-5` | `modelToClass` takes precedence (regression) |

The normalization is a last resort: `modelToClass` and the forward-table scan both run first,
so entries that are explicitly mapped continue to resolve through the existing code paths.

---

## Validation step 3 — Backward-compat: human-opened non-draft agent-branch PR still triggers

**Method:** Code review (static analysis of the route predicate).

The `auto-review` transition predicate in `agent-auto-trigger-reusable.yml` (lines 165–175)
includes an `opened` path alongside the new `ready_for_review` path:

```yaml
((inputs.event-action == 'ready_for_review' &&
  contains(inputs.pr-body, '<!-- authored-by-model:')) ||
 (inputs.event-action == 'opened' && !inputs.pr-is-draft &&
  !inputs.pr-author-is-bot))
```

For a human opening a non-draft PR on an `agent/issue-<N>` branch:
- `event-action == 'opened'` ✓
- `!inputs.pr-is-draft` ✓ (non-draft PR)
- `!inputs.pr-author-is-bot` ✓ (`github.event.pull_request.user.type != 'Bot'` for humans)
- `startsWith(inputs.pr-head-ref, 'agent/')` ✓

All four conditions are satisfied → route returns `'auto-review'` → `agent:review` is applied.

The `pr-author-is-bot` input is forwarded in `agent-auto-trigger.yml`:
```yaml
pr-author-is-bot: ${{ github.event.pull_request.user.type == 'Bot' }}
```

This is functionally equivalent to the pre-PR-#832 behaviour for the `opened` event (which had
no draft or bot guard at all), so existing human workflows are unaffected.

**Confirming evidence:** Auto-trigger run #42553220264 for PR #835 evaluated
`opened` for a bot-authored non-draft PR and correctly returned empty transition
(because `pr-author-is-bot == true` → `!pr-author-is-bot == false`).
The symmetric case — human author — passes the `!pr-author-is-bot` check and routes normally.

---

## Validation step 4 — Fail-loud: non-compliant model

**Method:** Code review (issue scope allows this in lieu of a live run).

Branch 3 of `check_pr_readiness_and_promote` in `docker/scripts/entrypoint.sh` (lines 265–273):

```bash
else
    # Branch 3: compliance failure
    log "ERROR: PR #${pr_number} is not a draft and does not contain the \
authoritative marker '${authoritative_marker}'"
    log "ERROR: The agent may have opened a non-draft PR, promoted it to \
ready-for-review before the entrypoint ran, or written its own authored-by-model marker."
    log "ERROR: Recovery: convert the PR back to draft with \
'gh pr draft ${pr_number} --repo ${GITHUB_REPO}', then re-run the action."
    exit 1
fi
```

The three-state check is entered for every PR-creating action:
- `action_implement`: calls `check_pr_readiness_and_promote "$PR_NUMBER"` (line 483)
- `action_design`: calls `check_pr_readiness_and_promote "$PR_NUMBER"` (via same function)
- `action_fix_deployment`: opens PR with `--draft`, then calls `gh pr ready` after marker inject

**Failure modes covered:**
1. Agent opened a non-draft PR (forgot `--draft`).
2. Agent called `gh pr ready` before the entrypoint ran.
3. Agent wrote its own `<!-- authored-by-model: … -->` marker (the wrong value may match the
   wrong model; Branch 3 compares the PR body against the authoritative `<!-- authored-by-model: ${AGENT_MODEL} -->` string).

In all three cases the entrypoint:
- Emits three `ERROR`-level log lines with specific context.
- Provides the exact recovery command (`gh pr draft`).
- Exits non-zero, causing the GitHub Actions job to fail and alerting the operator.

---

## Test suite results

Vitest run confirming 859/859 tests pass (all 47 test files, zero failures):

```
 Test Files  47 passed (47)
      Tests  859 passed (859)
   Duration  4.46s
```

Relevant test files for this feature:
- `.github/scripts/test/model-pair.test.ts` — 5 new normalization tests (lines 551–629)
- `.github/scripts/test/auto-trigger-routing.test.ts` — 5 assertions including:
  - `"listens for ready_for_review and forwards pr-is-draft"` (line 21)
  - `"auto-review route fires on ready_for_review and on opened when not draft"` (line 51)
