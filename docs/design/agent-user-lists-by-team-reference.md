# Design: Manage agent username lists by GitHub team reference

**Issue:** [#626](https://github.com/mfrancza/agentic-development-workflow/issues/626)

## Summary

Let operators configure `AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, and `CODE_REVIEWERS`
as mixed lists of individual GitHub logins and `org/team-slug` references. Team
members are resolved at runtime, so joining or leaving the team takes effect on
the very next workflow event — there is no cache to go stale.

The three lists are consumed in different ways and each gets a different
resolution mechanism:

- **`AGENT_ALLOWLIST`** — the allowlist gate moves out of caller workflow `if:`
  expressions and into a step inside each reusable workflow (aligning with the
  gate-consolidation requested in [#629](https://github.com/mfrancza/agentic-development-workflow/issues/629)
  and the maintainer's preference stated in issue #626). The in-reusable step
  resolves team references via the GitHub API against the triggering event's
  sender login and fails the job (fail-closed) if the sender is not covered by
  any explicit login or any resolved team member. Caller `if:` expressions drop
  the `contains(fromJSON(vars.AGENT_ALLOWLIST), ...)` clause; only the
  event/label/trust-model clauses remain in the caller. (The `concurrency:`
  block **also** moves out of the caller — see Decision 1's "Concurrency
  groups move inside the reusable, after the gate" subsection — because
  keeping it on the caller would reintroduce the queued-run-displacement
  bug this design is specifically designed to prevent.)
- **`ADMIN_ASSIGNEES`** — issue assignees must be users. The grooming
  container's entrypoint expands team references to logins before invoking
  Claude, so the prompt still receives a flat list and the existing
  `gh issue edit --add-assignee` path is unchanged.
- **`CODE_REVIEWERS`** — `gh pr edit --add-reviewer` already accepts
  `org/team-slug` for review requests. Team references pass through unchanged;
  GitHub owns the per-member notification fan-out and tracks membership live.

A shared TypeScript helper under `.github/scripts/src/lib/` performs the
expansion and is reused by the in-reusable gate step, the groom container
entrypoint, and the future developer-container escalation path.

## Requirements (from issue #626 and grooming Q&A)

1. **Mixed lists.** All three variables accept entries that are either an
   individual GitHub login (user or bot — e.g. `alice` or
   `mfrancza-developer-agent[bot]`) or an `org/team-slug` reference (e.g.
   `Brale-xyz/dev`). Explicit logins and team references coexist in the same
   list.
2. **Live membership.** Joining or leaving a referenced team changes who is
   covered by the list without hand-editing the Actions variable. This rules
   out Terraform-time resolution (grooming note Q2) — a `data
   "github_team_members"` source would require `terraform apply` on every
   membership change.
3. **`AGENT_ALLOWLIST` gate semantics preserved end-to-end.** The eleven
   existing `contains(fromJSON(vars.AGENT_ALLOWLIST), <sender>)` call sites
   must keep producing the same deny/allow outcome for a given sender identity.
   Workflow `if:` expressions cannot call the GitHub API (grooming note Q1), so
   the API-driven membership check moves one level in, into a step inside the
   reusable workflow. The maintainer prefers this redesign over keeping an
   expanded allowlist in a workflow variable because the caller `if:`
   expressions are already too complex (issue [#626](https://github.com/mfrancza/agentic-development-workflow/issues/626#issuecomment-6241114137)
   and issue [#629](https://github.com/mfrancza/agentic-development-workflow/issues/629)).
4. **Issue assignment path unchanged.** Issue assignees are users — the
   assignment command stays `gh issue edit --add-assignee <login>` and the
   team-to-member expansion happens upstream of it.
5. **Fail-closed for the allowlist, warn-and-skip for the others** (issue
   "Constraints" bullet 4):
   - **Allowlist.** The in-reusable gate step denies execution whenever
     authorization cannot be positively established from a successful API
     response: unresolvable team (404, 403, network error), empty expanded
     allowlist, or sender absent from both the explicit logins and every
     resolved team member. There is no previously-cached grant to fall back
     on, so a transient API outage denies — not grants — access. A referenced
     team that successfully resolves to zero members (last member removed, team
     emptied) is treated identically to the team never having existed: the
     grants it would have carried disappear immediately, which is the required
     revocation semantic from grooming point 5. An unrelated failing team
     causes the whole gate step to fail and the job to skip, so revocations
     from other teams in the same list cannot be delayed by one team's outage.
     This "any team error fails the gate" semantic is **order-independent**:
     the gate resolves every team reference in the list before deciding, so
     reordering the entries in `AGENT_ALLOWLIST` can never change the
     authorization outcome. See Decision 1 for the implementation rule.
   - **Assignees / reviewers.** A team that currently has zero members, or a
     team reference that fails to resolve, logs a warning and is skipped for
     that invocation. The explicit logins in the same list are still assigned
     or requested. This matches the warn-and-skip behavior established by
     [`docs/design/configurable-github-assignees.md`](configurable-github-assignees.md).
6. **Bot identities remain explicit entries.** Bot logins such as
   `mfrancza-developer-agent[bot]` cannot be team members, so they must stay
   in `AGENT_ALLOWLIST` as individual string entries. The parser must treat
   anything without `/` as a login and leave it unchanged.
7. **Target audience is org callers of the `agent-vars` module.** This repo
   is a personal repo, so [`docs/design/configurable-github-assignees.md`](configurable-github-assignees.md)
   deliberately left teams out of scope. External org consumers of the
   published `agent-vars` module (see
   [`docs/design/publish-reusable-workflows-and-modules.md`](publish-reusable-workflows-and-modules.md))
   are the audience here; the personal-repo deployment of this repo is only
   an incidental consumer and will continue to use individual logins.

### Ambiguities resolved during design

- **Where does the allowlist check live?** The grooming notes offered
  "pre-resolution step" and "gate redesign" as the two broad approaches. The
  maintainer picked the gate redesign in [issue #626](https://github.com/mfrancza/agentic-development-workflow/issues/626#issuecomment-6241114137)
  ("the if statements are already complex for implementers") and pointed to
  [issue #629](https://github.com/mfrancza/agentic-development-workflow/issues/629)
  as the broader consolidation effort. Decision 1 therefore moves the
  allowlist check into a step inside each reusable workflow instead of
  pre-expanding into a companion variable. This also eliminates any
  cache-staleness window (grants and revocations take effect on the next
  triggering event) and removes the fail-open risk of a scheduled resolver
  carrying stale values forward.
- **What identity performs the membership API calls?** Resolving
  `org/team-slug` references calls `GET /orgs/{org}/teams/{team_slug}/members`,
  which requires the caller to see organization team membership. Per the
  [List team members](https://docs.github.com/en/rest/teams/members#list-team-members)
  reference, this needs the `members: read` fine-grained organization
  permission (or the classic `read:org` scope). The default `GITHUB_TOKEN`
  issued to a repository workflow does **not** carry org-level team-read
  permission and cannot satisfy this requirement. The design therefore
  requires a GitHub App (or PAT) that is installed on the installation's
  own organization with `Members: Read` at the organization level, and the
  identity choice is explicitly flagged as human-required (Decision 2).
  Scope is deliberately limited to one organization per installation
  because GitHub App installation tokens are installation-specific — see
  Decision 2's "Single-organization scope" paragraph for the full
  rationale; multi-org support would require per-org token routing and is
  future work.
- **How much resolution is handled in Claude vs. deterministic code?** The
  entrypoint resolves team references before Claude sees the list. Claude's
  prompt stays as a flat `["user1", "user2", …]` input, so the prompt and
  Claude's judgement path do not have to parse `org/team` syntax or handle
  API failures. (Decision 3.)

## Decisions

### Decision 1: Runtime allowlist gate step inside each reusable workflow

**Decision.** Move the `AGENT_ALLOWLIST` check out of caller `if:` expressions
and into a first-position gate step inside each reusable workflow that is
reachable from a user-triggered caller. The step runs before any Claude
container launch, reads `vars.AGENT_ALLOWLIST`, resolves every
`org/team-slug` entry at trigger time via the GitHub API, compares a
caller-supplied **principal login** against the union of explicit logins
and resolved team members (plus any caller-supplied known-identity
exceptions), and calls `core.setFailed(...)` (which fails the step, which
fails the job) whenever the principal is not covered.

**The gate's principal is caller-supplied, not hardcoded to `sender.login`.**
The gate step takes two inputs: a `principal` login string and an optional
`additional-trusted-logins` JSON array. The caller is responsible for
selecting the principal appropriate to the event type (the pre-move
`if:` expressions already encoded this), and for passing any
known-identity exceptions the pre-move expression allowed. This preserves
the existing event-specific authorization semantics exactly, rather than
imposing a uniform "sender must be allowlisted" policy on all consumers.

**Caller `if:` changes.** The `contains(fromJSON(vars.AGENT_ALLOWLIST), …)`
clauses are removed from caller workflows wherever they currently gate on
`AGENT_ALLOWLIST`; only the event / label / known-identity and
trust-model clauses remain in the caller `if:`. The gate itself is now a
single documented step in each reusable, and caller boilerplate shrinks
correspondingly. This resolves the "every caller restates the gate" drift
problem #629 is tracking for the allowlist specifically; label-based
gates stay in the caller per that issue's constraint.

**Concurrency groups move inside the reusable, after the gate.** Keeping
the current caller-level `concurrency:` block alongside the moved-in
gate would reintroduce the exact queued-run-displacement problem #629 is
designed to prevent, for a different reason. GitHub Actions'
`cancel-in-progress: false` only protects the **in-flight** run in a
concurrency group — if a run is already queued (not yet started) and a
new event enters the same group, the queued run is **cancelled and
replaced** by the new one. Today the allowlist clause in the caller
`if:` filters unauthorized events out of the caller job entirely, so
only authorized runs ever enter the group. If the gate moves inside the
reusable while the caller still carries the concurrency block, an
unauthorized sender (e.g. a non-allowlisted collaborator removing and
reapplying `agent:developer`) now passes the simplified caller `if:`,
enters `agent-implement-issue-<N>`, displaces an authorized queued
rerun, and only *then* fails the gate inside the reusable — the
legitimate request has already been lost.

To preserve the behaviour, the reusable is restructured into two jobs
and the caller's `concurrency:` block is removed:

- **`authorize` job** — runs the detect-team-refs step, the conditional/
  nonfatal resolver mint (per Decision 3), and the gate step. Carries
  **no `concurrency:` block**, so every triggering event — authorized
  or not — reaches it. Unauthorized events exit here via
  `core.setFailed(...)`; authorized events proceed to the work job. Before
  detect/mint/gate, it runs the same four-step helpers-ref bootstrap used by
  other jobs that consume local composites: validate `inputs.helpers-ref`,
  resolve it to a SHA, check out that SHA into `_agentic-workflow` without
  persisted credentials, and verify the checked-out HEAD equals the resolved
  SHA. The bootstrap is required in every `authorize` job: neither that
  checkout nor a minted token crosses a job boundary, and both `agent-token`
  and `check-agent-allowlist` are local composites that must resolve from
  this repository for external callers. Each authorize job needs
  `contents: read` for this checkout. The five non-review reusables inherit
  it from their workflow-level permissions; `agent-review-reusable.yml`
  instead sets `permissions: {}`, so its authorize job must declare
  `permissions: contents: read` explicitly.
- **`work` job** — carries `needs: authorize` and the **concurrency
  group that used to live on the caller** (`cancel-in-progress: false`,
  group key identical to the pre-move caller block — e.g.
  `agent-implement-issue-${{ inputs.issue-number }}`,
  `agent-groom-issue-${{ inputs.issue-number }}`,
  `agent-review-pr-${{ inputs.pr-number }}`, etc.). This is the job
  that actually launches the Claude container. Because `needs:
  authorize` is the only way to reach `work`, unauthorized events never
  enter the work-queue concurrency group and can never displace an
  authorized queued rerun.

Caller stubs lose both the `contains(fromJSON(vars.AGENT_ALLOWLIST),
…)` clause **and** the `concurrency:` block (the concurrency group key
is now hard-coded in the reusable, derived from the same input the
caller already passes — issue number for the issue-triggered
reusables, PR number for the PR-triggered reusables). This removal
applies to the block at **whichever YAML scope the caller currently
uses** — most callers (`agent-groom.yml`, `agent-design.yml`,
`agent-implement.yml`, `agent-review.yml`) carry a **job-level**
`concurrency:` block, but `agent-respond-review.yml` carries a
**workflow-level** `concurrency:` block (see `agent-respond-review.yml`
lines 11–13: `group: agent-respond-review-pr-${{
github.event.pull_request.number }}`, `cancel-in-progress: false`).
A workflow-level block applies to **every job** the workflow starts,
including the new `authorize` job, so leaving it in place would let
unauthorized `pull_request_review` events occupy and displace
`agent-respond-review-pr-<N>` before the gate denies — the exact
displacement window this restructuring exists to close. Both scopes
must be removed from the caller for the fix to hold; the group moves
onto the reusable's `work` job regardless of which scope it came from.
The `work` job re-runs its own copy of detect-team-refs + conditional/
nonfatal mint if the groom container needs the resolver token (per
Decision 3's boundary 2), because minted-token outputs from the
`authorize` job cannot cross a job boundary.

**Why not keep concurrency on the caller and solve this another way?**
Three alternatives were considered and rejected:

- *Namespace the concurrency group with the sender login
  (`agent-implement-issue-<N>-<sender>`).* Isolates each sender's runs
  from each other but destroys the "one agent run per issue at a time"
  invariant — two different authorized senders could trigger
  overlapping developer runs on the same issue. The invariant matters
  because the developer agent assumes exclusive access to the issue
  branch.
- *Add `continue-on-error: true` on the implicit gate step and rely on
  the gate's "run but no-op" behaviour.* The job still enters the
  concurrency group and still displaces queued runs; the problem is
  the *entry* into the group, not whether the gate denies.
- *A step-level concurrency primitive.* GitHub Actions has no
  step-level concurrency; concurrency is job-scoped only.

The two-job split is the simple fix: it mirrors the existing CI
pattern (e.g. `terraform-ci-reusable.yml`'s `plan` → `apply` chain) and
keeps the authorization and the serialisation semantics each in their
own job where the ownership is unambiguous.

**Special case — `agent-review`: hold the PR lock around the entire
reviewer-matrix invocation, not around each matrix leg.** The two-job
`authorize` → `work` layout above assumes a single container-launching
work job per reusable. `agent-review-reusable.yml` is the one existing
reusable that does **not** fit that assumption: it is already a two-job
workflow (`resolve` preflight job → matrix `review` job with
`strategy.matrix.include: ${{ fromJson(needs.resolve.outputs.set) }}`
and `fail-fast: false`, see
`agent-review-reusable.yml:107-224`). Each matrix leg mints its own
reviewer-agent token, dismisses stale reviews, runs the reviewer
container for one model, uploads its own log artifact, and resolves
its own addressed review threads. Today the caller lock
(`agent-review-pr-${{ github.event.pull_request.number }}` with
`cancel-in-progress: false`) is held at the caller-job level, i.e.
around the entire reusable invocation, so all N parallel matrix legs
run inside one lock.

Naively applying the above two-job split to `agent-review` (promote
the existing `resolve` + matrix `review` structure as the `work` job
and attach the `agent-review-pr-<N>` concurrency to the matrix
`review` job) would attach the same lock to **every matrix leg**.
With GitHub Actions' default concurrency behaviour (one running + one
pending, `cancel-in-progress: false` only protects the running leg),
N = 2 models serialise rather than parallelise, and N ≥ 3 models
cancel sibling pending legs — the third-and-later configured
reviewer would never post a review, defeating the multi-reviewer
feature in `REVIEWER_MODELS`.

To preserve the whole-invocation lock while still authorising before
entering it, `agent-review-reusable.yml` is restructured into
**three** jobs rather than two, using the nested-worker-reusable
pattern:

- **`authorize` job** — same as the general two-job layout: no
  `concurrency:` block, runs the four-step helpers-ref bootstrap before the
  detect-team-refs + conditional/nonfatal resolver mint + gate step.
  Unauthorized events exit via `core.setFailed(...)` here and never reach
  the concurrency group. Because this reusable's workflow-level
  `permissions: {}` is deny-all, this job explicitly declares
  `permissions: contents: read`; otherwise its bootstrap checkout fails
  before the gate can run.
- **`review` wrapper job** — `needs: authorize`, carries the
  **`agent-review-pr-${{ inputs.pr-number }}` concurrency group that
  used to live on the caller** (`cancel-in-progress: false`,
  identical group key). This job does not launch any containers
  itself; its sole purpose is to hold the PR-level lock around the
  entire fan-out. It must declare the same `permissions:` block the
  current matrix `review` job carries (`contents: write` +
  `pull-requests: write`) because `agent-review-reusable.yml` sets
  workflow-level `permissions: {}` (deny-all) and because **nested
  reusables cannot elevate scopes above their caller job** — they
  can only keep or reduce the calling job's permissions. Omitting
  the block leaves the wrapper job (and therefore the nested
  worker's matrix `review` job) with no permissions, so the
  per-matrix-leg `resolveReviewThread` GraphQL mutation would be
  rejected. It uses `uses:` to invoke a new nested worker reusable:
  ```yaml
  review:
    needs: authorize
    concurrency:
      group: agent-review-pr-${{ inputs.pr-number }}
      cancel-in-progress: false
    # Scopes mirror the pre-restructuring matrix `review` job's
    # permissions. The nested worker cannot elevate above this.
    permissions:
      contents: write
      pull-requests: write
    # `$/` resolves against this workflow's repository and running SHA,
    # rather than an external consumer's checkout. It deliberately has no
    # `@ref` suffix.
    uses: $/.github/workflows/agent-review-worker-reusable.yml
    with:
      pr-number: ${{ inputs.pr-number }}
      repo: ${{ inputs.repo }}
      image: ${{ inputs.image }}
      default-model: ${{ inputs.default-model }}
      reviewer-models: ${{ inputs.reviewer-models }}
      logs-retention-days: ${{ inputs.logs-retention-days }}
      helpers-ref: ${{ inputs.helpers-ref }}
    secrets: inherit
  ```
- **`agent-review-worker-reusable.yml`** (new nested reusable) —
  contains the existing `resolve` preflight job and the matrix
  `review` job verbatim from today's `agent-review-reusable.yml`,
  with no `concurrency:` blocks on either (the lock is held by the
  caller job that invokes this nested reusable).

Because a job that `uses:` a reusable workflow holds its slot in its
concurrency group until the entire invoked workflow's job DAG
completes, this layout holds `agent-review-pr-<N>` for the full
resolver-plus-fan-out duration. All matrix legs run in parallel
inside the single wrapper job's lock, as they do today. A second
authorized `agent:review` event on the same PR waits for the entire
first fan-out to finish before entering the group; a non-allowlisted
event never reaches the wrapper job and therefore never enters the
group at all.

This is the one reusable that gets the three-job layout. All other
reusables listed in the previous subsection use the simpler two-job
`authorize` → `work` layout because they launch a single container
per invocation and have no fan-out to preserve.

**Event-specific authorization policies preserved.** The current call sites
do not all authorize the triggering event's `sender.login` against the
plain allowlist. Each site keeps its existing semantics after the move:

| Caller | Event | Principal passed to gate | Trusted-login exceptions | Notes |
|---|---|---|---|---|
| `agent-groom.yml` | `issues.labeled` | `github.event.sender.login` | — | Unchanged behaviour. |
| `agent-design.yml` | `issues.labeled` | `github.event.sender.login` | — | Unchanged behaviour. |
| `agent-implement.yml` | `issues.labeled` | `github.event.sender.login` | — | Unchanged behaviour. |
| `agent-review.yml` | `pull_request_target.labeled` | `github.event.sender.login` | — | Unchanged behaviour. |
| `agent-review.yml` | `pull_request_target.synchronize` | **gate skipped** | — | Today's caller intentionally authorizes `synchronize` through the `agent:review` label's presence alone, with no pusher check (see the comment at `agent-review.yml:40-46`): the label is the authorization artifact, applied earlier by an allowlisted actor; same-repo + head-repo match is sufficient to re-review. Imposing a sender/pusher allowlist check here would stop re-reviews when a non-allowlisted same-repo collaborator pushes to an already-reviewed PR. The gate step therefore accepts a `skip-gate` input that the caller sets to `true` for the `synchronize` branch, and the existing same-repo + label-presence guards in the caller `if:` remain the sole gate for that event. |
| `agent-respond-review.yml` | `pull_request_review.submitted` | `github.event.review.user.login` | `mfrancza-reviewer-agent[bot]`, `Copilot`, `copilot-pull-request-reviewer[bot]`, `github-copilot[bot]` | The caller today authorizes a review author via the allowlist OR the four known reviewer-bot logins (because the checked-in `terraform/terraform.tfvars` does not and should not include these bots in `agent_allowlist`). The gate step accepts a JSON array of trusted logins; the caller passes the four bot logins and the gate allows the principal if it matches any trusted login OR any allowlist entry. Without this, the review-response loop stops on every bot review. |
| `agent-auto-trigger.yml` → `auto-groom`, `auto-design`, `auto-developer-do`, `auto-developer-undraft`, `auto-developer-unblock` | `issues.*` | `github.event.sender.login` | — | Unchanged behaviour. |
| `agent-auto-trigger.yml` → `auto-review` | `pull_request.opened` | **gate skipped** | — | Today's job does not check `AGENT_ALLOWLIST` — it authorizes based on branch prefix (`agent/…` or `design/…`) OR PR author being the developer-agent bot, plus the same-repo guard. There is nothing to preserve by adding a sender check; the caller's `if:` stays authoritative. The reusable it dispatches (`agent-auto-trigger-reusable.yml`) does not include the allowlist gate step for this transition. |

The `skip-gate` and `additional-trusted-logins` inputs are explicit; the
reusable workflow does not infer them from event names. Any new caller
must declare its policy at wiring time, and the design doc / AGENTS.md
documents the two currently-skipped cases so future consumers cannot
accidentally weaken the gate.

**Known-identity exceptions are not added to `AGENT_ALLOWLIST`.** The
reviewer-bot logins and future similar identities stay as per-caller
constants (passed through `additional-trusted-logins`), not operator-managed
allowlist entries. This matches how `terraform.tfvars` is checked in today
(the reviewer bots are not in `agent_allowlist`) and keeps the operator
list focused on humans/teams who may trigger agent runs via labels, not
automated reviewers who respond to agent-authored PRs.

**Resolution semantics (fail-closed, order-independent).** The gate step
treats authorization as grantable only when a positive membership answer is
produced from a successful API response during the current workflow run,
and the deny/allow outcome does not depend on the order of entries in
`AGENT_ALLOWLIST`:

- Entries without `/` are explicit logins and compared directly to the
  principal login (case-insensitive).
- Entries matching `^[^/]+/[^/]+$` are team references. The gate passes
  `supportedOrg = github.repository_owner` into the shared expander
  (Decision 5), which rejects any entry whose org component does not
  match (surfacing the Decision 2 single-org constraint as a `cross-org`
  resolution error without an API call). For in-scope entries, the
  expander calls `teams.listMembersInOrg` with pagination for each
  reference and returns `{ expanded, errors }`. The gate resolves
  **every** team reference in the list; it does not short-circuit on the
  first matching team, so a resolution error later in the list cannot be
  skipped by a lucky early match.
- If `errors` is non-empty — any team the gate attempted to resolve failed
  (team not found, 403, 5xx, network timeout, malformed entry) — the gate
  step fails via `core.setFailed(...)` with a visible per-team error list.
  This is the "unrelated failing team fails the whole gate" semantic from
  requirement 5. Known-identity exceptions (the `additional-trusted-logins`
  input, e.g. the reviewer bots) are evaluated **before** team resolution
  is attempted and allow the gate to pass without any API call, so a
  reviewer-bot event is not denied by an unrelated team outage.
- Otherwise (all teams resolved cleanly), the gate allows if the principal
  matches any explicit login or any resolved team member, and denies
  otherwise.
- A team that resolves successfully to zero members contributes zero grants
  for that run — the only way an emptied team's former member can still
  trigger a workflow is for them to appear as an explicit login in the same
  list or in a different, non-empty team.
- A completely empty `AGENT_ALLOWLIST` denies all principals.

**Login-only lists do not require the Decision 2 credential.** When
`AGENT_ALLOWLIST` contains no entries matching `^[^/]+/[^/]+$` (i.e. every
entry is an explicit login such as `alice` or `developer[bot]`), the gate
step performs no API call and allows the principal based on a direct
case-insensitive comparison against the explicit logins (plus any
`additional-trusted-logins` match). This covers the personal-repo
deployment path in requirement 7 and any org deployment that chooses to
stay on explicit logins: it would be wrong to deny those events solely
because an org `Members: Read` credential has not been provisioned, since
there is no membership lookup to authenticate. Operationally, this means
an operator who adopts the new gate without adding team references and
without provisioning the Decision 2 identity sees **no behaviour change**
versus the pre-move caller `if:` expressions — the sender is still
authorized by direct allowlist membership, fail-closed semantics still
apply (missing/empty allowlist denies), and no credential error occurs.

The distinction is strictly between **"the list has no team references"**
(no credential needed, no API call made) and **"the list has at least one
team reference and resolution produced errors"** (fail-closed per the
bullet above, even when the principal is also an explicit-login match in
the same list). A missing or unreadable credential while at least one
team reference is present is itself a resolution error and denies.

**Why resolve all teams before deciding?** A short-circuit-on-first-match
rule makes authorization order-dependent: with a principal in `org/good`
and `org/broken` returning 403, `["org/good","org/broken"]` would authorize
without observing the error, while `["org/broken","org/good"]` would fail
at the first element. Operators would be able to accidentally weaken the
gate by reordering an otherwise identical list, and the "unrelated failing
team fails the whole gate" clause in requirement 5 would be impossible to
honour. Resolving every team reference first (cost: one `listMembersInOrg`
call per team reference per event, expected <20 teams per list) keeps the
policy order-independent and keeps the implementation of
`expandTeamRefs()` — which already returns an all-at-once `errors` list —
consistent with the gate's documented contract.

Because the API call happens on every triggering event, grants and
revocations take effect immediately on the next event — there is no cache
or scheduled refresh and therefore no staleness window to specify. A user
removed from the referenced team at 10:00 cannot trigger a workflow at
10:01.

**Credentials.** `teams.listMembersInOrg` requires organization `Members:
Read` (fine-grained) or `read:org` (classic). The default `GITHUB_TOKEN` on
a repository workflow does not carry this permission. See Decision 2 for
the identity/credential plan, which is flagged human-required because this
is an org-scope installation and the identity used by the gate authenticates
all allowlist checks.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Scheduled resolver that expands `AGENT_ALLOWLIST` into a companion `AGENT_ALLOWLIST_RESOLVED` variable; callers keep `contains(fromJSON(vars.AGENT_ALLOWLIST_RESOLVED), ...)` in their `if:`. | Rejected by the maintainer in favor of the gate redesign (issue [#626](https://github.com/mfrancza/agentic-development-workflow/issues/626#issuecomment-6241114137)) because the caller `if:` expressions are already too complex and should be consolidated per [#629](https://github.com/mfrancza/agentic-development-workflow/issues/629). Also carries a staleness window (grants and revocations lag the cron) and a fail-open risk: if the resolver fails for any reason, every subsequent workflow run reuses the stale `AGENT_ALLOWLIST_RESOLVED`, meaning a user removed from a team can keep triggering agents indefinitely until the resolver succeeds again, not just for one refresh interval. Clearing the resolved list on resolver failure would be fail-closed but would also lock everyone out on any transient outage, defeating the point of a cache. The runtime gate has neither problem. |
| Per-trigger preflight job in each caller workflow: a job runs the resolution and emits `outputs.allowed`, downstream jobs gate on it. | Keeps the resolution in the caller — exactly the duplication #629 is removing. Also spins up an extra runner for every event even when the gate denies. |
| Keep the gate in the caller but implement a composite action `check-agent-allowlist` and copy the single-line invocation across callers. | Still copy-paste per caller; still gives up the single source of truth; still requires an org-permissioned identity to be configured in every caller. Only a modest ergonomic improvement over the status quo. |
| Store the resolved list in a committed repo file (e.g. `.github/data/agent_allowlist_resolved.json`) and have workflows read it. | Workflow `if:` expressions can only access `vars.*`, `github.*`, `env.*`, and a handful of other contexts — they cannot read repo files without a step. Combined with the gate-redesign direction, this is strictly worse than running the gate as a step. |
| Terraform-time resolution via `data "github_team_members"`. | Explicitly ruled out by the issue "Constraints" bullet 2 and grooming note Q2: changes would only take effect on the next `terraform apply`. |

### Decision 2: Gate step uses a dedicated `allowlist-resolver` GitHub App with org `Members: Read`, scoped to a single supported organization

**Decision.** The in-reusable gate step and the groom-container
`ADMIN_ASSIGNEES` expansion (Decision 3) both call `GET
/orgs/{org}/teams/{team_slug}/members`, which per the [List team members
reference](https://docs.github.com/en/rest/teams/members#list-team-members)
requires the organization fine-grained permission `Members: Read` (or the
classic scope `read:org`). The default `GITHUB_TOKEN` issued to a repository
workflow does **not** carry an organization-level team-read permission and
cannot satisfy this requirement. Writing to a repository Actions variable
is not required by this design because there is no companion variable to
update.

**Single-organization scope.** This design supports team references from
exactly **one** organization per installation — the organization that owns
the repository running the workflow (`github.repository_owner`). All three
list variables (`AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, `CODE_REVIEWERS`)
accept team references of the form `<supported-org>/<team-slug>` only.
Entries whose `org` component does not equal the supported org are treated
as validation errors by the shared expander (Decision 5), surface as
`errors` entries, and therefore (a) fail the gate step closed for
`AGENT_ALLOWLIST` and (b) warn-and-skip for `ADMIN_ASSIGNEES` /
`CODE_REVIEWERS` — the same handling as other resolution errors.

The reason this is a design constraint rather than an implementation
detail: GitHub App installation tokens are **installation-specific**. A
token minted for the installation on `org-a` cannot read team membership on
`org-b` even if the same App is installed in both orgs — the API returns
404 (or 403, depending on the request). A list such as
`AGENT_ALLOWLIST=["org-a/team-dev","org-b/team-ops"]` with the App
installed in both orgs would fail resolution on whichever org the token
does not belong to and therefore deny every event (requirement 5's
"unrelated failing team fails the whole gate" clause). Rather than silently
behaving that way, the design rejects cross-org entries at validation
time with a clear error message so operators discover the misconfiguration
immediately. Multi-organization support — per-org credential routing where
the gate mints a separate installation token per referenced org and routes
`teams.listMembersInOrg` calls to the correct token — is explicitly
out of scope (see the Out-of-scope section) and left as future work.

Because this is a change to the identity that authenticates allowlist
decisions, the identity choice was escalated to a human. The maintainer
has selected **option (a)**: a new, dedicated `allowlist-resolver` GitHub
App installed on the supported organization with only
`Organization permissions → Members: Read` and
`Repository permissions → Metadata: Read`. The implementation sub-issue
([#648](https://github.com/mfrancza/agentic-development-workflow/issues/648))
retains the `human-required` label because provisioning the App
(creating it, installing it, generating the private key, writing the
secrets) is still a human action that happens outside the code repo; the
code tasks (#649 gate step, #650 groom entrypoint, #651 docs) depend on
it so no code is written against an unprovisioned identity.

Rationale for picking (a):

- **Least privilege.** Only the two permissions above — no code,
  issue, PR, or admin access. A leaked key reads org membership and
  nothing else.
- **Distinct actor in the audit log.** Allowlist checks and
  `ADMIN_ASSIGNEES` expansions show up under a dedicated App name in
  the organization audit log, separately from developer-agent code and
  issue operations.
- **Blast-radius isolation from the developer-agent App.** The
  developer-agent App already carries contents/issues/PRs; adding
  org Members read to it (option (b)) would mean a developer-agent
  key compromise also leaks org membership. A separate App keeps the
  two concerns independent.
- **Durable control.** Unlike a fine-grained PAT (option (c)), a GitHub
  App installation token is machine-identity-bound and does not expire
  on a user's cadence.

The App's credentials are wired into the gate step as `GH_TOKEN` /
`token:` on the `github-script` action (or equivalent), via a token
minted at step-run time from the App's client ID + private key — the
same pattern the repo already uses for the `developer-agent` App token
(see `agent-groom-reusable.yml:132-137` for the existing mint step
shape). The reusable workflow declares two new secrets,
`secrets.ALLOWLIST_RESOLVER_APP_ID` and
`secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY`, under
`on.workflow_call.secrets`; callers pass them through from
organization-level or repository-level secrets alongside the existing
developer-agent App secrets. Operator setup is documented in the
README.md operator-setup section and in the `agent-vars` module README
as part of #651.

Options (b) and (c) are retained in the "Alternatives considered" table
below with their rejection rationale so future readers can see why the
new-App path was chosen.

**No access without the identity when team references are in use.** If
`AGENT_ALLOWLIST` contains at least one entry matching `^[^/]+/[^/]+$` and
the installing organization has not provisioned the Decision 2 identity,
the gate step fails every event — fail-closed, visible in the Actions run
log, naming the missing credential and the unresolved team(s). This
applies even when the triggering principal is also an explicit-login
match in the same list: the mere presence of a team reference means the
authorization answer depends on membership data the gate cannot read, and
silently allowing the explicit-login portion while hiding the team
reference's failure would create a two-tier gate whose effective policy
drifts with the credential's provisioning status.

**Login-only lists require no credential.** When `AGENT_ALLOWLIST`
contains **zero** team references (every entry is an explicit login), the
gate step takes a credential-free path per Decision 1's "Resolution
semantics" bullet on login-only lists: direct string comparison against
the explicit logins, no `teams.listMembersInOrg` call, no requirement on
the Decision 2 identity. This is a design-level distinction (list shape
decides which path runs), not a runtime bypass mode — there is still one
gate step with one documented policy, and the explicit-login path cannot
be reached in the presence of a team reference. The personal-repo
deployment described in requirement 7 and any org that stays on explicit
logins therefore see the new gate behave identically to the pre-move
caller `if:` expression; no new secret or App provisioning is required
unless and until a team reference is added to the list.

This "no credential required" guarantee is enforced structurally at the
reusable-workflow layer, not just at the gate-step layer: the resolver
App's secrets are declared `required: false` under
`on.workflow_call.secrets`, and the `agent-token` mint step that
produces `ALLOWLIST_RESOLVER_TOKEN` is both **conditional** on at least
one list variable actually containing a team reference and
**nonfatal** (`continue-on-error: true`) when it does run. A login-only
operator who never installs the resolver App therefore sees the mint
step skip entirely rather than failing hard inside
`actions/create-github-app-token`'s missing-credentials path. See
Decision 3's "Conditional, nonfatal minting" paragraph for the full
specification; this paragraph only states the invariant that falls out
of it.

**Why not defer the identity choice to a runtime smoke test?** The
`AGENT_ALLOWLIST` is the fleet's primary access-control gate. Shipping a
design that lets the implementation agent pick the identity based on an
empirical check is the pattern the project's AGENTS.md § "Escalating to a
human" exists to prevent. The decision was deferred to a human by design,
not by probing; the maintainer selected option (a) above.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| **(b) Extend the existing `developer-agent` App to add `Organization → Members: Read`.** | Simpler because the App is already installed, but widens the blast radius of a developer-agent key compromise from code/issue operations to also reading org membership. The two concerns stay independent under (a). |
| **(c) Fine-grained PAT with `read:org`, stored as an organization-level secret.** | Easiest to provision for a single org, but PATs are user-impersonating and expire; not a durable control. GitHub Apps are the project's standard machine identity (the developer-agent App already follows this pattern). |
| Allow the implementation agent to pick based on a runtime smoke test (whether the default `GITHUB_TOKEN` happens to have the permission). | `AGENT_ALLOWLIST` is the primary access-control gate; identity selection is not an empirical choice. Explicitly escalated to a human per AGENTS.md § "Escalating to a human". |

### Decision 3: Entrypoint expands `ADMIN_ASSIGNEES` team references before invoking Claude

**Decision.** `docker/scripts/entrypoint.sh` grows a shell helper (or calls
a baked-in `docker/scripts/expand_team_refs.js` compiled from
`.github/scripts/src/lib/expand-team-refs.ts`) that reads the
`ADMIN_ASSIGNEES` env var, iterates its entries, and for each entry that
matches `^[^/]+/[^/]+$` calls `gh api orgs/{org}/teams/{slug}/members
--paginate --jq '.[].login'`. The expanded flat list is deduped against the
explicit logins and the result is re-exported as `ADMIN_ASSIGNEES` (same
env var name, same JSON array shape) before Claude is invoked. The
grooming prompt sees the same shape it sees today.

Team-reference entries that fail to resolve (API error, team not found) and
teams that are empty are both logged with a warning and omitted from the
expanded list. If no entries at all resolve (empty source list, or all
teams empty / failed), the warn-and-skip behaviour in the existing
`groom.md` prompt handles it — no behaviour change.

**Credentials and container token forwarding.** The membership API call
needs the same organization `Members: Read` permission documented in
Decision 2. The groom container's existing `GH_TOKEN` is the
developer-agent App token, which per the operator-setup documentation in
`README.md` carries repository-scoped permissions (contents, issues, PRs)
and does **not** include organization Members: Read. The Decision 2
identity therefore needs to reach the container as a distinct env var
(e.g. `ALLOWLIST_RESOLVER_TOKEN`); the entrypoint helper calls `gh api`
with that token (`GH_TOKEN=$ALLOWLIST_RESOLVER_TOKEN gh api ...`) rather
than the developer-agent token. Without the Decision 2 identity
provisioned, every team entry in `ADMIN_ASSIGNEES` warn-and-skips (per
requirement 5) and grooming proceeds with only the explicit-login portion
of the list.

Getting the token to the container crosses **four** boundaries, and all
four need the groom-only wiring to land together. The structural
constraint that makes this four hops instead of three: `agent-groom.yml`
is a job-level `uses:` caller (jobs.groom is a single `uses:` with a
`secrets:` block — no `steps:` and no job `env:`, both of which GitHub
Actions disallows alongside a `uses:` at job level). A caller-level
environment variable therefore cannot propagate into the reusable, and
the token has to flow through the `secrets:` passthrough into
`agent-groom-reusable.yml` and only materialize as a step `env:` on the
reusable's actual `run-agent` step.

1. **Caller stub `.github/workflows/agent-groom.yml`** passes the
   `allowlist-resolver` App's two secrets through the existing
   `secrets:` block of its `uses:
   ./.github/workflows/agent-groom-reusable.yml` call —
   `ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}`
   and `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{
   secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}`. The caller stub has
   no `steps:` and no job `env:` (both unsupported alongside `uses:` at
   job level), so the secrets must flow via `secrets:` into the
   reusable; a job-level `env:` next to `uses:` would not even be a
   valid workflow file.
2. **Reusable workflow `.github/workflows/agent-groom-reusable.yml`**
   declares both new secrets under `on.workflow_call.secrets`
   (`ALLOWLIST_RESOLVER_APP_ID` and
   `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY`, both `required: false` — see
   "Conditional, nonfatal minting" below for why the secrets are optional)
   and adds a second `agent-token` step that mints an installation token
   from them (parallel to the existing developer-agent mint step at
   `agent-groom-reusable.yml:132-137`), exposing the minted token as a
   step output. Per Decision 1's "Concurrency groups move inside the
   reusable, after the gate" subsection, the reusable is now split into
   an `authorize` job and a `work` job; the resolver mint and the
   detect-team-refs step live in **both** jobs — the `authorize` job's
   copy produces the token the gate step consumes, and the `work`
   job's copy produces the token the "Run grooming agent" step
   consumes. The duplication is unavoidable because `actions/create-
   github-app-token` outputs cannot cross a job boundary (the output
   value is scoped to the originating job's post-step context), and
   both jobs legitimately need an installation token minted from the
   same App's secrets. Both copies run under the same conditional/
   nonfatal rules (`if:` driven by the matching detect-team-refs step
   and `continue-on-error: true`), so a login-only operator still sees
   zero mint attempts and a mint failure still falls through to the
   per-variable downstream enforcement. The `work` job then sets
   `env: ALLOWLIST_RESOLVER_TOKEN: ${{ steps.<work-mint>.outputs.token
   }}` on the existing "Run grooming agent" step (the `uses:
   ./_agentic-workflow/.github/actions/run-agent` step at
   `agent-groom-reusable.yml:156-170`), alongside the existing
   `ADMIN_ASSIGNEES: ${{ inputs.admin-assignees }}` env entry — this is
   the first point in the chain where the token exists as a step env
   var the composite can forward. When the `work` job's mint step is
   skipped or fails (see below), the `steps.<work-mint>.outputs.token`
   interpolation expands to an empty string and the container-side
   helper handles that case explicitly rather than being handed a
   half-provisioned token. `ALLOWLIST_RESOLVER_TOKEN` is a per-run name
   local to the reusable's step env and the container — it is not a
   secret the operator provisions.

   **Conditional, nonfatal minting.** The `agent-token` composite
   delegates to `actions/create-github-app-token`, which fails hard if
   the `client-id` or `private-key` input is empty or if the mint call
   itself returns an error (missing App installation, revoked key,
   transient GitHub outage). The resolver mint step therefore cannot
   be a plain always-on step with `secrets: required: true` — doing so
   would abort every groom job on a login-only deployment that has not
   provisioned the resolver App (contradicting Decision 2's "login-only
   lists require no credential" guarantee) and would abort every groom
   job on a mint failure even when only `ADMIN_ASSIGNEES` needs the
   token (contradicting requirement 5's warn-and-skip semantic for the
   best-effort variables). The resolver mint step therefore:

   - Runs behind an `if:` condition driven by a preceding
     "detect-team-refs" `run:` step that sets outputs
     `allowlist_has_team` (true iff `vars.AGENT_ALLOWLIST` contains at
     least one entry with `/`) and `assignees_has_team` (true iff
     `inputs.admin-assignees` contains at least one entry with `/`).
     The mint step runs only when at least one of those is true; a
     login-only configuration skips the mint entirely and the step
     output is empty. In the two-job layout from Decision 1, the
     `authorize` job's detect-step only needs `allowlist_has_team`
     (that job gates on the allowlist, not on `ADMIN_ASSIGNEES`), so
     its mint `if:` is `steps.detect.outputs.allowlist_has_team ==
     'true'`. The groom reusable's `work` job's detect-step produces
     `assignees_has_team`, so its mint `if:` is
     `steps.detect.outputs.assignees_has_team == 'true'`. Non-groom
     `work` jobs do not run their own detect-step or mint (they do not
     consume `ADMIN_ASSIGNEES`); only the authorize job in those
     reusables mints the resolver token.
   - Carries `continue-on-error: true`, so that a mint failure (missing
     secret because the operator intentionally has not provisioned the
     App, revoked key, GitHub API outage) does not abort the reusable
     before the downstream fail-closed / warn-and-skip enforcement
     runs. The step's failure surfaces in the Actions UI as a yellow
     "step failed, job continuing" annotation, which is the correct
     operator-visible signal — the gate step and the container
     entrypoint then enforce the right policy per variable.
   - Is referenced downstream only as `steps.<mint>.outputs.token`
     (never as `secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` directly),
     so a missing/empty token is observable as an empty string by both
     the gate step env and the "Run grooming agent" step env.

   Downstream enforcement (unchanged from the fail-closed /
   warn-and-skip policies specified in Decision 1 and Decision 3; this
   paragraph only names the paths that now include "mint skipped or
   failed" as a specific trigger):

   - **Gate step** (first-position in every reusable, per Decision 1):
     when `vars.AGENT_ALLOWLIST` contains at least one team reference
     AND the minted token is empty, the gate exits `core.setFailed(...)`
     with a `credential-unavailable` reason naming both the missing
     identity and the unresolved team(s). This is the same fail-closed
     path Decision 2 already specifies for "team references present +
     identity unprovisioned"; the only clarification is that
     "unprovisioned" explicitly covers "secret unset" **and** "mint
     attempted and failed".
   - **Groom container entrypoint** (groom reusable only, per Decision 3):
     when `ADMIN_ASSIGNEES` contains at least one team reference AND
     `ALLOWLIST_RESOLVER_TOKEN` is empty inside the container, each
     team entry is logged with a `WARNING: resolver credential
     unavailable — skipping team entry '<entry>'` and the explicit
     logins in the same list are still assigned. This matches the
     warn-and-skip policy already specified for a `listMembersInOrg`
     resolution error on an individual team; "credential unavailable"
     is treated as the same class of resolution error for a best-effort
     variable rather than as a hard job abort.

   The combined effect across the four operator scenarios the reviewer
   called out:

   | `AGENT_ALLOWLIST` | `ADMIN_ASSIGNEES` | Resolver secrets | Mint step | Gate | Groom entrypoint |
   |---|---|---|---|---|---|
   | login-only | login-only | absent | skipped (`if:` false) | passes (login-only path) | no team expansion attempted |
   | login-only | has team ref | absent | runs, fails `continue-on-error` | passes (login-only path) | warn-and-skips every team entry; groom proceeds with explicit logins |
   | login-only | has team ref | present but mint fails | runs, fails `continue-on-error` | passes (login-only path) | warn-and-skips every team entry; groom proceeds with explicit logins |
   | has team ref | login-only | absent | runs, fails `continue-on-error` | **denies** (fail-closed, `credential-unavailable`) | not reached |
   | has team ref | has team ref | present and mint succeeds | runs, succeeds | runs against resolver token; allow/deny per policy | expands team entries against resolver token |
   | has team ref | has team ref | present but mint fails | runs, fails `continue-on-error` | **denies** (fail-closed, `credential-unavailable`) | not reached |

   For non-groom reusables (`agent-design`, `agent-implement`,
   `agent-review`, `agent-respond-review`, `agent-auto-trigger`) the
   `assignees_has_team` detect-step output is unconditionally `false`
   because those reusables do not consume `ADMIN_ASSIGNEES`, so the
   mint runs iff `AGENT_ALLOWLIST` has at least one team reference, and
   only the `authorize` job needs it. The detect-step shape stays the
   same across all reusables so the gate wiring is uniform; the
   difference between groom and non-groom is only in the `work` job
   (which repeats the detect+mint pattern for groom, and skips it for
   the rest).
3. **Composite action `.github/actions/run-agent/action.yml`**
   enumerates the environment forwarded to `docker run` (see the
   `_opt_env` block near lines 191–230, which already uses conditional
   `-e` flags for `ADMIN_ASSIGNEES` and `CODE_REVIEWERS`). The composite
   grows one more conditional entry — `[[ -n
   "${ALLOWLIST_RESOLVER_TOKEN:-}" ]] && _opt_env+=(-e
   ALLOWLIST_RESOLVER_TOKEN)` — using the **name-only** `-e` form (same
   shape as the existing `-e GH_TOKEN` at line 223) so the token value
   stays out of the composite's rendered shell command and the process
   list. Because every other caller stub leaves the var unset (and does
   not declare the corresponding secrets on its reusable), the
   forwarding stays groom-only in effect; no new per-caller flag is
   required.
4. **Container entrypoint `docker/scripts/entrypoint.sh`** picks up
   `ALLOWLIST_RESOLVER_TOKEN` from its environment and passes it to the
   `expand_team_refs` helper. The entrypoint does **not** `export` the
   value globally — the helper reads it directly or runs the `gh` call
   under a scoped `GH_TOKEN=...` prefix so the developer-agent token
   remains the default for the rest of the groom run. The helper
   derives `supportedOrg` from the already-forwarded `GITHUB_REPO`
   env var (format `owner/name`) as `supportedOrg="${GITHUB_REPO%%/*}"`
   — see Decision 5's "Caller responsibilities for `supportedOrg`"
   paragraph for why this uses `GITHUB_REPO` rather than
   `GITHUB_REPOSITORY_OWNER` (the latter is **not** forwarded by the
   `run-agent` composite's `docker run` line and would be empty inside
   the container).

**Container artifact-redaction contract.** The log-harvesting trap in
`docker/scripts/entrypoint.sh` (`_log_capture_exit`) today redacts four
secret values (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`XAI_API_KEY`) from `/home/agent/logs` before the host workflow reads the
bind-mount. `ALLOWLIST_RESOLVER_TOKEN` is a new credential with the same
sensitivity — a leaked value is an unlimited read on an org's team
membership for the token lifetime — so the trap grows a fifth redaction
block for it using the same two-pass BRE-escaping pattern the existing
four blocks use, with the sentinel `***REDACTED-ALLOWLIST_RESOLVER_TOKEN***`.
The redaction is unconditional on presence (`if [ -n
"${ALLOWLIST_RESOLVER_TOKEN:-}" ]; then …`) so it is inert on non-groom
containers where the var is unset. The scrubbing test in
`docker/test/entrypoint.bats` (or wherever the scrubber is covered) gains
a corresponding case.

**Test coverage** for the forwarding path — not just the helper logic — is
part of #650's acceptance and must exercise the full caller→reusable→
composite→entrypoint chain, not just the composite boundary. A test that
starts with `ALLOWLIST_RESOLVER_TOKEN=sentinel-value` already on the
runner can only catch a missing composite `-e` flag; it cannot catch a
missing `secrets:` passthrough in the caller or a missing
`on.workflow_call.secrets` declaration in the reusable, both of which
would silently drop the token before it ever reaches the composite.
Acceptable coverage is either (a) a full e2e workflow run on a test
deployment that sets `ALLOWLIST_RESOLVER_TOKEN=sentinel-value` as a
repo/org secret, triggers `agent-groom.yml`, and asserts the sentinel is
observable inside the container (e.g. via a stubbed `expand_team_refs`
that echoes a hash of the token to the log), or (b) a layered
static-plus-runtime test asserting all four boundaries individually: the
caller stub's `secrets:` block names the new secret, the reusable's
`on.workflow_call.secrets` declares it and binds it to the `run-agent`
step's `env:` block, the composite forwards the env var into `docker
run`, and the container entrypoint reads it. Pure composite-level
runtime observation is insufficient on its own.

**Workflow-level tests for conditional and nonfatal minting.** The
mint-step policy specified in boundary 2 above cannot be verified by
helper-only tests — the failure modes it protects against happen
before the entrypoint ever runs. #650 adds three workflow-level
tests on a test deployment:

1. **Absent resolver secret, login-only lists.** Deploy with
   `AGENT_ALLOWLIST=["alice"]` and `ADMIN_ASSIGNEES=["bob"]` and the
   `ALLOWLIST_RESOLVER_APP_*` secrets unset. Trigger `agent-groom` as
   `alice`. The detect-step must report `needs_resolver=false`, the
   mint step must be skipped (not red-failed) in the Actions UI, and
   the groom job must succeed with no team expansion attempted and no
   `credential-unavailable` error on the gate step.
2. **Absent resolver secret, `ADMIN_ASSIGNEES` has a team ref.**
   Deploy with `AGENT_ALLOWLIST=["alice"]` and
   `ADMIN_ASSIGNEES=["bob","<supported-org>/some-team"]` and the
   `ALLOWLIST_RESOLVER_APP_*` secrets unset. Trigger `agent-groom` as
   `alice`. The detect-step must report
   `allowlist_has_team=false`/`assignees_has_team=true`, the mint
   step must run and fail under `continue-on-error`, the gate step
   must still pass (login-only `AGENT_ALLOWLIST` path), and the
   groom container's log must show a `WARNING: resolver credential
   unavailable — skipping team entry '<supported-org>/some-team'`
   while `bob` is still assigned. The job must succeed.
3. **Resolver secret present but mint fails,
   `AGENT_ALLOWLIST` has a team ref.** Simulate a mint failure by
   setting `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` to a syntactically
   valid but invalid-for-this-App key (e.g. a different App's key or
   a key the App has had rotated out). Deploy with
   `AGENT_ALLOWLIST=["<supported-org>/some-team"]` and trigger
   `agent-groom` as a member of `some-team`. The mint step must run
   and fail under `continue-on-error`, the gate step must deny with
   `credential-unavailable` naming both the identity and the
   unresolved team, and the groom container must **not** be invoked
   (fail-closed on the security-critical gate even when the only
   failure cause is a bad mint).

Together these three cases exercise the two policy branches
("login-only tolerates missing credential" and "gate fail-closed on
unavailable credential") against the real mint-step failure modes,
not just synthetic token-emptiness in a helper unit test.

This decision applies to **groom** today. If future issues extend
`ADMIN_ASSIGNEES` consumption to the designer or developer agents (as
anticipated in Decision 5 of `configurable-github-assignees.md`), those
entrypoint paths reuse the same shell helper and the same credential
wiring.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Teach Claude to parse team references and call the API. | Pushes a deterministic, well-defined expansion into non-deterministic Claude turns; adds API-failure handling to a prompt instead of a shell path; and complicates testing. The grooming agent should receive the same flat `["login", …]` shape it already handles. |
| Resolve `ADMIN_ASSIGNEES` in the caller stub (`agent-groom.yml`) and pass only the expanded value to the reusable. | Would put API-calling TypeScript inside a workflow `run:` step; viable, but duplicates the entrypoint-side expansion that the developer container will eventually need. Centralising in the entrypoint also keeps local `docker run` behaviour parity — operators running the groom container locally see the same expansion. |
| Resolve inside the reusable's `run-agent` composite action. | Would couple the composite action to GitHub team semantics; `run-agent` is intentionally generic across all agent actions. Entrypoint expansion keeps the composite's responsibility limited to forwarding the token into the container (one additional conditional `-e` in the existing `_opt_env` block, consistent with how `ADMIN_ASSIGNEES` and `CODE_REVIEWERS` are already forwarded), not performing the team-member resolution itself. |

### Decision 4: `CODE_REVIEWERS` team references pass through to `gh pr edit --add-reviewer`, per entry, with per-call failure isolation

**Decision.** `gh pr edit --add-reviewer` already accepts an `org/team-slug`
value and the GitHub REST endpoint it wraps (`POST
/repos/{owner}/{repo}/pulls/{n}/requested_reviewers` with `team_reviewers`)
natively supports team reviewers. The implement container's handling of
`CODE_REVIEWERS` passes each entry through unchanged: `gh pr edit
--add-reviewer "alice"` for a login, `gh pr edit --add-reviewer
"Brale-xyz/dev"` for a team.

The implement prompt (`implement.md`) stays prompt-identical except for a
clarifying sentence that entries may be either user logins or
`org/team-slug` references and both forms should be passed to `gh pr edit`
as-is, and that the prompt issues **one `gh pr edit --add-reviewer` call
per entry** rather than one combined call with multiple `--add-reviewer`
flags.

**Failure isolation: one call per entry.** The underlying endpoint `POST
/repos/{owner}/{repo}/pulls/{n}/requested_reviewers` validates all
reviewers (both the `reviewers` user array and the `team_reviewers`
team-slug array) **atomically**: if any one entry is invalid — unknown
user, deleted team, team the authenticated identity cannot see, user
without repo access, etc. — the entire request returns `422 Unprocessable
Entity` and **no** reviewer is added. The current `implement.md` text,
which emits a single `gh pr edit <pr> --add-reviewer alice --add-reviewer
bob` invocation, inherits that all-or-nothing behaviour: one bad entry
blocks every good one, directly contradicting requirement 5's "the
explicit logins in the same list are still assigned or requested"
promise. The design therefore requires per-entry invocations:

```bash
for entry in $(jq -r '.[]' <<< "$CODE_REVIEWERS"); do
  if ! gh pr edit "<pr>" --repo "$GITHUB_REPO" --add-reviewer "$entry" 2>&1 | tee /dev/stderr; then
    log "WARNING: failed to add CODE_REVIEWERS entry '$entry' — skipping (other entries unaffected)"
  fi
done
```

A failing entry (invalid team, unknown user, 422 from any cause) logs a
warning and the loop proceeds to the next entry. A succeeding entry adds
the user or team-level review request as `gh pr edit` would have. This
is the only mechanism the prompt uses — no pre-flight team-membership
validation API call is required, so the design still avoids expanding
team slugs to logins and still gives GitHub ownership of live team
notification routing.

**Empty teams are handled by GitHub.** A team that currently has zero
members is still a valid team reference; `POST
/requested_reviewers` with a team-slug that has no current members
succeeds and the review request tracks membership live (if someone joins
the team later, they become a valid reviewer for that request). The
warn-and-skip for empty teams in requirement 5 therefore applies
naturally: for `CODE_REVIEWERS`, "empty team" produces a successful
request with an empty immediate recipient list, which is the correct
behaviour and does not need to be filtered out. The deliberately
pessimistic warning emitted for a 422 from any cause (including a
hypothetical future endpoint behaviour change) is enough to surface the
case to the operator.

**Implementation task verifies this before changing anything.** The first
step of the `CODE_REVIEWERS` task is a one-command smoke test (`gh pr edit
--add-reviewer "<test-org>/<test-team>"` against a disposable PR) to
confirm the current `gh` version in the developer image supports the team
syntax. If it does not, the task escalates for a design revision. The
grooming notes (Q3) called this out as the likely-simplest case worth
verifying first. The task also adds an isolation test — a `CODE_REVIEWERS`
value of `["alice","org/does-not-exist","bob"]` on a disposable PR must
result in `alice` and `bob` being requested as reviewers and only
`org/does-not-exist` being warned-and-skipped (verifying the per-entry
loop isolates failures correctly).

**Why not expand `CODE_REVIEWERS` like `ADMIN_ASSIGNEES`?** Review requests
on GitHub have first-class team semantics: a team-level review request shows
up as "this team was requested" rather than as every current member being
individually requested, GitHub notifies the right people based on team
notification settings, and the review request tracks membership live
(someone who joins the team after the request shows up as a valid reviewer;
someone who leaves does not need the review request removed). Expanding
team slugs to logins at request time would lose all of this and would
re-create the exact "the list goes stale on membership change" problem the
issue is trying to solve. Pass-through (per entry) is strictly better here.

### Decision 5: Shared TypeScript expander lives in `.github/scripts/src/lib/`

**Decision.** `.github/scripts/src/lib/expand-team-refs.ts` exports a pure
function `expandTeamRefs(entries: string[], octokit: Octokit, options: {
supportedOrg: string }): Promise<{ expanded: string[]; errors:
ResolutionError[] }>` that:

- Treats any entry without `/` as a login and passes it through unchanged.
- Treats any entry matching `^[^/]+/[^/]+$` as a team reference. If the
  entry's `org` component does **not** equal `options.supportedOrg` (case-
  insensitive), the expander returns it as a resolution error with reason
  `cross-org` **without** calling the API, surfacing the single-org
  constraint from Decision 2. The error message names both the supported
  org and the rejected org so operators can diagnose it from the Actions
  log alone.
- For team references whose org matches `supportedOrg`, resolves via
  Octokit `teams.listMembersInOrg({ org, team_slug })` with automatic
  pagination (`octokit.paginate`).
- Resolves **every** team reference in the input (does not short-circuit)
  so the returned `errors` list reflects the full state of the input. This
  matches the gate step's order-independent policy in Decision 1: a caller
  that fails-closed on any error cannot have that semantic silently
  weakened by the expander skipping remaining entries after a success. The
  cost is bounded: one API call per team reference per invocation, with
  expected list sizes under 20.
- Dedupes the final list (case-insensitive to match GitHub login
  semantics).
- Returns a per-entry error list alongside the expanded result rather than
  throwing, so callers can decide fail-closed vs. warn-and-skip.
- Does not reject malformed entries at parse time; it returns them as
  resolution errors with a `malformed` reason, so the caller logs them
  uniformly with API-failure cases.

**Caller responsibilities for `supportedOrg`.** The gate step derives it
from `${{ github.repository_owner }}` so cross-org entries are rejected
automatically on every event. The groom entrypoint derives it from the
**already-forwarded `GITHUB_REPO`** env var (format `owner/name`, set on
every container by the composite action — see Decision 3's note on the
container env surface). Concretely: `supportedOrg="${GITHUB_REPO%%/*}"`
in shell, or `GITHUB_REPO.split('/', 1)[0]` in Node. Using the forwarded
`GITHUB_REPO` avoids relying on `GITHUB_REPOSITORY_OWNER`, which the
Actions runner sets on the host but which `.github/actions/run-agent/
action.yml` does not forward into the container's env (the composite's
`docker run` line lists `-e GITHUB_REPO` but not
`-e GITHUB_REPOSITORY_OWNER`); reading `$GITHUB_REPOSITORY_OWNER` inside
the container would be empty under the entrypoint's `set -u` and would
either abort or silently treat valid same-org teams as cross-org
mismatches. Callers do not have to configure the supported org
explicitly — the installation's own org is always the single supported
org, and both the gate-step path and the container path derive it from
variables the surrounding infrastructure already sets.

**Nested-team membership is included.** The GitHub [List team members
endpoint](https://docs.github.com/en/rest/teams/members#list-team-members)
explicitly documents that "team members will include the members of child
teams" — there is no server-side `direct-only` filter. Each returned
member carries an `inherited` boolean the caller could post-filter on, but
this design intentionally keeps the API default (inherited members are
included) because:

1. It matches operator intent: if `org/engineering` has a child team
   `org/engineering-backend`, an operator who writes `org/engineering` in
   `AGENT_ALLOWLIST` almost certainly expects backend engineers to be
   covered. A direct-only semantic would silently exclude them.
2. It matches how `gh pr edit --add-reviewer "org/engineering"` behaves on
   the PR-review side (Decision 4), keeping the three lists consistent.
3. The repo's cited example `Brale-xyz/dev` has no child teams, so this is
   a design choice, not a hidden surprise for the current operator.

The expander therefore does not post-filter on `inherited`, and the
`inherited` field is documented in the expander's module docstring so
future callers can opt into a direct-only mode by passing a predicate (not
part of the initial scope). The behaviour is covered by a unit test case
that mocks a `listMembersInOrg` response containing both `inherited: true`
and `inherited: false` members and asserts both are present in the output,
plus an end-to-end validation point in #652 that creates a real nested-team
setup and confirms the inherited member can trigger a gated workflow.

Unit tests under `.github/scripts/test/lib/expand-team-refs.test.ts` mock
Octokit at the module boundary (per the existing convention) and cover:
pure login pass-through, team expansion with pagination, mixed input,
deduping, empty team, 404 on team, 403 on team, malformed entry,
bot-identity entry, nested-team membership (inherited members included),
and the single-org constraint — an entry whose org does not match
`supportedOrg` returns a `cross-org` resolution error and `teams.list
MembersInOrg` is **not** called for it.

The in-reusable gate step (new `.github/scripts/src/check-agent-allowlist.ts`)
consumes the helper. The container-side expansion in `docker/scripts/`
consumes it too — either by baking the compiled JS into the developer
image at build time, or by re-implementing the small logic in shell against
`gh api`. Implementation picks whichever keeps the image build simple;
both paths share the same test contract.

### Decision 6: Terraform variable types stay `list(string)`; descriptions document the mixed format

**Decision.** `variable "agent_allowlist"`, `variable "admin_assignees"`,
and `variable "code_reviewers"` in `terraform/modules/agent-vars/variables.tf`
keep their current `list(string)` types. Their `description` strings grow a
sentence documenting that entries may be either an individual login (user
or bot) or an `org/team-slug` reference. An optional `validation` block
rejects entries that are empty strings or contain more than one `/`.

**Why not a richer Terraform type (object with `kind` discriminator, or
`sum` type)?** Terraform types are value shapes, not identity ontologies —
a `list(string)` already fits because every entry serializes to a string on
the wire anyway. A richer type would force the operator to write
`{ kind = "team", org = "foo", slug = "bar" }` for every team entry, which
is worse ergonomics than `"foo/bar"` for no runtime benefit; the parser
has to validate at runtime regardless because team existence is a GitHub
state, not a Terraform state.

## Out of scope

- **Multi-organization team references.** All team references in all three
  list variables must name the installation's own org (see Decision 2 and
  the `cross-org` resolution-error path in Decision 5). Operators who want
  to combine teams from multiple orgs in a single list need per-org
  credential routing (mint a separate installation token per referenced
  org and route `teams.listMembersInOrg` calls to the correct token),
  which is a future-work follow-up — the design surfaces cross-org entries
  as a validation error with a clear message so operators discover the
  limitation immediately rather than silently losing authorization on an
  outage of the wrong org's token.
- **Direct-members-only mode for team references.** The design uses the
  GitHub [List team members](https://docs.github.com/en/rest/teams/members#list-team-members)
  endpoint's default behaviour, which includes members of child teams via
  the `inherited: true` flag on each member record (see Decision 5 for the
  rationale and test coverage). An opt-in direct-only mode — where
  operators could tag a reference such as `org/team-slug!direct` to filter
  inherited members out — is not provided. Operators who need to deny a
  child-team member edit the team on GitHub.
- **Negative entries (deny-list).** The design has no syntax for "exclude
  this user even though they are a team member." Operators who need this
  edit the team on GitHub.
- **Per-workflow team references.** `AGENT_ALLOWLIST` is uniform across
  all consuming workflows. Per-workflow or per-stage team references (e.g.
  "team X can trigger `agent:groom` but not `agent:developer`") are future
  work.
- **Webhook-driven resolution.** GitHub's `membership` and `team` webhook
  events could notify installing orgs of membership changes, but the
  runtime gate design does not need notification because every triggering
  event re-resolves. No `membership`-webhook integration is specified.
- **Extending `ADMIN_ASSIGNEES` consumption to designer / resolve-conflicts
  / developer agents.** Decision 5 of
  `configurable-github-assignees.md` already called this out as future
  work; this design does not change that scope. The entrypoint helper is
  factored so a future extension is a single-file change in each additional
  entrypoint path.
- **Migrating `ESCALATION_ASSIGNEE` to accept a team reference.**
  `ESCALATION_ASSIGNEE` is a scalar single-username variable used only by
  `resolve-conflicts`. If a future issue migrates it to `ADMIN_ASSIGNEES`
  (per `configurable-github-assignees.md` Decision 5), team support comes
  along automatically through the shared entrypoint helper.
- **Caching API responses across workflow runs.** The runtime gate makes
  one API call per team reference per triggering event (resolving all
  teams before deciding, without short-circuiting — see Decision 1); at
  expected list sizes (<20 teams) this is well under GitHub's REST
  budget. A persistent cache would re-introduce the staleness and
  fail-open problems the runtime approach is specifically designed to
  avoid.
- **Terraform-side `data "github_team_members"` validation.** The design
  does not add a Terraform data source to pre-validate team references at
  `terraform plan` time. A plan-time validation would duplicate the
  runtime gate step's error handling and would fail on transient GitHub API
  issues during plans. Runtime resolution is the sole source of truth.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#645](https://github.com/mfrancza/agentic-development-workflow/issues/645) | **Terraform `agent-vars`:** update descriptions on `agent_allowlist`, `admin_assignees`, and `code_reviewers` to document the mixed `user \| org/team-slug` format; add optional validation blocks that reject empty strings and entries containing more than one `/`. Update the module README. (No companion `AGENT_ALLOWLIST_RESOLVED` variable — the runtime gate makes it unnecessary.) | — |
| Issue [#646](https://github.com/mfrancza/agentic-development-workflow/issues/646) | **Shared TypeScript expander:** add `.github/scripts/src/lib/expand-team-refs.ts` with the pure `expandTeamRefs()` function per Decision 5 (signature `(entries, octokit, { supportedOrg })`), plus `.github/scripts/test/lib/expand-team-refs.test.ts` covering login pass-through, pagination, dedupe, empty-team, 404/403, malformed, bot-identity, nested-team (inherited), and the **single-org constraint** (an entry whose org does not match `supportedOrg` returns a `cross-org` resolution error without calling `teams.listMembersInOrg`). | — |
| Issue [#647](https://github.com/mfrancza/agentic-development-workflow/issues/647) | **`CODE_REVIEWERS` team pass-through with per-entry failure isolation:** (1) run a smoke-test confirming `gh pr edit --add-reviewer "org/team-slug"` succeeds in the developer image's `gh` version. If it does not, label `human-required` and escalate per Decision 4. (2) Rewrite the `CODE_REVIEWERS` block in `docker/scripts/prompts/implement.md` so it issues **one `gh pr edit --add-reviewer <entry>` call per entry** rather than one combined call with multiple `--add-reviewer` flags — the underlying `POST /requested_reviewers` endpoint validates reviewers atomically and returns 422 for the whole request if any one is invalid, which would block valid entries and violate requirement 5's "explicit logins in the same list are still assigned or requested" promise. Each per-entry call that returns non-zero logs a warning and the loop proceeds. (3) Add an isolation test on a disposable PR with `CODE_REVIEWERS=["alice","org/does-not-exist","bob"]`: assert `alice` and `bob` are requested and only `org/does-not-exist` is warned-and-skipped. (4) Add a sentence to the prompt noting that entries may be either a user login or an `org/team-slug` reference and both forms are passed to `gh pr edit --add-reviewer` as-is. | — |
| Issue [#648](https://github.com/mfrancza/agentic-development-workflow/issues/648) | **Allowlist gate identity (human-required) — provision the chosen `allowlist-resolver` App:** retains the `human-required` label per Decision 2 because provisioning a GitHub App (creating it, installing it, generating the private key, writing the secrets) is a human action outside the code repo. The identity choice has been made: a new, dedicated `allowlist-resolver` App installed on **the single supported organization** (the one that owns the repository running the workflow — multi-org routing is out of scope per Decision 2) with only `Organization permissions → Members: Read` and `Repository permissions → Metadata: Read`. Deliverables: the App exists and is installed; `ALLOWLIST_RESOLVER_APP_ID` and `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` secrets are set at the organization or repository level; a short note in README operator setup confirms the chosen option and the single-organization scope limit (coordinated with #651). | — |
| Issue [#649](https://github.com/mfrancza/agentic-development-workflow/issues/649) | **In-reusable allowlist gate step and caller cleanup:** add `.github/scripts/src/check-agent-allowlist.ts` that reads `vars.AGENT_ALLOWLIST`, accepts a `principal` login and an optional `additional-trusted-logins` JSON array, allows the principal immediately **only** if it matches any trusted login (no API call — the known-identity exception documented in Decision 1); otherwise calls `expandTeamRefs()` with the Decision 2 identity **once, over all team references in the list** (do not short-circuit on first match: a resolution error later in the list must fail the gate regardless of whether an earlier team already matched the principal), and allows if `errors` is empty AND the principal matches any explicit login or any resolved team member. `core.setFailed`s otherwise (fail-closed on error per requirement 5). **Explicit logins in `AGENT_ALLOWLIST` do NOT bypass team resolution** — only the per-caller `additional-trusted-logins` input (bot identities) can short-circuit before API calls. This is critical: with `AGENT_ALLOWLIST=["alice","org/broken"]`, principal `alice`, and `org/broken` returning 403, the gate must deny (fail-closed on the team error) rather than allowing via an explicit-login shortcut. Also accept a `skip-gate: 'true'` input so the caller can opt out of the gate for the specific event types documented in Decision 1 (`agent-review` synchronize, `agent-auto-trigger` auto-review). Wire the step into the reusable workflows per the Decision 1 event-specific policy table — principal and trusted-login values vary per caller and per event. **Restructure each reusable into an `authorize` job and a `work` job** per Decision 1's "Concurrency groups move inside the reusable, after the gate" subsection: the `authorize` job carries the gate step and the detect-team-refs + conditional/nonfatal resolver mint (no `concurrency:` block on this job), and the existing single-job work (Docker build / `run-agent` / etc.) moves into a `work` job that declares `needs: authorize` and carries a `concurrency:` block with the **same group key and `cancel-in-progress: false` setting that was previously on the caller stub** (e.g. `agent-implement-issue-${{ inputs.issue-number }}`, `agent-groom-issue-${{ inputs.issue-number }}`). **Special case — `agent-review`**: because `agent-review-reusable.yml` is already a `resolve` + matrix `review` fan-out (one leg per configured reviewer model, `fail-fast: false`), attaching the `agent-review-pr-${{ inputs.pr-number }}` concurrency to the matrix `review` job would make every matrix leg compete for the same lock and GitHub's default one-running + one-pending behaviour would cancel sibling pending legs for `REVIEWER_MODELS` of length ≥ 2 (serialising two models) or ≥ 3 (cancelling the third-and-later leg before it posts). Instead, split `agent-review-reusable.yml` into a three-job layout per Decision 1's "Special case — `agent-review`" subsection: `authorize` (gate step, no concurrency) → a `review` wrapper job (`needs: authorize`, carries `concurrency: agent-review-pr-${{ inputs.pr-number }}` with `cancel-in-progress: false`, launches no containers itself, invokes a new nested reusable via `uses: ./.github/workflows/agent-review-worker-reusable.yml` with `secrets: inherit`) → `agent-review-worker-reusable.yml` (new file containing the existing `resolve` preflight job and the matrix `review` job from today's `agent-review-reusable.yml` verbatim, with no `concurrency:` blocks on either job because the lock is held by the caller job that invokes this nested reusable). The lock is thus held once per invocation around the entire fan-out at the wrapper job's level, so matrix legs run in parallel inside a single lock-holding slot rather than competing for it. Remove the matching `contains(fromJSON(vars.AGENT_ALLOWLIST), ...)` clauses **and** the matching `concurrency:` blocks from the caller workflows (keep event / label / trust-model / known-identity clauses in the caller `if:`; the concurrency group lives in the reusable's `work` job — or, for `agent-review`, the `review` wrapper job — going forward). Update AGENTS.md § "Repo-specific security defaults" to document the step-based gate and the required org identity. Acceptance tests must cover: (a) `agent-respond-review` with a review authored by `Copilot` (not in `AGENT_ALLOWLIST`) is still allowed through the trusted-logins exception; (b) `agent-review` `synchronize` event triggered by a pusher who is not in `AGENT_ALLOWLIST` but on an already-labeled same-repo PR is still allowed; (c) `agent-review` `labeled` event triggered by a non-allowlisted sender is denied; (d) `agent-groom`/`agent-design`/`agent-implement` events by a non-allowlisted sender are denied; (e) `auto-review` continues to authorize based on branch prefix / author with no sender gate; (f) **order-independence** of the gate's error policy: with a principal in `org/good` and `org/broken` returning 403, both `["org/good","org/broken"]` and `["org/broken","org/good"]` deny the request; (g) **explicit-login does not bypass team error**: with `AGENT_ALLOWLIST=["alice","org/broken"]`, principal `alice`, and `org/broken` returning 403, the gate denies (not allowed via explicit-login shortcut) — the only pre-resolution bypass is `additional-trusted-logins`; (h) `additional-trusted-logins` **does** bypass team error: with `AGENT_ALLOWLIST=["org/broken"]`, principal `Copilot`, trusted-logins `["Copilot"]`, and `org/broken` returning 403, the gate allows (the trusted-login fast path is taken before any API call); (i) **single-org constraint**: an entry such as `other-org/team` where `other-org != github.repository_owner` is rejected by the expander as a `cross-org` resolution error, which per fail-closed semantics denies the gate; `teams.listMembersInOrg` must **not** be called for that entry (assert via mock) — this surfaces the Decision 2 scope limit at validation time rather than as an opaque 404 at runtime. Pass `supportedOrg = github.repository_owner` into the expander; (j) **login-only, no credential**: with `AGENT_ALLOWLIST=["alice","developer[bot]"]` (no team references at all) and the Decision 2 identity **not** provisioned, principal `alice` is allowed and principal `mallory` is denied — the gate must not fail-closed on a missing credential when no entry requires a membership lookup; `teams.listMembersInOrg` must **not** be called (assert via mock); (k) **login-only path matches pre-move caller `if:`**: for a login-only list, the gate's allow/deny outcome must be identical to the equivalent pre-move `contains(fromJSON(vars.AGENT_ALLOWLIST), <sender>)` for every tested principal. Reusable-workflow wiring: in each of the six reusables (`agent-groom`, `agent-design`, `agent-implement`, `agent-review`, `agent-respond-review`, `agent-auto-trigger`) that need the gate, declare the `ALLOWLIST_RESOLVER_APP_*` secrets with **`required: false`** under `on.workflow_call.secrets`; add a **"detect-team-refs"** `run:` step that sets output `allowlist_has_team` (true iff `vars.AGENT_ALLOWLIST` contains any entry with `/`) and derived output `needs_resolver` (for non-groom reusables, `needs_resolver == allowlist_has_team`; the groom reusable extends the detect step per #650 to also factor in `assignees_has_team`); add the resolver `agent-token` mint step with **`if: steps.detect.outputs.needs_resolver == 'true'`** and **`continue-on-error: true`** so a login-only deployment skips it and a mint failure does not abort before the gate can enforce fail-closed; wire the mint's `steps.<mint>.outputs.token` into the gate step as the resolver token (empty string when the mint was skipped or failed, which the gate handles explicitly per acceptance test (j) and the fail-closed case for team references with no token). Add workflow-level tests, not just unit tests, for: (o) **login-only, missing secret, mint skipped**: deploy with `AGENT_ALLOWLIST=["alice"]` and the resolver secrets unset; the detect-step reports `needs_resolver=false`, the mint step is skipped (not red-failed), the gate step allows `alice` and denies `mallory`, no `teams.listMembersInOrg` call; (p) **team ref, missing secret, gate fail-closed**: deploy with `AGENT_ALLOWLIST=["<supported-org>/some-team"]` and the resolver secrets unset; the detect-step reports `needs_resolver=true`, the mint step runs and fails under `continue-on-error`, the gate step denies with `credential-unavailable` naming both the missing identity and the unresolved team; (q) **team ref, bad secret, gate fail-closed**: same list, but with the secret present and an intentionally-invalid private key; the mint fails under `continue-on-error` and the gate denies with the same `credential-unavailable` reason — the fail-closed path does not depend on whether the mint failed because the secret was absent or because it was invalid; (r) **authorized pending run survives subsequent denied sender**: on a test deployment, trigger `agent-implement` on issue N as an allowlisted sender (run A starts, the `work` job acquires the `agent-implement-issue-N` concurrency slot), then while A is still running trigger `agent-implement` on the same issue as an allowlisted sender again (run B's `work` job queues behind A), then trigger a third event on the same issue as a **non-allowlisted** sender (run C's `authorize` job runs and denies via `core.setFailed(...)`; run C's `work` job never runs and never enters the `agent-implement-issue-N` concurrency group). Assert run B's `work` job eventually runs after A completes — the authorized queued rerun must not have been cancelled by run C's event. Repeat for `agent-review`, `agent-groom`, `agent-design` with the appropriate concurrency group keys and triggering events; (s) **caller `concurrency:` blocks removed**: static assertion against each caller stub (`agent-groom.yml`, `agent-design.yml`, `agent-implement.yml`, `agent-review.yml`, `agent-respond-review.yml`, `agent-auto-trigger.yml`) that the job-level `concurrency:` block is gone and the corresponding reusable's `work` job (or, for `agent-review`, the `review` wrapper job) carries the matching block (prevents regressions where someone re-adds caller-level concurrency and reopens the displacement window); (t) **reviewer matrix: whole-invocation lock holds all N legs in parallel**: on a test deployment with `REVIEWER_MODELS` set to three distinct models, trigger `agent-review` on a PR as an allowlisted sender; all three matrix legs must run concurrently (not serialised, not cancelled) and each must post its own review verdict. Static assertion that `agent-review-worker-reusable.yml` exists and that neither its `resolve` job nor its matrix `review` job declares a `concurrency:` block (the lock must live on the wrapper job, not on individual matrix legs or the preflight job); (u) **reviewer matrix: second authorized invocation waits for complete first fan-out**: trigger `agent-review` on the same PR a second time (as an allowlisted sender, while the first fan-out of three legs is still running); the second invocation's `authorize` job runs immediately but its `review` wrapper job must stay queued in the `agent-review-pr-<N>` concurrency group until **all** matrix legs of the first fan-out complete, then run its own full fan-out of three legs. Assert no leg from the first fan-out is cancelled when the second invocation enters the queue; (v) **reviewer matrix: denied event never enters the lock**: trigger `agent-review` on the same PR as a **non-allowlisted** sender while an authorized fan-out is in-flight; the denied event's `authorize` job must fail-closed, its `review` wrapper job must never run, and the Actions UI must show it never entered the `agent-review-pr-<N>` concurrency group (i.e. the running fan-out and any queued authorized rerun are unaffected). | Issues #646, #648 |
| Issue [#650](https://github.com/mfrancza/agentic-development-workflow/issues/650) | **Groom entrypoint expansion of `ADMIN_ASSIGNEES`** (single supported org — Decision 2 scope — any entry whose org component does not match the supported org is warned-and-skipped as a `cross-org` resolution error, no API call for that entry): add a shell (or small Node) helper in `docker/scripts/` that expands team references in `ADMIN_ASSIGNEES` before Claude is invoked, logs per-entry warnings for empty/failed/cross-org teams, and re-exports the deduped flat list under the same env var name. Wire the Decision 2 identity through all four boundaries end-to-end: (i) in `.github/workflows/agent-groom.yml` add the secret(s) to the existing `secrets:` passthrough block of the `uses: ./.github/workflows/agent-groom-reusable.yml` call — `agent-groom.yml` is a job-level `uses:` caller with no `steps:` and no job `env:` (both unsupported alongside `uses:` at job level), so the token must flow via `secrets:` into the reusable; (ii) in `.github/workflows/agent-groom-reusable.yml` declare the two new secrets `ALLOWLIST_RESOLVER_APP_ID` + `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` under `on.workflow_call.secrets` with **`required: false`** (they must be optional because a login-only deployment should remain supported — Decision 2's "Login-only lists require no credential" guarantee); split the reusable into the `authorize` and `work` jobs per #649's restructuring and place the groom-container resolver mint in the **`work` job** (because minted-token outputs cannot cross a job boundary and the "Run grooming agent" step runs in the `work` job): add a **"detect-team-refs"** `run:` step in the `work` job before the mint that sets outputs `allowlist_has_team`, `assignees_has_team`, and `assignees_needs_resolver` (true iff `assignees_has_team` is true — the `work` job only mints for the container, not for the gate), then add a second `agent-token` step that mints an installation token from the two secrets (parallel to the existing developer-agent mint at `agent-groom-reusable.yml:132-137`) with **`if: steps.detect.outputs.assignees_needs_resolver == 'true'`** and **`continue-on-error: true`** — the mint must be conditional (so a login-only `ADMIN_ASSIGNEES` skips it entirely rather than failing on empty credentials inside `actions/create-github-app-token`) and nonfatal (so a mint failure when only `ADMIN_ASSIGNEES` needs the token lets the groom proceed with warn-and-skip rather than aborting the whole job). Set `env: ALLOWLIST_RESOLVER_TOKEN: ${{ steps.<work-mint>.outputs.token }}` on the existing "Run grooming agent" step at `agent-groom-reusable.yml:156-170`; this interpolation expands to the empty string when the mint is skipped or failed, which the container-side helper handles explicitly. The `authorize` job's own detect-step + mint (introduced by #649) still runs for the gate — this is a legitimately duplicated mint across the two jobs, since each job needs its own installation token; (iii) in `.github/actions/run-agent/action.yml` add a conditional name-only `-e ALLOWLIST_RESOLVER_TOKEN` to the existing `_opt_env` block so the token reaches the container (groom-only in effect because other callers leave it unset); (iv) in `docker/scripts/entrypoint.sh` have the helper call `gh api` with that token (`GH_TOKEN=$ALLOWLIST_RESOLVER_TOKEN gh api …`) without exporting it globally, and treat an **empty** `ALLOWLIST_RESOLVER_TOKEN` combined with an `ADMIN_ASSIGNEES` entry containing `/` as a per-entry warn-and-skip (log `WARNING: resolver credential unavailable — skipping team entry '<entry>'`) rather than as a hard entrypoint failure — this preserves Decision 3's best-effort guarantee for `ADMIN_ASSIGNEES` when the mint step was skipped or failed, and (iv.a) have the helper derive `supportedOrg` from the already-forwarded `GITHUB_REPO` env var (format `owner/name`) as `supportedOrg="${GITHUB_REPO%%/*}"` and reject any entry whose org component does not match before issuing an API call for it. **Do not** read `$GITHUB_REPOSITORY_OWNER` inside the container: the `run-agent` composite's `docker run` line forwards `GITHUB_REPO` but **not** `GITHUB_REPOSITORY_OWNER` (see `.github/actions/run-agent/action.yml` lines 222–229), so `$GITHUB_REPOSITORY_OWNER` is empty under the entrypoint's `set -u`. Add a fifth redaction block for `ALLOWLIST_RESOLVER_TOKEN` in the `_log_capture_exit` trap and a scrubber test case. Include an **ordinary workflow/container handoff test** that does not manually inject `supportedOrg` or `GITHUB_REPOSITORY_OWNER` — the helper must correctly derive the supported org from the composite's existing forwarded env, so running the groom container through the normal `run-agent` composite path with no extra env wiring must still produce correct same-org acceptance and cross-org warn-and-skip behaviour; a test that pre-sets `GITHUB_REPOSITORY_OWNER` on the host would mask a regression where the helper reverted to that unforwarded variable. Include a test that verifies the token actually reaches the container through the **full caller→reusable→composite→entrypoint handoff** (a composite-only test that starts with the token already on the runner cannot catch a missing `secrets:` passthrough or a missing `on.workflow_call.secrets` declaration): either a full e2e workflow run with a sentinel token, or a layered static-plus-runtime test asserting (a) caller `secrets:` names the new secret, (b) reusable's `on.workflow_call.secrets` declares it and binds it to the `run-agent` step's `env:`, (c) composite forwards the env var, (d) container sees the value. **Workflow-level tests for conditional/nonfatal minting** (helper-only tests cannot exercise the pre-container failure paths): (A) absent resolver secret + login-only `AGENT_ALLOWLIST` + login-only `ADMIN_ASSIGNEES` → detect-step reports `needs_resolver=false`, mint step is skipped (not red-failed), groom succeeds with no team expansion attempted; (B) absent resolver secret + login-only `AGENT_ALLOWLIST` + `ADMIN_ASSIGNEES=["bob","<supported-org>/some-team"]` → mint step runs, fails under `continue-on-error`, gate step passes (login-only path), container warns-and-skips the team entry while assigning `bob`, job succeeds; (C) resolver secret present but mint fails (e.g. intentionally-invalid private key) + `AGENT_ALLOWLIST=["<supported-org>/some-team"]` → mint runs and fails under `continue-on-error`, gate step denies with `credential-unavailable`, groom container not invoked (fail-closed on the security-critical gate even when the only failure cause is a bad mint). No prompt change required beyond a one-sentence note. | Issues #646, #648 |
| Issue [#651](https://github.com/mfrancza/agentic-development-workflow/issues/651) | **Documentation:** update AGENTS.md § "Repo-specific security defaults" (in-reusable gate and the org `Members: Read` identity), § "Optional env vars" references for `ADMIN_ASSIGNEES` / `CODE_REVIEWERS` to document the mixed format, and README.md § operator setup to add a short "GitHub team references in `AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, `CODE_REVIEWERS`" subsection that includes the Decision 2 credential setup. | Issues #645, #648 |
| Issue [#652](https://github.com/mfrancza/agentic-development-workflow/issues/652) | **End-to-end validation:** on a test deployment with a real org team, verify (a) a user added to the team can trigger `agent:groom` on the very next event, no cache wait required; (b) a user removed from the team cannot trigger on the next event (revocation case — must be verified); (c) a team that is emptied of all members contributes zero grants on the next event (revocation case — the former last member cannot trigger unless they appear as an explicit login or in a different team); (d) a referenced team that is temporarily deleted / 404s / 403s causes the gate step to fail the job (fail-closed, no cached grant survives); (e) a `human-required` issue with `ADMIN_ASSIGNEES` containing an `org/team` is assigned to every current team member; (f) a PR with `CODE_REVIEWERS` containing an `org/team` carries a team-level review request on GitHub; (g) all three lists continue to work with a mix of individual logins (including a bot login) and team references; (h) a nested-team member (member of a child of the referenced team) is correctly treated as covered; (i) a `pull_request_review.submitted` event authored by `Copilot` (a known-trusted login not in `AGENT_ALLOWLIST`) still triggers `agent-respond-review` — the trusted-logins exception works end-to-end; (j) a `pull_request_target.synchronize` event on a PR already carrying `agent:review`, triggered by a same-repo non-allowlisted collaborator, still triggers `agent-review` — the label-only authorization on `synchronize` is preserved; (k) **order-independence**: with `AGENT_ALLOWLIST` set to `["org/good","org/broken"]` where the principal is a member of `org/good` and `org/broken` returns 403, the gate denies; and with the entries reversed (`["org/broken","org/good"]`), the gate also denies — the outcome does not depend on list order; (l) `ALLOWLIST_RESOLVER_TOKEN` appears in a redacted form in the groom container's `/home/agent/logs/container.log` after a run that intentionally echoes the token, confirming the scrubber covers the new credential; (m) **explicit-login-plus-failing-team**: with `AGENT_ALLOWLIST=["alice","org/broken"]`, principal `alice`, and `org/broken` returning 403 at trigger time, the gate denies — the explicit-login match does not bypass the team-resolution error (sibling of (k) order-independence, verifying Decision 1's rule that only `additional-trusted-logins` short-circuits before API calls); (n) **token-handoff end-to-end**: with `ALLOWLIST_RESOLVER_TOKEN` provisioned as a secret and a stubbed `expand_team_refs` that writes a hash of the received token to the agent log, trigger `agent-groom` through the caller stub and confirm the sentinel's hash appears in the container log — verifies the full caller→reusable→composite→entrypoint handoff, not just the composite boundary; (o) **single-org constraint, end-to-end**: with `AGENT_ALLOWLIST=["other-org/some-team"]` (an org other than the repository's owner), the gate step denies and the Actions log shows a `cross-org` error naming both the supported org and the rejected org; `ADMIN_ASSIGNEES` with the same cross-org entry warn-and-skips and grooming proceeds with the explicit-login portion only; (p) **CODE_REVIEWERS per-entry isolation**: with `CODE_REVIEWERS=["alice","org/does-not-exist","bob"]` on a disposable PR, `alice` and `bob` are requested as reviewers and only `org/does-not-exist` is warned-and-skipped — the invalid entry does not block the valid ones (verifies Decision 4's per-entry `gh pr edit` loop against GitHub's atomic 422-on-any-invalid-reviewer behaviour); (q) **login-only deployment, no resolver credential**: on a test deployment with `AGENT_ALLOWLIST=["alice","developer[bot]"]` and the Decision 2 identity **not** provisioned, trigger `agent:groom` as `alice` and confirm the gate step passes with no `teams.listMembersInOrg` call and no credential error; trigger again as `mallory` and confirm the gate denies — the personal-repo path and any login-only org deployment must work without a credential; (r) **container supportedOrg handoff**: on the same test deployment, run the groom container through the standard `run-agent` composite path (no manual `GITHUB_REPOSITORY_OWNER` injection) with `ADMIN_ASSIGNEES=["<same-org>/some-team","other-org/some-team"]` and confirm the same-org entry expands successfully while the cross-org entry warn-and-skips — verifies the helper derives `supportedOrg` from the already-forwarded `GITHUB_REPO`, not from an unforwarded `GITHUB_REPOSITORY_OWNER`; (s) **nonfatal mint failure for `ADMIN_ASSIGNEES` only**: on a test deployment with `AGENT_ALLOWLIST=["alice"]` (login-only) and `ADMIN_ASSIGNEES=["bob","<supported-org>/some-team"]` and the resolver secrets unset, trigger `agent:groom` as `alice` and confirm the mint step shows as failed-but-continuing in the Actions UI, the gate step passes (login-only path), the container log shows `WARNING: resolver credential unavailable — skipping team entry '<supported-org>/some-team'`, and the issue ends up assigned to `bob` with the team entry absent — verifies the mint step is nonfatal for the best-effort `ADMIN_ASSIGNEES` consumer; (t) **fail-closed on mint failure for `AGENT_ALLOWLIST`**: on the same test deployment with `AGENT_ALLOWLIST=["<supported-org>/some-team"]` and the resolver secret present but with an intentionally-invalid private key, trigger `agent:groom` as a member of `some-team` and confirm the gate step denies with `credential-unavailable` naming both the identity and the team, and the groom container is not invoked — verifies the mint-failure path is fail-closed for the security-critical gate; (u) **authorized pending run survives denied event, end-to-end**: on a test deployment, trigger `agent:developer` on issue N as an allowlisted sender so a developer run starts (long-running — the developer container typically takes >1 minute, which is more than enough window). While that run is still active, remove and reapply `agent:developer` as the same (or another) allowlisted sender to queue a second authorized run behind it. While both are still in-flight / queued, remove and reapply `agent:developer` as a **non-allowlisted** collaborator. Observe the Actions UI: the non-allowlisted event spawns a new workflow run whose `authorize` job fails and whose `work` job never runs; the queued authorized rerun must still be present in the `agent-implement-issue-N` concurrency group and must eventually run after the first authorized run completes. Repeat the scenario on a PR-triggered reusable (e.g. `agent-review`) to confirm the pattern holds across both issue-keyed and PR-keyed concurrency groups. This verifies Decision 1's two-job restructuring prevents an unauthorized sender from cancelling queued authorized work; (v) **reviewer matrix: whole-invocation lock preserves all N legs end-to-end**: on a test deployment with `REVIEWER_MODELS=["sonnet","gpt-5","grok-4"]` (three distinct configured models), apply `agent:review` to a disposable same-repo PR as an allowlisted sender. All three matrix legs of the reviewer fan-out must run in parallel inside the `agent-review-pr-<N>` concurrency slot and each must post its own review verdict on the PR (verify three distinct reviews appear). While the first fan-out is still running, apply `agent:review` a second time as an allowlisted sender (remove-and-reapply the label); the second invocation's `review` wrapper job must queue behind the first in the same concurrency group, and all three of the first fan-out's legs must finish without any leg being cancelled by the second event. After the first fan-out completes, the second invocation's wrapper job must run and spawn its own three-leg fan-out, all three of which must also post their reviews. Finally, with both authorized invocations in-flight (one running + one queued), apply `agent:review` a third time as a **non-allowlisted** collaborator; the denied invocation's `authorize` job must fail-closed and never enter the `agent-review-pr-<N>` group. This verifies Decision 1's special-case three-job layout for `agent-review` preserves the matrix fan-out across the authorize-before-concurrency restructuring. | Issues #645, #646, #647, #648, #649, #650, #651 |

Dependencies are recorded natively as GitHub blocked-by relationships on the
sub-issues. The Terraform task, the shared TypeScript expander, the
`CODE_REVIEWERS` pass-through, and the human-required identity decision are
mutually independent and can proceed in parallel. The in-reusable gate step
and the groom entrypoint expansion both depend on the expander *and* the
identity decision (so the credential is available to wire in). The
documentation task depends on the Terraform task's variable surface and the
identity decision. End-to-end validation depends on all other tasks.
