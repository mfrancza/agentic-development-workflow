# Design: Cross-org `secrets: inherit` fix — pass reusable-workflow secrets by name

**Issue:** [#581](https://github.com/mfrancza/agentic-development-workflow/issues/581)

## Summary

`secrets: inherit` only propagates secrets to a called reusable workflow when
the caller and the reusable live in the **same GitHub organization**. When an
external adopter in another org calls
`mfrancza/agentic-development-workflow/.github/workflows/*-reusable.yml@v0`
with `secrets: inherit`, no secrets are passed through and the reusable fails
at startup with `Secret DEVELOPER_APP_ID is required, but not provided while
calling`. This is exactly the failure the first external adopter
(`Brale-xyz/brale-ts-lib`) hit — their first push after the caller stubs
landed failed in ~4 seconds with that error (run
[35894849130](https://github.com/Brale-xyz/brale-ts-lib/actions/runs/35894849130)),
and they fixed it by naming every secret explicitly in each caller's
`secrets:` block.

Both the adoption guide (`docs/adopting.md`) and this repo's own caller stubs
(what adopters are instructed to copy, per adopting-guide step 8) use
`secrets: inherit`. Fixing the docs without fixing the stubs leaves the
published examples wrong — so the fix lands in three coordinated changes:

1. **Rewrite `docs/adopting.md`** — replace every `secrets: inherit` in the
   caller-stub examples with an explicit `secrets:` block, and rewrite the
   "Which keys do I need?" callout to document the cross-org constraint.
2. **Switch this repo's own caller stubs to explicit secrets** — 11 workflow
   files (`agent-*.yml` + `terraform-ci.yml`), each listing exactly the
   secrets declared by its reusable counterpart. In-org propagation keeps
   working either way, so this is a correctness fix for the published
   examples at zero behaviour cost.
3. **Add a static regression test** — assert that no caller stub in
   `.github/workflows/` uses `secrets: inherit` when its `uses:` target is a
   `*-reusable.yml` workflow, so the pattern cannot creep back.

## Requirements as understood

From issue #581, its grooming Q&A, the Brale-xyz run cited in the issue, and
the current state of this repo:

- **Correctness.** The adoption guide and the caller stubs must produce a
  working result for an **external** adopter following the instructions as
  written. Today they produce a startup failure for any caller in a different
  organization.
- **Audit-driven docs.** The "Which keys do I need?" callout must be
  accurate about which secrets are required vs optional for each reusable.
  The audit below is the single source of truth; the docs rewrite consumes
  it rather than re-inventing the mapping.
- **Published examples match reality.** The repo's own caller stubs are what
  adopters copy (per `docs/adopting.md` step 8: *"Add caller-stub workflow
  files — copy the relevant stubs from Reusable workflows below into
  `.github/workflows/`."*). If the stubs use `secrets: inherit`, the
  copy-paste result is wrong even after the guide is corrected. So the
  stubs are rewritten too.
- **Regression protection.** A static test in `.github/scripts/test/`
  prevents a future PR from reintroducing `secrets: inherit` on a caller
  stub without a reviewer noticing.

### Ambiguity resolutions

- **Should the repo's own caller stubs switch to explicit secrets?** Yes
  (Decision 1 below). The issue flags this as an architectural question;
  the recommendation to switch is accepted — the explicit list is both the
  correctness fix for adopters and the clearer security posture (reviewers
  see at a glance which secrets reach each reusable).
- **Should we pass the optional provider API keys by name too, or only the
  required App-identity secrets?** Pass all five by name (Decision 2). An
  adopter who sets only `ANTHROPIC_API_KEY` continues to work — the three
  provider-key `secrets.*` expressions evaluate to empty strings for
  unset secrets, which is exactly what the reusable (with
  `required: false`) and the container (which validates based on the
  resolved model) already handle. Omitting them from the stub would
  silently drop them even for callers that *do* set them.
- **Should the static test apply only to `agent-*.yml` stubs, or to every
  caller stub in `.github/workflows/`?** Every caller stub that calls a
  `*-reusable.yml` (Decision 3). `terraform-ci.yml` is explicitly named in
  the issue and must be covered; `ci.yml` / `secret-scan.yml` / the two
  test harnesses call reusables that declare no secrets at all and are
  permitted to omit the `secrets:` block entirely — but if a future edit
  adds `secrets: inherit`, the test catches it.
- **Does the test need to validate `docs/adopting.md` code blocks too?**
  No (deferred as out of scope). Parsing fenced YAML blocks inside Markdown
  is brittle, and the audit lineage keeps the docs honest for the one-time
  rewrite. If drift becomes a recurring problem, a follow-up can add an
  `rg` grep against `docs/` to the same test file.

## Reusable-workflow secrets inventory

Audit of every `.github/workflows/*-reusable.yml` file as of this design.
This is the single source of truth the adopting-guide rewrite consumes;
every explicit `secrets:` block in a caller stub must match the row for its
reusable exactly (same names, in the same order for readability).

| Reusable | Required secrets | Optional secrets |
|----------|------------------|------------------|
| `agent-auto-trigger-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | — |
| `agent-design-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `agent-fix-checks-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `agent-fix-deployment-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `agent-groom-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `agent-implement-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `agent-pr-merged-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | — |
| `agent-resolve-conflicts-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `agent-respond-review-reusable.yml` | `DEVELOPER_APP_ID`, `DEVELOPER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `agent-review-reusable.yml` | `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` |
| `ci-reusable.yml` | — | — |
| `secret-scan-reusable.yml` | — | — |
| `terraform-ci-reusable.yml` | `TERRAFORM_APP_ID`, `TERRAFORM_APP_PRIVATE_KEY`, `TF_API_TOKEN` | — |
| `test-helper-ref-reusable.yml` | — | — |

Pattern: eight developer-agent container workflows share the
`DEVELOPER_APP_ID` / `DEVELOPER_APP_PRIVATE_KEY` + three optional provider
keys shape; the reviewer workflow swaps the App pair for
`REVIEWER_APP_ID` / `REVIEWER_APP_PRIVATE_KEY`; two non-container workflows
(`agent-auto-trigger`, `agent-pr-merged`) take only the developer-agent App
pair; `terraform-ci` is the odd one with three required Terraform-specific
secrets.

## Current state of the caller stubs

Audit of every file in `.github/workflows/` that is not a `*-reusable.yml`,
grouped by what the fix needs to do to it:

| Caller stub | Calls | Current `secrets:` | Action required |
|-------------|-------|---------------------|-----------------|
| `agent-auto-trigger.yml` | `agent-auto-trigger-reusable.yml` (×6 jobs) | `inherit` | Explicit block (2 secrets) |
| `agent-design.yml` | `agent-design-reusable.yml` (×2 jobs) | `inherit` | Explicit block (5 secrets) |
| `agent-fix-checks.yml` | `agent-fix-checks-reusable.yml` | `inherit` | Explicit block (5 secrets) |
| `agent-fix-deployment.yml` | `agent-fix-deployment-reusable.yml` | `inherit` | Explicit block (5 secrets) |
| `agent-groom.yml` | `agent-groom-reusable.yml` | `inherit` | Explicit block (5 secrets) |
| `agent-implement.yml` | `agent-implement-reusable.yml` | `inherit` | Explicit block (5 secrets) |
| `agent-pr-merged.yml` | `agent-pr-merged-reusable.yml` | `inherit` | Explicit block (2 secrets) |
| `agent-resolve-conflicts.yml` | `agent-resolve-conflicts-reusable.yml` | `inherit` | Explicit block (5 secrets) |
| `agent-respond-review.yml` | `agent-respond-review-reusable.yml` | `inherit` | Explicit block (5 secrets) |
| `agent-review.yml` | `agent-review-reusable.yml` | `inherit` | Explicit block (5 secrets) |
| `terraform-ci.yml` | `terraform-ci-reusable.yml` (×2 jobs) | `inherit` | Explicit block (3 secrets) |
| `ci.yml` | `ci-reusable.yml` | *(none)* | No change — reusable has no `secrets:` |
| `secret-scan.yml` | `secret-scan-reusable.yml` | *(none)* | No change |
| `test-helper-ref.yml` | `test-helper-ref-reusable.yml` | *(none)* | No change |
| `release-images.yml` | *(no reusable)* | — | No change |
| `release.yml` | *(no reusable)* | — | No change |
| `test-action-portability.yml` | *(no reusable)* | — | No change |
| `test-reusable-portability.yml` | *(no reusable call)* | — | No change |
| `test-terraform-ci-trust-boundary.yml` | *(no reusable)* | — | No change |

11 files change; the static test (Decision 3) covers all 19 for regression.

Current state of `docs/adopting.md`:

- **16 occurrences of `secrets: inherit`** in caller-stub code blocks
  (lines 552, 622, 635, 694, 764, 830, 891, 949, 1003, 1081, 1151, 1166,
  1182, 1197, 1213, 1227).
- **One narrative mention** of `secrets: inherit` in the "Which keys do I
  need?" callout at lines 202–207, which explicitly tells adopters they
  can rely on inheritance to drop unset keys — the sentence that is
  *actively wrong* for external callers.

## Decisions

### Decision 1 — Switch this repo's own caller stubs to explicit secrets

**Decision.** Rewrite the 11 in-repo caller stubs (`agent-*.yml` and
`terraform-ci.yml`) to replace `secrets: inherit` with an explicit
`secrets:` block that names every secret declared by the called reusable
(both required and optional, per Decision 2).

**Alternatives considered.**

- **Leave repo stubs on `secrets: inherit`, fix only the docs.** Rejected.
  `docs/adopting.md` step 8 instructs adopters to copy the stubs from
  `.github/workflows/`. If the stubs use `inherit` and the docs show
  explicit, adopters have two conflicting sources of truth and will often
  defer to the "real" file over the docs. The adopter who reported this
  issue hit exactly that failure mode. Fixing one without the other
  leaves the published surface broken.
- **Delete the repo's own caller stubs and keep only `*-reusable.yml`.**
  Rejected. The stubs are what this repo *uses* to run its own agents;
  removing them would stop the agents.
- **Keep repo stubs on `inherit` and add a prominent "do not copy
  verbatim" banner.** Rejected. Documentation banners age poorly, and
  the explicit-secrets form is strictly clearer: a reviewer looking at
  the stub can see the full secret surface without opening a second file.

**Trade-off accepted.** Adding or removing a reusable secret declaration
now requires a coordinated edit in each caller stub, where `inherit`
required none. The static test (Decision 3) catches `inherit` regressions
but does not catch stale explicit lists; the mitigation is that
`required: true` secrets fail the workflow loudly at startup if they are
omitted, and the audit table in this doc is the reference reviewers use
when adding a new secret.

### Decision 2 — Pass all declared secrets by name, including optional provider keys

**Decision.** Each explicit `secrets:` block names every secret the
reusable declares — both `required: true` and `required: false`. The
pattern for a developer-agent container stub is:

```yaml
secrets:
  DEVELOPER_APP_ID:          ${{ secrets.DEVELOPER_APP_ID }}
  DEVELOPER_APP_PRIVATE_KEY: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}
  ANTHROPIC_API_KEY:         ${{ secrets.ANTHROPIC_API_KEY }}
  OPENAI_API_KEY:            ${{ secrets.OPENAI_API_KEY }}
  XAI_API_KEY:               ${{ secrets.XAI_API_KEY }}
```

An adopter who sets only `ANTHROPIC_API_KEY` keeps working: GitHub
Actions evaluates `${{ secrets.OPENAI_API_KEY }}` to an empty string
when the secret is unset, the reusable sees the optional secret as
empty, and the container's model-aware validation accepts the empty
value since the resolved model does not need it.

**Alternatives considered.**

- **Pass only required secrets; omit optional ones from the stub.**
  Rejected. Omitting `ANTHROPIC_API_KEY` from the stub silently drops it
  even for an adopter who has set the secret — exactly the kind of
  silent-fallback failure mode this repo avoids elsewhere
  (fail-loud-on-ambiguous-input principle). The adopter would be
  mystified: the key is set, the stub was copied as-is, and the
  container still errors out at runtime.
- **Pass all five provider keys conditionally with
  `if: secrets.FOO != ''` guards at the caller.** Rejected. Not
  supported by the GitHub Actions `secrets:` grammar; secrets are a
  flat key-value map at the `uses:` level, with no per-key `if:`.
- **Introduce a "profile" input (e.g. `providers: ['anthropic']`) and
  select secrets dynamically inside the reusable.** Rejected as
  significantly out-of-scope for a bug fix. The current empty-string
  fallthrough already achieves the same result with zero API surface
  change.

### Decision 3 — Static regression test covers every caller stub, not just `agent-*`

**Decision.** Add a vitest file under `.github/scripts/test/` (name:
`caller-stub-secrets-inherit.test.ts`, following the existing
`workflow-concurrency.test.ts` pattern) that:

1. Enumerates every `.yml` file in `.github/workflows/` that is **not** a
   `*-reusable.yml` (same filter as `workflow-concurrency.test.ts`, but
   not restricted to the `agent-*` prefix — see rationale below).
2. For each file, finds every `uses:` line pointing at a
   `*-reusable.yml` (local or remote reference).
3. Fails if the surrounding job declares `secrets: inherit`.

The test does **not** attempt to validate that each explicit `secrets:`
block names the correct keys for its reusable — that is a different
contract (completeness vs. anti-pattern avoidance) and would require a
YAML parser plus the reusable-secret inventory above. The runtime check
(a missing required secret fails the workflow loudly) is the backstop
for that contract.

**Alternatives considered.**

- **Restrict the test to `agent-*.yml` stubs.** Rejected. `terraform-ci.yml`
  is explicitly named in the issue, and future reusables may ship under
  other prefixes. The broader filter is the same cost and catches
  everything.
- **Also validate `docs/adopting.md` code blocks.** Deferred (listed in
  Out of scope). Parsing fenced YAML blocks inside Markdown is brittle;
  the one-time rewrite is sufficient. If drift becomes a recurring
  problem, follow-up with a dedicated test.
- **Replace the test with an actionlint custom rule.** Rejected.
  actionlint has no built-in `secrets: inherit` warning for cross-org
  callers (the pattern is valid in-org), and this repo already uses
  vitest for static-inventory checks of workflow files — matching the
  convention is cheaper than adding a new linter.

### Decision 4 — "Which keys do I need?" callout rewrite

**Decision.** Replace the current callout (adopting.md lines 202–207)
with text that:

1. States up front that the reusable workflows live in the
   `mfrancza` organization, so cross-org callers must pass each secret
   by name — `secrets: inherit` propagates nothing across org
   boundaries.
2. Points at the explicit `secrets:` block shape (Decision 2) as the
   contract to copy.
3. Keeps the user-facing guidance about which provider keys are
   actually needed: an adopter who only runs Anthropic models can leave
   `OPENAI_API_KEY` and `XAI_API_KEY` unset in their repo. The explicit
   `secrets:` block still names those keys, but
   `${{ secrets.OPENAI_API_KEY }}` evaluates to an empty string and the
   reusable (declaring them `required: false`) accepts the empty value
   silently; the container's model-aware validation errors loudly only
   if the resolved model actually needs the missing key.
4. Links to the audit table in each reusable's section of the guide so
   adopters can confirm the required/optional split at a glance.

The exact wording is left to the implementer, who writes it against the
audit table in this document.

**Alternatives considered.**

- **Keep the callout minimal ("pass secrets by name"), rely on the
  per-reusable section to document the shape.** Rejected. Cross-org
  behaviour is non-obvious enough that it earns a dedicated callout; a
  footnote in each section would scatter the explanation.
- **Add an org-detection step to each caller stub that fails loudly
  with a cross-org warning if `secrets: inherit` is used.** Rejected as
  out of scope. The static test (Decision 3) prevents the pattern from
  entering this repo; adopters catching it in their own repos is a
  user-facing docs problem, not a workflow-logic problem.

## Out of scope

- **Validating `docs/adopting.md` code blocks via the static test.** The
  one-time rewrite is sufficient; a Markdown-code-block linter is future
  work only if drift reappears.
- **Changing the reusable workflows themselves.** Required/optional
  declarations are correct and unchanged. The fix touches callers and
  docs, not reusables.
- **Changing the `terraform-ci-reusable.yml` adoption story.** It
  remains consumer-only (see the gotcha at `docs/adopting.md` line
  1618). Switching `terraform-ci.yml` (the repo-owned caller) to
  explicit secrets is still in scope — the issue names the file
  explicitly, and the regression test must cover it to prevent future
  drift.
- **Adopting a per-component "profile" or "preset" mechanism** that
  would let a stub declare `providers: [anthropic]` and have the
  reusable select secrets accordingly. The empty-string pass-through
  achieves the same effect with zero API-surface change (Decision 2
  rationale).
- **Updating `agents/grooming/label-criteria.json` or AGENTS.md** —
  this change does not alter triggers, labels, env vars, or the
  `AGENT_ACTION` matrix; the Shell/Workflow activity conventions
  sections stay untouched.
- **Automatic smoke-testing from a cross-org consumer repo.** Covered by
  Issue [#455](https://github.com/mfrancza/agentic-development-workflow/issues/455)
  (adoption smoke test), which this design does not duplicate. The e2e
  validation task below is scoped narrower (in-repo workflow still fires
  after the stub rewrite, test passes, docs match the stubs).
- **Release-notes update for the v0 → v0.0.1 (or next) tag.** The
  release-notes/gotchas update is covered by Issue
  [#456](https://github.com/mfrancza/agentic-development-workflow/issues/456);
  this design does not re-scope that task. The e2e validation task below
  posts a comment on #455 and #456 so the smoke test and gotchas-fold
  pick up the fixed guide.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| [#590](https://github.com/mfrancza/agentic-development-workflow/issues/590) | Rewrite `docs/adopting.md`: replace every `secrets: inherit` in the caller-stub code blocks (16 occurrences, line numbers listed in this design under *Current state of the caller stubs*) with an explicit `secrets:` block matching the reusable's declaration (per the audit table in this design). Rewrite the "Which keys do I need?" callout (lines 202–207) per Decision 4. Verify each explicit block against the audit table before committing. | — |
| [#591](https://github.com/mfrancza/agentic-development-workflow/issues/591) | Switch this repo's own caller stubs (`.github/workflows/`: `agent-auto-trigger.yml`, `agent-design.yml`, `agent-fix-checks.yml`, `agent-fix-deployment.yml`, `agent-groom.yml`, `agent-implement.yml`, `agent-pr-merged.yml`, `agent-resolve-conflicts.yml`, `agent-respond-review.yml`, `agent-review.yml`, `terraform-ci.yml` — 11 files) from `secrets: inherit` to explicit `secrets:` blocks naming every secret the reusable declares (per Decision 2 and the audit table in this design). Leave `ci.yml`, `secret-scan.yml`, `test-helper-ref.yml`, and the non-reusable-calling workflows unchanged. | — |
| [#592](https://github.com/mfrancza/agentic-development-workflow/issues/592) | Add `.github/scripts/test/caller-stub-secrets-inherit.test.ts` following the pattern of `workflow-concurrency.test.ts`. The test enumerates every non-`*-reusable.yml` file in `.github/workflows/`, finds `uses:` lines targeting a `*-reusable.yml`, and fails if the surrounding job declares `secrets: inherit`. See Decision 3 for the exact scope. | Issue #591 (test asserts the invariant #591 establishes; landing the test first would fail CI on main) |
| [#593](https://github.com/mfrancza/agentic-development-workflow/issues/593) | End-to-end validation: (a) confirm the explicit `secrets:` block in every rewritten caller stub names every secret listed in the audit table (no typos, no missing/extra keys); (b) trigger one agent run against this repo (e.g. apply `agent:groom` to a test issue) to confirm the explicit-secrets wiring still mints a token and the agent runs — in-repo propagation is unaffected by the change but is worth proving once; (c) confirm the new vitest file passes locally and in CI; (d) post a comment on Issue #455 (adoption smoke test) and Issue #456 (release-notes/gotchas update) noting that the fix has landed and the smoke test should re-run against the updated guide. | Issues #590, #591, #592 |

Issues #590 and #591 modify disjoint file trees (`docs/` vs.
`.github/workflows/`) and can proceed in parallel. Issue #592 depends on
#591 because the regression test asserts the invariant #591 establishes;
shipping the test first would make its PR fail against `main`.
Issue #593 is the final validation and depends on all implementation
tasks.
