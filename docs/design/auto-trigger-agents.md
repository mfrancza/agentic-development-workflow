# Design: Auto-trigger `agent:*` labels through the SDLC

**Issue:** [#145](https://github.com/mfrancza/agentic-development-workflow/issues/145)

## Summary

Give the operator per-`agent:*`-label switches — one Terraform variable — that
turn on automatic hand-off between the SDLC stages: new issue → grooming →
design → implementation → code review. Every switch defaults to **off**, so
existing manual behavior is preserved on a fresh apply; flipping a switch on
makes that stage's label get applied automatically at the natural upstream
signal (issue opened, grooming classification landed, design PR merged, agent
PR opened) by a single new `agent-auto-trigger.yml` workflow. No agent
container, entrypoint, or prompt changes.

## Requirements (from issue #145 grooming Q&A)

1. **Per-`agent:*`-label configuration.** One switch per `agent:*` label in
   use — today: `agent:groom`, `agent:design`, `agent:developer`,
   `agent:review`. `fix-checks` / `respond-review` / `fix-deployment` are
   event-driven (workflow_run, pull_request_review, deployment_status) and
   have no `agent:*` label, so they are not in scope for this issue.
2. **Terraform-managed.** The configuration lives in Terraform, mirroring
   `agent_allowlist` and `default_claude_model` — the operator flips a bool
   and runs `terraform apply` rather than editing YAML.
3. **Safe default.** Grooming Q&A calls out opt-in (default `false`) as the
   lower-risk default. Adopted here — matches current behavior (nothing
   auto-advances) and prevents an unattended fresh clone from spending
   Anthropic credits the moment an issue is opened.
4. **Wiring point.** The grooming notes ask where `agent:*` labels are
   applied so the gate can wrap those calls. Answer: today they are all
   applied by hand (or by the grooming agent, but only for classification
   labels — `plan` / `do`, never `agent:*`). This design creates the
   auto-application sites, one per transition, and gates each at that site.
5. **Future extensibility.** Grooming Q&A raises single-map vs N-booleans.
   Single map chosen — adding an `agent:*` label is a one-key change to the
   variable, not a new resource.

## Design

### The five transitions we are gating

The SDLC is a chain of stages linked by `agent:*` labels. Each transition
is a "the previous stage finished; apply the next stage's label" event.
Enumerated exhaustively (matching the trigger labels defined in
`terraform/main.tf`):

| # | Upstream signal | Label to apply | Gate | Sender gate? | Draft guard? |
|---|---|---|---|---|---|
| 1 | `issues.opened` | `agent:groom` | `groom` | Yes — `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` | Yes — `!contains(github.event.issue.labels.*.name, 'draft')` |
| 2 | `issues.labeled` where label is `plan` | `agent:design` | `design` | Yes — `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` | No |
| 3 | `issues.labeled` where label is `do` | `agent:developer` | `developer` | Yes — `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` | Yes — `!contains(github.event.issue.labels.*.name, 'draft')` |
| 4 | `issues.unlabeled` where label is `draft` | `agent:developer` | `developer` | Yes — `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` | No (draft is being removed; this transition _is_ the un-draft path) |
| 5 | `pull_request.opened` on an agent-created branch | `agent:review` | `review` | No (head-repo guard covers fork PRs; see Decision 5) | N/A |

All five transitions apply the `AGENT_ALLOWLIST` sender gate where a meaningful sender exists. Transitions #1–#4 are triggered by `issues` events. GitHub has no per-label or per-action permission model, so any collaborator with triage permission can open issues, apply labels, or remove labels. Without a sender check, a non-allowlisted actor could cause the auto-trigger job to apply an `agent:*` label under the developer-agent App identity — which is in `AGENT_ALLOWLIST` — and thereby trigger an agent run, spending Anthropic credits, without ever being in the allowlist themselves. The `AGENT_ALLOWLIST` sender gate on all `issues`-event jobs closes this gap and preserves the invariant that agent workflows are only triggered by actors on `AGENT_ALLOWLIST`.

Transition #5 (`pull_request.opened`) uses the branch-prefix predicate instead of a sender-login check: the App slug varies per install, and a PR on an `agent/…` branch is a candidate for the review pipeline regardless of who opened it. A head-repo guard (`github.event.pull_request.head.repo.full_name == github.repository`) covers the fork-PR case, preventing outside contributors from triggering auto-review via a matching branch name.

Transition #4 exists because the un-draft job in `agent-design.yml` removes
the `draft` label from every sub-issue when the design PR merges — that
removal is the natural signal to start implementation on each unblocked
sub-issue. Transitions #3 and #4 share the `developer` gate because they
target the same `agent:*` label.

Transition #5's branch predicate is
`startsWith(head.ref, 'agent/') || startsWith(head.ref, 'design/')`, which
covers every branch prefix a developer-agent action produces today
(`agent/issue-{N}`, `agent/fix-deploy-issue-{N}`, `design/issue-{N}` — see
`docker/scripts/entrypoint.sh`). A branch-name predicate is preferred to a
sender-login predicate because the agent App slug is per-install and
hard-codes into YAML awkwardly, whereas branch prefixes are already
load-bearing conventions in this repo.

### Decision 1: Single map variable, JSON-encoded Actions variable

**Decision.** One Terraform variable:

```hcl
variable "auto_trigger_agents" {
  type = object({
    groom     = bool
    design    = bool
    developer = bool
    review    = bool
  })
  default = {
    groom     = false
    design    = false
    developer = false
    review    = false
  }
}
```

exposed as a JSON-encoded Actions variable `AUTO_TRIGGER_AGENTS` via
`github_actions_variable`. Workflows gate with
`vars.AUTO_TRIGGER_AGENTS != '' && fromJSON(vars.AUTO_TRIGGER_AGENTS).<key> == true`.

The leading `vars.AUTO_TRIGGER_AGENTS != ''` check is required. If the workflow
is merged before `terraform apply` has run (i.e., the variable does not yet
exist in the repo), `vars.AUTO_TRIGGER_AGENTS` evaluates to the empty string
and `fromJSON('')` throws a runtime error. The non-empty guard short-circuits
first and ensures the workflow fails **closed** (condition is `false`) rather
than erroring out. The implementation in issue #155 must use this two-part
form for every job's `if:` predicate.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| N flat booleans (`auto_trigger_agent_groom`, …) — one Terraform var and one Actions variable per label | Adding a future `agent:*` label means adding a new Terraform resource, a new Actions variable, and a matching workflow gate. The grooming notes explicitly flag the map form as the extensible one. |
| A `map(bool)` (untyped keys) instead of an `object({...})` | Loses schema enforcement — a typo like `develloper = true` in `terraform.tfvars` would silently produce a config with the wrong key, and the workflow gate would evaluate to `null == true` → `false`. The typed object errors at plan time. |
| String-encoded booleans (`vars.AUTO_TRIGGER_AGENT_GROOM == 'true'`) as separate Actions vars | Avoids `fromJSON` but pays the "N resources" tax. The `fromJSON` pattern is already used in this repo (`fromJSON(vars.AGENT_ALLOWLIST)` in every workflow), so operators recognize it. |

The typed object also gives the operator a single call site in `terraform.tfvars` — one block, four keys — instead of N scattered lines.

### Decision 2: Single new workflow `agent-auto-trigger.yml`, one job per transition

**Decision.** Add `.github/workflows/agent-auto-trigger.yml` containing five
jobs (one per row of the transitions table). Each job:

- has its own `on:` filter for the upstream signal (or a shared `on:` with
  per-job `if:` predicates — see below),
- gates on `fromJSON(vars.AUTO_TRIGGER_AGENTS).<key> == true`, and — for jobs triggered by `issues.labeled` or `issues.unlabeled` (transitions #2, #3, #4) — additionally on `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` per `AGENTS.md`'s repo-specific security standard (see transitions table above),
- for transitions #1 and #3, additionally gates on `!contains(github.event.issue.labels.*.name, 'draft')` — design sub-issues are opened with `draft` already applied, are fully scoped by construction, and must not be re-groomed or prematurely handed to the developer agent while the design PR is still open (see Decision 2 note below and issue #284),
- mints a developer-agent installation token via
  `./.github/actions/agent-token`, and
- applies the target label with `gh issue edit --add-label` or
  `gh pr edit --add-label`.

Because GitHub combines all `on:` entries at the workflow level (not per
job), the workflow declares `on: { issues: [opened, labeled, unlabeled],
pull_request: [opened] }` at the top and each job's `if:` narrows to its
specific event/label — the standard multi-trigger pattern already used by
`agent-design.yml` (`issues.labeled` for the design job, `pull_request.closed`
for the un-draft job).

**Draft guard on transitions #1 and #3 (issue #284).** When both `groom` and
`developer` auto-trigger gates are on, design sub-issues created by the design
agent (which already carry `draft`) would otherwise be auto-groomed (transition
#1) and then have `agent:developer` applied when the groomer classifies them
`do` (transition #3) — all while the issue is still `draft`. The
`agent-implement` preflight correctly skips draft issues, but by doing so it
consumes the one-shot `labeled` event for `agent:developer`; when the design
PR later merges and `auto-developer-undraft` runs its `--add-label
agent:developer`, GitHub sees the label already present and emits no new
`labeled` event, leaving the issue permanently stalled. Adding
`!contains(github.event.issue.labels.*.name, 'draft')` to the `if:` predicate
of both `auto-groom` and `auto-developer-do` makes `auto-developer-undraft`
(transition #4) the sole path for design sub-issues, keeping the label event
available for the un-draft hand-off. `agent-implement`'s draft preflight is
retained as defence in depth.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Extend each existing workflow (`agent-groom.yml`, `agent-design.yml`, …) with a final "apply next label" step | Spreads the auto-trigger logic across five files and couples "am I gated on?" checks to unrelated workflow gating. When the operator wants to reason about "what does auto-trigger do?", they should read one file. |
| Add the label application inside the agent container (entrypoint applies the next-stage label after the action succeeds) | Couples the container image to knowing about SDLC config; the container currently knows nothing about which trigger labels exist. Also requires threading `vars.AUTO_TRIGGER_AGENTS` into every workflow's `docker run` env, doubling the surface. |
| One workflow per transition (`agent-auto-groom.yml`, `agent-auto-design.yml`, …) | Five files for what is conceptually one feature; the operator has to enable/disable each independently and read five workflows to reason about the pipeline. |

Keeping the logic in one workflow also means the un-draft job in
`agent-design.yml` stays unchanged — it removes `draft`, the
`issues.unlabeled` event fires, and the auto-trigger workflow decides
whether to apply `agent:developer`. Decoupled, testable one file at a time.

### Decision 3: The auto-triggering identity is the developer-agent App

**Decision.** Every job in `agent-auto-trigger.yml` mints a
`developer-agent` installation token via
`./.github/actions/agent-token` (same pattern as
`agent-groom.yml` / `agent-design.yml` / `agent-implement.yml`) and uses that
token to apply the label.

**Exception — transition #5 (`pull_request.opened`):** the composite action
`./.github/actions/agent-token` is a local action and requires a repository
checkout to resolve. For `pull_request.opened`, checking out the repository
at the PR's head SHA means executing PR-authored repository code — in
particular local actions like `./.github/actions/agent-token` — with
secrets (the App credentials) in scope — a supply-chain risk. Transition
#5's job must instead call `actions/create-github-app-token` directly (the
same approach `agent-design.yml`'s `pull_request.closed` handler already
uses), without any `actions/checkout` step. This is the only job in
`agent-auto-trigger.yml` that deviates from the composite-action pattern;
all four `issues`-triggered jobs (transitions #1–#4) check out the default
branch (trusted code, not PR-authored) and can safely use the composite
action.

This matters because the downstream workflows (`agent-groom.yml`,
`agent-design.yml`, `agent-implement.yml`, `agent-review.yml`) gate on
`contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)`. The
sender of the label-added event is whoever the token belongs to — so the
developer-agent bot slug MUST be present in `agent_allowlist` (see
`terraform.tfvars.example` for the required form). If the entry is missing,
the auto-trigger job succeeds and the `agent:*` label lands on the issue,
but every downstream agent workflow run concludes `skipped` with no error —
the auto-trigger chain appears to work (the label is there) while the actual
agent run never starts. Confirm the developer-agent bot identity is in
`AGENT_ALLOWLIST` before enabling any auto-trigger gate.

**Alternatives considered.**

- **`GITHUB_TOKEN`**: has label write permission, but the sender in
  downstream workflows becomes `github-actions[bot]`, which is not in
  `AGENT_ALLOWLIST` and would silently break the chain. Fail-quiet is worse
  than fail-loud here.
- **A dedicated `auto-trigger-agent` App identity**: extra identity surface
  (App to provision, secrets to store, allowlist entry to add) with no
  isolation benefit — this workflow's authority is exactly "apply
  `agent:*` labels", which the developer-agent App already has.

### Decision 4: No re-entry guards beyond GitHub's native ones

**Decision.** Rely on GitHub's built-in behavior: `issues.labeled` and
`issues.unlabeled` only fire when the label state actually changes, and
`gh issue edit --add-label` on a label that is already present is a no-op
that does not produce a new `labeled` event. So auto-applying `agent:groom`
to an issue that already carries it is a no-op with no cascade.

Two loops considered and ruled out, plus one new non-loop confirmed safe after codebase changes:

- **Auto-groom → grooming applies `plan` → auto-design → design creates
  sub-issues → un-draft → auto-developer → developer opens PR → auto-review**
  — that is the *intended* pipeline, not a loop. Each step advances state
  monotonically and terminates at "PR under review".
- **Auto-review on `pull_request.opened` firing again on
  `pull_request.synchronize`**: only `opened` is subscribed. `synchronize`
  re-runs the *reviewer* workflow (which the reviewer image already handles
  in-place), not the auto-trigger workflow.
- **Automatic label removals causing spurious `issues.unlabeled` events**: since this design was first written, several automatic label-cleanup behaviors have been added to the codebase — `agent:groom` is removed from an issue after a successful grooming run (by `agent-groom.yml`), `agent:design` is removed from the parent issue when the design PR merges (by `agent-design.yml`'s undraft job), and `agent:developer` is removed from the linked issue when the developer-agent's PR is closed — merged or abandoned — (by `agent-pr-merged.yml`). Each removal fires an `issues.unlabeled` event, which causes `agent-auto-trigger.yml` to evaluate its five jobs. No unintended auto-trigger fires: each job gates on a specific label name, and transition #4 (the only `issues.unlabeled` job) gates on `draft` being removed — none of the cleanup events remove `draft`. The no-re-entry guarantee holds.

The edge case to note: `agent:developer` is now automatically removed by `agent-pr-merged.yml` when the developer agent's PR closes (merged or abandoned). This generates an `issues.unlabeled` event for `agent:developer`, which — as analyzed above — does not trigger transition #3 or #4. A human who wants to re-run implementation on that issue must re-apply `do`, which causes transition #3 to fire — that is the expected retry path.

**Alternative considered.** A ledger of "we auto-applied X on Y" to prevent
re-application after a human removes a label. Rejected — solves a
non-problem (humans can just leave the `auto_trigger_agents.developer` gate
off, or toggle it in Terraform) at the cost of stateful cross-run
persistence in a stateless workflow.

### Decision 5: `pull_request.opened` fires from any actor on an agent branch

**Decision.** Transition #5 gates on the branch prefix, not on the PR
author. If a human happens to open a PR from an `agent/issue-42` branch,
auto-review still applies. That is intentional — a PR on that branch is by
definition a candidate for the same review pipeline, regardless of who
pushed the button.

To keep this safe against outside contributors from forks, the gate also
requires `github.event.pull_request.head.repo.full_name ==
github.repository` — the same head-repo guard the un-draft job in
`agent-design.yml` already uses. A forked PR with a matching branch name
cannot trigger auto-review.

**Alternative considered.** Gate on
`github.event.pull_request.user.login == '<developer-agent-app>[bot]'`.
Rejected: the App slug varies per install, so pinning it in YAML would
require another Terraform var; and it excludes the legitimate "human
pushes a rescue commit and opens the PR" case.

### Decision 6: Blocked-by deferral for the developer transitions

**Decision.** Both `auto-developer-do` (transition #3) and
`auto-developer-undraft` (transition #4) run a `check-blockers` step
immediately after minting the token. If the issue has open blockers
(`blocked == "true"`), the job applies the `blocked` label (instead of
`agent:developer`) and exits success. If the issue has no open blockers
(`blocked == "false"`), the job applies `agent:developer` as normal.

The `check-blockers` composite action (`./.github/actions/check-blockers`)
wraps `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` and
returns `blocked="true"|"false"` plus a JSON array of open-blocker objects
for diagnostic purposes.

See [`docs/design/blocked-by-dependencies.md`](blocked-by-dependencies.md)
Decision 6 for the full rationale: the withholding must happen at the
label-application site to avoid the one-shot `labeled` event trap (issue
#284) — if `agent:developer` were applied and then the preflight failed
loudly, the issue would carry `agent:developer` permanently and the
un-block cascade could never re-fire it. Applying `blocked` instead records
the deferred state in a machine-readable way that the `auto-developer-unblock`
cascade job can query and re-drive when the last blocker closes.

The `auto-groom` (transition #1), `auto-design` (transition #2), and
`auto-review` (transition #5) transitions are intentionally excluded from
this pattern. See blocked-by-dependencies.md Decision 6 for the full
rationale (fail-loud preflight already covers the manual-application case
for design; grooming and review run on signals that predate or are
orthogonal to issue-level dependency relationships).

**Alternatives considered.**
- *Apply `agent:developer` and rely on the preflight to skip.* Rejected:
  consumes the one-shot `labeled` event (#284 trap), permanently stranding
  the issue.
- *Apply no label and do nothing.* Rejected: leaves no machine-readable
  record for the un-block cascade to identify and re-drive the issue.

## Out of scope

- **Auto-triggering for `fix-checks`, `respond-review`, `fix-deployment`, and `resolve-conflicts`.**
  These have no `agent:*` label; `fix-checks` runs on `workflow_run`, `respond-review` on `pull_request_review`, `fix-deployment` on `deployment_status`, and `resolve-conflicts` on `push` to `main`. They are already effectively "auto-triggered" by their event and are outside the per-`agent:*`-label configuration this issue defines.
- **Per-issue overrides beyond the operator's Terraform toggle.** The
  operator either turns on `auto_trigger_agents.groom` for the whole repo
  or leaves it off. A future issue can add a "no-auto" label if that
  becomes a real need — the extension point is one added `if:` clause per
  job.
- **Cost telemetry / rate limiting** on the auto-triggered runs. If
  auto-groom + auto-design + auto-developer end up spending unexpected
  Anthropic credits, the operator's remedy is to flip a bool off; a spend
  cap is a separate concern.
- **Grooming agent changes.** The groomer already applies `plan` / `do` /
  `model:*`; it does not need to also apply `agent:design` /
  `agent:developer` because the auto-trigger workflow handles those on the
  `plan` / `do` labeled event.
- **A GitHub App identity dedicated to auto-triggering.** The
  developer-agent App is reused (Decision 3).
- **Loop suppression via a persistent ledger** (Decision 4).

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#154](https://github.com/mfrancza/agentic-development-workflow/issues/154) | Terraform: add `auto_trigger_agents` object variable, `AUTO_TRIGGER_AGENTS` Actions variable (`jsonencode`), tfvars example entry, and AGENTS.md/README.md updates; extend the `AGENTS.md` repo-specific security-defaults allowlist-gating bullet to also cover `issues.unlabeled` (same rationale as `issues.labeled`: no per-label permission model, sender check is the only defence against triage collaborators bypassing the allowlist via label removal) | — |
| [#155](https://github.com/mfrancza/agentic-development-workflow/issues/155) | `.github/workflows/agent-auto-trigger.yml`: five jobs (auto-groom, auto-design, auto-developer-do, auto-developer-undraft, auto-review), each gated on the corresponding `fromJSON(vars.AUTO_TRIGGER_AGENTS).<key>` and minting a developer-agent token | Issue #154 |
| [#156](https://github.com/mfrancza/agentic-development-workflow/issues/156) | End-to-end validation: with each of the four gates flipped on in turn, open a fresh test issue and confirm the full chain (groom → design → developer → review) advances without human labeling; verify each gate turned off leaves current manual behavior intact | Issues #154 and #155 |

The Terraform task defines the contract (variable name `AUTO_TRIGGER_AGENTS`,
JSON keys `groom` / `design` / `developer` / `review`, all defaulting
`false`), so the workflow task can proceed in parallel against that
contract — but the workflow will fail closed until `terraform apply` runs
against the merged Terraform change, so the end-to-end validation task
sequences after both.

Dependencies will be recorded natively as GitHub blocked-by relationships
on the issues.
