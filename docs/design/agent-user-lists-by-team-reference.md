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
  event/label/concurrency gates remain in the caller.
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
  requires a GitHub App (or PAT) that is installed on the referenced
  organizations with `Members: Read` at the organization level, and the
  identity choice is explicitly flagged as human-required (Decision 2).
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
`AGENT_ALLOWLIST`; only the event / label / concurrency / known-identity
and trust-model clauses remain in the caller `if:` so a second queued
label does not displace an in-flight run (the constraint from
[#629](https://github.com/mfrancza/agentic-development-workflow/issues/629)).
The gate itself is now a single documented step in each reusable, and
caller boilerplate shrinks correspondingly. This resolves the "every caller
restates the gate" drift problem #629 is tracking for the allowlist
specifically; label-based gates stay in the caller per that issue's
constraint.

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
- Entries matching `^[^/]+/[^/]+$` are team references. The gate resolves
  **every** team reference in the list by calling the shared expander
  (Decision 5), which calls `teams.listMembersInOrg` with pagination for
  each reference and returns `{ expanded, errors }`. The gate does not
  short-circuit on the first matching team; it waits for the expander to
  finish all references so a resolution error later in the list cannot be
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

### Decision 2: Gate step uses a human-approved org `Members: Read` App identity (human-required)

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

Because this is a change to the identity that authenticates allowlist
decisions, it is explicitly escalated to a human. The implementation sub-issue
([#648](https://github.com/mfrancza/agentic-development-workflow/issues/648))
is created with the `human-required` label and does not proceed until a
maintainer has picked an identity and provisioned it. The human reviewer
chooses between:

- **(a) New `allowlist-resolver` GitHub App installed on each referenced
  organization with only `Organization permissions → Members: Read` and
  `Repository permissions → Metadata: Read`.** This is the design's
  recommended default: least-privilege, dedicated identity, auditable in org
  audit log as a distinct actor, and reusable by the groom-container
  `ADMIN_ASSIGNEES` expansion.
- **(b) Extend the existing `developer-agent` App to add
  `Organization → Members: Read`.** Simpler because the App is already
  installed, but widens the blast radius of a developer-agent key compromise
  from code/issue operations to also reading org membership. Discouraged
  unless (a) is operationally blocked.
- **(c) Fine-grained PAT with `read:org`, stored as an organization-level
  secret.** Easiest to provision for a single org, but PATs are
  user-impersonating and expire; not recommended for a durable control.

Whichever identity the human picks, its credential is wired into the gate
step as `GH_TOKEN` / `token:` on the `github-script` action (or equivalent)
and documented in the operator setup section of README.md and in the
`agent-vars` module README. The reusable workflow declares a new
`secrets.ALLOWLIST_RESOLVER_APP_ID` and
`secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` (option (a)) or a single
`secrets.ALLOWLIST_RESOLVER_TOKEN` (option (c)); callers pass them through
alongside the existing developer-agent App secrets.

**No access without the identity.** If the installing organization has not
provisioned the identity, the gate step fails every event — fail-closed,
visible in the Actions run log. The design does not provide a bypass mode
for "no identity, trust the explicit logins only" because that would create
two code paths for the same gate and would silently degrade authorization
on misconfiguration.

**Why not defer the identity choice to a runtime smoke test?** The
`AGENT_ALLOWLIST` is the fleet's primary access-control gate. Shipping a
design that lets the implementation agent pick the identity based on an
empirical check is the pattern the project's AGENTS.md § "Escalating to a
human" exists to prevent. The decision is deferred to a human by design,
not by probing.

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
   organization-level secret through the existing `secrets:` block of
   its `uses: ./.github/workflows/agent-groom-reusable.yml` call —
   `ALLOWLIST_RESOLVER_TOKEN: ${{ secrets.ALLOWLIST_RESOLVER_TOKEN }}`
   for Decision 2 option (c), or `ALLOWLIST_RESOLVER_APP_ID` plus
   `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY` for option (a). The caller stub
   has no `steps:` and no job `env:` (both unsupported alongside `uses:`
   at job level), so the secret must flow via `secrets:` into the
   reusable; a job-level `env:` next to `uses:` would not even be a
   valid workflow file.
2. **Reusable workflow `.github/workflows/agent-groom-reusable.yml`**
   declares the new secret(s) under `on.workflow_call.secrets` (adding
   `ALLOWLIST_RESOLVER_TOKEN` for option (c), or
   `ALLOWLIST_RESOLVER_APP_ID` + `ALLOWLIST_RESOLVER_APP_PRIVATE_KEY`
   for option (a)). For option (a) the reusable adds a second
   `agent-token` step that mints an installation token from those two
   secrets (parallel to the existing developer-agent mint step at
   `agent-groom-reusable.yml:132-137`) and exposes it as a step output;
   for option (c) the reusable uses `secrets.ALLOWLIST_RESOLVER_TOKEN`
   directly. The reusable then sets
   `env: ALLOWLIST_RESOLVER_TOKEN: <minted-token-or-secret>` on the
   existing "Run grooming agent" step (the `uses:
   ./_agentic-workflow/.github/actions/run-agent` step at
   `agent-groom-reusable.yml:156-170`), alongside the existing
   `ADMIN_ASSIGNEES: ${{ inputs.admin-assignees }}` env entry — this is
   the first point in the chain where the token exists as a step env
   var the composite can forward.
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
   remains the default for the rest of the groom run.

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

### Decision 4: `CODE_REVIEWERS` team references pass through to `gh pr edit --add-reviewer`

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
as-is.

**Implementation task verifies this before changing anything.** The first
step of the `CODE_REVIEWERS` task is a one-command smoke test (`gh pr edit
--add-reviewer "<test-org>/<test-team>"` against a disposable PR) to
confirm the current `gh` version in the developer image supports the team
syntax. If it does not, the task escalates for a design revision. The
grooming notes (Q3) called this out as the likely-simplest case worth
verifying first.

**Why not expand `CODE_REVIEWERS` like `ADMIN_ASSIGNEES`?** Review requests
on GitHub have first-class team semantics: a team-level review request shows
up as "this team was requested" rather than as every current member being
individually requested, GitHub notifies the right people based on team
notification settings, and the review request tracks membership live
(someone who joins the team after the request shows up as a valid reviewer;
someone who leaves does not need the review request removed). Expanding
team slugs to logins at request time would lose all of this and would
re-create the exact "the list goes stale on membership change" problem the
issue is trying to solve. Pass-through is strictly better here.

### Decision 5: Shared TypeScript expander lives in `.github/scripts/src/lib/`

**Decision.** `.github/scripts/src/lib/expand-team-refs.ts` exports a pure
function `expandTeamRefs(entries: string[], octokit: Octokit): Promise<{
expanded: string[]; errors: ResolutionError[] }>` that:

- Treats any entry without `/` as a login and passes it through unchanged.
- Treats any entry matching `^[^/]+/[^/]+$` as a team reference and
  resolves it via Octokit `teams.listMembersInOrg({ org, team_slug })` with
  automatic pagination (`octokit.paginate`).
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
bot-identity entry, and nested-team membership (inherited members
included).

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
| Issue [#646](https://github.com/mfrancza/agentic-development-workflow/issues/646) | **Shared TypeScript expander:** add `.github/scripts/src/lib/expand-team-refs.ts` with the pure `expandTeamRefs()` function per Decision 5, plus `.github/scripts/test/lib/expand-team-refs.test.ts` covering login pass-through, pagination, dedupe, empty-team, 404/403, malformed, bot-identity, and nested-team (inherited) cases. | — |
| Issue [#647](https://github.com/mfrancza/agentic-development-workflow/issues/647) | **`CODE_REVIEWERS` team pass-through:** add a smoke-test step to the implement prompt / entrypoint path confirming `gh pr edit --add-reviewer "org/team-slug"` succeeds; update `docker/scripts/prompts/implement.md` with one sentence allowing team-slug entries; no other code changes needed if the smoke test passes. If the smoke test fails, label `human-required` and escalate per Decision 4. | — |
| Issue [#648](https://github.com/mfrancza/agentic-development-workflow/issues/648) | **Allowlist gate identity (human-required):** created with the `human-required` label per Decision 2. A maintainer picks an identity (new `allowlist-resolver` App vs. extending the developer-agent App vs. a PAT), provisions the installation / secret, and documents the credential wiring. No code change happens on this issue; the deliverables are the installation decision, the secret in the relevant org/repo, and a short note in the README operator setup. | — |
| Issue [#649](https://github.com/mfrancza/agentic-development-workflow/issues/649) | **In-reusable allowlist gate step and caller cleanup:** add `.github/scripts/src/check-agent-allowlist.ts` that reads `vars.AGENT_ALLOWLIST`, accepts a `principal` login and an optional `additional-trusted-logins` JSON array, allows the principal immediately **only** if it matches any trusted login (no API call — the known-identity exception documented in Decision 1); otherwise calls `expandTeamRefs()` with the Decision 2 identity **once, over all team references in the list** (do not short-circuit on first match: a resolution error later in the list must fail the gate regardless of whether an earlier team already matched the principal), and allows if `errors` is empty AND the principal matches any explicit login or any resolved team member. `core.setFailed`s otherwise (fail-closed on error per requirement 5). **Explicit logins in `AGENT_ALLOWLIST` do NOT bypass team resolution** — only the per-caller `additional-trusted-logins` input (bot identities) can short-circuit before API calls. This is critical: with `AGENT_ALLOWLIST=["alice","org/broken"]`, principal `alice`, and `org/broken` returning 403, the gate must deny (fail-closed on the team error) rather than allowing via an explicit-login shortcut. Also accept a `skip-gate: 'true'` input so the caller can opt out of the gate for the specific event types documented in Decision 1 (`agent-review` synchronize, `agent-auto-trigger` auto-review). Wire the step into the reusable workflows per the Decision 1 event-specific policy table — principal and trusted-login values vary per caller and per event. Remove the matching `contains(fromJSON(vars.AGENT_ALLOWLIST), ...)` clauses from the caller workflows (keep event / label / concurrency / trust-model / known-identity clauses). Update AGENTS.md § "Repo-specific security defaults" to document the step-based gate and the required org identity. Acceptance tests must cover: (a) `agent-respond-review` with a review authored by `Copilot` (not in `AGENT_ALLOWLIST`) is still allowed through the trusted-logins exception; (b) `agent-review` `synchronize` event triggered by a pusher who is not in `AGENT_ALLOWLIST` but on an already-labeled same-repo PR is still allowed; (c) `agent-review` `labeled` event triggered by a non-allowlisted sender is denied; (d) `agent-groom`/`agent-design`/`agent-implement` events by a non-allowlisted sender are denied; (e) `auto-review` continues to authorize based on branch prefix / author with no sender gate; (f) **order-independence** of the gate's error policy: with a principal in `org/good` and `org/broken` returning 403, both `["org/good","org/broken"]` and `["org/broken","org/good"]` deny the request; (g) **explicit-login does not bypass team error**: with `AGENT_ALLOWLIST=["alice","org/broken"]`, principal `alice`, and `org/broken` returning 403, the gate denies (not allowed via explicit-login shortcut) — the only pre-resolution bypass is `additional-trusted-logins`; (h) `additional-trusted-logins` **does** bypass team error: with `AGENT_ALLOWLIST=["org/broken"]`, principal `Copilot`, trusted-logins `["Copilot"]`, and `org/broken` returning 403, the gate allows (the trusted-login fast path is taken before any API call). | Issues #646, #648 |
| Issue [#650](https://github.com/mfrancza/agentic-development-workflow/issues/650) | **Groom entrypoint expansion of `ADMIN_ASSIGNEES`:** add a shell (or small Node) helper in `docker/scripts/` that expands team references in `ADMIN_ASSIGNEES` before Claude is invoked, logs per-entry warnings for empty/failed teams, and re-exports the deduped flat list under the same env var name. Wire the Decision 2 identity through all four boundaries end-to-end: (i) in `.github/workflows/agent-groom.yml` add the secret(s) to the existing `secrets:` passthrough block of the `uses: ./.github/workflows/agent-groom-reusable.yml` call — `agent-groom.yml` is a job-level `uses:` caller with no `steps:` and no job `env:` (both unsupported alongside `uses:` at job level), so the token must flow via `secrets:` into the reusable; (ii) in `.github/workflows/agent-groom-reusable.yml` declare the new secret(s) under `on.workflow_call.secrets`, mint a token from them if Decision 2 picked option (a) (new `agent-token` step with the resolver App's client-id / private-key, parallel to the existing developer-agent mint at `agent-groom-reusable.yml:132-137`), and set `env: ALLOWLIST_RESOLVER_TOKEN: <minted-token-or-secret>` on the existing "Run grooming agent" step at `agent-groom-reusable.yml:156-170`; (iii) in `.github/actions/run-agent/action.yml` add a conditional name-only `-e ALLOWLIST_RESOLVER_TOKEN` to the existing `_opt_env` block so the token reaches the container (groom-only in effect because other callers leave it unset); (iv) in `docker/scripts/entrypoint.sh` have the helper call `gh api` with that token (`GH_TOKEN=$ALLOWLIST_RESOLVER_TOKEN gh api …`) without exporting it globally. Add a fifth redaction block for `ALLOWLIST_RESOLVER_TOKEN` in the `_log_capture_exit` trap and a scrubber test case. Include a test that verifies the token actually reaches the container through the **full caller→reusable→composite→entrypoint handoff** (a composite-only test that starts with the token already on the runner cannot catch a missing `secrets:` passthrough or a missing `on.workflow_call.secrets` declaration): either a full e2e workflow run with a sentinel token, or a layered static-plus-runtime test asserting (a) caller `secrets:` names the new secret, (b) reusable's `on.workflow_call.secrets` declares it and binds it to the `run-agent` step's `env:`, (c) composite forwards the env var, (d) container sees the value. No prompt change required beyond a one-sentence note. | Issues #646, #648 |
| Issue [#651](https://github.com/mfrancza/agentic-development-workflow/issues/651) | **Documentation:** update AGENTS.md § "Repo-specific security defaults" (in-reusable gate and the org `Members: Read` identity), § "Optional env vars" references for `ADMIN_ASSIGNEES` / `CODE_REVIEWERS` to document the mixed format, and README.md § operator setup to add a short "GitHub team references in `AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, `CODE_REVIEWERS`" subsection that includes the Decision 2 credential setup. | Issues #645, #648 |
| Issue [#652](https://github.com/mfrancza/agentic-development-workflow/issues/652) | **End-to-end validation:** on a test deployment with a real org team, verify (a) a user added to the team can trigger `agent:groom` on the very next event, no cache wait required; (b) a user removed from the team cannot trigger on the next event (revocation case — must be verified); (c) a team that is emptied of all members contributes zero grants on the next event (revocation case — the former last member cannot trigger unless they appear as an explicit login or in a different team); (d) a referenced team that is temporarily deleted / 404s / 403s causes the gate step to fail the job (fail-closed, no cached grant survives); (e) a `human-required` issue with `ADMIN_ASSIGNEES` containing an `org/team` is assigned to every current team member; (f) a PR with `CODE_REVIEWERS` containing an `org/team` carries a team-level review request on GitHub; (g) all three lists continue to work with a mix of individual logins (including a bot login) and team references; (h) a nested-team member (member of a child of the referenced team) is correctly treated as covered; (i) a `pull_request_review.submitted` event authored by `Copilot` (a known-trusted login not in `AGENT_ALLOWLIST`) still triggers `agent-respond-review` — the trusted-logins exception works end-to-end; (j) a `pull_request_target.synchronize` event on a PR already carrying `agent:review`, triggered by a same-repo non-allowlisted collaborator, still triggers `agent-review` — the label-only authorization on `synchronize` is preserved; (k) **order-independence**: with `AGENT_ALLOWLIST` set to `["org/good","org/broken"]` where the principal is a member of `org/good` and `org/broken` returns 403, the gate denies; and with the entries reversed (`["org/broken","org/good"]`), the gate also denies — the outcome does not depend on list order; (l) `ALLOWLIST_RESOLVER_TOKEN` appears in a redacted form in the groom container's `/home/agent/logs/container.log` after a run that intentionally echoes the token, confirming the scrubber covers the new credential; (m) **explicit-login-plus-failing-team**: with `AGENT_ALLOWLIST=["alice","org/broken"]`, principal `alice`, and `org/broken` returning 403 at trigger time, the gate denies — the explicit-login match does not bypass the team-resolution error (sibling of (k) order-independence, verifying Decision 1's rule that only `additional-trusted-logins` short-circuits before API calls); (n) **token-handoff end-to-end**: with `ALLOWLIST_RESOLVER_TOKEN` provisioned as a secret and a stubbed `expand_team_refs` that writes a hash of the received token to the agent log, trigger `agent-groom` through the caller stub and confirm the sentinel's hash appears in the container log — verifies the full caller→reusable→composite→entrypoint handoff, not just the composite boundary. | Issues #645, #646, #647, #648, #649, #650, #651 |

Dependencies are recorded natively as GitHub blocked-by relationships on the
sub-issues. The Terraform task, the shared TypeScript expander, the
`CODE_REVIEWERS` pass-through, and the human-required identity decision are
mutually independent and can proceed in parallel. The in-reusable gate step
and the groom entrypoint expansion both depend on the expander *and* the
identity decision (so the credential is available to wire in). The
documentation task depends on the Terraform task's variable surface and the
identity decision. End-to-end validation depends on all other tasks.
