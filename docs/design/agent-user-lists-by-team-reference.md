# Design: Manage agent username lists by GitHub team reference

**Issue:** [#626](https://github.com/mfrancza/agentic-development-workflow/issues/626)

## Summary

Let operators configure `AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, and `CODE_REVIEWERS`
as mixed lists of individual GitHub logins and `org/team-slug` references. Team
members are resolved at runtime, so joining or leaving the team propagates
automatically without re-applying Terraform or editing the Actions variable.

The three lists are consumed in different ways and each gets a different
resolution mechanism:

- **`AGENT_ALLOWLIST`** — used in workflow `if:` expressions, which cannot call
  the GitHub API. A new scheduled resolver workflow expands the operator-facing
  `AGENT_ALLOWLIST` to a flat list of logins and writes it to a new
  Terraform-managed companion variable `AGENT_ALLOWLIST_RESOLVED`. All eleven
  existing `contains(fromJSON(vars.AGENT_ALLOWLIST), ...)` call sites switch to
  the resolved variable.
- **`ADMIN_ASSIGNEES`** — issue assignees must be users. The grooming
  container's entrypoint expands team references to logins before invoking
  Claude, so the prompt still receives a flat list and the existing
  `gh issue edit --add-assignee` path is unchanged.
- **`CODE_REVIEWERS`** — `gh pr edit --add-reviewer` already accepts
  `org/team-slug` for review requests. Team references pass through unchanged;
  GitHub owns the per-member notification fan-out and tracks membership live.

A shared TypeScript helper under `.github/scripts/src/lib/` performs the
expansion and is reused by the resolver workflow, the groom container, and the
future developer-container escalation path.

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
   workflow `if:` conditions that gate on
   `contains(fromJSON(vars.AGENT_ALLOWLIST), <sender>)` must keep returning
   the same `true/false` for a given sender identity. Workflow expressions
   cannot call the GitHub API (grooming note Q1), so the API-driven
   resolution has to happen before the gate evaluates.
4. **Issue assignment path unchanged.** Issue assignees are users — the
   assignment command stays `gh issue edit --add-assignee <login>` and the
   team-to-member expansion happens upstream of it.
5. **Fail-closed for the allowlist, warn-and-skip for the others** (issue
   "Constraints" bullet 4):
   - **Allowlist.** When the resolved allowlist is empty, the natural
     `contains([], login)` evaluation returns `false` and every gated job
     skips. The resolver additionally refuses to overwrite the previously
     resolved value with an empty list on a resolver error — a transient API
     outage must not silently lock everyone out.
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

- **Where does the resolved allowlist live?** The grooming notes offered
  "pre-resolution step" and "gate redesign" as the two broad approaches. A
  per-trigger preflight job would touch all seven workflow files and spin up
  a runner for every gated event. A scheduled resolver that writes a
  companion variable touches zero gate expressions in shape (only the name
  changes) and keeps the gate expression form that AGENTS.md documents as a
  security default. The chosen approach is the scheduled resolver with a
  companion variable (Decision 1).
- **Where does the resolver run and under what identity?** Writing a
  repository Actions variable requires either the workflow `GITHUB_TOKEN`
  with `actions: write` (which the GitHub docs cover for `/repos/{owner}/{repo}/actions/variables`
  via the fine-grained `actions` permission) or a GitHub App installation
  token with the `Variables: Write` permission. The resolver workflow is
  specified to prefer `GITHUB_TOKEN` first (Decision 2); if a runtime check
  during implementation shows the default token is insufficient on this repo,
  escalate to a human for the App-identity decision rather than silently
  expanding the developer-agent App's scope.
- **How much resolution is handled in Claude vs. deterministic code?** The
  entrypoint resolves team references before Claude sees the list. Claude's
  prompt stays as a flat `["user1", "user2", …]` input, so the prompt and
  Claude's judgement path do not have to parse `org/team` syntax or handle
  API failures. (Decision 3.)

## Decisions

### Decision 1: Scheduled resolver + `AGENT_ALLOWLIST_RESOLVED` companion variable

**Decision.** Add a Terraform-managed Actions variable
`AGENT_ALLOWLIST_RESOLVED` whose value is a JSON array of GitHub logins. A
new workflow `.github/workflows/resolve-agent-allowlist.yml` reads
`vars.AGENT_ALLOWLIST` (operator-facing, mixed users + team slugs), expands
every `org/team-slug` entry via `GET /orgs/{org}/teams/{team_slug}/members`
with pagination, dedupes against the explicit logins in the same list, and
writes the result to `AGENT_ALLOWLIST_RESOLVED` via `PATCH
/repos/{owner}/{repo}/actions/variables/AGENT_ALLOWLIST_RESOLVED`. The
resolver runs on a 15-minute schedule and on `workflow_dispatch` for manual
refresh after a known membership change.

All eleven existing `contains(fromJSON(vars.AGENT_ALLOWLIST), <sender>)`
expressions change to `contains(fromJSON(vars.AGENT_ALLOWLIST_RESOLVED),
<sender>)`. The operator-facing variable name stays `AGENT_ALLOWLIST` to
preserve operator muscle memory: operators continue to edit
`agent_allowlist` in Terraform; the `_RESOLVED` suffix on the runtime
variable advertises that it is derived, not hand-edited.

The Terraform resource for `AGENT_ALLOWLIST_RESOLVED` carries
`lifecycle { ignore_changes = [value] }` so the resolver's writes do not
cause Terraform plan drift. The initial Terraform-applied value is
`jsonencode([])`.

**Staleness window.** With a 15-minute schedule, a user removed from a
referenced team retains allowlist access for up to 15 minutes. Operators who
need a shorter window can shorten the cron, or manually trigger
`workflow_dispatch` after a known removal. Operators who need an immediate
revoke can also remove the user by adding the user as a *negative* explicit
entry — not supported by this design — or simply edit the team on GitHub
and wait up to 15 minutes. This window is a deliberate trade-off against the
cost of per-trigger API resolution; the alternatives below explain why.

**Resolver failure behaviour.** The resolver preserves the previous
`AGENT_ALLOWLIST_RESOLVED` value on any error (unreachable org, deleted
team, API outage, zero members returned when at least one team reference is
present) and exits non-zero so the workflow run turns red. A completely
empty source list (operator misconfiguration — both `AGENT_ALLOWLIST` and
every referenced team are empty) propagates to an empty resolved list and
causes every allowlist-gated workflow to skip — this is the explicit
fail-closed behaviour from requirement 5.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Per-trigger preflight job: a lightweight job runs on every workflow event, calls the API, emits an `allowed` output, and all downstream jobs gate on `needs.preflight.outputs.allowed == 'true'`. | Requires editing all seven workflow files and eleven call sites; spins up a runner for every event (including ones that would evaluate `false` and currently skip without a runner); and departs from the uniform `contains(fromJSON(vars.AGENT_ALLOWLIST), ...)` convention documented in AGENTS.md § "Repo-specific security defaults". The staleness win is small (seconds instead of minutes) relative to this cost. |
| Resolver overwrites `AGENT_ALLOWLIST` in place. | Causes Terraform plan drift on every resolver run — Terraform owns the variable and would plan to revert it. Working around this with `lifecycle { ignore_changes = [value] }` on the operator-facing variable hides *all* edits from Terraform plan, which is a worse operator experience than having two variables (one operator-managed, one resolver-managed) with distinct names. |
| Store the resolved list in a committed repo file (e.g. `.github/data/agent_allowlist_resolved.json`) and have workflows read it. | Workflow `if:` expressions can only access `vars.*`, `github.*`, `env.*`, and a handful of other contexts — they cannot read repo files without a step. This defeats the goal of keeping the gate as an `if:` expression. |
| Terraform-time resolution via `data "github_team_members"`. | Explicitly ruled out by the issue "Constraints" bullet 2 and grooming note Q2: changes would only take effect on the next `terraform apply`. |

### Decision 2: Resolver runs under `GITHUB_TOKEN` with `actions: write`, escalate if insufficient

**Decision.** The resolver workflow declares top-level
`permissions: { actions: write, contents: read }` and uses the default
`GITHUB_TOKEN` to PATCH the Actions variable. If a runtime smoke test during
implementation shows the default token cannot write repository Actions
variables on this repo (behaviour differs between personal and org accounts
and between fine-grained token setups), the implementer applies the
`human-required` label on the sub-issue and the human reviewer picks between
(a) extending the developer-agent App to include `Variables: Write`,
(b) adding a new `allowlist-resolver` App with only `Variables: Write`, or
(c) using the existing `terraform-ci` App whose Admin scope already covers
this. Option (b) is the least-privilege choice and is the design's
preferred fallback; option (a) is scope creep for an App focused on code and
issue operations; option (c) overloads a CI identity.

**Why not pick the App identity in this design?** The question is partly
empirical — whether `GITHUB_TOKEN` can write the variable depends on repo
and org settings — and partly a security-sensitive identity choice that
AGENTS.md § "Escalating to a human" lists as human-in-the-loop territory.
Picking the identity now would either (i) commit the fleet to a new App
identity that may be unnecessary or (ii) commit the developer-agent App to
expanded scope. Deferring the choice to the implementation task, with a
clear escalation path, lets the human reviewer weigh the actual observed
constraint.

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

This decision applies to **groom** today. If future issues extend
`ADMIN_ASSIGNEES` consumption to the designer or developer agents (as
anticipated in Decision 5 of `configurable-github-assignees.md`), those
entrypoint paths reuse the same shell helper.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Teach Claude to parse team references and call the API. | Pushes a deterministic, well-defined expansion into non-deterministic Claude turns; adds API-failure handling to a prompt instead of a shell path; and complicates testing. The grooming agent should receive the same flat `["login", …]` shape it already handles. |
| Resolve `ADMIN_ASSIGNEES` in the caller stub (`agent-groom.yml`) and pass only the expanded value to the reusable. | Would put API-calling TypeScript inside a workflow `run:` step; viable, but duplicates the entrypoint-side expansion that the developer container will eventually need. Centralising in the entrypoint also keeps local `docker run` behaviour parity — operators running the groom container locally see the same expansion. |
| Resolve inside the reusable's `run-agent` composite action. | Would couple the composite action to GitHub team semantics; `run-agent` is intentionally generic across all agent actions. Entrypoint expansion keeps the composite action unchanged. |

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
- Dedupes the final list (case-insensitive to match GitHub login
  semantics).
- Returns a per-entry error list alongside the expanded result rather than
  throwing, so callers can decide fail-closed vs. warn-and-skip.
- Does not reject malformed entries at parse time; it returns them as
  resolution errors with a `malformed` reason, so the caller logs them
  uniformly with API-failure cases.

Unit tests under `.github/scripts/test/lib/expand-team-refs.test.ts` mock
Octokit at the module boundary (per the existing convention) and cover: pure
login pass-through, team expansion with pagination, mixed input, deduping,
empty team, 404 on team, 403 on team, malformed entry, bot-identity entry.

The resolver workflow entry (`src/resolve-agent-allowlist.ts`) consumes the
helper. The container-side expansion in `docker/scripts/` consumes it too —
either by baking the compiled JS into the developer image at build time, or
by re-implementing the small logic in shell against `gh api`. Implementation
picks whichever keeps the image build simple; both paths share the same
test contract.

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

- **Nested teams / team hierarchies.** GitHub Enterprise supports child
  teams; `teams.listMembersInOrg` returns only the direct members of the
  named team. If a referenced team has child teams, their members are not
  included. A future issue can switch to a traversal if the need arises;
  the single-level case is sufficient for the issue's cited `Brale-xyz/dev`
  example.
- **Negative entries (deny-list).** The design has no syntax for "exclude
  this user even though they are a team member." Operators who need this
  edit the team on GitHub.
- **Per-workflow team references.** `AGENT_ALLOWLIST_RESOLVED` is uniform
  across all seven consuming workflows. Per-workflow or per-stage team
  references (e.g. "team X can trigger `agent:groom` but not
  `agent:developer`") are future work.
- **Pre-trigger (zero-latency) resolution.** The 15-minute staleness window
  on the allowlist is accepted as a trade-off; operators who need per-event
  resolution can manually `workflow_dispatch` the resolver.
- **Webhook-driven resolver refresh.** GitHub's `membership` and `team`
  webhook events could trigger an immediate refresh, but they require org
  admin to subscribe and are not available on all plans. The scheduled
  refresh plus manual dispatch covers the current need; a webhook trigger
  can be added later.
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
- **Caching API responses within a workflow run.** The resolver makes one
  API call per team reference per run; at expected list sizes (<20 teams)
  this is negligible. No in-run cache is specified.
- **Terraform-side `data "github_team_members"` validation.** The design
  does not add a Terraform data source to pre-validate team references at
  `terraform plan` time. A plan-time validation would duplicate the
  runtime resolver's error handling and would fail on transient GitHub API
  issues during plans. Runtime resolution is the sole source of truth.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#645](https://github.com/mfrancza/agentic-development-workflow/issues/645) | **Terraform `agent-vars`:** add `AGENT_ALLOWLIST_RESOLVED` resource (default `jsonencode([])`, `lifecycle { ignore_changes = [value] }`); update descriptions on `agent_allowlist`, `admin_assignees`, and `code_reviewers` to document the mixed `user \| org/team-slug` format; add optional validation blocks that reject empty strings and entries containing more than one `/`. Update the module README. | — |
| Issue [#646](https://github.com/mfrancza/agentic-development-workflow/issues/646) | **Shared TypeScript expander:** add `.github/scripts/src/lib/expand-team-refs.ts` with the pure `expandTeamRefs()` function per Decision 5, plus `.github/scripts/test/lib/expand-team-refs.test.ts` covering login pass-through, pagination, dedupe, empty-team, 404/403, malformed, and bot-identity cases. | — |
| Issue [#647](https://github.com/mfrancza/agentic-development-workflow/issues/647) | **`CODE_REVIEWERS` team pass-through:** add a smoke-test step to the implement prompt / entrypoint path confirming `gh pr edit --add-reviewer "org/team-slug"` succeeds; update `docker/scripts/prompts/implement.md` with one sentence allowing team-slug entries; no other code changes needed if the smoke test passes. If the smoke test fails, label `human-required` and escalate per Decision 4. | — |
| Issue [#648](https://github.com/mfrancza/agentic-development-workflow/issues/648) | **Resolver workflow:** add `.github/workflows/resolve-agent-allowlist.yml` (schedule every 15 min + `workflow_dispatch`), `permissions: { actions: write, contents: read }`, invoking a new `.github/scripts/src/resolve-agent-allowlist.ts` entry that reads `vars.AGENT_ALLOWLIST`, calls `expandTeamRefs()`, and PATCHes `AGENT_ALLOWLIST_RESOLVED`. Preserve previous value on error and exit non-zero. First-run smoke test: verify `GITHUB_TOKEN` can PATCH the variable; if not, escalate for the App-identity decision per Decision 2. | Issues #645, #646 |
| Issue [#649](https://github.com/mfrancza/agentic-development-workflow/issues/649) | **Switch allowlist consumers to `AGENT_ALLOWLIST_RESOLVED`:** update all eleven `contains(fromJSON(vars.AGENT_ALLOWLIST), ...)` call sites in `.github/workflows/agent-implement.yml`, `agent-groom.yml`, `agent-design.yml`, `agent-review.yml`, `agent-respond-review.yml`, and `agent-auto-trigger.yml` (five sites) to reference `vars.AGENT_ALLOWLIST_RESOLVED`. Update AGENTS.md § "Repo-specific security defaults" to document both variables and the resolver. | Issue #648 |
| Issue [#650](https://github.com/mfrancza/agentic-development-workflow/issues/650) | **Groom entrypoint expansion of `ADMIN_ASSIGNEES`:** add a shell (or small Node) helper in `docker/scripts/` that expands team references in `ADMIN_ASSIGNEES` before Claude is invoked, logs per-entry warnings for empty/failed teams, and re-exports the deduped flat list under the same env var name. No prompt change required beyond a one-sentence note. | Issue #646 |
| Issue [#651](https://github.com/mfrancza/agentic-development-workflow/issues/651) | **Documentation:** update AGENTS.md § "Repo-specific security defaults" (allowlist resolver), § "Optional env vars" references for `ADMIN_ASSIGNEES` / `CODE_REVIEWERS` to document the mixed format, and README.md § operator setup to add a short "GitHub team references in `AGENT_ALLOWLIST`, `ADMIN_ASSIGNEES`, `CODE_REVIEWERS`" subsection. | Issue #645 |
| Issue [#652](https://github.com/mfrancza/agentic-development-workflow/issues/652) | **End-to-end validation:** on a test deployment with a real org team, verify (a) a user added to the team can trigger `agent:groom` within one resolver cycle; (b) a user removed from the team cannot after one cycle; (c) a `human-required` issue with `ADMIN_ASSIGNEES` containing an `org/team` is assigned to every current team member; (d) a PR with `CODE_REVIEWERS` containing an `org/team` carries a team-level review request on GitHub; (e) the resolver preserves the previous `AGENT_ALLOWLIST_RESOLVED` value when a referenced team is temporarily deleted; (f) all three lists continue to work with a mix of individual logins (including a bot login) and team references. | Issues #645, #646, #647, #648, #649, #650, #651 |

Dependencies are recorded natively as GitHub blocked-by relationships on the
sub-issues. The Terraform task, the shared TypeScript expander, and the
`CODE_REVIEWERS` pass-through are mutually independent and can proceed in
parallel. The resolver workflow and the groom entrypoint expansion both
depend on the expander. The allowlist consumer switch depends on the
resolver workflow. The documentation task depends only on the Terraform
task's variable surface. End-to-end validation depends on all other tasks.
