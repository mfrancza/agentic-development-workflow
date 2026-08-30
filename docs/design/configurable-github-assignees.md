# Design: Configurable GitHub Assignees for Human Review and Action

**Issue:** [#47](https://github.com/mfrancza/agentic-development-workflow/issues/47)

## Summary

Add two configurable groups of GitHub usernames to the workflow:

- **Admin assignees** (`ADMIN_ASSIGNEES`) — assigned to issues the grooming agent
  determines cannot be securely automated.
- **Code reviewers** (`CODE_REVIEWERS`) — requested as PR reviewers when the
  developer agent determines a PR requires human code review.

Both groups are Terraform-managed variables exposed as JSON-encoded GitHub
Actions repository variables, following the established pattern of
`agent_allowlist` and `auto_trigger_agents`. All members of each group are
assigned. When a group is empty the agent logs a warning and skips assignment.

## Requirements (from issue #47 and grooming Q&A)

1. **Two distinct groups.** An *admin assignees* group for issues that require
   human action to implement or resolve, and a *code reviewers* group for PRs
   where the developer agent determines human code review is warranted.
2. **Configuration via Terraform variables** (Q&A answer 1) — same IaC
   pattern as `agent_allowlist` and `auto_trigger_agents`, so the lists are
   version-controlled alongside the rest of the operator configuration.
3. **Assign all members** of the relevant group (Q&A answer 2) rather than
   picking one.
4. **In scope: grooming agent and developer agent** (Q&A answer 3). The
   grooming agent assigns `ADMIN_ASSIGNEES` when it applies `human-required`
   to an issue. The developer agent requests reviews from `CODE_REVIEWERS`
   when it determines a PR requires human code review.
5. **Trigger criteria** (Q&A answer 4):
   - Issues: the grooming agent assigns when the issue involves something that
     cannot be securely automated (security, permissions, billing, legal, etc.).
   - PRs: the developer agent makes the determination. Branch protection rules
     enforce that the right approvers are on the PR before it can merge.
6. **Fallback: log a warning and skip assignment** when the configured group is
   empty or not set (Q&A answer 5).

## Design

### Decision 1: Configuration — Terraform variables → JSON Actions variables

**Decision.** Add two new Terraform variables:

```hcl
variable "admin_assignees" {
  description = "GitHub usernames to assign to issues that require human action (when the grooming agent applies the human-required label). All members are assigned. Leave empty to skip assignment and log a warning."
  type        = list(string)
  default     = []
}

variable "code_reviewers" {
  description = "GitHub usernames to request as reviewers on PRs where the developer agent determines human code review is needed. All members are requested. Leave empty to skip reviewer request and log a warning."
  type        = list(string)
  default     = []
}
```

Exposed as JSON-encoded repository Actions variables `ADMIN_ASSIGNEES` and
`CODE_REVIEWERS` via `github_actions_variable` resources in `terraform/main.tf`,
identical in form to `AGENT_ALLOWLIST`. The default of `[]` means these variables
always exist once Terraform is applied, eliminating the need for a non-empty
guard (`vars.ADMIN_ASSIGNEES != ''`) in workflow YAML — the agents simply check
for an empty array at the point of assignment.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Environment variables set manually per-workflow run | Not version-controlled alongside other config; operator must set them manually per environment; no IaC review/apply cycle. |
| A dedicated config file (e.g., `agents/config/assignees.json`) | The Terraform pattern is already established for all operator configuration in this repo and keeps changes reviewed and applied atomically. |
| A single merged list for both issues and PRs | The two groups have distinct semantics: admin assignees act on issues; code reviewers approve PRs. They may overlap but keeping them separate keeps the intent explicit. |
| Extending `ESCALATION_ASSIGNEE` (single-username pattern from `resolve-conflicts`) | `ESCALATION_ASSIGNEE` is a single username used only by `resolve-conflicts`. The Q&A calls for a configurable *group*. Reusing the scalar would change its semantics and break existing deployments. |

### Decision 2: Grooming agent uses ADMIN_ASSIGNEES for human-required issues

**Decision.** Pass `ADMIN_ASSIGNEES` as an environment variable into the
grooming container via `agent-groom.yml`. The entrypoint reads it with the
existing optional-var pattern:

```bash
ADMIN_ASSIGNEES="${ADMIN_ASSIGNEES:-}"
```

The value is included in the prompt context passed to Claude. The updated
`groom.md` prompt instructs Claude to:

1. Parse the `ADMIN_ASSIGNEES` JSON array.
2. When applying the `human-required` label to an issue, assign every username
   in the list with `gh issue edit ... --add-assignee "<username>"`.
3. If the list is empty, log a warning (`log "WARNING: human-required applied
   but ADMIN_ASSIGNEES is empty — no assignees will be added"`) and skip
   assignment.

Currently `groom.md` says to assign "the human(s) whose input is needed" but
provides no list. This change makes that list operator-configured rather than
left to Claude's discretion.

The `agents/grooming/label-criteria.json` `human-required` entry already
documents that assignment should happen alongside the label; no change is
needed to the criteria file itself.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Shell logic in the entrypoint: apply assignees after the grooming run completes | The entrypoint does not know whether Claude applied `human-required`; it would have to re-query the issue labels after the run and conditionally call `gh issue edit`, adding complexity. Passing the list into the prompt keeps all assignment logic with the agent that makes the decision. |
| Having Claude choose the appropriate human from a larger pool | Defeats the purpose — the issue calls for a configurable list whose membership the operator controls. |

### Decision 3: Developer agent uses CODE_REVIEWERS for PRs needing human review

**Decision.** Pass `CODE_REVIEWERS` as an environment variable into the
developer container via `agent-implement.yml`. The entrypoint reads it:

```bash
CODE_REVIEWERS="${CODE_REVIEWERS:-}"
```

The value is included in the prompt context. The updated `implement.md` prompt
instructs Claude to:

1. Parse the `CODE_REVIEWERS` JSON array.
2. When the agent determines a PR requires human code review (security-sensitive
   changes, complex architectural decisions, or escalation points where
   `human-required` is applied), request reviews from every username in the
   list with `gh pr edit ... --add-reviewer "<username>"`.
3. If the list is empty when a reviewer request would have been made, log a
   warning and skip.

The developer agent already applies the `human-required` label and assigns the
issue when it escalates; this change extends that pattern to the PR by
requesting reviews from the configured group.

For routine PRs where the agent is confident, it may opt not to request
additional human reviewers beyond the automated `agent:review` pipeline.
Branch protection still enforces at least one approval before any merge.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Always request all CODE_REVIEWERS on every agent PR | Would generate review noise on routine implementations. The Q&A says "the developer agent should make the determination," implying judgment is needed rather than blanket assignment. |
| Using GitHub CODEOWNERS | Out of scope; see "Out of scope" below. |

### Decision 4: REVIEWERS env var in entrypoint.sh is superseded

The entrypoint already declares `REVIEWERS="${REVIEWERS:-}"` (line 13 of
`entrypoint.sh`) from an earlier placeholder. This variable is currently unused.
The implementation task for the entrypoint should remove `REVIEWERS` and replace
it with `CODE_REVIEWERS` and `ADMIN_ASSIGNEES`, aligning the naming with the
Actions variables and the prompts. No callers currently set `REVIEWERS`, so
removal is a clean change.

### Decision 5: Scope is grooming and developer agents only (for now)

The designer agent (`design.md`) and resolve-conflicts agent both have
human-escalation code paths that currently use hardcoded or unconfigured
assignees. Extending this design to those agents is deferred:

- The designer agent (`design.md`) uses the same `human-required` / assign
  pattern as the developer agent. A future issue can thread `ADMIN_ASSIGNEES`
  through it once the pattern is validated on grooming and implementation.
- `resolve-conflicts` uses `ESCALATION_ASSIGNEE` (a single username). A future
  issue can migrate it to `ADMIN_ASSIGNEES`.

## Out of scope

- **GitHub CODEOWNERS** — automatic reviewer assignment via branch/file-path
  rules. A future improvement; this design is about configurable groups in IaC.
- **Team / org group support** — GitHub org teams as reviewers or assignees.
  The repo is a personal repo; `list(string)` of individual usernames covers
  the current need.
- **Per-issue or per-PR overrides** — a single global set of code reviewers and
  admin assignees applies uniformly. Label-based per-issue overrides are a
  future extension point.
- **Round-robin or load-balancing assignment** — all members are assigned, as
  specified in Q&A answer 2.
- **Designer agent and resolve-conflicts agent** — extending the configured
  assignees pattern to those agents is out of scope per Decision 5.
- **Migration of `ESCALATION_ASSIGNEE`** to use `ADMIN_ASSIGNEES` — kept
  as a separate follow-up to avoid scope creep.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#288](https://github.com/mfrancza/agentic-development-workflow/issues/288) | Terraform: add `admin_assignees` and `code_reviewers` variables, expose as `ADMIN_ASSIGNEES` and `CODE_REVIEWERS` Actions variables; update `terraform.tfvars.example` | — |
| [#289](https://github.com/mfrancza/agentic-development-workflow/issues/289) | Entrypoint and prompts: read `ADMIN_ASSIGNEES` and `CODE_REVIEWERS` in `entrypoint.sh`; remove unused `REVIEWERS` var; update `groom.md` and `implement.md` to assign/request-review using the configured lists with warn-if-empty behavior | — |
| [#290](https://github.com/mfrancza/agentic-development-workflow/issues/290) | Workflow updates: pass `ADMIN_ASSIGNEES` to `agent-groom.yml` container env and `CODE_REVIEWERS` to `agent-implement.yml` container env | Issue #288 |
| [#291](https://github.com/mfrancza/agentic-development-workflow/issues/291) | Documentation: update `AGENTS.md` optional env vars table and Actions variable list; update `README.md` operator setup section | — |
| [#292](https://github.com/mfrancza/agentic-development-workflow/issues/292) | End-to-end validation: with both lists populated, groom an issue that triggers `human-required` and verify all `ADMIN_ASSIGNEES` are assigned; implement an issue that warrants human review and verify all `CODE_REVIEWERS` are requested | Issues #288, #289, #290, #291 |

The Terraform task and the Entrypoint/prompts task are independent and can
proceed in parallel — the contract (env var names `ADMIN_ASSIGNEES` and
`CODE_REVIEWERS`, JSON-array format) is established by this document.
The Workflow task must come after the Terraform task because it references
`vars.ADMIN_ASSIGNEES` and `vars.CODE_REVIEWERS` which are created by
`terraform apply`. The Documentation task can be written in parallel with
implementation but should be committed as part of one of the other PRs to
avoid doc drift. End-to-end validation depends on all implementation tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on the
sub-issues.
