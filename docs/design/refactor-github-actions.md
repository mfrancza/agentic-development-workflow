# Design: Refactor GitHub Actions Workflow Scripts

**Issue:** [#33](https://github.com/mfrancza/agentic-development-workflow/issues/33)

## Summary

The seven agent workflows carry roughly a thousand lines of YAML, much of it
inline shell:
jq pipelines, GraphQL pagination, and multi-branch error-handling policy
embedded in `run:` blocks, with several scripts duplicated near-verbatim
across workflows. This design:

1. Introduces **TypeScript** as the scripting language for workflow logic,
   executed **from source** (no build artifacts) via thin composite actions.
2. Establishes a single shared package at `.github/scripts/` holding all
   activity sources, dependencies, and unit tests.
3. Adds a **CI workflow** (`ci.yml`, named `CI`) that enforces type checking
   and runs the unit tests on every pull request — which also makes the
   existing `agent-fix-checks` trigger (`workflows: ["CI"]`) functional for
   the first time.
4. Defines the migration inventory, the threshold for what stays shell, and
   the security exceptions that must not move into workspace-executed code.

## Requirements as understood

From issue #33 and its
[grooming comment](https://github.com/mfrancza/agentic-development-workflow/issues/33#issuecomment-4887520822):

- The workflows contain a lot of inline shell; refactor the complex scripts
  into **reusable activities**.
- Introduce a **general programming language** for complex scripting, chosen
  for **ease of integration** with GitHub Actions and **type safety**.
- The grooming comment asks the design to settle: the language choice (with
  rationale), the reuse mechanism (composite actions vs. reusable workflows
  vs. custom JS/TS actions), the threshold for migrating a script vs. leaving
  it as shell, an inventory of existing scripts, and a migration priority
  order.

## Inventory of inline shell

| Script | Where | Size / notes |
|--------|-------|--------------|
| Resolve `model:*` label → Claude model | 5 copies: agent-design, agent-groom, agent-implement, agent-review (PR variant), agent-fix-deployment | ~30 lines each, near-identical; biggest duplication |
| Preflight: skip if PR already exists | 2 copies: agent-design, agent-implement | Contains the subtle `gh pr list --head` fork-owner workaround |
| Preflight: skip if issue labeled `draft` | agent-implement | Small |
| Check for reviewer feedback (skip logic) | agent-respond-review | ~85 lines; GraphQL pagination, fail-open policy; most complex |
| Un-draft sub-issues on design-PR merge | agent-design (`undraft-sub-issues` job) | ~70 lines; careful error-handling; **security exception, stays shell** (Decision 8) |
| Resolve deployment → workflow run + issue | agent-fix-deployment | ~30 lines |
| Filter to agent-authored PRs | agent-fix-checks | Small |
| `docker build` / `docker run` env plumbing | all 7 workflows | Repeated but individually trivial; addressed with a composite action, no TS needed |

## Decisions

### Decision 1 — Language: TypeScript

**Decision:** Use TypeScript for all extracted workflow logic.

**Rationale:** GitHub Actions' first-class tooling is the Node ecosystem:
`@actions/core` (typed inputs/outputs/logging), `@actions/github` (typed,
pre-configured Octokit). Type safety is structural, not opt-in, and the
GitHub REST/GraphQL API surface — which is nearly all these scripts touch —
has complete type definitions via Octokit. This satisfies both selection
criteria in the issue directly.

**Alternatives considered:**
- **Python** — good ecosystem, but type safety is opt-in (mypy/pyright must
  be bolted on) and there is no Actions-native equivalent of
  `@actions/toolkit`; API access would go through a third-party client or
  raw HTTP. Weaker on both criteria.
- **Deno** — native TS execution with no install step, but nonstandard in
  the Actions ecosystem and adds a second runtime to learn; the runner
  already ships Node.
- **Staying with shell + more composite actions** — solves reuse but not
  type safety or testability; the `check-reviewer-feedback` script is at the
  practical limit of maintainable shell already.

### Decision 2 — Execution: run TS from source via composite actions

**Decision:** Each activity is exposed as a **composite action** under
`.github/actions/<activity>/action.yml` whose steps are: `actions/setup-node`
(with npm cache) → `npm ci` → run the TypeScript source with
`npx --no-install tsx`. Both the `npm ci` and the run step set
`working-directory: .github/scripts` so `tsx` resolves from the package's own
`node_modules/.bin`, and `--no-install` guarantees `npx` can never fall back
to fetching `tsx` from the registry — execution always uses the
lockfile-pinned version. No compiled or bundled JavaScript is committed.

**Rationale:** The decisive constraint is that most PRs in this repo are
agent-authored and agent-reviewed. What is reviewed must be what runs. A
source-only layout keeps every diff to readable TypeScript.

**Alternatives considered:**
- **Custom JavaScript actions with checked-in `dist/`** (a `using: node`
  JavaScript action + ncc bundle — the canonical published-action pattern).
  Rejected: every
  logic change regenerates a large minified bundle that the reviewer agent
  cannot meaningfully audit; nothing inherently prevents `dist/` drifting
  from `src/` (or being maliciously divergent), so CI would need a
  rebuild-and-diff job; contributors must remember a build step. Zero
  runtime overhead is not worth this in a repo where every job already runs
  a multi-minute `docker build`.
- **`actions/github-script`** — inline JS in workflow YAML. Rejected: no
  type checking at all, code stays embedded in YAML (the thing this issue
  asks to remove), not unit-testable, not reusable across workflows.

**Accepted costs:** ~5–15 s of setup-node + `npm ci` per job (negligible
next to the Docker builds), and a runtime dependency on the npm registry —
deterministic via `package-lock.json` and softened by the setup-node cache,
but a registry outage would fail workflow runs.

`tsx` is pinned as a devDependency and is the single execution path. Node
24's native type-stripping was considered as a zero-dependency alternative
but rejected for now: keeping one explicit, versioned executor avoids
behavior drift when the runner's Node version changes.

### Decision 3 — One shared package at `.github/scripts/`

**Decision:** A single npm package holds all activity sources:

```
.github/scripts/
  package.json          # deps: @actions/core, @actions/github; dev: typescript, tsx, vitest
  package-lock.json
  tsconfig.json         # strict: true
  src/<activity>.ts     # one entry file per activity
  src/lib/*.ts          # shared helpers (label parsing, pagination, ...)
  test/*.test.ts        # vitest unit tests
.github/actions/<activity>/action.yml   # thin composite wrapper per activity
```

**Alternatives considered:** one package per action directory. Rejected:
N lockfiles, N tsconfigs, N audit surfaces; activities share helpers (label
parsing, Octokit setup) that would otherwise be duplicated — recreating in
TypeScript the duplication problem this issue exists to fix.

### Decision 4 — GitHub API access via Octokit, not the `gh` CLI

**Decision:** Activities call the GitHub API through `@actions/github`'s
Octokit client (REST and GraphQL), authenticated by a `token` action input.
They do not shell out to `gh`.

**Rationale:** Typed request/response shapes replace `--jq` string pipelines;
`octokit.paginate` replaces the `--paginate | jq -s 'add'` idiom in the
respond-review script; error handling becomes structured (status codes,
typed errors) instead of exit-code-and-regex parsing.

This is a **scoped exception** to the repo convention that GitHub API
operations go through `gh` (`.github/copilot-instructions.md`, Key
Technologies). It applies only to the workflow-executed activities in
`.github/scripts/`; in-container agent scripting (`docker/scripts/`,
`docker/reviewer/`) and shell steps that remain in workflow YAML keep using
`gh`. The convention docs are updated to record this split as part of the
scaffold task (Issue #133).

This also improves the output-injection posture required by `AGENTS.md` —
narrowly, at the `GITHUB_OUTPUT`-writing step: inside an activity, values
flow action-input → `process.env` → `core.setOutput()` with no shell
interpolation, and `@actions/core` writes `GITHUB_OUTPUT` with
delimiter-safe encoding, so the manual `tr -d '\r\n'` stripping becomes
unnecessary *within activities*. The rest of the `AGENTS.md` rule is
unchanged: shell steps that still write user-controlled values to
`GITHUB_OUTPUT` keep the CR/LF stripping, and workflows must continue to
pass untrusted values — including activity outputs — into `run:` blocks via
`env:` and `"$VAR"` references, never by `${{ ... }}` interpolation.

### Decision 5 — Activity input/output contract

**Decision:** Composite action inputs are declared in `action.yml` and passed
to the script as environment variables (`INPUT_*` or explicit `env:` mapping);
scripts read them via `@actions/core` `getInput()` and publish results with
`core.setOutput()`. Workflows consume outputs exactly as today
(`steps.<id>.outputs.<name>`), so migration does not change any consuming
expression except the step's `uses:`/`with:` block.

Skip/proceed decisions keep the current convention (`skip=true|false`,
`proceed=true|false` string outputs) so `if:` conditions in workflows are
unchanged in form.

### Decision 6 — Threshold: what moves to TypeScript, what stays shell

**Decision:** A `run:` block moves to a TypeScript activity when it contains
any of: API-response parsing (`--jq`), conditional branching, pagination, or
an error-handling policy (fail-open/fail-closed distinctions). A `run:` block
stays shell when it is a single command or a linear sequence of commands with
no parsing or branching (e.g. `docker build`, `docker run`).

Repetition alone does not force TypeScript: the repeated `docker build` +
`docker run` steps become a **composite action** (`run-agent`) in plain YAML +
shell, parameterized by image build context, `AGENT_ACTION`, and the
issue/PR/run identifiers, since there is nothing to type-check or unit-test
in them.

### Decision 7 — CI workflow

**Decision:** Add `.github/workflows/ci.yml` with `name: CI`, triggered on
`pull_request`, running in the `.github/scripts` package: `npm ci`,
`tsc --noEmit`, and `vitest run`. It runs on every PR without path filters.

**Rationale:**
- With run-from-source execution there is no compile step anywhere else —
  CI is the only gate that enforces the type safety this issue asks for.
- The extracted logic (fail-open rules, label parsing, preflight decisions)
  is exactly the branching logic unit tests pay for, and tests need CI to
  matter.
- `agent-fix-checks` already triggers on `workflow_run` for a workflow named
  `CI` that does not exist; this workflow makes that path live. Running on
  every PR (no path filter) keeps the fix-checks signal uniform — a
  path-filtered CI would leave most agent PRs with no `CI` run at all, and a
  skipped-but-reported run would surface as a confusing conclusion.
- Scope is deliberately minimal: typecheck + unit tests. actionlint,
  shellcheck, and Terraform validation are future work (see Out of scope).

### Decision 8 — Security exceptions and preserved properties

1. **`undraft-sub-issues` stays inline shell.** That job (in
   `agent-design.yml`) deliberately executes nothing from the workspace: on
   `pull_request.closed` the checkout can be post-merge HEAD, so a merged PR
   that modified a local action could route its code past
   `DEVELOPER_APP_PRIVATE_KEY`. Moving its logic into `.github/scripts/`
   would recreate exactly that path. It remains inline shell with its
   existing comment block, and this design documents it as a permanent
   exception to the migration threshold.
2. **`agent-review` keeps its base-SHA pinned checkout.** It runs on
   `pull_request_target`; activities execute from the
   `github.event.pull_request.base.sha` checkout, so PR-authored script
   changes never run with reviewer credentials. No change needed — the
   existing checkout step already guarantees this — but the constraint is
   recorded here so future edits don't loosen it.
3. **Local actions still require checkout first.** The existing convention
   (checkout with `persist-credentials: false` before any
   `./.github/actions/*` reference) is unchanged and now also applies to the
   activity actions.

### Decision 9 — Testing strategy

**Decision:** Unit tests (vitest) cover the decision logic of each activity —
model-label resolution (zero/one/many `model:*` labels), preflight skip
decisions (fork-owned branches, draft labels), and the respond-review skip
matrix (review state × body × inline comments × unresolved threads ×
API-failure fail-open paths) — with Octokit calls mocked at the module
boundary. Entry files stay thin (read inputs → call pure function → set
outputs) so the logic under test does no IO.

End-to-end behavior is validated through the real workflow path per repo
convention: a final validation task exercises each migrated workflow via its
actual trigger and compares behavior against the pre-migration baseline
(details in the task breakdown).

## Migration priority

1. **Scaffold + CI first** — everything else is gated on the package and the
   typecheck/test gate existing.
2. **`resolve-model`** — five near-identical copies; highest dedup value,
   lowest logic risk.
3. **Preflight activities** (`find-existing-pr`, `check-draft-label`) — two
   copies plus one small single.
4. **`check-reviewer-feedback`** — single copy but the most complex logic;
   highest unit-test value.
5. **Event-resolution activities** (`resolve-deployment`, fix-checks author
   filter) — small singles, migrated for consistency and testability.
6. **`run-agent` composite action** — YAML-only consolidation of the
   build/run steps; independent of the TypeScript work.

## Out of scope

- Migrating `docker/scripts/entrypoint.sh` and `docker/reviewer/entrypoint.sh`
  — container-internal scripting is a separate concern from workflow YAML and
  has its own design history.
- The `undraft-sub-issues` job (permanent security exception, Decision 8).
- actionlint / shellcheck / Terraform validation in CI — future issue.
- Branch-protection changes to make `CI` a required check — needs a human
  decision about merge gating; noted for follow-up.
- Publishing the actions for reuse outside this repository.
- Reusable workflows (`workflow_call`) — the duplication here is at step
  granularity, not job granularity; composite actions are the right unit.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#133](https://github.com/mfrancza/agentic-development-workflow/issues/133) | Scaffold `.github/scripts/` package (package.json, strict tsconfig, tsx, vitest) and add `ci.yml` (`name: CI`: `tsc --noEmit` + `vitest run` on `pull_request`); document the activity conventions and shell-vs-TS threshold in `AGENTS.md` and `README.md` | — |
| [#134](https://github.com/mfrancza/agentic-development-workflow/issues/134) | `resolve-model` activity (issue and PR variants) + composite action; migrate the five call sites in agent-design, agent-groom, agent-implement, agent-review, agent-fix-deployment | Issue #133 |
| [#135](https://github.com/mfrancza/agentic-development-workflow/issues/135) | Preflight activities: `find-existing-pr` (fork-owner filtering) and `check-draft-label` + composite actions; migrate agent-design and agent-implement call sites | Issue #133 |
| [#136](https://github.com/mfrancza/agentic-development-workflow/issues/136) | `check-reviewer-feedback` activity + composite action with full unit-test coverage of the skip matrix and fail-open paths; migrate agent-respond-review | Issue #133 |
| [#137](https://github.com/mfrancza/agentic-development-workflow/issues/137) | Event-resolution activities: `resolve-deployment` (run + issue lookup) and `filter-agent-pr` (author trust gate) + composite actions; migrate agent-fix-deployment and agent-fix-checks | Issue #133 |
| [#138](https://github.com/mfrancza/agentic-development-workflow/issues/138) | `run-agent` composite action (YAML/shell only): parameterize the docker build + docker run steps; migrate all seven workflows | — |
| [#139](https://github.com/mfrancza/agentic-development-workflow/issues/139) | End-to-end validation through the real workflow path: exercise each migrated workflow via its actual trigger (label application, review submission, synthetic check failure/deployment failure where feasible) and verify behavior matches the pre-migration baseline | Issues #134, #135, #136, #137, #138 |

Tasks #134–#137 are independent of each other once the scaffold (Issue #133)
lands and can proceed in parallel. Task #138 is pure YAML and independent of
the TypeScript scaffold. The validation task depends on all migration tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
