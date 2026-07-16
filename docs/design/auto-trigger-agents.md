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

| # | Upstream signal | Label to apply | Gate |
|---|---|---|---|
| 1 | `issues.opened` | `agent:groom` | `groom` |
| 2 | `issues.labeled` where label is `plan` | `agent:design` | `design` |
| 3 | `issues.labeled` where label is `do` | `agent:developer` | `developer` |
| 4 | `issues.unlabeled` where label is `draft` | `agent:developer` | `developer` |
| 5 | `pull_request.opened` on an agent-created branch | `agent:review` | `review` |

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
`fromJSON(vars.AUTO_TRIGGER_AGENTS).<key> == true`.

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
- gates on `fromJSON(vars.AUTO_TRIGGER_AGENTS).<key> == true`,
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

This matters because the downstream workflows (`agent-groom.yml`,
`agent-design.yml`, `agent-implement.yml`, `agent-review.yml`) gate on
`contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)`. The
sender of the label-added event is whoever the token belongs to — so the
developer-agent bot must be in `AGENT_ALLOWLIST`. It already is, per
`AGENTS.md`: *"The agent bots are included in the allowlist so that agents
can apply `agent:*` labels to route work to one another."* No allowlist
change needed.

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

Two loops considered and ruled out:

- **Auto-groom → grooming applies `plan` → auto-design → design creates
  sub-issues → un-draft → auto-developer → developer opens PR → auto-review**
  — that is the *intended* pipeline, not a loop. Each step advances state
  monotonically and terminates at "PR under review".
- **Auto-review on `pull_request.opened` firing again on
  `pull_request.synchronize`**: only `opened` is subscribed. `synchronize`
  re-runs the *reviewer* workflow (which the reviewer image already handles
  in-place), not the auto-trigger workflow.

The one edge case is a user manually removing the `agent:developer` label
after auto-triggering: re-adding `do` (which they would have to remove
first) would re-fire transition #3. That is a human overriding auto-trigger,
which is the expected way to opt out per-issue.

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

## Out of scope

- **Auto-triggering for `fix-checks`, `respond-review`, `fix-deployment`.**
  These have no `agent:*` label; they run on `workflow_run`,
  `pull_request_review`, and `deployment_status`. They are already
  effectively "auto-triggered" by their event and are outside the
  per-`agent:*`-label configuration this issue defines.
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
| [#154](https://github.com/mfrancza/agentic-development-workflow/issues/154) | Terraform: add `auto_trigger_agents` object variable, `AUTO_TRIGGER_AGENTS` Actions variable (`jsonencode`), tfvars example entry, and AGENTS.md/README.md updates | — |
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
