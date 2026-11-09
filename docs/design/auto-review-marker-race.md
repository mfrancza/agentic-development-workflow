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
4. **Credential-enforced promotion boundary** — the developer-agent session uses a token restricted to `contents: write` + `issues: write` (no `pull-requests` permission); the entrypoint retains the system token for all PR API calls. Because GitHub's permission model does not allow `gh pr create` without also allowing `gh pr ready`, this requires the entrypoint to own all PR lifecycle calls for `action_implement` and `action_design`. A model that attempts `gh pr ready` with a hallucinated marker receives a 403 at the API level, making the draft/ready contract enforceable by construction rather than by prompt discipline (see **Decision 6**).

## Requirements as understood

From the issue body ([#793](https://github.com/mfrancza/agentic-development-workflow/issues/793)) and the grooming notes:

1. **The first review triggered by `pull_request.opened` must see the configured authoring model, not a model-generated string.** The incident on PR #790 (2026-11-01) showed the developer model opening the PR with `<!-- authored-by-model: claude-sonnet-4-6 -->` (a self-hallucinated snapshot ID) at 22:40:19, the auto-triggered review reading it at 22:40:52, and the entrypoint overwriting the marker with the configured `sonnet` value only at 22:41:24. The pairing policy therefore ran as "Sonnet reviews Sonnet," exactly the blind-spot sharing the pairing config exists to prevent.

2. **The marker must be authoritative from the moment the PR becomes reviewable.** The issue proposal lists two acceptable mechanisms: (a) instruct the model to include a specific marker line in its `gh pr create`, or (b) have the entrypoint own PR creation / promotion to reviewable state. In either case the model must be told never to write its own `authored-by-model` marker.

3. **Defence in depth — normalize `claude-*` IDs to their tier class in the pairing resolver.** Even with the race closed, an unmapped Anthropic snapshot ID (future `claude-sonnet-5-0`, etc.) must still pair by class rather than silently falling through to `DEFAULT_MODEL`. The issue lists this as optional; this design treats it as required because (a) the implementation is small and (b) it closes the same observed pairing-miss in the one scenario the first two layers do not (a human-opened agent-branch PR that bypasses the draft contract, or a prompt-compliance failure).

4. **Acceptance signals** (verbatim from the issue): (a) on a new agent PR, the review triggered by `pull_request.opened` logs the configured authoring model and the paired reviewer; (b) a unit test shows `claude-sonnet-4-6` resolving to the sonnet class.

### Ambiguities resolved

- **Entrypoint-owns-PR-creation vs draft-ready-for-review.** The issue proposal lists "entrypoint creates the PR body itself" as one option. Initially resolved as: **draft-ready-for-review**, because taking over `gh pr create` required splitting the model's run. Revised after the credential-separation analysis (see **Decision 6**): GitHub's permission model grants `gh pr ready` to any token that can call `gh pr create --draft`, so the only enforceable boundary is revoking `pull-requests: write` from the model's token entirely — which requires the entrypoint to own all PR API calls for `action_implement` and `action_design`. The draft/ready-for-review contract is retained as the event-ordering mechanism; entrypoint-owned creation is added as the enforcement mechanism. See **Decisions 1 and 6**.
- **What to do when the model forgets `--draft`.** Resolved as: **fail loudly in the entrypoint** rather than silently repair, because the race has already fired by the time the entrypoint sees the non-draft PR — silent repair would hide the compliance regression and leave the first review paired incorrectly. See **Decision 1**.
- **Scope of normalization.** Only `claude-<family>-*` IDs are normalized. OpenAI and xAI naming conventions are less uniform (`gpt-5.6-sol`, `gpt-6-astra`, `grok-4.5`, etc.), and the class-table coverage for those vendors is up to date; normalization there would be more guesswork than guard. See **Decision 4**.
- **Coordination of landing order.** Resolved as: the auto-trigger change (Decision 2) is backward-compatible and lands first; the entrypoint/prompt change (Decision 1) lands second; the normalization (Decision 4) lands independently. See **Task breakdown**.

## Design

### Decision 1 — Open agent PRs as draft; flip to ready-for-review after injecting the marker

**Decision.** For the three actions that create PRs — `action_implement`, `action_design`, `action_fix_deployment` — change the entrypoint so:

- `action_implement` and `action_design`: the model writes PR title and body to `.pr-metadata.json` in the workspace root (see **Decision 6**) and does NOT call `gh pr create`. After the agent run completes, the entrypoint:
  1. Reads `.pr-metadata.json` and calls `gh pr create --draft` using the system token (entrypoint-owned PR creation per Decision 6).
  2. Applies the three-state PR-readiness check (see partial-run recovery below). If a non-draft PR exists and the marker is absent or wrong, the entrypoint fails loudly.
  3. Calls `inject_authored_by_marker` (unchanged logic; already strips any stray marker and prepends the authoritative line).
  4. Calls `gh pr ready "$PR_NUMBER" --repo "$GITHUB_REPO"` to flip the PR to ready-for-review. GitHub emits `pull_request.ready_for_review`, which the auto-trigger listens for (see **Decision 2**).

- `action_fix_deployment`: the entrypoint already owns `gh pr create`. Add `--draft` to the `gh pr create` invocation; after `inject_authored_by_marker`, add the same `gh pr ready` call. No prompt change needed — the model does not open the PR here.

**Partial-run recovery state machine.** The `isDraft == true` assertion in step 2 would cause a re-run to fail incorrectly if a prior run had already promoted the PR (marker injected and `gh pr ready` called, but a subsequent step failed). To avoid this, the entrypoint implements a three-state check on `pr.isDraft`:

1. `pr.isDraft == true` → normal path: proceed through steps 3–4 (inject marker, flip to ready).
2. `pr.isDraft == false` AND the PR body already contains the authoritative marker (`<!-- authored-by-model: <CONFIGURED_MODEL> -->`) → partial-run recovery: a prior run succeeded at injecting the marker and promoting the PR; only downstream steps may remain. Skip steps 3–4, log "PR already ready with authoritative marker," and continue to any remaining post-PR steps.
3. `pr.isDraft == false` AND the marker is absent or does not match the configured model → compliance failure: the model opened a non-draft PR, the model called `gh pr ready` before the entrypoint, or the model wrote its own (incorrect) marker and promoted. Fail loudly (exit non-zero); do not apply `agent:review`.

The entrypoint knows the configured model at this point (the same value passed to `inject_authored_by_marker`) and can compare it to the marker already in the PR body. Issue #817 must implement all three branches explicitly; the existing description's reference to a simple `isDraft == true` assertion must be updated to reflect this state machine.

**Rationale.** The draft/ready-for-review transition is a natural semantic signal: "draft" means "not yet reviewable," which precisely matches "marker not yet authoritative." GitHub emits a distinct `ready_for_review` event when the transition happens, so the auto-trigger can anchor on that event instead of the racy `opened`. The entrypoint's existing `inject_authored_by_marker` logic stays unchanged — the new steps are entrypoint-owned PR creation (Decision 6), a `--draft` flag, and a `gh pr ready` call. The model's prompt is updated to write `.pr-metadata.json` instead of calling `gh pr create`.

**Fail-loud on non-draft PRs.** Prompt compliance is not guaranteed; a non-compliant model could still open a non-draft PR. With the bot-author gate on the `opened` path (Decision 2), a bot-authored non-draft PR no longer triggers `agent:review` immediately — the auto-trigger skips it because `is-bot-author` is true. The fail-loud check then surfaces the compliance failure without a mispaired review having been dispatched. The failure mode is: workflow run fails; operator reads the error, inspects the PR (no `agent:review` applied yet), re-runs the action after the entrypoint corrects the state (or manually invokes `inject_authored_by_marker` and `gh pr ready`), and auto-review proceeds normally via `pull_request.ready_for_review`. The fail-loud check thus acts as a backstop that prevents silent mispairing; the bot-author gate (Decision 2) prevents the review from being dispatched in the first place.

**Alternative considered — entrypoint takes over `gh pr create`.** Initially declined as the primary fix because a smaller change (prompt discipline + fail-loud) appeared sufficient. Subsequently adopted in **Decision 6** after the credential-separation analysis showed that GitHub's permission model grants `gh pr ready` to any token that can call `gh pr create --draft`. Since there is no supported way to restrict the model to PR creation without also granting PR promotion, enforcing the invariant at the API level requires the entrypoint to own all PR lifecycle calls. See **Decision 6** for the full scope and rationale.

**Alternative considered — rely on prompt discipline alone ("never write a marker").** Rejected. Even if the model complies and writes no marker, the entrypoint's post-PR `inject_authored_by_marker` still runs after `pull_request.opened`, so the first auto-review would read a PR body with no marker and silently fall through to `DEFAULT_MODEL` — the same pairing miss, with a different trigger. Prompt discipline is necessary but not sufficient.

**Alternative considered — silent repair when the model forgets `--draft`.** Rejected (see above). The race has already fired; silent repair hides the regression.

### Decision 2 — Auto-trigger listens for `pull_request.ready_for_review`; skips draft openings

**Decision.** Modify `.github/workflows/agent-auto-trigger.yml` and `agent-auto-trigger-reusable.yml`:

- **`agent-auto-trigger.yml`** — add `ready_for_review` to `on.pull_request.types`, and forward `github.event.pull_request.draft` as a new reusable input.
- **`agent-auto-trigger-reusable.yml`** — add a `pr-is-draft` boolean input and an `is-bot-author` boolean input. Forward `github.event.pull_request.draft` and derive `is-bot-author` from `github.event.pull_request.user.type == 'Bot'` in the caller. Modify the `auto-review` transition predicate in the `route` job so it fires when:
  - `event-name == 'pull_request'` AND
  - `event-action == 'ready_for_review'` (new), OR `event-action == 'opened' AND !pr-is-draft AND !is-bot-author` (existing path, now draft-gated **and bot-author-gated**), AND
  - the existing head-repo / branch-name / author checks.
- Keep the `pull_request.opened` path **for human-authored PRs only**: a human opening a non-draft PR on an `agent/*` or `design/*` branch still gets `agent:review` applied (no marker race because no agent is in the loop).

**Bot-author gate is essential for the prompt-compliance failure case.** If a model forgets `--draft`, GitHub emits `opened` before the entrypoint can assert `isDraft`. Without the `!is-bot-author` gate, the route predicate evaluates `opened AND !draft` as true, applies `agent:review` immediately, and the reviewer reads whatever stale or missing marker the model wrote. The entrypoint's fail-loud check (Decision 1) detects the non-draft state afterward, but it cannot prevent or retract a review that is already running or posted. With `!is-bot-author` on the `opened` path, bot-authored non-draft openings are silently skipped by the auto-trigger; the fail-loud check then surfaces the compliance failure without a mispaired review having been dispatched.

**Rollout coordination.** The bot-author gate on `opened` means bot-authored PRs that open non-draft will not trigger via `opened` (blocked by `is-bot-author`) and will not yet trigger via `ready_for_review` (because the entrypoint has not yet added the `gh pr ready` flip). To avoid a window where bot-authored agent PRs receive no auto-review: **Issue #816 (this task) and Issue #817 (entrypoint draft contract) must land in the same deployment window.** Deploying Issue #816 alone during active agent hours is not recommended. If a phased rollout is required, the bot-author gate may be merged as a separate follow-on commit within the Issue #816 PR but held from merge until Issue #817 is ready to land simultaneously.

**Rationale.** Adding `ready_for_review` and gating `opened` on both `!draft` and `!is-bot-author` closes the race completely for the prompt-compliance failure path. The route predicate remains the single auditable truth-table for every SDLC transition. `github.event.pull_request.user.type` is a stable GitHub field that is `'Bot'` for GitHub App actors (including the entrypoint's `gh` CLI context) and `'User'` for humans.

**Alternative considered — gate `opened` on `!draft` only (no bot-author check).** Rejected. As noted above, a model forgetting `--draft` causes `opened` to fire with `draft == false`; the predicate evaluates true, `agent:review` is applied before the marker is authoritative, and the race is reproduced. The fail-loud check cannot retract the review.

**Alternative considered — replace `opened` with `ready_for_review` entirely.** Rejected. A human opening a non-draft PR directly on an agent branch (e.g., cherry-picking from a fork) is a rare but supported path today; silently removing auto-review for that path is an unrelated behavior change.

**Alternative considered — rely on a per-PR check in the auto-review job rather than the route predicate.** Rejected. The route predicate is the single auditable truth-table for every SDLC transition; pushing the draft check downstream into the job splits the contract across two places.

**Previously residual risk — model-initiated `gh pr ready` bypass, now closed by Decision 6.** The `ready_for_review` route accepts all bot-authored events without a draft guard, because the entrypoint is the expected source of that event. If the model were to call `gh pr ready` before the entrypoint injects the marker, `ready_for_review` would fire with a stale or absent marker, `agent:review` would be applied, and the first review would run with incorrect pairing. The marker-presence check below guards the absent-marker case. The hallucinated-marker case (model writes an incorrect marker, then calls `gh pr ready`) is closed by **Decision 6**: with the model's token restricted to `contents: write` + `issues: write` and no `pull-requests` permission, any `gh pr ready` call receives a 403 at the API level — the model cannot promote the PR regardless of what it writes to the PR body. The marker-presence check is therefore retained as defence-in-depth for unexpected bypass paths, not as the primary enforcement mechanism. To implement: in the auto-trigger's `ready_for_review` path, before applying `agent:review`, the route job verifies that an `<!-- authored-by-model: … -->` marker is present in the PR body. If the marker is absent, the route job skips label application and exits cleanly; the entrypoint's fail-loud check will surface the violation when it runs. Issue #816 must implement this marker-presence check as part of the `ready_for_review` route.

### Decision 3 — Prompt discipline: never write the marker; open PRs as draft

**Decision.** Update the prompt files:

- `docker/scripts/prompts/implement.md` and `docker/scripts/prompts/design.md`:
  - Replace the current "`Use the gh CLI … open a PR`" line with an explicit instruction to write `{"title": "...", "body": "..."}` to `.pr-metadata.json` in the workspace root and push the branch. Do NOT call `gh pr create`. Document that the entrypoint reads `.pr-metadata.json`, creates the draft PR using the system token, injects the `authored-by-model` marker, and flips the PR to ready-for-review (see **Decision 6**). Because the model's token has no `pull-requests` permission, any `gh pr create --draft` call would return HTTP 403; the prompt change is a belt-and-suspenders instruction on top of the API-level enforcement.
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

- `action_implement` — entrypoint opens PR (Decision 6); prompt change to write `.pr-metadata.json` instead of calling `gh pr create`; entrypoint flip.
- `action_design` — entrypoint opens PR (Decision 6); prompt change to write `.pr-metadata.json` instead of calling `gh pr create`; entrypoint flip.
- `action_fix_deployment` — entrypoint opens PR; entrypoint `--draft` + flip, no prompt change.

The other two marker-injecting actions — `action_fix_checks` and `action_respond_review` — do not create PRs; the marker injection there is a refresh on an already-ready PR. These actions get the prompt-level "do not write a marker" update (Decision 3) but no entrypoint flip.

**Rationale.** Keeps the entrypoint diff tight and matches the scope of the race: the race only exists on PR *creation*, not on PR *update*.

### Decision 6 — Credential-enforced promotion boundary: entrypoint-owned PR creation for `action_implement` and `action_design`

**Decision.** For `action_implement` and `action_design`, the entrypoint creates the draft PR rather than the model. The model's agent session is provisioned with a token scoped to `contents: write` and `issues: write` (no `pull-requests` permission), so it can push branches and create sub-issues but cannot call any PR API endpoint. The entrypoint uses the system token (GitHub App installation token with `pull-requests: write`) for all PR lifecycle calls: `gh pr create --draft`, `inject_authored_by_marker`, and `gh pr ready`.

**Protocol:**

1. The model's prompt (`implement.md`, `design.md`) is updated to: write `{"title": "...", "body": "..."}` to `.pr-metadata.json` in the workspace root and push the branch. Do NOT call `gh pr create`.
2. After `run_agent` completes, the entrypoint reads `.pr-metadata.json` and calls `gh pr create --draft --title "..." --body "..."` using the system token.
3. The entrypoint proceeds through Decision 1's three-state PR-readiness check, `inject_authored_by_marker`, and `gh pr ready`.

**Why per-endpoint permission scoping is unavailable.** GitHub fine-grained tokens and App installation tokens scope `pull-requests: write` at the resource-type level, not per-endpoint. A token that can call `POST /repos/.../pulls` (create PR) also allows `PATCH /repos/.../pulls/{n}` (update PR, the endpoint `gh pr ready` uses). There is no supported mechanism to grant create without granting update. Therefore, the only way to prevent the model from calling `gh pr ready` is to revoke `pull-requests: write` from the model's token entirely — which requires the entrypoint to handle all PR API calls.

**Rationale.** Requirement 2 states that "the marker must be authoritative from the moment the PR becomes reviewable." The draft/ready-for-review contract (Decision 1) achieves this for the happy path and for prompt-compliance failures where the model opens a non-draft PR (blocked by the bot-author gate, surfaced by the fail-loud check). The remaining bypass — model writes a hallucinated marker and calls `gh pr ready` before the entrypoint — cannot be prevented by prompt discipline (Decision 3) or the marker-presence check (Decision 2) alone, because both are advisory checks that the model can bypass by holding the same write token. Only an API-level token boundary eliminates this bypass path. This decision defines that boundary.

**Token-provisioning infrastructure.** A new **GitHub App** is created for the model session with the following permission scope: `contents: write` (branch push) and `issues: write` (sub-issue creation and `blocked_by` dependency management for `action_design`), but **no `pull-requests` permission**. `issues: write` is necessary because `action_design` must create sub-issues and wire `blocked_by` dependencies during the agent run; a token that only has `contents: write` would cause `action_design` to fail before it can create any required sub-issues. GitHub App permissions allow `issues: write` to be granted independently of `pull-requests: write`, so the enforcement boundary is preserved.

**Bootstrap path (maintainer-owned, out-of-band).** GitHub App registration — creating the App in GitHub's App settings, selecting its permission scope, and generating its private key — cannot be performed by Terraform. This repository's Terraform manages repository settings, variables, branch protection, and labels; it consumes Actions secrets but cannot create them. A maintainer must therefore perform the following steps before Issue #817 can be implemented:

1. Register the new GitHub App in the organization's (or personal account's) GitHub App settings, granting **`contents: write`** and **`issues: write`** only; do not grant `pull-requests`.
2. Install the App on this repository.
3. Generate a private key for the App via the GitHub UI.
4. Store the App ID as `RESTRICTED_APP_ID` and the private key PEM as `RESTRICTED_APP_PRIVATE_KEY` in this repository's Actions secrets.

Terraform and workflows only *consume* those secrets — `actions/create-github-app-token` reads `RESTRICTED_APP_ID` and `RESTRICTED_APP_PRIVATE_KEY` to mint the restricted installation token before `docker run`. Rotation of the private key follows the same maintainer-owned path: generate a new key in the GitHub App settings and update the secret. Fine-grained PATs are explicitly excluded from this design: a PAT cannot be minted at runtime by `actions/create-github-app-token`, requires a long-lived secret with a manual rotation model, and scoping at the token-creation site is less auditable than an App with declared permissions that is managed separately. Issue #827 must provision this GitHub App (not a PAT) with the maintainer-owned bootstrap path described above, and must document the four bootstrap steps for the maintainer who carries it out.

**Separate-context dual-token boundary.** The `/proc/<pid>/environ` attack surface means any token present in the agent container's process environment — even if unset in a subshell — can be read by a model subprocess running as the same container user via `/proc/PID/environ` or equivalent OS-level introspection. The correct enforcement boundary therefore requires the system token to be **absent from the agent container entirely**, not merely unset in a subshell. The previously described dual-subshell pattern (`( unset SYSTEM_GH_TOKEN; GH_TOKEN="$RESTRICTED_GH_TOKEN" run_agent ... )`) is insufficient for exactly this reason and is dropped from this design.

The revised runner-side protocol:

1. Before `docker run`, the runner mints the restricted model token via `actions/create-github-app-token` (using `RESTRICTED_APP_ID` and `RESTRICTED_APP_PRIVATE_KEY`). The system token remains available only in the runner environment.
2. The runner starts the agent container with `docker run --env GH_TOKEN="$RESTRICTED_GH_TOKEN" ...` — the system token is not passed to any `--env` flag and is therefore never present in the container environment. The model subprocess has no path to the system token regardless of how it introspects its own process tree or the container's init environment.
3. After `docker run` exits (agent run complete, `.pr-metadata.json` and branch push done), all PR lifecycle work executes in a **separate execution context** where the system token is available but the agent container is no longer running: the runner (or a dedicated PR-operations step/second container) reads `.pr-metadata.json`, calls `gh pr create --draft`, performs marker injection, and calls `gh pr ready` using the system token only.

Issue #827 must specify the runner-side separation mechanism — for example, a post-container runner step (GitHub Actions `run:` step using `SYSTEM_GH_TOKEN`), a second `docker run` invocation for PR operations passed only `SYSTEM_GH_TOKEN`, or a separate GitHub Actions job receiving `.pr-metadata.json` as an artifact. Issue #817 must move `gh pr create --draft`, `inject_authored_by_marker`, and `gh pr ready` out of the entrypoint Bash functions and into whichever runner-side mechanism Issue #827 selects, for `action_implement` and `action_design`. Infrastructure provisioning is tracked as a dependency of **Issue #817** (see **Issue #827**).

**Alternative considered — retain model-issued `gh pr create --draft` with credential separation.** Not achievable. As explained above, `pull-requests: write` grants both create and update. Giving the model the ability to create a draft PR also grants it the ability to promote that PR — which is exactly the bypass this decision closes. Credential separation without entrypoint-owned creation does not enforce the invariant.

**Previously noted as out of scope.** The original analysis deferred this as requiring token-provisioning infrastructure changes outside the scope of the design. After review, Requirement 2 ("marker authoritative from the moment the PR becomes reviewable") cannot be met without an enforceable API-level boundary; the infrastructure work is therefore in scope for #793.

### Decision 7 — Documentation updates land with the entrypoint-wiring PR

**Decision.** In the sub-issue that wires Decision 1 into the entrypoint (**Task B** below), update in the same PR:

- `AGENTS.md` — the "Auto-trigger gates" table gains a note that transition #5 now fires on `pull_request.ready_for_review` (with `pull_request.opened && !draft` retained for human-opened agent-branch PRs).
- `AGENTS.md` — the `inject_authored_by_marker` paragraph (if any) notes that agent PRs open as draft and are flipped to ready after the marker is written. If no such paragraph exists, do not add one — the entrypoint is the single source of truth per repo convention.
- `docs/design/configurable-model-pair-preferences.md` — Decision 4 gains a cross-reference to this doc noting the draft+ready-for-review contract that makes the marker authoritative at pair-tier read time.
- `docs/model-guidance.md` — the "Cross-vendor class table" section gains a short note explaining the Claude-family prefix normalization (Decision 4 of this doc).

**Rationale.** `AGENTS.md`'s "Keeping Documentation Current" convention requires docs-in-the-same-PR when behavior changes. Bundling the docs with Task B means the merged state is self-consistent at every point.

## Out of scope

- **Backfilling the marker on PRs already open at the time the fix lands.** Pre-fix PRs that were reviewed with the wrong marker have already been reviewed; a re-review by applying `agent:review` on the current (corrected) marker is the operator-visible mitigation path.
- **Changing the pairing resolver's `DEFAULT_MODEL` behavior when no marker is present.** The existing "marker absent → skip pairing tier, fall through to `DEFAULT_MODEL`" behavior is preserved; this design only changes when the marker is present-but-unmapped.
- **OpenAI and xAI normalization.** See Decision 4 rationale.
- **Removing the `pull_request.opened` path from the auto-trigger.** Kept for human-opened non-draft agent-branch PRs (Decision 2).
- **Changing GitHub-side event behavior for `agent-review.yml`.** The reviewer workflow still fires on label application; this design only affects when the label is applied by the auto-trigger.

## Task breakdown

Dependencies are tracked in GitHub as native `blocked_by` relationships.

| Issue | Task | Depends on |
|-------|------|------------|
| Issue #816 | Extend `agent-auto-trigger.yml` and `agent-auto-trigger-reusable.yml` to listen for `pull_request.ready_for_review` and to gate `pull_request.opened` on both `!draft` and `!is-bot-author`. Add `pr-is-draft` and `is-bot-author` inputs, forward `github.event.pull_request.draft` and `github.event.pull_request.user.type == 'Bot'`, update the route predicate per Decision 2. Add marker-presence check on the `ready_for_review` branch per Decision 2. **Must land in the same deployment window as Issue #817** (see Decision 2 rollout coordination note); bot-authored agent PRs will receive no auto-review in the gap between the two. | — |
| Issue #827 | Provision restricted GitHub App installation token for the model's `run_agent` session (Decision 6): `contents: write` + `issues: write`, no `pull-requests` permission. **Maintainer bootstrap (out-of-band, not Terraform):** a maintainer registers the GitHub App in GitHub's App settings with the correct permission scope, installs it on this repository, generates a private key, and stores `RESTRICTED_APP_ID` and `RESTRICTED_APP_PRIVATE_KEY` as repository Actions secrets (see Decision 6 bootstrap path). The issue must document these four steps clearly for the maintainer who carries them out. Once the secrets exist, update the runner-side workflow to mint the restricted model token via `actions/create-github-app-token` before `docker run`, and pass it as `GH_TOKEN` to the agent container. The system token must **not** be passed into the agent container at all — the system token remains available only in the runner environment. This issue must also decide and document the runner-side separation mechanism for PR lifecycle operations (post-container runner step, second Docker invocation with `SYSTEM_GH_TOKEN` only, or split GitHub Actions job with artifact hand-off) so that Issue #817 can implement it. | — |
| Issue #817 | Update `docker/scripts/entrypoint.sh` per Decisions 1, 5, and 6. For `action_implement` and `action_design`: the entrypoint prompts are updated to write `.pr-metadata.json` and push (no `gh pr create`); the agent runs in its container with the restricted token only; all PR lifecycle work (`gh pr create --draft`, the three-state PR-readiness check from Decision 1, `inject_authored_by_marker`, `gh pr ready`) moves to the runner-side execution context defined in Issue #827 (outside the agent container), using the system token. For `action_fix_deployment`: opens with `gh pr create --draft` (system token) and calls `gh pr ready` after `inject_authored_by_marker` — the entrypoint already owns PR creation here, so the existing in-container approach is acceptable (the model does not create the PR); if the Issue #827 mechanism is a split-job design, `action_fix_deployment` follows the same runner-side pattern for consistency. Update `docker/scripts/prompts/implement.md` and `design.md` to write `.pr-metadata.json` instead of calling `gh pr create`; update `respond-to-review.md`, `respond-to-checks.md`, `fix-deployment.md` per Decision 3 (never write the marker). Update `AGENTS.md` and this design's cross-reference in `docs/design/configurable-model-pair-preferences.md` per Decision 7. | Issues #816, Issue #827 |
| Issue #818 | Extend `.github/scripts/src/lib/model-pair.ts` (and/or `model-classes.ts`) with the `claude-<family>-*` normalization per Decision 4. Add Vitest coverage in `.github/scripts/test/model-pair.test.ts` for `claude-sonnet-4-6` → sonnet, `claude-haiku-5-0` → haiku, `claude-opus-9-9` → opus, and `claude-mystery-1-0` → unresolved. Update `docs/model-guidance.md` with the normalization note per Decision 7. | — |
| Issue #819 | End-to-end validation on a test issue: (1) apply `agent:developer` to a test issue with a provider configured such that the authoring model is Anthropic-sonnet-class; confirm the runner logs show the PR opening as draft (runner-side `gh pr create --draft` using system token), `inject_authored_by_marker` writing the configured model, and `gh pr ready` flipping the PR — all in the runner-side execution context, not inside the agent container; (2) confirm the first auto-triggered review workflow run reads the configured marker (not any model-generated string) and pairs to a non-Anthropic sonnet-class reviewer; (3) temporarily set `AGENT_MODEL` to a snapshot ID not in `modelToClass` (e.g. via a workflow dispatch override) and confirm the resolver normalizes to the sonnet class via Decision 4; (4) verify that a human-opened non-draft agent-branch PR still triggers auto-review via the preserved `pull_request.opened` path; (5) attempt `gh pr ready` from a model-session token and confirm a 403 is returned (credential boundary validation); (6) confirm the agent container's environment contains no system-token value (e.g., via `docker inspect` on the stopped container or a container-side `env` log captured during the run), verifying the separate-context boundary described in Decision 6. | Issues #816, #817, #818, Issue #827 |

Issues #816, #818, and Issue #827 (token provisioning) are independent and can proceed in parallel. Issue #817 depends on both #816 (auto-trigger `ready_for_review` support must exist before the entrypoint's `gh pr ready` flip is useful) and Issue #827 (restricted model token must exist before the entrypoint switches to the system token for PR creation). Issue #819 depends on all implementation tasks.
