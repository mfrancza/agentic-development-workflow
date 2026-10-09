# Design: Configurable developer author for conflict discovery

**Issue:** [#580](https://github.com/mfrancza/agentic-development-workflow/issues/580)

## Summary

The push-to-`main` conflict-resolution path currently searches only for pull
requests authored by `app/mfrancza-developer-agent`. That identity is the
default on the `find-conflicted-prs` composite action, but
`agent-resolve-conflicts-reusable.yml` neither exposes nor passes the action's
`author` input. External adopters therefore get a successful finder job with an
empty matrix instead of conflict resolution for their own developer App's PRs.

The reusable workflow will expose an optional `developer-author` string input,
defaulting to `app/mfrancza-developer-agent` for backward compatibility, and
pass it unchanged to the finder's existing `author` input. External caller
stubs will set it explicitly to `app/<developer-app-slug>`. Documentation and a
static workflow-contract test will make the new configuration discoverable and
prevent the pass-through from being removed.

## Requirements as understood

Issue #580 and its grooming notes require the following:

- Restore automatic conflict discovery for external adopters whose developer
  App has a repository-specific slug. The concrete runtime failure is
  [Brale-xyz/brale-ts-lib run 35908416433](https://github.com/Brale-xyz/brale-ts-lib/actions/runs/35908416433):
  after a push to `main`, the finder reported `No open developer-agent PRs
  found.`, skipped the resolve matrix, and left PRs #43 and #47 conflicted.
  This is runtime evidence for changing the otherwise passing workflow, as
  required by `AGENTS.md`.
- Preserve `workflow_dispatch` with `pr_number` as a direct, author-independent
  backstop. The new input affects enumeration only; the finder's existing
  direct-PR branch remains unchanged.
- Choose one source of truth for the developer identity: an explicit reusable
  input or derivation from an App token.
- Keep existing consumers compatible. A caller that omits the new input must
  retain this repository's current `app/mfrancza-developer-agent` behavior.
- Correct `docs/adopting.md`: `AGENT_ALLOWLIST` controls which actors may
  trigger applicable agent workflows; it does not identify PR authors for the
  conflict finder. The conflict-resolution caller example must show the actual
  author configuration.
- Add regression coverage in `.github/scripts/test/` for the public input and
  its pass-through to the composite action. Existing unit coverage already
  proves that `find-conflicted-prs.ts` inserts the supplied author into the
  GitHub search query, so its implementation does not need redesign.
- Consider whether Issue #455's external-adoption smoke test should expand.
  This design treats a focused static contract test as the required regression
  and leaves a live cross-repository conflict fixture out of scope because it
  would require durable external App credentials, repositories, and deliberate
  conflicts.

### Ambiguity resolutions

- **Input name and value form.** Use `developer-author`, matching the reusable's
  kebab-case input convention and describing the value's role rather than a
  particular authentication mechanism. Its value is GitHub's search qualifier
  form, `app/<app-slug>`, because that is what the existing action accepts.
- **Whether this repository's caller must pass the input.** It need not. The
  compatibility default intentionally preserves the current local caller
  unchanged. External examples pass it explicitly because their identity cannot
  be inferred from this repository's default.
- **Validation.** Do not add a restrictive slug regex. GitHub's search API is
  authoritative for accepted `author:` qualifiers, and the workflow input is
  repository-controlled configuration rather than untrusted event text. Empty
  or invalid values naturally produce no matches; the input description and
  caller example provide the supported `app/<slug>` form.

## Current data flow and proposed contract

Today the reusable omits the final edge:

```text
reusable workflow (no identity input)
  -> find-conflicted-prs action
     -> default author: app/mfrancza-developer-agent
        -> TypeScript GitHub search query
```

The proposed flow is:

```text
caller developer-author (or compatibility default)
  -> reusable inputs.developer-author
     -> action author
        -> INPUT_AUTHOR
           -> TypeScript GitHub search query
```

No App token enters this discovery path. The finder continues to use the
workflow `GITHUB_TOKEN` with `pull-requests: read`; the developer App token is
minted later and only in matrix jobs that actually resolve a conflict.

## Decisions

### Decision 1 — Use an explicit reusable input, not runtime token derivation

**Decision.** Add optional string input `developer-author` to
`agent-resolve-conflicts-reusable.yml` and pass
`${{ inputs.developer-author }}` to the finder's `author` input.

**Alternatives considered.**

- **Derive the App slug from a developer installation token.** Rejected. The
  finder currently needs only the read-only workflow token. Derivation would
  require minting a higher-privilege developer token in the finder job, moving
  the App private key into a job that does not otherwise need it, and adding an
  API call and failure mode before enumeration. It would also couple PR author
  selection to whichever credentials happen to be supplied rather than to an
  inspectable workflow contract.
- **Read the identity from `AGENT_ALLOWLIST`.** Rejected. The variable is a JSON
  set of trusted trigger actors, can contain multiple humans and bots, and is
  not a unique developer-PR identity. Reusing it would preserve the conceptual
  error in the current adoption guide.
- **Change the composite action's default globally.** Rejected. No universal
  external App slug exists, and the action already has the necessary parameter.

The explicit input keeps least privilege intact and makes the external caller's
identity choice visible in review.

### Decision 2 — Retain the current identity as a compatibility default

**Decision.** Define `developer-author` as optional with default
`app/mfrancza-developer-agent`. Leave `.github/workflows/agent-resolve-conflicts.yml`
unchanged; it inherits that value.

**Alternatives considered.**

- **Make the input required.** Rejected because it would break every existing
  caller at reusable-workflow validation time, including this repository's
  caller, even though existing in-repository behavior is correct.
- **Use an empty default and fail loudly.** Rejected for the same compatibility
  reason. The action's current default already defines established behavior.
- **Also pass the value explicitly from the local caller.** Valid but redundant.
  Keeping one compatibility default in the reusable/action boundary minimizes
  churn while external examples demonstrate explicit configuration.

The action's matching default remains in place so direct action consumers are
also backward compatible. The reusable owns its public default and passes it
explicitly, preventing accidental reliance on a nested action default.

### Decision 3 — Test the workflow contract statically and retain existing unit tests

**Decision.** Add a focused Vitest static test that reads
`agent-resolve-conflicts-reusable.yml` and asserts all three contract points:
the `developer-author` workflow-call input exists, its default is the current
App author, and the finder step passes `${{ inputs.developer-author }}` as
`author`. Keep the existing behavioral unit test that verifies a supplied
author appears in the search query.

**Alternatives considered.**

- **Only test `find-conflicted-prs.ts`.** Rejected because it already works;
  the defect is the missing YAML wiring, which a TypeScript unit test cannot
  catch.
- **Parse the workflow with a new YAML dependency.** Rejected. A small,
  narrowly scoped textual contract follows the repository's existing static
  inventory-test pattern and avoids expanding the dependency surface.
- **Add a live external-repository smoke test now.** Deferred. Such a test would
  need external App installation credentials and a reliably conflicted PR,
  making it stateful and costly. The static pass-through test covers the exact
  regression while the adopter can validate the released reusable in its
  normal environment.

### Decision 4 — Document identity separately from trigger authorization

**Decision.** In `docs/adopting.md`, remove `AGENT_ALLOWLIST` from the
resolve-conflicts prerequisites unless needed for some separate caller gate,
explain that `developer-author` is the GitHub search author in
`app/<developer-app-slug>` form, and add it to the external caller stub.

**Alternatives considered.**

- **Keep the allowlist statement and say it is indirectly related.** Rejected;
  it is factually false for this workflow's push and manual triggers and sends
  operators to the wrong configuration surface.
- **Document token derivation instead.** Rejected with Decision 1.

The guide should also state that manual `pr-number` dispatch bypasses author
enumeration, preserving the existing recovery path.

## Implementation boundaries

The workflow implementation task changes only the reusable workflow and its
static regression test. No changes are expected in
`.github/actions/find-conflicted-prs/action.yml` or
`.github/scripts/src/find-conflicted-prs.ts`: both already accept and propagate
an author. The documentation task changes only the resolve-conflicts section of
`docs/adopting.md`. These tasks can proceed independently against the contract
defined here.

## Out of scope

- Automatically deriving App identity from `DEVELOPER_APP_ID`, an installation
  token, `AGENT_ALLOWLIST`, repository variables, or API metadata.
- Changing developer App permissions, token minting, agent identities, branch
  protection, workflow triggers, or the resolve-conflicts container behavior.
- Resolving conflicts on human-authored PRs or supporting multiple developer
  App authors in one enumeration run. The input intentionally selects one
  GitHub search author.
- Redesigning the finder action or its TypeScript mergeability polling.
- Building a persistent cross-repository conflict fixture for Issue #455.
- Removing the `workflow_dispatch` manual backstop.
- Updating `AGENTS.md` or `README.md`; the operator-facing configuration lives
  in the reusable contract and `docs/adopting.md`.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|------------|
| [#605](https://github.com/mfrancza/agentic-development-workflow/issues/605) | Add the `developer-author` reusable input, pass it to the finder action, and add a static workflow-contract regression test | — |
| [#606](https://github.com/mfrancza/agentic-development-workflow/issues/606) | Correct the resolve-conflicts prerequisites and caller stub in `docs/adopting.md` | — |
| [#607](https://github.com/mfrancza/agentic-development-workflow/issues/607) | End-to-end validation: run focused tests and validate both explicit external-author enumeration and backward-compatible default behavior | Issue #605, Issue #606 |

The workflow and documentation tasks are independent. The validation task
depends on both so it exercises the final public contract and documentation as
one adopter-facing unit. Dependencies will be recorded as native GitHub
blocked-by relationships.
