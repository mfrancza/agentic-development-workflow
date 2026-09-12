# Design: Prevent recurrence of the `github.job_workflow_sha` linter-false-positive incident

**Issue:** [#526](https://github.com/mfrancza/agentic-development-workflow/issues/526)
**Parent designs (both amended by this document):**

- [docs/design/reusable-workflow-helper-resolution.md](reusable-workflow-helper-resolution.md) (Issue [#498](https://github.com/mfrancza/agentic-development-workflow/issues/498)) — established the self-checkout pattern; used `github.job_workflow_sha`, which was later found to resolve empty.
- [docs/design/helper-checkout-job-workflow-sha-context.md](helper-checkout-job-workflow-sha-context.md) (Issue [#513](https://github.com/mfrancza/agentic-development-workflow/issues/513)) — revised design (not retracted); its initial proposal to use `job.workflow_sha` was wrong, but runtime evidence confirmed that `github.job_workflow_sha` also resolved empty in practice. The revised design (Issue #513, updated) replaces both with the explicit `helpers-ref` input.

**Related:** #522 (revert), #523 (revert), #524 (revert), #525 (revert), #527 (the revert-cascade PR that restored the working state), #508 (where the actionlint false-positive was originally noted in-prose but not acted on), #538 (corrects this incident record).

> **Correction note (Issue [#538](https://github.com/mfrancza/agentic-development-workflow/issues/538)):**
> This document originally stated that `github.job_workflow_sha` is the correct expression and the
> actionlint diagnostic a false positive. That conclusion was based on run 34178131104 succeeding —
> but a successful step conclusion is not evidence of the resolved ref.
>
> Runtime evidence from agent-groom run
> [34303371563](https://github.com/mfrancza/agentic-development-workflow/actions/runs/34303371563)
> shows that `github.job_workflow_sha` **parsed but evaluated to an empty value**: the checkout
> input dump omitted `ref` entirely, and `actions/checkout` fell back to `main` rather than
> detaching at the intended SHA. Actionlint's diagnostic was accidentally correct — the expression
> had a real problem that a green step masked.
>
> `job.workflow_sha` remains an invalid property of the `job` context (confirmed by the parse-time
> failures in #522–#525). The correct replacement is the explicit required `helpers-ref` input;
> see [`docs/design/helper-checkout-job-workflow-sha-context.md`](helper-checkout-job-workflow-sha-context.md)
> (Issue #513, revised design) for the full design and `AGENTS.md` § "Known traps" for the
> authoritative gotcha entry. The body of this document is preserved unchanged as a historical
> record; read it in light of this correction.

## Summary

On 2026-09-09 02:14–02:20Z the entire agent fleet went down for six minutes
because the design + implementation chain took an actionlint false-positive
report as ground truth and replaced the **correct, GitHub-documented**
`github.job_workflow_sha` context with a nonexistent `job.workflow_sha`
property across every reusable workflow. Unknown context properties are a
parse-time invalidation, so every push/issues event produced a
zero-job failure run, auto-trigger stopped applying labels, and the fleet
stalled. The chain then hardened the mistake in three subsequent PRs
(#523 lint ban, #524 runtime guard, #525 regression test) — every one of
them premised on the same false positive, and every one of them shipped
with green CI because the failure only manifests at event dispatch time.
PR #527 reverted all four PRs and restored the working state.

This design covers the **preventive follow-ups** requested in issue #526.
The incident itself is already resolved. The follow-ups are:

1. **Document the trap durably** in `AGENTS.md` so a future agent (or human)
   inspecting the self-checkout pattern reads the counter-argument before
   they act on a linter warning.
2. **Guard the trap in configuration.** Ship a pre-emptive
   `.github/actionlint.yaml` that ignores the specific undefined-context
   diagnostic for `github.job_workflow_sha`, so any local or future-CI
   actionlint run does not resurface the false positive.
3. **Codify the runtime-evidence rule** for grooming, design, and review:
   a proposed "fix" that would change code with a passing live-run history
   must produce runtime evidence of the failure it claims to fix — a
   linter warning alone is not sufficient grounds.
4. **Retract the misleading design doc** (`helper-checkout-job-workflow-sha-context.md`)
   and add an inline correction note to the parent design
   (`reusable-workflow-helper-resolution.md`) so future readers who follow
   the chain of design links land on the correct explanation rather than
   the false-positive-driven successor.

## Requirements as understood

Restated from issue #526 and its
[grooming Q&A](https://github.com/mfrancza/agentic-development-workflow/issues/526#issuecomment-grooming):

- **The correct expression is `github.job_workflow_sha`.** GitHub's
  contexts documentation defines this property on the `github` context for
  reusable-workflow runs. `job.workflow_sha` is not a property of the `job`
  context — the `job` context exposes only `container`, `services`, and
  `status`. The evidence that `github.job_workflow_sha` works at runtime is
  run 34178131104, which successfully resolved the helper checkout before
  failing on an unrelated step.
- **actionlint's schema is outdated** and flags `github.job_workflow_sha`
  as an undefined property. This false positive was noted in PR #508's
  description but not acted on — until the four-PR cascade took it as
  actionable and shipped the change.
- **The follow-ups are preventive, not corrective.** The revert (#527)
  already fixed the immediate breakage. This design only implements the
  three preventive follow-ups the issue's grooming Q&A itemises.
- **Every touchpoint that mentions the trap must point to the same
  authoritative note.** Duplicating the explanation invites drift; the
  gotcha lives in one place (`AGENTS.md`) and every design doc, prompt, or
  workflow comment that touches this territory links there.
- **The failing PRs are the ground truth for what to defend against.** The
  four reverted PRs — a code change, a lint ban, a runtime guard, and a
  regression test, each layered on the previous — show that the review
  loop cannot be trusted to catch this class of error once the initial
  false premise is accepted. The defence must therefore include both a
  configuration guard (that the linter itself will not raise the false
  positive) and a documentation guard (that a human or agent reading the
  code sees the counter-argument).

### Ambiguity resolutions

1. **Where does the AGENTS.md gotcha live?** Two candidate homes exist:
   inline in the existing "Reusable workflows: self-checkout for helper
   actions" subsection (where the expression is already used), or a new
   top-level "Known traps" section. This design picks **both**: the
   authoritative content lives in a new `## Known traps` section at the
   bottom of `AGENTS.md`, and the existing self-checkout subsection gains
   a one-line cross-reference. See Decision 1.
2. **Should the pre-emptive actionlint config ship even though actionlint
   is not in CI?** Yes. Agents run `actionlint` locally during
   `fix-checks` and `respond-review` work, and the container image ships
   with the CLI. A repo-standard config that the CLI picks up
   automatically is the cheapest guard against a future agent (or CI
   pipeline) taking the false positive seriously. See Decision 2.
3. **Where does the runtime-evidence principle live?** The
   `Code Review Standards` section of `AGENTS.md` is the canonical home
   for reviewer-facing rubrics — both the reviewer agent's prompt and
   humans read it. Adding a new bullet under
   "Every review evaluates the PR against these dimensions" (Correctness
   subsection) plus a short standalone subsection with the incident
   citation is the right shape. The `groom.md` and `design.md` prompts
   pick it up transitively through their existing "read AGENTS.md"
   instructions; no new prompt content is needed beyond a targeted
   pointer. See Decision 3.
4. **Should `helper-checkout-job-workflow-sha-context.md` be deleted or
   retracted-in-place?** Retracted in place. Deletion loses the historical
   record of what went wrong; a **RETRACTED** banner at the top plus a
   pointer to this design doc preserves the trail without misleading
   future readers who follow inbound links (e.g. from #513 or PR #521).
   See Decision 4.

## Decisions

### Decision 1 — New `## Known traps` section in `AGENTS.md`

**Decision.** Add a new top-level section `## Known traps` to `AGENTS.md`,
positioned just before `## Adding a New Agent Action`. Its first (and
currently only) entry is the `github.job_workflow_sha` false positive.
The section is structured so future traps (e.g. the action-metadata
template-expression trap already documented in `ci-reusable.yml`
comments, the empty-expression trap referenced in issue #526) can be
appended without restructuring.

The entry states, at minimum:

- The **correct** context: `github.job_workflow_sha` on the `github`
  context, populated by GitHub for reusable-workflow runs to the SHA the
  caller's `@<ref>` resolved to.
- The **wrong** alternative: `job.workflow_sha` does not exist on the
  `job` context. Using it makes the resulting expression evaluate to an
  empty string, which in the specific case of a workflow file (not just
  a step-level expression) invalidates the file at parse time and yields
  a zero-job failure run with the file path shown in place of the
  workflow name.
- The **false positive**: actionlint's context schema is outdated and
  reports `github.job_workflow_sha` as undefined. Do not "fix" it. The
  fix is to keep the correct expression and rely on the pre-emptive
  actionlint ignore (Decision 2) or on the runtime-evidence rule
  (Decision 3) when the linter is not in scope.
- The **incident anchor**: a one-line citation of this design doc and
  Issue #526 so a reader who lands on the gotcha via grep can pull the
  full history if they need it.

The existing "Reusable workflows: self-checkout for helper actions"
subsection gains a one-line cross-reference to `## Known traps` — placed
next to the `${{ github.job_workflow_sha }}` line in the code block's
prose surround, not inside the code block — so an agent editing the
self-checkout code encounters the counter-argument at the point of use.

**Alternatives considered.**

- **Inline the gotcha in the existing self-checkout subsection only.**
  Rejected. The gotcha's audience is broader than the one subsection —
  any future actionlint diagnostic in this territory, and any prompt or
  design doc that references the context expression, needs a single
  authoritative target to link to. A dedicated section is that target.
- **Add the gotcha to `docs/design/reusable-workflow-helper-resolution.md`.**
  Rejected as the primary home. Design docs describe intent at a moment
  in time; a running "traps" list belongs in the always-read conventions
  file (`AGENTS.md`). The design doc is amended in place (Decision 4) to
  point at the gotcha.
- **Put the trap in the `design.md` and `groom.md` prompts.** Rejected.
  Duplicating the explanation across two prompts + AGENTS.md is exactly
  the "one fact per line" merge-hazard the merge-friendly-documentation
  section already warns against. Prompts pick up the gotcha
  transitively via their existing AGENTS.md read.

### Decision 2 — Ship `.github/actionlint.yaml` with a pre-emptive ignore

**Decision.** Add a repo-root `.github/actionlint.yaml` file (actionlint's
default config location, auto-loaded by the CLI without any flags) that
ignores the specific undefined-context error for
`github.job_workflow_sha`:

```yaml
# See docs/design/job-workflow-sha-linter-trap.md and AGENTS.md § Known traps.
# GitHub's contexts documentation defines job_workflow_sha on the github
# context for reusable-workflow runs. actionlint's bundled schema does not
# yet know about it and reports it as undefined; this is a known false
# positive. Do NOT "fix" the code by removing or renaming the expression —
# see the incident history in issue #526.
self-hosted-runner:
  # (default; kept explicit so this file is grep-able as an actionlint config)
  labels: []
paths:
  ".github/workflows/**/*.yml":
    ignore:
      - 'property "job_workflow_sha" is not defined in object type'
      - 'undefined variable "job_workflow_sha"'
```

Both ignore patterns are included because actionlint's exact error wording
for undefined context properties has varied across versions (the first form
is current; the second is the older phrasing). Matching both makes the
ignore version-tolerant.

The file is deliberately minimal: it only records the one ignore plus a
prominent comment. No other actionlint policy is set — this is purely a
guard, not a lint-configuration exercise.

**Why ship the config even though actionlint is not in CI.** The
developer container image already includes the `actionlint` CLI (see the
[refactor-github-actions.md](refactor-github-actions.md) discussion of
lint plans), and agents doing `fix-checks` or `respond-review` work on a
reusable-workflow PR routinely run `actionlint` locally to check their
changes. Without a repo-standard config, every agent sees the false
positive fresh and is tempted to act on it. The config file is a
one-time cost that closes the temptation loop for good.

**Alternatives considered.**

- **Prose-only "do not run actionlint against this expression"
  guidance in AGENTS.md.** Rejected on its own — the trap is that
  actionlint output is convincing exactly because it looks like ground
  truth. A prose warning is easy to overlook when the tool output is
  right in front of you. Prose plus config is stronger than either
  alone, so this design does both.
- **Wait until actionlint is proposed for CI (a future issue) before
  adding the config.** Rejected. The incident already happened without
  actionlint being in CI — a single ad-hoc local run was enough to
  convince the chain. Waiting to add the config only delays the
  configuration guard for no benefit.
- **Vendor an updated actionlint schema.** Rejected as over-engineering.
  actionlint's schema is bundled in the binary; overriding it requires
  building a custom binary. The upstream project accepts PRs for
  missing context properties, and issue #526's follow-ups do not depend
  on that upstream work landing.
- **Fork actionlint and cut a private release.** Rejected. Owning a
  fork of a widely-used tool for a single-property patch is a
  maintenance burden that dwarfs the benefit.

### Decision 3 — Codify the runtime-evidence rule in `AGENTS.md` Code Review Standards

**Decision.** Add a new bullet under `AGENTS.md` §
"Code Review Standards" → "Every review evaluates the PR against these
dimensions" → **Correctness** (or as a new sibling dimension if it does
not fit cleanly), and a short standalone subsection titled
"Reverting or replacing code with a passing live-run history" under
"Repo-specific security defaults", stating the rule:

> A proposed change that would replace, revert, or "fix" code that has a
> **passing live-run history** must be accompanied by **runtime evidence
> of the failure it claims to fix** — a linter warning, a static type
> error, a code-review preference, or a schema-based guess is not
> sufficient grounds on its own. Cite a failed workflow run, a
> reproducible local failure, or a documented breaking change from an
> upstream dependency. If the only evidence is a linter or schema
> warning, treat it as a hypothesis until it produces a runtime failure —
> the linter may be wrong (see `## Known traps`).

The rule applies to all three review-adjacent activities:

- **Grooming** — the groomer applies `bug`/`enhancement` labels based on
  problem statements; a bug report whose only evidence is a linter
  warning against currently-working code should be groomed as a
  hypothesis (or `question`) rather than accepted as a bug.
- **Design** — the designer's prompt already directs the agent to read
  `AGENTS.md`; the new rule is picked up transitively. A design that
  proposes to change working code needs a runtime-failure citation in its
  requirements section.
- **Review** — the reviewer agent's prompt links to the
  Code Review Standards section; adding the rule there makes it a
  first-class review dimension.

The `groom.md` and `design.md` prompts each gain one short pointer
sentence (of the form "see AGENTS.md § 'Reverting or replacing code with
a passing live-run history' before recommending a change to a workflow
file or a workflow expression that has a passing run in the history") so
an agent skimming its prompt at the top of a run sees the pointer.
The prompt content is deliberately a **pointer, not a copy** — the
merge-friendly-docs rule (one fact per line, no duplication) applies.

**Alternatives considered.**

- **New freestanding process doc under `docs/`.** Rejected. AGENTS.md
  is already the omnibus conventions file and its "Code Review Standards"
  section already carries this shape of content (reviewer rubrics that
  apply to both humans and agents). A new doc splits the audience.
- **Update the `code-review-agent.md` design doc instead of AGENTS.md.**
  Rejected. That design doc records the *creation* of the reviewer
  agent; ongoing review rubrics belong in AGENTS.md (which the design
  itself directs the reviewer to read).
- **Add the rule as a hook or an actionable check.** Rejected as
  premature. The rule is a judgement principle, not something a script
  can enforce reliably (deciding "did this code have a passing live-run
  history" requires reading the git history and matching against
  affected workflow runs). Once a mechanical shape emerges, a future
  design can layer enforcement on top of the principle.

### Decision 4 — Retract `helper-checkout-job-workflow-sha-context.md`; amend `reusable-workflow-helper-resolution.md`

**Decision.** The retracted design and the parent design are updated
in place:

- **`docs/design/helper-checkout-job-workflow-sha-context.md`** gains a
  **RETRACTED** banner at the very top (before the front-matter) with:
  - a one-sentence retraction ("This design was premised on a false
    positive from actionlint; every PR it spawned (#522–#525) was
    reverted in #527. See docs/design/job-workflow-sha-linter-trap.md
    (Issue #526) for the postmortem and follow-ups.");
  - a "do not follow the recommendations in this document" instruction;
  - the original content preserved unchanged below the banner so
    incoming links continue to resolve and the historical record is
    intact.
- **`docs/design/reusable-workflow-helper-resolution.md`** gains a short
  **Correction note** at the top (immediately after the front-matter,
  before the Summary section) pointing out that Issue #513's amendment
  proposal was later reverted (#527) and that `github.job_workflow_sha`
  as originally written in that design is the correct expression. The
  correction cites Issue #526 and this design doc. No other content in
  the doc is changed — its original decisions (subdirectory naming,
  audit inventory, self-checkout pattern, security posture) were and
  remain correct.

**Rationale.** The retracted design is highly linkable — issue #513, PR
#521, and every one of the four reverted PRs (#522–#525) point at it —
and future agents doing archaeology on the incident will land on it
first. A prominent retraction banner turns those inbound landings into
correct navigation to this design without breaking any link.

**Alternatives considered.**

- **Delete `helper-checkout-job-workflow-sha-context.md` outright.**
  Rejected. Deletion breaks inbound links and hides the historical
  record. The postmortem value of the retracted design (as a case study
  in "how a false premise cascades") outweighs the cost of keeping the
  file around with a banner.
- **Merge the retracted design's history into this doc verbatim.**
  Rejected. Duplication with the retracted file, and readability cost
  in this doc. A pointer suffices.
- **Rewrite the parent design instead of adding a correction note.**
  Rejected. The parent design's decisions are correct as-is; a rewrite
  would obscure the fact that only one downstream amendment was
  reverted, not the parent design's strategy.

### Decision 5 — No new automated regression test in this design

**Decision.** This design does not introduce a new automated regression
test. The pre-emptive actionlint config (Decision 2) is the
configuration-level defence, and Decision 3's runtime-evidence rule is
the process-level defence. No new CI job or workflow file is added.

**Rationale.** The four PRs that shipped the original mistake included
their own regression test (#525's `test-only-job-workflow-sha-reusable.yml`,
which asserted a property of the *wrong* expression). Layering another
automated test on top of these two defences would risk repeating the
same failure mode — "a test that codifies the wrong invariant is worse
than no test". The two defences that survive review (configuration +
process) are the right shape for a class of bug where the linter itself
is unreliable.

If a future incident shows that the configuration and process defences
are insufficient, a targeted regression test can be added then — with
the specific failure it would have caught used as the acceptance
criterion, rather than a speculative test written now.

**Alternatives considered.**

- **Add a workflow that dispatches every reusable workflow and asserts
  the helper checkout HEAD matches `job_workflow_sha` at runtime.**
  Rejected. This is exactly what #525 attempted; it did not save the
  chain because the test was passing (the *wrong* expression evaluated
  to an empty ref, which `actions/checkout` silently accepted, so the
  test was effectively vacuous). The failure mode was not test coverage
  — it was accepting a false premise. Configuration and process
  defences address the premise; another automated test does not.
- **Add a docs-linter that greps for `job.workflow_sha` (without
  `github.`) and fails.** Rejected. It would fail on this very design
  doc, which cites the wrong expression to describe the incident. The
  cost of maintaining allow-listed docs quickly exceeds the marginal
  value over the actionlint config.

## Out of scope

- **Documenting the other traps referenced in issue #526's grooming Q&A
  (the action-metadata trap in `ci-reusable.yml`; the empty-expression
  trap).** They are analogues of the same "invisible-until-dispatch"
  visibility gap, and the `## Known traps` section is structured to
  accept them, but this design does not migrate them. A follow-up
  issue can convert the existing `ci-reusable.yml` comments into a
  `## Known traps` entry.
- **Adding actionlint to CI as a permanent check.** Adding a lint step
  is a separate design (see `docs/design/refactor-github-actions.md`'s
  "future issue" note). This design only ships the ignore config so
  that when actionlint is eventually added, the ignore is already
  wired.
- **Automatically enforcing the runtime-evidence rule.** Decision 3 is
  a review principle, not a script. See Decision 3's rejected
  "hook or actionable check" alternative.
- **Upstream fix for actionlint's context schema.** Filing a PR against
  the actionlint repository to add `job_workflow_sha` is a good idea
  and would obviate the ignore config someday, but it is a decoupled
  upstream contribution and not part of this repo's follow-up work.
- **Rewriting `helper-checkout-job-workflow-sha-context.md` beyond the
  retraction banner.** Retracted-in-place preserves the historical
  record; a rewrite would obscure it.
- **Reworking `AGENTS.md`'s existing sections.** The additions are
  strictly additive: one new `## Known traps` top-level section, one
  cross-reference line in the existing self-checkout subsection, one
  new bullet plus one new short subsection in `Code Review Standards`.
  No existing prose is reworded beyond that.
- **New GitHub App permissions, new labels, or new agent actions.**
  This design is documentation and configuration only.

## Task breakdown

| Issue | Task | Depends on |
|-------|------|-----------|
| Issue [#528](https://github.com/mfrancza/agentic-development-workflow/issues/528) | Add `## Known traps` section to `AGENTS.md` with the `github.job_workflow_sha` entry (Decision 1). Add the one-line cross-reference to the trap from the existing "Reusable workflows: self-checkout for helper actions" subsection. Add the runtime-evidence rule to `AGENTS.md` § Code Review Standards (Decision 3) — one new bullet under "Every review evaluates the PR against these dimensions" (Correctness) and one new short subsection under "Repo-specific security defaults" titled "Reverting or replacing code with a passing live-run history". Add pointer sentences in `docker/scripts/prompts/groom.md` and `docker/scripts/prompts/design.md` that reference the new AGENTS.md subsection. | — |
| Issue [#529](https://github.com/mfrancza/agentic-development-workflow/issues/529) | Ship `.github/actionlint.yaml` per Decision 2 with the two ignore patterns and the incident-anchor comment. Run `actionlint .github/workflows/*.yml` locally to confirm the ignore takes effect (i.e. no false-positive diagnostics on `github.job_workflow_sha`) and record the command + output in the PR description. | — |
| Issue [#530](https://github.com/mfrancza/agentic-development-workflow/issues/530) | Amend `docs/design/helper-checkout-job-workflow-sha-context.md` with the RETRACTED banner (Decision 4) and add the Correction note to the top of `docs/design/reusable-workflow-helper-resolution.md` (Decision 4). Do not modify any other content in either file. | — |
| Issue [#531](https://github.com/mfrancza/agentic-development-workflow/issues/531) | End-to-end verification: (a) grep `AGENTS.md` to confirm the `## Known traps` heading and the `github.job_workflow_sha` entry are present; (b) run `actionlint .github/workflows/*.yml` and confirm zero diagnostics related to `job_workflow_sha`; (c) grep the two amended design docs for the retraction/correction banner; (d) grep `docker/scripts/prompts/groom.md` and `docker/scripts/prompts/design.md` for the runtime-evidence pointer sentence. Record the four command outputs in the PR description. | Issues #528, #529, #530 |

The three implementation tasks (#528, #529, #530) are independent of
each other — they touch disjoint files and can proceed in parallel.
The e2e verification task (#531) waits on all three.

Dependencies are recorded natively as GitHub blocked-by relationships
on the issues; the table above documents the intent so a reviewer of
this design PR can confirm the created dependency graph matches.
