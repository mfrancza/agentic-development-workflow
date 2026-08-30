# Design: Generate Volatile AGENTS.md/README Sections from Their Sources of Truth

**Issue:** [#90](https://github.com/mfrancza/agentic-development-workflow/issues/90)

## Summary

Replace hand-maintained copies of mechanical facts in `AGENTS.md` and `README.md`
with regions that are generated from their actual sources of truth:
- The **label reference table** ← `terraform/main.tf` `automation_labels` map
- The **AGENT\_ACTION table** ← `docker/scripts/entrypoint.sh` dispatcher + workflow env blocks
- The **workflow trigger table** ← `.github/workflows/agent-*.yml` `on:` / job-level `if:` blocks

Each generated region is bounded by HTML comment markers
(`<!-- generated:<section>:start -->` … `<!-- generated:<section>:end -->`),
so hand-written prose around them survives editing. A new CI step re-runs
the generator and fails on any diff, keeping the contract simple: the PR
that causes drift must also run the script and commit the result.

Parallel agent PRs that previously conflicted on the same label bullets now
each touch only the single source file that was actually changed; the
generated region is regenerated deterministically and cleanly replaces
whatever was there before, eliminating the merge-conflict surface for those
sections entirely.

## Requirements as understood (from issue #90)

Issue #90 identifies three root causes of `AGENTS.md`/`README.md` drift
and conflicts:

1. **Copy-maintenance burden**: The Labels list, the `AGENT_ACTION` env-var
   table, and the workflow trigger descriptions are manually kept in sync
   with `terraform/main.tf`, `docker/scripts/entrypoint.sh`, and
   `.github/workflows/*.yml`. Any PR that adds a label or workflow must
   also edit both docs, creating a second commit site for every change.

2. **Concurrent-PR conflicts**: Five hand-resolved doc merge conflicts in
   one week; duplicate `agent:design` bullets added by two parallel PRs
   (the example specifically cited for the Labels section).

3. **Staleness**: Notes like "not yet in terraform" and "not yet
   implemented" survive long after the feature lands, because the note and
   the implementation are in different files and often in different PRs.

**Proposed remedy (from the issue):**
- A generator script that reads the authoritative sources and writes the
  mechanical sections between delimiters.
- Generated regions marked with start/end HTML comments so surrounding
  prose is untouched.
- A CI drift check (not an auto-commit bot): the PR that changes a source
  must also run the script and commit the result.
- Agent prompts updated to run the generator instead of hand-editing.

**Design questions posed by the issue (resolved here):**
- *Which sections are worth generating?* → Label reference table, AGENT\_ACTION
  table, and workflow trigger table. The MVP Workflow narrative (the numbered
  steps) stays hand-written; it contains behavioral prose that has no
  machine-readable source.
- *Templating approach?* → A single self-contained bash script (`scripts/generate-docs.sh`)
  using `jq` for JSON and a purpose-built awk parser for the terraform HCL map.
  No new runtimes or package dependencies beyond what the `node:22-bookworm`
  base image already provides.
- *Boundary markers and drift-check reporting?* → HTML comment delimiters;
  the CI step runs `git diff --exit-code` after regeneration and prints a
  human-readable instruction on failure.
- *README deduplication vs duplication?* → README sections that duplicate a
  generated AGENTS.md section are replaced with a one-line cross-reference link.
  AGENTS.md is the single place where generated tables live; README links there.

## Decisions

### Decision 1: Which sections are generated in the MVP

**Decision.** Three generated regions in `AGENTS.md`, all placed inside the
existing sections they supplement:

| Region marker | Content produced | Source(s) |
|---------------|-----------------|-----------|
| `generated:labels` | Markdown table: label name, short description, colour hex | `terraform/main.tf` `automation_labels` local |
| `generated:agent-actions` | Markdown table: action name → required env vars | `docker/scripts/entrypoint.sh` case statement + `.github/workflows/agent-*.yml` env blocks |
| `generated:workflow-triggers` | Markdown table: workflow file, trigger event, key gating condition | `.github/workflows/agent-*.yml` `on:` + job-level `if:` |

The `generated:labels` region is inserted **before** the existing prose bullets
in the `## Labels` section, clearly labelled as the authoritative reference
table. The prose bullets below the marker remain hand-written and explain
behavioral context not captured by a short description. Agents are instructed
(in the updated prompts and in the updated **Keeping Documentation Current**
section) never to edit inside the markers and to search for existing entries
before adding prose bullets.

**Not generated in this design:**
- The MVP Workflow narrative (steps 1–7) — behavioral prose; no machine-readable source.
- The Auto-trigger gates table — it already links back to the auto-trigger design doc and describes
  complex conditional logic that is not cleanly representable as structured data. Agents adding a
  new gate would need to edit the narrative anyway; generation would save one column of data at the
  cost of a partial-generation that still requires hand-editing around it.
- Security defaults, Code Review Standards, Shell Script Conventions — prose; no machine-readable source.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Generate the Auto-trigger gates table | The table documents conditional logic (`blocked`-deferral, draft guards) that is not captured by the `on:` / `if:` blocks alone; prose wrapping would still need editing |
| Generate the entire Labels bullet prose (not just a table) | Prose context (when to apply, behavioral caveats, cross-references) has no structured source; attempting to generate it would require maintaining a parallel structured-data file, trading one sync burden for another |
| Generate only the AGENT\_ACTION table (narrowest scope) | Leaves Labels — the highest-conflict section — hand-maintained |

### Decision 2: Generator script — bash with jq and a targeted awk HCL parser

**Decision.** One self-contained shell script at `scripts/generate-docs.sh`
with `#!/bin/bash` and `set -euo pipefail`. Dependencies:

| Tool | Purpose | Availability |
|------|---------|-------------|
| `jq` | Parse `agents/grooming/label-criteria.json` | Present in `node:22-bookworm` and GitHub-hosted `ubuntu-24.04` runners |
| `awk` / `grep` / `sed` | Parse `terraform/main.tf` automation\_labels map; parse entrypoint.sh case statement | POSIX; always present |
| `python3 -c "import yaml,sys; ..."` | Parse `.github/workflows/*.yml` `on:` and `env:` blocks | `python3` + `python3-yaml` are present in `node:22-bookworm` (Debian `python3-yaml` is installed via `apt-get`); same on `ubuntu-24.04` |

The HCL parser is a purpose-built awk program targeting the specific
`automation_labels = { "name" = { color = "..."; description = "..." } }`
format in this repo's terraform. It is NOT a general HCL parser. If
`terraform/main.tf` changes the format of this specific block, the generator
fails with a clear error and the developer must update the awk program as
well. Tests in CI validate the script's output against a known snapshot (see
Decision 4); those tests would catch a silent misparse.

The script takes no arguments. It reads from the three source files directly
(paths relative to the repo root). On success it overwrites AGENTS.md and
README.md in-place: it extracts the content between each pair of markers,
replaces it with freshly-generated content, and writes the result back.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Node.js / TypeScript in `.github/scripts/` | The generator is a dev/agent tool, not a workflow activity; adding `js-yaml` to the activity package blurs the boundary established in the refactor design. A separate `scripts/` npm package adds lockfile and dependency surface. |
| Python script with `python-hcl2` | Adds a pip dependency (not default-installed); general HCL parsing is overkill for one specific map block; the script would require a `pip install` step in CI and in agent containers. |
| `hcl2json` (Go binary) | Not present in `node:22-bookworm` or the GitHub-hosted runner; would require a separate installation step with a pinned version; the narrow awk parser is adequate and avoids the binary dependency. |
| Maintain a canonical JSON data file read by both Terraform and the generator | Cleaner long-term but changes how Terraform manages labels (requires `jsondecode(file(...))` in `main.tf`), which is a separate refactor with its own Terraform plan implications. Deferred. |

### Decision 3: Boundary markers and in-place update mechanics

**Decision.** Generated regions use HTML comment markers that GitHub renders
invisibly in web views:

```
<!-- generated:<section>:start — do not edit; run scripts/generate-docs.sh to regenerate -->
…generated content…
<!-- generated:<section>:end -->
```

Section identifiers: `labels`, `agent-actions`, `workflow-triggers`.

The script locates each pair of markers with `awk` and replaces the content
between them. If a marker pair is missing or malformed (start without end, or
wrong order), the script exits non-zero with an error message indicating which
file and which marker is broken. The markers are never generated — they are
permanent load-bearing structure inserted in the initial task.

The instruction in the start marker (`do not edit; run scripts/generate-docs.sh
to regenerate`) is the primary guard for human and agent editors. The agent
prompts add a second guard at the action layer (Decision 5).

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Custom syntax (`{{generated:start}}`) | Non-standard; HTML comments render invisibly in GitHub web UI, which is better UX |
| Use `BEGIN_GENERATED` / `END_GENERATED` without section names | No section names means the script would need positional assumptions to distinguish regions in the same file |
| Separate generated files (e.g., `docs/labels.md`) included via a non-standard mechanism | GitHub-flavored Markdown has no native include mechanism; generated content must live in-file |

### Decision 4: CI drift check — regenerate and `git diff --exit-code`

**Decision.** A new step in `.github/workflows/ci.yml` (the `CI` workflow,
run on every pull request) runs `scripts/generate-docs.sh` and then:

```bash
git diff --exit-code docs/AGENTS.md README.md || {
  echo "::error::Generated sections in AGENTS.md/README.md are out of date."
  echo "::error::Run 'scripts/generate-docs.sh' locally and commit the result."
  exit 1
}
```

This step runs **after** the existing `tsc --noEmit` and `vitest run` steps.
The step requires `python3-yaml` to be installed on the runner; the CI step
adds `apt-get install -y python3-yaml` before invoking the script. This is a
one-time installation of a runner package (no persistent image change needed
for CI).

The generator produces deterministic output (sorted by label name within each
group, fixed column widths). Determinism is required so that two PRs that run
the generator independently produce identical output and do not conflict with
each other.

An auto-commit alternative (a bot that commits the regenerated files directly
to the PR branch) was considered and rejected, per the issue's own
recommendation: it would require the bot to push to agent-authored branches,
which complicates branch-protection policy and creates a second actor in the
commit history. The fix-and-commit pattern (run the script, commit) is already
the established pattern for `fix-checks` and is familiar to every agent workflow.

### Decision 5: Agent prompt updates — run, don't hand-edit

**Decision.** All prompt files in `docker/scripts/prompts/` that currently
instruct agents to update AGENTS.md when making changes gain a new paragraph:

> **Generated sections**: `AGENTS.md` and `README.md` contain regions bounded
> by `<!-- generated:<section>:start -->` / `<!-- generated:<section>:end -->`
> markers. Do not edit inside these markers. If your change alters a source
> (labels in `terraform/main.tf`, AGENT\_ACTION env vars in
> `docker/scripts/entrypoint.sh` or the workflow YAML, or workflow trigger
> conditions), run `scripts/generate-docs.sh` from the repo root and commit
> the updated AGENTS.md and README.md alongside your other changes. The CI
> drift check will fail if you skip this step.

The update applies to all action prompts, because any action can potentially
touch a label, workflow, or env-var source. The existing **Keeping
Documentation Current** section of `AGENTS.md` is updated to include:
"Run `scripts/generate-docs.sh` and commit the result whenever a change
touches a source file for a generated section (labels, AGENT\_ACTION vars,
workflow triggers). Do not hand-edit inside generation markers."

### Decision 6: README deduplication — link, don't copy

**Decision.** `README.md` does not receive its own generation markers.
Instead, any content in `README.md` that would duplicate a generated AGENTS.md
section is replaced with a one-line cross-reference:

> See [`AGENTS.md § Labels`](AGENTS.md#labels) for the full label reference.

This eliminates the second copy-maintenance obligation for README without
requiring the generator to write to two files.

**Rationale:** The issue asks whether "README duplicates any generated section
or links to AGENTS.md instead." README.md is an operator-facing document
(setup and deployment guide) rather than an agent-facing reference; agents
read AGENTS.md. Labels and AGENT\_ACTION details are more relevant to agent
developers than to operators setting up the repo. Linking is therefore the
natural split.

**Alternatives considered.**

| Alternative | Reason rejected |
|-------------|-----------------|
| Run the generator on README.md too (duplicate generated tables) | Two generated copies of the same data must be kept in sync; if one drifts (e.g., a branch cherry-pick touches only one file), CI must catch both and the error is harder to explain |
| Leave README.md unchanged (no deduplication) | README.md prose references labels and AGENT\_ACTION values that drift if those sections are updated; eventual drift between README narrative and the generated AGENTS.md table is confusing |

## Out of scope

- **Generating the MVP Workflow narrative** — the numbered behavioral steps
  (1–7) have no machine-readable source; their prose is the only authoritative
  description.
- **Generating the Auto-trigger gates table** — see Decision 1.
- **Migrating `automation_labels` from HCL to JSON** — the awk parser is the
  pragmatic first step; a full data-layer refactor (read `jsonencode(file(...))`
  in terraform) is a separate, higher-risk change.
- **Auto-commit bot** — rejected per the issue's own framing; the CI-check +
  run-and-commit pattern is sufficient.
- **Generating the grooming label criteria section** — `agents/grooming/label-criteria.json`
  is a machine-readable source, but the criteria are already only used by the
  grooming agent prompt (not duplicated in AGENTS.md prose); no generation needed.
- **Suppressing the drift check on `design/` branches** — design-branch PRs
  may add new labels in terraform before the generator handles them; CI must
  still require the generator to be run (the designer prompt update covers this).
- **Windows / non-bash support** — the generator targets the Linux environment
  of the developer container and GitHub-hosted runners; no cross-platform requirement.
- **Generating content from README.md into AGENTS.md** — information flows
  one-way: sources → AGENTS.md; README links to AGENTS.md.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#341](https://github.com/mfrancza/agentic-development-workflow/issues/341) | Insert generation markers into `AGENTS.md` and `README.md`; replace duplicated label/action content in `README.md` with cross-reference links; document the marker convention in the `## Keeping Documentation Current` section | — |
| [#343](https://github.com/mfrancza/agentic-development-workflow/issues/343) | Implement `scripts/generate-docs.sh`: awk-based `automation_labels` parser for `terraform/main.tf`; AGENT\_ACTION table parser from `entrypoint.sh` + workflow env blocks; workflow-trigger table parser from `.github/workflows/agent-*.yml`; deterministic output; in-place marker replacement | Issue #341 |
| [#345](https://github.com/mfrancza/agentic-development-workflow/issues/345) | Add drift-check step to `.github/workflows/ci.yml`: install `python3-yaml`, run `scripts/generate-docs.sh`, assert `git diff --exit-code AGENTS.md README.md` | Issue #343 |
| [#346](https://github.com/mfrancza/agentic-development-workflow/issues/346) | Update agent prompts in `docker/scripts/prompts/` to run `scripts/generate-docs.sh` on source changes; add generator instruction to `AGENTS.md § Keeping Documentation Current` | — (independent; can proceed once the generator script scope is locked) |
| [#347](https://github.com/mfrancza/agentic-development-workflow/issues/347) | End-to-end validation: add a label to `terraform/main.tf`, run the generator, verify AGENTS.md table updates; add a workflow action, verify AGENT\_ACTION table updates; simulate forgetting to run the generator and confirm CI fails with the expected error message | Issues #341, #343, #345, #346 |

The marker-insertion task and the prompt-update task are independent and can
proceed in parallel. The generator script task depends on the marker-insertion
task (to confirm marker names and placement). The CI drift-check task depends
on the generator script. The validation task depends on all four.

Dependencies are recorded natively as GitHub blocked-by relationships on the
sub-issues.
