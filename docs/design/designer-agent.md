# Design: Designer Agent

**Issue:** [#68](https://github.com/mfrancza/agentic-development-workflow/issues/68)

## Summary

Add a designer agent that runs when an allowlisted user (or agent) applies the
`agent:design` label to an issue. It studies the issue and its grooming Q&A,
writes a design document, opens a PR for it, and creates draft sub-issues for
the implementation tasks with their dependencies recorded. The sub-issues stay
labeled `draft` until the design PR merges.

This automates the design process already used for issues #27, #39, and #54 —
the documents in `docs/design/` and the sub-issue trees under those issues are
the reference examples of the expected output.

## Requirements (from issue #68 grooming Q&A)

1. **Trigger** — `agent:design` label (typo `agent:degisn` in the original
   body confirmed as such) applied by a permitted user.
2. **Permitted users** — a Terraform variable listing users.
3. **Design PR** — a freeform Markdown document; structure follows from the
   problem but covers common design concerns. Choosing sections is part of
   each design.
4. **Draft sub-issues** — marked with a `draft` label until the design PR is
   merged.

## Design

### Trigger and identity: the established `agent:*` pattern

A new workflow `agent-design.yml` mirrors `agent-groom.yml`:

- `on: issues: [labeled]`, gated on `github.event.label.name ==
  'agent:design'`, the issue being open, and
  `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)`.
- **Permissions var: reuse `AGENT_ALLOWLIST`.** It is already the
  Terraform-managed "users permitted to trigger agents" list and already
  includes the agent bot identities, so agents (e.g. grooming) can hand off
  to the designer. A separate per-agent allowlist adds Terraform surface
  without a current use case; GitHub *teams* ("groups") are out of scope on a
  personal repo and can be revisited if the repo moves to an org.
- Runs the existing developer image with a new `AGENT_ACTION=design` and the
  developer-agent identity. The developer app already has Contents (R/W) for
  the design branch/PR and Issues (R/W) for sub-issue creation, sub-issue
  linking, blocked-by relationships, and labels — no new identity or
  permission is needed.
- `model:<name>` labels on the issue override `vars.DEFAULT_CLAUDE_MODEL`,
  exactly like `agent-implement` / `agent-groom`.

The grooming agent's `plan` label is the natural upstream signal: issues the
groomer classifies as `plan` are the intended inputs for `agent:design`.

### The `design` action: entrypoint mechanics, Claude judgment

`action_design` in `docker/scripts/entrypoint.sh` follows `action_implement`:

1. Clone, create branch `design/issue-{N}`.
2. Fetch the issue (title, body, labels, comments — the grooming Q&A is
   essential context) and pass it to Claude with the `design.md` prompt.
3. Claude writes `docs/design/<slug>.md`, creates the sub-issues, commits,
   pushes, and opens the PR (Claude owns the GitHub side, per the PR #11
   convention).
4. Post-run verification, fail-loud: an open PR exists for
   `design/issue-{N}` **and** issue N has at least one sub-issue. Exit
   non-zero otherwise.

The branch name `design/issue-{N}` is a load-bearing convention: the draft
lifecycle (below) uses it to map a merged design PR back to its parent issue.

### The `design.md` prompt: what a design must contain

Freeform Markdown in `docs/design/`, per the Q&A — no rigid template. The
prompt requires the document to *cover* (not necessarily as sections):

- The requirements as understood, citing the issue and grooming answers.
- The decisions the design settles, each with the considered alternatives and
  why the chosen one won — decisions the parent design or repo conventions
  already settle are referenced, not re-argued.
- What is explicitly out of scope.
- A task breakdown table mapping every sub-issue with its dependencies.

The prompt points at the existing documents in `docs/design/` as exemplars
and at the repo conventions that constrain any design here (AGENTS.md
security defaults, workflow patterns, identity separation).

For the sub-issues, the prompt encodes the practices already in use:

- Single-PR-sized tasks; each body states scope, key files, and its place in
  the dependency order; parallelizable tasks are explicitly independent, and
  an end-to-end validation task depends on the implementation tasks.
- Every sub-issue: linked to the parent atomically via
  `gh issue create --parent "$GITHUB_ISSUE_NUMBER"` (the
  `POST .../sub_issues` REST endpoint returns 404 for the developer-agent
  token; `--parent` uses a GraphQL mutation internally and succeeds),
  dependencies recorded natively via blocked-by
  (`POST /repos/{repo}/issues/{n}/dependencies/blocked_by` with the blocking
  issue's global database ID as `-F issue_id=<id>`), and labeled
  `draft` + `enhancement`.
- Issue references at the start of a Markdown line must be written as
  "Issue #N" — a bare leading `#N` renders as a header (bug class already
  caught twice in review).

### Draft lifecycle

- **New Terraform label `draft`** (grey), applied by the designer to every
  sub-issue it creates. Semantics: "scoped by an unmerged design; do not
  implement yet."
- **Un-draft on design merge:** a small job (in `agent-design.yml`, second
  trigger) on `pull_request: closed` where `merged == true` and the head
  branch matches `design/issue-*`. It extracts the parent issue number from
  the branch name, enumerates the parent's sub-issues, and removes the
  `draft` label from each — plain `gh` CLI steps with the agent token; no
  container needed. Alternatives considered: manual un-drafting (toil that
  will be forgotten) and closing/reopening sub-issues (destroys the
  blocked-by graph); both rejected.
- **Implementation guard:** `agent-implement.yml` gains one condition — skip
  (with a log line) when the issue carries the `draft` label, so a stray
  `agent:developer` label cannot start implementation against an unapproved
  design.

### Design revisions

If the design PR is rejected or needs rework, the normal PR loop already
covers it: review comments trigger `agent-respond-review` on the design
branch (it is a developer-agent PR), and the sub-issues stay `draft` until a
merge actually happens. Re-running the designer on the same issue is
idempotent-by-preflight: like `agent-implement`, the action skips if an open
PR for `design/issue-{N}` already exists.

## Out of scope

- GitHub team ("group") support in the allowlist — personal repo; revisit in
  an org.
- Redesigning after the design PR merges (edit the doc or re-run the designer
  manually after removing the old branch).
- Automatic `agent:developer` labeling of un-drafted sub-issues — the human
  decides when implementation starts (consistent with every other agent
  hand-off in this repo).

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#69](https://github.com/mfrancza/agentic-development-workflow/issues/69) | Terraform: `agent:design` + `draft` labels, docs | — |
| [#70](https://github.com/mfrancza/agentic-development-workflow/issues/70) | `design` entrypoint action + `design.md` prompt in the developer image | — |
| [#71](https://github.com/mfrancza/agentic-development-workflow/issues/71) | `agent-design.yml` workflow: label trigger, allowlist gate, model resolution, dispatch | #69, #70 |
| [#72](https://github.com/mfrancza/agentic-development-workflow/issues/72) | Draft lifecycle: un-draft job on design-PR merge + `draft` skip-guard in `agent-implement.yml` | #69 |
| [#73](https://github.com/mfrancza/agentic-development-workflow/issues/73) | End-to-end validation: run the designer on a real `plan` issue; verify doc PR, draft sub-issues with relationships, and un-drafting on merge | #71, #72 |

Issues #69 and #70 can proceed in parallel (this document is the contract:
`AGENT_ACTION=design`, env `GITHUB_ISSUE_NUMBER`, branch `design/issue-{N}`).
Issue #72 only needs the label from #69. Issue #73 validates the whole loop.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
