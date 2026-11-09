# Design: Fix the auto-review / authored-by-model marker race

**Issue:** [#793](https://github.com/mfrancza/agentic-development-workflow/issues/793)

**Related designs:**
- [`docs/design/configurable-model-pair-preferences.md`](configurable-model-pair-preferences.md) — introduced the `<!-- authored-by-model: … -->` marker (Decision 4), the pairing resolver, and the Terraform-managed `REVIEW_MODEL_PAIRING` variable this design extends.
- [`docs/design/auto-trigger-agents.md`](auto-trigger-agents.md) — defines the `pull_request.opened` → `agent:review` transition this design re-anchors on `pull_request.ready_for_review`.
- [`docs/design/multi-provider-models.md`](multi-provider-models.md) — Claude-family provider inference consulted by the normalization fallback.
- [`docs/model-guidance.md`](../model-guidance.md) — cross-vendor capability-tier table consulted by the normalization fallback.

## Summary

The first auto-triggered review on an agent PR can read the wrong `<!-- authored-by-model: … -->` marker because the model self-writes a marker during `gh pr create`, `pull_request.opened` fires immediately, and the entrypoint's `inject_authored_by_marker` only overwrites the marker a few seconds later. This design closes the race in three layers:

1. **Draft+ready-for-review contract** — agent PRs open as draft, the entrypoint injects the authoritative marker, then the entrypoint flips the PR to ready-for-review. The auto-trigger listens for `pull_request.ready_for_review` and skips draft openings, so the first `agent:review` label application happens after the marker is authoritative.
2. **Prompt discipline** — the developer and designer prompts explicitly forbid writing an `authored-by-model` marker. The entrypoint continues to strip any stray marker before injecting its own (already the case; preserved for defence in depth).
3. **Pairing resolver normalization** — when the pairing resolver cannot find an authoring model in the class table, a `claude-<family>-*` prefix lookup normalizes any Claude snapshot (including hallucinated future snapshots like `claude-sonnet-4-6`) to its tier class so the resolver pairs by class instead of silently falling through to `DEFAULT_MODEL`.

## Threat model

**In scope:** accidental model or prompt-compliance errors. The scenarios this design addresses are:

- The model hallucinating its own model ID in an `authored-by-model` marker (the incident on PR #790).
- The model forgetting to pass `--draft` to `gh pr create`.
- The timing race: `pull_request.opened` fires before `inject_authored_by_marker` runs.
- The pairing resolver silently falling through to `DEFAULT_MODEL` for an unmapped snapshot ID.

**Out of scope:** a model inside the container deliberately calling `gh pr ready` before the entrypoint runs, or deliberately writing a made-up marker and then promoting the PR. This is accepted residual risk under the following reasoning: the model already holds a token that can edit the PR body and open a non-draft PR today; this design does not widen that token's permissions, does not add new triggers, and therefore does not make deliberate bypass riskier than it is now. The marker-presence check on `ready_for_review` events (Decision 2) reduces — but does not eliminate — exposure to the deliberate-promotion case; this is explicitly accepted as a residual risk (see **Out of scope** section).

## Requirements as understood

From the issue body ([#793](https://github.com/mfrancza/agentic-development-workflow/issues/793)) and the grooming notes:

1. **The first review triggered by `pull_request.opened` must see the configured authoring model, not a model-generated string.** The incident on PR #790 (2026-11-01) showed the developer model opening the PR with `<!-- authored-by-model: claude-sonnet-4-6 -->` (a self-hallucinated snapshot ID) at 22:40:19, the auto-triggered review reading it at 22:40:52, and the entrypoint overwriting the marker with the configured `sonnet` value only at 22:41:24. The pairing policy therefore ran as "Sonnet reviews Sonnet," exactly the blind-spot sharing the pairing config exists to prevent.

2. **The marker must be authoritative from the moment the PR becomes reviewable.** The issue proposal lists two acceptable mechanisms: (a) instruct the model to include a specific marker line in its `gh pr create`, or (b) have the entrypoint own PR creation / promotion to reviewable state. In either case the model must be told never to write its own `authored-by-model` marker.

3. **Defence in depth — normalize `claude-*` IDs to their tier class in the pairing resolver.** Even with the race closed, an unmapped Anthropic snapshot ID (future `claude-sonnet-5-0`, etc.) must still pair by class rather than silently falling through to `DEFAULT_MODEL`. The issue lists this as optional; this design treats it as required because (a) the implementation is small and (b) it closes the same observed pairing-miss in the one scenario the first two layers do not (a human-opened agent-branch PR that bypasses the draft contract, or a prompt-compliance failure).

4. **Acceptance signals** (verbatim from the issue, updated for the draft contract): (a) on a new agent PR, the review triggered by `pull_request.ready_for_review` logs the configured authoring model and the paired reviewer; (b) a unit test shows `claude-sonnet-4-6` resolving to the sonnet class.

### Ambiguities resolved

- **Entrypoint-owns-PR-creation vs draft-ready-for-review.** The issue proposal lists "entrypoint creates the PR body itself" as one option. Resolved as: **draft-ready-for-review**, because taking over `gh pr create` requires splitting the model's run into pre-PR (write title/body to files) and post-PR (apply labels, request reviewers) phases, which is a sweeping refactor relative to the problem being solved. The draft-ready-for-review contract achieves the same race-elimination with a two-line entrypoint change plus prompt discipline. See **Decision 1**.
- **What to do when the model forgets `--draft`.** Resolved as: **fail loudly in the entrypoint** rather than silently repair, because the race has already fired by the time the entrypoint sees the non-draft PR — silent repair would hide the compliance regression and leave the first review paired incorrectly. See **Decision 1**.
- **Scope of normalization.** Only `claude-<family>-*` IDs are normalized. OpenAI and xAI naming conventions are less uniform (`gpt-5.6-sol`, `gpt-6-astra`, `grok-4.5`, etc.), and the class-table coverage for those vendors is up to date; normalization there would be more guesswork than guard. See **Decision 4**.
- **Coordination of landing order.** Resolved as: the auto-trigger change (Decision 2) is backward-compatible and lands first; the entrypoint/prompt change (Decision 1) lands second; the normalization (Decision 4) lands independently. See **Task breakdown**.

## Design

### Decision 1 — Open agent PRs as draft; flip to ready-for-review after injecting the marker

**Decision.** For the three actions that create PRs — `action_implement`, `action_design`, `action_fix_deployment` — change the entrypoint so:

- `action_implement` and `action_design`: the model is instructed (via the prompt) to call `gh pr create --draft`. After the agent run completes, the entrypoint:
  1. Finds the PR (unchanged).
  2. Applies the three-state PR-readiness check (see partial-run recovery below). If a non-draft PR exists and the marker is absent or wrong, the entrypoint fails loudly.
  3. Calls `inject_authored_by_marker` (unchanged logic; already strips any stray marker and prepends the authoritative line).
  4. Calls `gh pr ready "$PR_NUMBER" --repo "$GITHUB_REPO"` to flip the PR to ready-for-review. GitHub emits `pull_request.ready_for_review`, which the auto-trigger listens for (see **Decision 2**).

- `action_fix_deployment`: the entrypoint already owns `gh pr create`. Add `--draft` to the `gh pr create` invocation; after `inject_authored_by_marker`, add the same `gh pr ready` call. No prompt change needed — the model does not open the PR here.

**Partial-run recovery state machine.** The `isDraft == true` assertion in step 2 would cause a re-run to fail incorrectly if a prior run had already promoted the PR (marker injected and `gh pr ready` called, but a subsequent step failed). To avoid this, the entrypoint implements a three-state check on `pr.isDraft`:

1. `pr.isDraft == true` → normal path: proceed through steps 3–4 (inject marker, flip to ready).
2. `pr.isDraft == false` AND the PR body already contains the authoritative marker (`<!-- authored-by-model: <CONFIGURED_MODEL> -->`) → partial-run recovery: a prior run succeeded at injecting the marker and promoting the PR; only downstream steps may remain. Skip steps 3–4, log "PR already ready with authoritative marker," and continue to any remaining post-PR steps.
3. `pr.isDraft == false` AND the marker is absent or does not match the configured model → compliance failure: the model opened a non-draft PR, the model called `gh pr ready` before the entrypoint, or the model wrote its own (incorrect) marker and promoted. Fail loudly (exit non-zero); do not apply `agent:review`.

The entrypoint knows the configured model at this point (the same value passed to `inject_authored_by_marker`) and can compare it to the marker already in the PR body. Issue #817 must implement all three branches explicitly; the existing description's reference to a simple `isDraft == true` assertion must be updated to reflect this state machine.

**Rationale.** The draft/ready-for-review transition is a natural semantic signal: "draft" means "not yet reviewable," which precisely matches "marker not yet authoritative." GitHub emits a distinct `ready_for_review` event when the transition happens, so the auto-trigger can anchor on that event instead of the racy `opened`. The entrypoint's existing `inject_authored_by_marker` logic stays unchanged — the only new steps are a `--draft` flag and a `gh pr ready` call. No refactor to the model's PR-creation flow.

**Fail-loud on non-draft PRs.** Prompt compliance is not guaranteed; a non-compliant model could still open a non-draft PR. With the bot-author gate on the `opened` path (Decision 2), a bot-authored non-draft PR no longer triggers `agent:review` immediately — the auto-trigger skips it because `is-bot-author` is true. The fail-loud check then surfaces the compliance failure without a mispaired review having been dispatched. The fail-loud check thus acts as a backstop that prevents silent mispairing; the bot-author gate (Decision 2) prevents the review from being dispatched in the first place.

**Recovery transition for branch 3 (non-draft, marker absent or wrong).** Once a PR has been promoted to ready, `action_design`/`action_implement` returns early because the PR already exists, and calling `gh pr ready` on a non-draft PR is a no-op — no `ready_for_review` event is emitted. The operator therefore cannot recover by simply re-running the action. The required recovery steps are:

1. The operator converts the PR back to draft: `gh pr draft <PR_NUMBER> --repo "$GITHUB_REPO"`.
2. The operator re-runs the original action (e.g. via workflow dispatch or by re-triggering the failed run).
3. The entrypoint now sees `isDraft == true` (branch 1), runs normally: injects the authoritative marker and calls `gh pr ready`, which emits `pull_request.ready_for_review` and triggers auto-review normally.

The entrypoint's fail-loud error message must include this instruction explicitly so the operator does not attempt a bare re-run. Issue #817 must implement the error message accordingly.

**Alternative considered — entrypoint takes over `gh pr create`.** Rejected. This eliminates the race unconditionally but splits the model's run into two phases (pre-PR title/body writing and post-PR label/reviewer actions) because the model does not yet know the PR number when it runs. The refactor touches `run_agent`'s contract, the `CODE_REVIEWERS` flow in `implement.md`, and the escalation flow in `implement.md` / `design.md` (both of which `gh pr edit` the newly-opened PR with `human-required`). A smaller fix achieves the same race elimination.

**Alternative considered — rely on prompt discipline alone ("never write a marker").** Rejected. Even if the model complies and writes no marker, the entrypoint's post-PR `inject_authored_by_marker` still runs after `pull_request.opened`, so the first auto-review would read a PR body with no marker and silently fall through to `DEFAULT_MODEL` — the same pairing miss, with a different trigger. Prompt discipline is necessary but not sufficient.

**Alternative considered — silent repair when the model forgets `--draft`.** Rejected (see above). The race has already fired; silent repair hides the regression.

### Decision 2 — Auto-trigger listens for `pull_request.ready_for_review`; skips draft openings

**Decision.** Modify `.github/workflows/agent-auto-trigger.yml` and `agent-auto-trigger-reusable.yml`:

- **`agent-auto-trigger.yml`** — add `ready_for_review` to `on.pull_request.types`, and forward `github.event.pull_request.draft`, `github.event.pull_request.user.type == 'Bot'`, and `github.event.pull_request.body || ''` as new reusable inputs (`pr-is-draft`, `is-bot-author`, and `pr-body` respectively).
- **`agent-auto-trigger-reusable.yml`** — add a `pr-is-draft` boolean input, an `is-bot-author` boolean input, and a `pr-body` string input. Forward `github.event.pull_request.draft`, derive `is-bot-author` from `github.event.pull_request.user.type == 'Bot'`, and forward `pr-body` as `github.event.pull_request.body || ''` in the caller. The reusable workflow runs under `workflow_call` and cannot directly access `github.event` from the caller context, so all event data needed by the reusable must be passed as explicit inputs. Modify the `auto-review` transition predicate in the `route` job so it fires when:
  - `event-name == 'pull_request'` AND
  - `event-action == 'ready_for_review'` (new), OR `event-action == 'opened' AND !pr-is-draft AND !is-bot-author` (existing path, now draft-gated **and bot-author-gated**), AND
  - the **existing** head-repo, branch-name, and allowlist checks (unchanged — the `ready_for_review` path does not loosen these guards; it accepts the same set of PRs that `opened` accepts, filtered only by the new event-type and marker-presence check below).
- Keep the `pull_request.opened` path **for human-authored PRs only**: a human opening a non-draft PR on an `agent/*` or `design/*` branch still gets `agent:review` applied (no marker race because no agent is in the loop).

**Bot-author gate is essential for the prompt-compliance failure case.** If a model forgets `--draft`, GitHub emits `opened` before the entrypoint can assert `isDraft`. Without the `!is-bot-author` gate, the route predicate evaluates `opened AND !draft` as true, applies `agent:review` immediately, and the reviewer reads whatever stale or missing marker the model wrote. The entrypoint's fail-loud check (Decision 1) detects the non-draft state afterward, but it cannot prevent or retract a review that is already running or posted. With `!is-bot-author` on the `opened` path, bot-authored non-draft openings are silently skipped by the auto-trigger; the fail-loud check then surfaces the compliance failure without a mispaired review having been dispatched.

**Rollout coordination.** The bot-author gate on `opened` means bot-authored PRs that open non-draft will not trigger via `opened` (blocked by `is-bot-author`) and will not yet trigger via `ready_for_review` (because the entrypoint has not yet added the `gh pr ready` flip). To avoid a window where bot-authored agent PRs receive no auto-review: **Issue #816 (this task) and Issue #817 (entrypoint draft contract) must land in the same deployment window.** Deploying Issue #816 alone during active agent hours is not recommended. If a phased rollout is required, the bot-author gate may be merged as a separate follow-on commit within the Issue #816 PR but held from merge until Issue #817 is ready to land simultaneously.

**Rationale.** Adding `ready_for_review` and gating `opened` on both `!draft` and `!is-bot-author` closes the race completely for the prompt-compliance failure path. The route predicate remains the single auditable truth-table for every SDLC transition. `github.event.pull_request.user.type` is a stable GitHub field that is `'Bot'` for GitHub App actors (including the entrypoint's `gh` CLI context) and `'User'` for humans.

**Alternative considered — gate `opened` on `!draft` only (no bot-author check).** Rejected. As noted above, a model forgetting `--draft` causes `opened` to fire with `draft == false`; the predicate evaluates true, `agent:review` is applied before the marker is authoritative, and the race is reproduced. The fail-loud check cannot retract the review.

**Alternative considered — replace `opened` with `ready_for_review` entirely.** Rejected. A human opening a non-draft PR directly on an agent branch (e.g., cherry-picking from a fork) is a rare but supported path today; silently removing auto-review for that path is an unrelated behavior change.

**Alternative considered — rely on a per-PR check in the auto-review job rather than the route predicate.** Rejected. The route predicate is the single auditable truth-table for every SDLC transition; pushing the draft check downstream into the job splits the contract across two places.

**Residual risk — model-initiated `gh pr ready` bypass.** A model holding the existing write token could call `gh pr ready` before the entrypoint injects the marker, causing `ready_for_review` to fire with a stale or absent marker. This is accepted residual risk under the threat model (see **Threat model** section): the model already holds a token that can open non-draft PRs and edit the PR body today; this design does not widen that surface. To reduce exposure for the absent-marker case: in the auto-trigger's `ready_for_review` path, before applying `agent:review`, the route job verifies that an `<!-- authored-by-model: … -->` marker is present in the PR body. The marker-presence check uses `contains(inputs.pr-body, '<!-- authored-by-model:')` as an expression-level `if:` condition, or binds `inputs.pr-body` to an `env:` variable before the condition check — the raw value must **never be interpolated directly into a `run:` script** (untrusted content). Because the reusable workflow runs under `workflow_call` and has no access to the caller's `github.event`, the PR body is supplied via the `pr-body` input defined above (forwarded as `github.event.pull_request.body || ''` by the caller). If the marker is absent, the route job skips label application and exits cleanly; the entrypoint's fail-loud check will surface the violation when it runs. This guards the absent-marker case but does not guard against a model-written (hallucinated) marker followed by `gh pr ready` — that case is accepted residual risk (see **Out of scope**). Issue #816 must implement this marker-presence check using `inputs.pr-body` as the data path.

### Decision 3 — Prompt discipline: never write the marker; open PRs as draft

**Decision.** Update the prompt files:

- `docker/scripts/prompts/implement.md` and `docker/scripts/prompts/design.md`:
  - Replace the current "`Use the gh CLI … open a PR`" line with an explicit instruction to call `gh pr create --draft …`. Document that the entrypoint flips the PR to ready-for-review after injecting the `authored-by-model` marker.
  - Add: "Do not write a `<!-- authored-by-model: ... -->` marker in the PR body. The entrypoint injects the authoritative marker; the model writing its own value silently mispairs the first auto-review."
  - Keep the existing "do not remove the marker" bullet (relevant to `gh pr edit` from later phases).
- `docker/scripts/prompts/respond-to-review.md`, `respond-to-checks.md`, `fix-deployment.md`: add the same "do not write a marker" sentence next to the existing preservation bullet. These actions do not create PRs; the sentence prevents the model from introducing a marker during `gh pr edit --body`.

**Rationale.** Prompt discipline is the first defence against a race that an operator sees after the fact (reviewing workflow logs). The entrypoint's fail-loud check (Decision 1) catches the compliance failure; the prompt change prevents it from happening in the first place. Both are needed — prompt-only would miss the case where the model opens a non-draft PR without writing a marker (the first auto-review would then see no marker and fall through to `DEFAULT_MODEL`); fail-loud-only would be a jarring operator experience for a mistake the prompt can prevent.

**Alternative considered — have the entrypoint pass a specific marker line to the model and instruct it to include exactly that line.** Rejected. Writing "include this exact line" still leaves the race intact (the marker is in the PR body at `pull_request.opened` time, which is fine, but any model error — hallucinated model ID, missing line, paraphrased line — reproduces the original bug with a slightly different failure mode). The draft-ready-for-review contract is race-free by construction; prompt-only compliance is not.

### Decision 4 — Normalize `claude-<family>-*` IDs to class in the pairing resolver

**Decision.** Extend the class-lookup path in `.github/scripts/src/lib/model-pair.ts` (specifically `getClassFromTable`) so that when a model ID is not present in `modelToClass` and not found by the forward-table scan, a Claude-family prefix lookup is tried:

- `claude-haiku-*` → `"haiku"`
- `claude-sonnet-*` → `"sonnet"`
- `claude-opus-*` → `"opus"`

Any other `claude-*` ID that does not match one of the three families (unlikely but possible for a future product name) remains unresolved and the resolver continues its existing warning/fallback behavior.

Add Vitest coverage in `.github/scripts/test/model-pair.test.ts` (and/or the shared classes test) that exercises the normalization for a representative hallucinated ID (`claude-sonnet-4-6` → sonnet class), one haiku case (`claude-haiku-5-0` → haiku class), one opus case (`claude-opus-9-9` → opus class), and one no-match case (`claude-mystery-1-0` → undefined class, resolver still falls through).

**Rationale.** The class table enumerates concrete snapshots (`claude-sonnet-4-5`, `claude-haiku-4-5`, etc.); a hallucinated future snapshot like `claude-sonnet-4-6` has the same sonnet-class semantics but isn't yet enumerated. A prefix-based normalization is deterministic and never guesses across tiers — the Claude-family naming convention is `claude-<family>-<version>`, where `<family>` ∈ {`haiku`,`sonnet`,`opus`} has been stable since the 3-series. Normalization at the resolver layer means a marker-race that evades layers 1 and 2 still produces a class-correct pairing.

The existing `modelToClass` entries continue to take precedence — the normalization only fires on a miss. So pinned snapshot IDs that are explicitly present in `modelToClass` still resolve through the authoritative reverse-lookup path.

**Alternative considered — maintain the class table more aggressively (auto-add every new Claude snapshot).** Rejected as orthogonal and higher-maintenance. Prefix normalization covers the forward-compatibility case without a per-snapshot code change.

**Alternative considered — generalize normalization across OpenAI and xAI naming.** Rejected. Those vendors use product-line names (`gpt-5.6-sol`, `grok-4.6`) rather than `<family>-<version>` patterns, so there is no safe prefix lookup. Class-table maintenance remains the mechanism for those vendors.

### Decision 5 — Scope of entrypoint changes

**Decision.** Only the three PR-creating actions need `--draft` + `gh pr ready`:

- `action_implement` — model opens PR; prompt change + entrypoint flip.
- `action_design` — model opens PR; prompt change + entrypoint flip.
- `action_fix_deployment` — entrypoint opens PR; entrypoint `--draft` + flip, no prompt change.

The other two marker-injecting actions — `action_fix_checks` and `action_respond_review` — do not create PRs; the marker injection there is a refresh on an already-ready PR. These actions get the prompt-level "do not write a marker" update (Decision 3) but no entrypoint flip.

**Rationale.** Keeps the entrypoint diff tight and matches the scope of the race: the race only exists on PR *creation*, not on PR *update*.

### Decision 6 — Documentation updates land with the entrypoint-wiring PR

**Decision.** In the sub-issue that wires Decision 1 into the entrypoint (**Task B** below), update in the same PR:

- `AGENTS.md` — the "Auto-trigger gates" table gains a note that transition #5 now fires on `pull_request.ready_for_review` (with `pull_request.opened && !draft` retained for human-opened agent-branch PRs).
- `AGENTS.md` — the `inject_authored_by_marker` paragraph (if any) notes that agent PRs open as draft and are flipped to ready after the marker is written. If no such paragraph exists, do not add one — the entrypoint is the single source of truth per repo convention.
- `docs/design/configurable-model-pair-preferences.md` — Decision 4 gains a cross-reference to this doc noting the draft+ready-for-review contract that makes the marker authoritative at pair-tier read time.
- `docs/model-guidance.md` — the "Cross-vendor class table" section gains a short note explaining the Claude-family prefix normalization (Decision 4 of this doc).

**Rationale.** `AGENTS.md`'s "Keeping Documentation Current" convention requires docs-in-the-same-PR when behavior changes. Bundling the docs with Task B means the merged state is self-consistent at every point.

## Out of scope

- **Taking over `gh pr create` in the entrypoint for `action_implement` and `action_design`.** The draft-ready-for-review contract eliminates the race with a much smaller change; the full refactor is deferred until a second motivating requirement emerges.
- **Backfilling the marker on PRs already open at the time the fix lands.** Pre-fix PRs that were reviewed with the wrong marker have already been reviewed; a re-review by applying `agent:review` on the current (corrected) marker is the operator-visible mitigation path.
- **Changing the pairing resolver's `DEFAULT_MODEL` behavior when no marker is present.** The existing "marker absent → skip pairing tier, fall through to `DEFAULT_MODEL`" behavior is preserved; this design only changes when the marker is present-but-unmapped.
- **OpenAI and xAI normalization.** See Decision 4 rationale.
- **Removing the `pull_request.opened` path from the auto-trigger.** Kept for human-opened non-draft agent-branch PRs (Decision 2).
- **Changing GitHub-side event behavior for `agent-review.yml`.** The reviewer workflow still fires on label application; this design only affects when the label is applied by the auto-trigger.
- **Credential-enforced promotion boundary (accepted residual risk).** A model that deliberately calls `gh pr ready` with a hallucinated marker before the entrypoint runs can still trigger auto-review with an incorrect pairing. This is accepted residual risk under the threat model of this design (see **Threat model** section): accidental errors (hallucinated IDs, forgotten `--draft`, timing race) are in scope; deliberate bypass by a model inside the container is not. The model already holds a token that can open non-draft PRs and edit the PR body today; this design does not widen that surface. The marker-presence check on `ready_for_review` events (Decision 2) partially mitigates this exposure for the absent-marker sub-case.

## Task breakdown

Dependencies are tracked in GitHub as native `blocked_by` relationships.

| Issue | Task | Depends on |
|-------|------|------------|
| Issue #816 | Extend `agent-auto-trigger.yml` and `agent-auto-trigger-reusable.yml` to listen for `pull_request.ready_for_review` and to gate `pull_request.opened` on both `!draft` and `!is-bot-author`. Add `pr-is-draft`, `is-bot-author`, and `pr-body` inputs to the reusable workflow; in the caller (`agent-auto-trigger.yml`) forward `github.event.pull_request.draft`, `github.event.pull_request.user.type == 'Bot'`, and `github.event.pull_request.body \|\| ''` respectively. Update the route predicate per Decision 2. Add marker-presence check on the `ready_for_review` branch per Decision 2 using `contains(inputs.pr-body, '<!-- authored-by-model:')` as an expression-level `if:` condition or via an `env:` variable — never interpolate `inputs.pr-body` into a `run:` script. **Must land in the same deployment window as Issue #817** (see Decision 2 rollout coordination note); bot-authored agent PRs will receive no auto-review in the gap between the two. | — |
| Issue #817 | Update `docker/scripts/entrypoint.sh` per Decisions 1 & 5: `action_fix_deployment` opens with `gh pr create --draft`; `action_implement` and `action_design` implement the three-state PR-readiness check (see Decision 1 partial-run recovery state machine): (1) `isDraft == true` → inject marker + flip; (2) `isDraft == false` and marker is authoritative → skip injection, continue; (3) `isDraft == false` and marker absent or wrong → fail loudly. All three PR-creating actions call `gh pr ready` after `inject_authored_by_marker`. Update `docker/scripts/prompts/implement.md`, `design.md`, `respond-to-review.md`, `respond-to-checks.md`, `fix-deployment.md` per Decision 3 (open as draft where applicable; never write the marker). Update `AGENTS.md` and this design's cross-reference in `docs/design/configurable-model-pair-preferences.md` per Decision 6. | Issue #816 |
| Issue #818 | Extend `.github/scripts/src/lib/model-pair.ts` (and/or `model-classes.ts`) with the `claude-<family>-*` normalization per Decision 4. Add Vitest coverage in `.github/scripts/test/model-pair.test.ts` for `claude-sonnet-4-6` → sonnet, `claude-haiku-5-0` → haiku, `claude-opus-9-9` → opus, and `claude-mystery-1-0` → unresolved. Update `docs/model-guidance.md` with the normalization note per Decision 6. | — |
| Issue #819 | End-to-end validation on a test issue: (1) apply `agent:developer` to a test issue with a provider configured such that the authoring model is Anthropic-sonnet-class; confirm the entrypoint logs show the PR opening as draft, `inject_authored_by_marker` writing the configured model, and `gh pr ready` flipping the PR; (2) confirm the first auto-triggered review workflow run reads the configured marker (not any model-generated string) and pairs to a non-Anthropic sonnet-class reviewer; (3) temporarily set `AGENT_MODEL` to a snapshot ID not in `modelToClass` (e.g. via a workflow dispatch override) and confirm the resolver normalizes to the sonnet class via Decision 4; (4) verify that a human-opened non-draft agent-branch PR still triggers auto-review via the preserved `pull_request.opened` path. | Issues #816, #817, #818 |

Issues #816 and #818 are independent. Issue #817 depends on #816 because the entrypoint's `gh pr ready` flip is only useful once the auto-trigger listens for `pull_request.ready_for_review`. Issue #819 depends on all three implementation tasks.
