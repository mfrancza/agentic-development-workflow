# Design: Opt-in conflict resolution for non-agent-authored PRs

**Issue:** [#802](https://github.com/mfrancza/agentic-development-workflow/issues/802)

**Parent designs:**
- [`docs/design/resolve-conflicts.md`](resolve-conflicts.md) (Issue #54) — the overall feature contract
- [`docs/design/agent-resolve-conflicts-workflow.md`](agent-resolve-conflicts-workflow.md) (Issue #64) — the push-triggered workflow
- [`docs/design/resolve-conflicts-developer-author.md`](resolve-conflicts-developer-author.md) (Issue #580) — the configurable developer-author contract

## Summary

Today `agent-resolve-conflicts` only touches PRs authored by one developer-agent App login — the parent design explicitly leaves "conflicts on human-authored PRs" out of scope and the finder's GitHub search query carries a mandatory `author:<developer-author>` qualifier. This design adds two opt-in mechanisms so operators can extend the resolver beyond agent-authored PRs without breaking the current default:

1. A repository-level setting (`RESOLVE_CONFLICTS_ALL_AUTHORS`, default `false`) that, when enabled, makes the push-to-`main` enumeration cover **every** open PR instead of only developer-agent-authored ones.
2. A per-PR label trigger (`agent:resolve-conflicts`) that an allowlisted operator can apply to any single PR to run the resolver against it on demand, regardless of the repo-wide setting or the PR's author.

Both mechanisms funnel into the existing `agent-resolve-conflicts-reusable.yml` reusable workflow (which already supports a `pr-number` passthrough that bypasses the authorship filter — the `workflow_dispatch` operator-override path). The default behavior is unchanged: a fresh repo sees exactly the agent-only enumeration it sees today.

## Requirements as understood

From Issue #802 and its single grooming comment:

1. **Scope setting** — "Add a setting for running it automatically on all PRs vs just agent-created ones." A repository-wide, Terraform-managed knob that flips the push-to-`main` enumeration between "developer-agent-authored only" (today's behavior) and "all open PRs." The default must preserve the current behavior.
2. **On-demand label trigger** — "as well as a label that can be applied to trigger it on demand." A `agent:*`-style label that an allowlisted operator can apply to a specific PR to invoke the resolver immediately on that PR, independent of the enumeration setting and independent of the PR's author.
3. **Grooming context** — the grooming note says these are "architectural changes to the merge conflict resolution system… [that] span multiple components and require design planning before implementation." That is the signal to expose each knob through the full chain (Terraform → Actions variable / label → caller stub → reusable workflow → composite action → TypeScript finder) rather than hardcoding behavior in any one layer.

### Ambiguity resolutions

The issue body is deliberately terse; the following judgment calls are not answered by grooming and are resolved below. They are called out so the reviewer knows which pieces are design-time choices rather than restated requirements.

- **Scope setting name and shape** — a single boolean Terraform variable `resolve_conflicts_all_authors` surfaced as the string Actions variable `RESOLVE_CONFLICTS_ALL_AUTHORS` (`"true"` / `"false"`). This matches the existing single-knob precedents (`ENABLE_PROTECTED_APPROVAL_GATE`, each key in `AUTO_TRIGGER_AGENTS`) rather than introducing a new object type for one field. See Decision 1.
- **Label name** — `agent:resolve-conflicts`. Every existing agent-trigger label uses `agent:<action>` where `<action>` names an `AGENT_ACTION` dispatcher case. `resolve-conflicts` is already the entrypoint's action name, so `agent:resolve-conflicts` is the natural extension. See Decision 2.
- **Label-trigger authorization** — gated on `AGENT_ALLOWLIST` sender, following the same pattern as every other user-triggered label workflow. The label itself is not a security boundary; the sender identity is.
- **Fork-headed PRs** — excluded from both the all-authors enumeration and the label-trigger path. The resolver needs to push the merge commit to the PR's head branch, and the developer-agent App installation on the base repo cannot push to a fork. Including fork PRs would guarantee runtime failure after a wasted token mint and container boot. See Decision 5.
- **`conflicts-escalated` label on the label-trigger path** — the label-trigger caller pre-removes `conflicts-escalated` before invoking the container, treating the `agent:resolve-conflicts` application as an explicit operator re-attempt. See Decision 4.
- **Label lifecycle after a successful run** — the caller removes `agent:resolve-conflicts` on success and leaves it in place on failure, matching the `agent:groom` convention described in `AGENTS.md § Labels`.
- **Humans opting out of all-authors sweeps** — out of scope; see "Out of scope" below. The initial design intentionally keeps the setting binary and documents the recommended escape hatches (apply `conflicts-escalated` to pin a PR, or leave the variable at its default).

## Decisions

### Decision 1 — A single boolean setting, not an object

**Decision.** Add a new boolean Terraform variable `resolve_conflicts_all_authors` (default `false`) and expose it as a repository Actions variable `RESOLVE_CONFLICTS_ALL_AUTHORS` whose value is the string `"true"` or `"false"`. The caller stub reads `vars.RESOLVE_CONFLICTS_ALL_AUTHORS` and passes it through to the reusable workflow as an `all-authors` string input; the reusable passes it through to the `find-conflicted-prs` composite action as the `all-authors` input; the composite action passes it to the TypeScript finder as `INPUT_ALL_AUTHORS`, which flips the `author:<developer-author>` qualifier off in the GitHub search query.

**Alternatives considered.**

- **Add a new key to `AUTO_TRIGGER_AGENTS`.** Rejected. That variable's semantics are "which upstream SDLC events auto-apply the next `agent:*` label." The scope of the resolver's enumeration is a different concept, and overloading a single JSON object forces every caller to pre-exist the object in Terraform. The existing single-value precedents (`ENABLE_PROTECTED_APPROVAL_GATE`, `FIX_CHECKS_ALLOW`) are a closer fit.
- **Make it a per-PR label instead of a repo variable.** Rejected because the issue explicitly asks for a *setting* in addition to the on-demand label. Operators who want the sweep for every conflict must not have to label every PR manually. The two mechanisms address different workflows (ambient automation vs. targeted intervention) and both are in scope.
- **Add a third-state `author-regex`.** Rejected as overfitting. Two authorship modes — "developer-agent only" and "everyone" — cover the requirement. A future refinement can introduce a list or regex if usage justifies the complexity.

### Decision 2 — `agent:resolve-conflicts` label, modeled on `agent:review`

**Decision.** Add a new repository label `agent:resolve-conflicts` to `terraform/modules/labels/main.tf` with the same `#6f42c1` color used for the other `agent:*` trigger labels, description "Run the merge-conflict resolver against this PR on demand." A new caller stub (or a new trigger on the existing `agent-resolve-conflicts.yml`; see Decision 6) listens for `pull_request.labeled` where the label name matches, gates on `vars.AGENT_ALLOWLIST` for the sender, and invokes the existing reusable workflow with `pr-number: ${{ github.event.pull_request.number }}`.

The reusable's existing `pr-number` input already bypasses the finder's author filter (the `workflow_dispatch` operator-override path from `docs/design/agent-resolve-conflicts-workflow.md` Decision 5), so no finder change is needed to support this trigger — the label-trigger reuses the dispatch-style path.

**Alternatives considered.**

- **`resolve-conflicts` with no `agent:` prefix.** Rejected because every existing agent-dispatch label uses the `agent:<action>` form, and the Labels section of `AGENTS.md` describes the prefix as the trigger-label convention.
- **Overload `agent:developer` to mean "run the resolver on this PR."** Rejected. `agent:developer` triggers `AGENT_ACTION=implement` on issues and would require an issue-vs-PR event conditional. The two actions have distinct entrypoints, distinct tokens-of-work (issue vs. PR), and distinct lifecycle expectations.
- **Use `conflicts-resolve` or `fix-conflicts` as the label name.** Rejected to preserve the pattern recognition value of the `agent:<action>` prefix; a greppable, uniform prefix is easier for operators to filter and for grooming to reason about.

### Decision 3 — Allowlist gating moves into the reusable workflow

**Decision.** The reusable workflow (`agent-resolve-conflicts-reusable.yml`) grows a conditional allowlist-gate job that invokes `./.github/actions/check-agent-allowlist` when a new optional `sender-login` input is non-empty. The push-triggered and `workflow_dispatch`-triggered callers do not pass `sender-login`, so the gate's `skip-gate: 'true'` fires and the existing behavior is unchanged. The label-triggered caller passes `sender-login: ${{ github.event.sender.login }}`, so the gate runs normally and fails closed if the sender is not in `AGENT_ALLOWLIST`.

To support allowlist entries that are `org/team-slug` references, the reusable also declares optional `ALLOWLIST_RESOLVER_APP_ID` / `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` secrets (both `required: false`), consistent with the other user-triggered reusables. When neither is supplied, team references in the allowlist are skipped with a warning (the existing resolver behavior); login-only allowlists work without configuring the resolver App.

**Alternatives considered.**

- **Gate in the caller stub's `if:` expression.** Rejected per the `AGENTS.md § Repo-specific security defaults` guidance: "Keep caller stubs limited to queue predicates…; reusable preflight gate jobs own lifecycle predicates." Putting the gate in the reusable also means external consumers inherit the gate automatically.
- **Add a separate reusable for the label-trigger.** Rejected as duplicative — the resolve matrix, token minting, and per-PR concurrency group are identical whatever the trigger. A conditional gate is simpler than two parallel reusables that would drift.
- **Always run the gate unconditionally.** Rejected because the push-to-`main` trigger has no human sender (the sender is whoever pushed to `main`, who already needs write access to `main` which is gated by branch protection and the protected-approval gate). Gating it would add a resolver round-trip for no additional authorization value.

### Decision 4 — Label-trigger pre-flights: clear `conflicts-escalated`, skip forks, require a non-closed PR

**Decision.** The label-trigger caller performs the following pre-flight steps **before** dispatching the reusable, in this order:

1. **Fork-head guard** — if `github.event.pull_request.head.repo.full_name != github.repository`, skip with a `::notice::` and remove the `agent:resolve-conflicts` label so the operator sees it did not stick. (Remove-on-skip prevents a stale label from accumulating on fork PRs where the operator keeps retrying.) Document the escape hatch in `AGENTS.md`: fork contributors can cherry-pick to a same-repo branch, same as the agent-review workaround.
2. **State guard** — if the PR is closed or merged, skip with a `::notice::` and do not remove the label.
3. **Clear `conflicts-escalated`** — if the PR carries `conflicts-escalated`, remove it with a PR comment: "Operator re-attempted resolution via `agent:resolve-conflicts`; prior escalation marker removed." The entrypoint's existing `conflicts-escalated` preflight would otherwise abort the run before any attempt, and the operator applying the label is unambiguously expressing intent to re-attempt. Without this step the label would be a silent no-op on escalated PRs.
4. **Dispatch** — pass `pr-number: ${{ github.event.pull_request.number }}` and `sender-login: ${{ github.event.sender.login }}` to the reusable. The reusable's existing matrix-of-one path handles the rest.

After the resolve job completes, a final job removes the `agent:resolve-conflicts` label on success (mirroring the `agent:groom` lifecycle) and leaves it in place on failure so the operator can cycle the label to retry.

**Alternatives considered.**

- **Fail loudly on `conflicts-escalated` instead of auto-clearing it.** Rejected because the operator's action — applying `agent:resolve-conflicts` to an escalated PR — is itself the manual override signal. Requiring them to remove `conflicts-escalated` first would be a second manual step with no additional safety value; the PR comment documents what happened for audit.
- **Fail loudly on fork PRs.** Rejected in favor of a `::notice::` + label-removal. A fork PR label-application is a mistake rather than an attack (the sender passed the allowlist gate), and a workflow failure would be noisier than warranted.
- **Perform the pre-flights inside the container.** Rejected because the pre-flights are cheap API calls that should abort the pipeline before the (relatively expensive) token mint and container build. The entrypoint's existing `conflicts-escalated` guard remains as a defense-in-depth check for the push-triggered path.

### Decision 5 — All-authors enumeration excludes fork PRs

**Decision.** When `all-authors=true`, the finder's search query is `is:pr is:open repo:<owner>/<name>` (dropping the `author:` qualifier) but the TypeScript finder adds a post-query filter that removes PRs where the head repository differs from the base repository (`head.repo.full_name != base.repo.full_name`). This avoids wasting the full mergeability poll (worst-case 155 s per PR) on PRs the resolver cannot push to.

Implementation note: the GitHub Search API does not expose the head-repo field in `issuesAndPullRequests` results, so the finder makes a `GET /repos/{owner}/{repo}/pulls/{number}` call per candidate before polling mergeability. The call is cheap and already required to support ordering with the existing mergeability poll.

**Alternatives considered.**

- **Let the resolver fail per-PR when it can't push.** Rejected: that burns a token mint and a full container boot per fork PR on every push to `main`. The up-front filter keeps the finder's latency bounded.
- **Rely on branch protection alone to prevent the push.** Rejected because branch protection is on `main`, not on PR branches. The push failure would happen inside the container well after the resolver has already done the semantic work.

### Decision 6 — Separate caller stub for the label trigger

**Decision.** Add a new caller stub `.github/workflows/agent-resolve-conflicts-labeled.yml` for the `pull_request.labeled` trigger. Keep `.github/workflows/agent-resolve-conflicts.yml` as the push/dispatch caller. Both stubs call the same reusable workflow.

**Alternatives considered.**

- **Add `pull_request: types: [labeled]` to the existing caller stub.** Rejected because the three triggers (`push`, `workflow_dispatch`, `pull_request.labeled`) have incompatible permission needs and incompatible job-level `if:` conditions. The caller stub would have to carry a 10-line event-type conditional and selectively forward different inputs per trigger. Two stubs with narrow responsibilities are easier to review and to grep for ("who can trigger the resolver via label? find the file with `pull_request: labeled`").
- **Reuse `agent-auto-trigger.yml`.** Rejected: that workflow is designed to **apply** `agent:*` labels based on SDLC transitions, not to react to `agent:*` labels. Mixing the two roles in one workflow would overload its purpose.

### Decision 7 — Documentation lives at the sources, not duplicated

**Decision.** The new label is documented by its entry in `terraform/modules/labels/main.tf` (per `AGENTS.md § Volatile facts live at their sources`). The new variable is documented by its entry in `terraform/variables.tf`, `terraform/modules/agent-vars/main.tf`, and `terraform/modules/agent-vars/README.md`. `AGENTS.md` adds a one-paragraph entry for `agent:resolve-conflicts` in the Labels section (matching the shape of the `agent:review` entry), extends the MVP Workflow § 6 summary to mention the new setting and label trigger, and references this design doc. `README.md` gains the new Actions variable in its list of repo variables.

**Alternatives considered.**

- **Duplicate the label and variable definitions into `AGENTS.md` and `README.md`.** Rejected per the existing "Volatile facts live at their sources" rule. Only the operator-facing summary lines belong in the prose docs.

## Out of scope

- **Per-PR opt-out label for the all-authors sweep.** A label like `no-auto-resolve` that excludes a PR from the sweep is a reasonable refinement, but the initial design keeps the scope binary. Operators can keep `RESOLVE_CONFLICTS_ALL_AUTHORS=false` and use the `agent:resolve-conflicts` label as a positive opt-in per PR, or they can apply `conflicts-escalated` to pin a PR out of the sweep. Introducing a dedicated skip label can be a follow-up issue if operator feedback justifies it.
- **Configurable list of permitted authors.** The scope setting is binary. A JSON list of allowed author logins could be added later if operators want "developer-agent plus one or two humans" granularity; the issue asks only for "all" vs. "agent-created."
- **Auto-trigger of `agent:resolve-conflicts`.** The `AUTO_TRIGGER_AGENTS` family of knobs applies the `agent:<action>` label automatically on an SDLC transition. There is no obvious SDLC transition that should auto-apply `agent:resolve-conflicts` (the push-to-`main` reactive path already handles "a PR just became conflicted"), so the label is operator-applied only.
- **Branch-protection-signed-commits interaction.** If a PR branch has branch protection requiring signed commits and the developer-agent App does not sign, the resolver's push will be rejected. This is a pre-existing limitation of the resolver on any PR; the all-authors expansion inherits it. Document in the label's description and in `AGENTS.md` that the resolver can only succeed on branches the developer-agent App is allowed to push to.
- **Model overrides on the label-trigger path.** The push-triggered path already uses `vars.DEFAULT_MODEL` with no per-PR override; the label-triggered path inherits that. Future work can add a `model:*` PR-label resolver step (mirroring `agent-review`) if needed.
- **A workflow-dispatch operator-override on the label trigger.** The existing `workflow_dispatch` on `agent-resolve-conflicts.yml` already covers the "I want to run this resolver manually against one PR" use case for operators with workflow-dispatch access; the label trigger extends that capability to anyone in `AGENT_ALLOWLIST` (i.e., it does not require write access to Actions).
- **Updating `docs/design/resolve-conflicts.md`'s "Conflicts on human-authored PRs" out-of-scope line.** That is the parent design's record of the state at the time it was written; this new design supersedes that line by making it opt-in rather than forbidden. We do not edit the parent doc (merged design docs describe the accepted state at their merge time), but we cite the supersession here for traceability.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|------------|
| [#804](https://github.com/mfrancza/agentic-development-workflow/issues/804) | Add the `resolve_conflicts_all_authors` Terraform variable + `RESOLVE_CONFLICTS_ALL_AUTHORS` Actions variable, add the `all-authors` input to the finder composite action and `find-conflicted-prs.ts` (including the fork-head filter from Decision 5), add the `all-authors` input to `agent-resolve-conflicts-reusable.yml`, wire the push caller stub to pass `vars.RESOLVE_CONFLICTS_ALL_AUTHORS`, and add a static workflow-contract regression test for the pass-through | — |
| [#805](https://github.com/mfrancza/agentic-development-workflow/issues/805) | Add the `agent:resolve-conflicts` label to `terraform/modules/labels/main.tf`, add the `sender-login` optional input and conditional allowlist-gate job to `agent-resolve-conflicts-reusable.yml` (plus the `ALLOWLIST_RESOLVER_APP_ID` / `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` optional secrets), create `.github/workflows/agent-resolve-conflicts-labeled.yml` with the pre-flight sequence from Decision 4 (fork-head guard + state guard + `conflicts-escalated` clear + label-cleanup on success), and add static workflow-contract tests | — |
| [#806](https://github.com/mfrancza/agentic-development-workflow/issues/806) | Documentation: add the `agent:resolve-conflicts` label entry to `AGENTS.md § Labels`, extend the MVP Workflow § 6 summary to describe the new setting and label trigger, link this design doc, and add `RESOLVE_CONFLICTS_ALL_AUTHORS` to the Actions-variables list in `README.md` and to `terraform/modules/agent-vars/README.md` | Issue #804, Issue #805 |
| [#807](https://github.com/mfrancza/agentic-development-workflow/issues/807) | End-to-end validation: (1) with `RESOLVE_CONFLICTS_ALL_AUTHORS=true`, open a non-agent-authored PR, manufacture a conflict with a push to `main`, verify the resolver attempts and succeeds; (2) with `RESOLVE_CONFLICTS_ALL_AUTHORS=false`, apply `agent:resolve-conflicts` to a non-agent-authored conflicted PR, verify the resolver runs, the label is removed on success, and `conflicts-escalated` is cleared if present; (3) verify fork-headed PRs are skipped on both paths with the expected notice | Issue #804, Issue #805, Issue #806 |

Issue #804 and Issue #805 are independent and can proceed in parallel; they touch overlapping files (the reusable workflow in particular), so one will rebase the other. Issue #806 (documentation) and Issue #807 (end-to-end validation) depend on both implementation tasks landing. Dependencies are recorded natively as GitHub blocked-by relationships on the issues.
