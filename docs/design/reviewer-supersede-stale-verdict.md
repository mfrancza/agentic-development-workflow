# Design: Reviewer supersedes its own stale CHANGES_REQUESTED verdict

**Issue:** [#267](https://github.com/mfrancza/agentic-development-workflow/issues/267)
**Parent designs:** [docs/design/re-review-loop.md](re-review-loop.md) (Issue #41), [docs/design/reviewer-container.md](reviewer-container.md) (Issue #39), [docs/design/code-review-agent.md](code-review-agent.md) (Issue #27)

## Requirements as understood

The re-review loop specified in `docs/design/re-review-loop.md` is supposed to
terminate in an `APPROVE` verdict once every blocking finding has been addressed.
Issue #267 documents that in practice the loop does **not** terminate whenever
the reviewer agent has ever posted a `CHANGES_REQUESTED` verdict on the PR:
subsequent re-review passes settle for `COMMENTED` (with fully positive bodies
and zero findings) instead of escalating to `APPROVE`.

The concrete evidence in the issue:

- **Bug PR #266.** Three re-review passes after the initial
  `CHANGES_REQUESTED` was addressed all ended in `COMMENTED` verdicts whose
  bodies were fully positive ("The implementation looks correct and clean across
  all review dimensions" — no findings). No `APPROVE` was ever posted.
- **Working PRs #250, #254, #257, #258, #259.** Each reached a terminal
  `APPROVE` the same day, but each ran without a prior standing
  `CHANGES_REQUESTED` review by the same reviewer bot on the PR.
- **Hypothesis (grooming).** Once a prior blocking review by the reviewer
  itself exists in the PR's review history (still shown as "Changes requested"
  in the GitHub UI until dismissed), the reviewer declines to escalate its
  verdict to `APPROVE` and settles for `COMMENTED`.

**Symptom.** Loops on any PR that ever received a blocking verdict never reach
the terminal `APPROVE`; humans read the PR as stuck. The advisory nature of the
bot approval (issue #206) limits the practical damage — a human approval is
what satisfies the ruleset — but the design intent of the re-review loop is a
terminal `APPROVE`.

**Ambiguity resolved.** The grooming notes list two candidate fixes and observe
that they are not mutually exclusive:

1. Prompt-level change — tell the reviewer that a fresh clean pass must
   `APPROVE` even when its own earlier `CHANGES_REQUESTED` still stands on the
   PR.
2. Entrypoint / workflow dismiss — mechanically dismiss the reviewer bot's
   prior `CHANGES_REQUESTED` review so no stale blocking verdict remains
   visible to the reviewer or the PR UI.

This design adopts **both**, in that order — the prompt clarification is the
minimum change that addresses the root cause of the verdict selection, and the
mechanical dismissal is a defence-in-depth layer that also cleans up the
PR review UI. See **Decision 3** for why doing neither alone is sufficient.

## Decisions

### Decision 1 — Fix the verdict selection at the prompt level (primary fix)

Update `docker/reviewer/prompts/review.md` so the **Verdict selection** section
explicitly states that:

- The verdict reflects the **current pass**, not the PR's review history.
  A prior `CHANGES_REQUESTED` review by this same bot does **not** prevent
  `APPROVE`; posting `APPROVE` now supersedes the earlier verdict.
- If the current pass has zero blocking findings, zero advisory-worth-recording
  findings, and every open review thread from prior passes is either resolved
  or recorded for resolution, the verdict **MUST** be `APPROVE`. Choosing
  `COMMENTED` in this case is incorrect: it leaves the re-review loop with no
  terminal event and PRs appear "stuck" to human observers.
- `COMMENTED` is reserved for the case where the current pass surfaces
  advisory-only findings worth noting. It is **not** a hedge to use when the
  reviewer feels shy about overturning its own prior verdict.

The updated language sits inside the existing verdict-selection section (no new
top-level structure) so this remains a minimal edit.

**Alternatives considered.**

- *Leave the prompt alone and rely solely on mechanical dismissal
  (Decision 2).* Rejected. The prompt currently allows Claude discretion to
  pick `COMMENTED` for clean passes. Removing the stale-verdict signal from
  the API surface reduces bias, but Claude's judgment may still hedge for
  other reasons (open threads carried over, cautious summarising). The prompt
  fix makes the terminal-`APPROVE` requirement deterministic; mechanical
  dismissal is a signal reduction, not a verdict guarantee.
- *Replace the entire verdict rubric.* Rejected as over-scoped. The
  `REQUEST_CHANGES` / `COMMENTED` / `APPROVE` distinction is correct; only the
  edge case (clean pass after a prior blocking review) is broken.
- *Introduce a new verdict "SUPERSEDE".* Rejected — GitHub's review API has
  three states; inventing a fourth in the prompt would need mapping back to
  the API anyway.

### Decision 2 — Dismiss stale CHANGES_REQUESTED reviews by the bot before each re-review (defence-in-depth + UX)

Add a workflow step in `.github/workflows/agent-review.yml` that runs **before**
the reviewer container. It uses the reviewer-app installation token (already
minted for the review-post step) to:

1. List reviews on the PR (paginated).
2. Filter to reviews authored by the reviewer bot identity (matching
   `steps.setup.outputs.app-slug` or `[bot]`-suffixed login) whose state is
   `CHANGES_REQUESTED` and not already `DISMISSED`.
3. Call `PUT /repos/{repo}/pulls/{n}/reviews/{review_id}/dismissals` on each,
   with a fixed message: `Superseded by re-review from this bot.`

Semantics of dismissal in the GitHub API: the review body and its inline
comments remain visible in the PR history, but the review's blocking status is
cleared and the UI shows a "dismissed" marker. This is exactly the UX we want —
no destruction of prior findings, only demotion of the stale verdict.

**Ordering: before the container runs.** The dismissal happens up front so that
any `gh api` calls the reviewer agent makes during the pass do not see a
standing CHANGES_REQUESTED verdict for itself. This removes the signal that the
issue hypothesises biases Claude toward `COMMENTED`. Ordering "after the
container posts APPROVE" would clean up the UI but leaves the bias intact
during the pass. Since the primary fix (Decision 1) already handles the verdict
directly, the choice of ordering is a defence-in-depth preference; before-run
is chosen because it also silently no-ops on runs where the reviewer never had
a CHANGES_REQUESTED to dismiss.

**Failure posture: fail open.** A dismissal API failure is logged but does not
fail the workflow. Rationale: the prompt fix (Decision 1) is what actually
selects `APPROVE`. If dismissal is skipped, the loop still terminates on the
next clean re-review; the only cost is a lingering stale banner in the PR UI.
Fail-open matches the posture of the existing `resolve-review-threads` action.

**Alternatives considered.**

- *Dismiss from inside the container instead of the workflow.* Rejected. The
  container is deliberately minimal (`reviewer-container.md` decision 3): its
  only writes are the local `RESOLVE_THREADS_FILE` and the single review-post
  `gh api` call. Adding a second write path — even to the same review API —
  broadens the container's write surface. Doing it in the workflow keeps the
  container's contract intact and lets the API call use the same short-lived
  installation token the workflow already has via `steps.setup.outputs.token`.
- *Use the workflow's `GITHUB_TOKEN` (the same token used for the
  resolve-threads step).* Rejected in favour of the reviewer-app token. A bot
  dismissing its own review is the correct identity; using `github-actions[bot]`
  would show the dismissal as coming from the workflow runner, which is
  semantically confusing on the PR timeline.
- *Only dismiss after the current pass posts `APPROVE`.* Rejected as
  discussed in the ordering note above. Adds a conditional read of the just-
  posted review's verdict without materially improving safety.
- *Dismiss all prior reviews by the bot, not just `CHANGES_REQUESTED`.*
  Rejected. Prior `COMMENTED` reviews carry no blocking state (nothing to
  supersede) and prior `APPROVED` reviews are already terminal-positive. Only
  `CHANGES_REQUESTED` needs dismissal. `DISMISSED` reviews are already in the
  target state and are skipped by the filter.

### Decision 3 — Ship both fixes together, not just one

The two decisions above are complementary and the design ships both in the same
release, because each alone leaves a residual gap:

- **Prompt fix alone** (Decision 1 only) — the reviewer will select the correct
  verdict, but the PR's review UI still shows the stale
  "Changes requested" banner until someone dismisses it manually. Human
  reviewers reading the PR may still read the state as ambiguous. Also, the
  prompt fix depends on Claude following the new instruction reliably; if a
  future model or prompt change regresses the behaviour, there is no
  mechanical safety net.
- **Dismissal alone** (Decision 2 only) — the stale CHANGES_REQUESTED is gone
  from the API surface, but the prompt still permits `COMMENTED` for clean
  passes and Claude may still hedge for reasons unrelated to the dismissed
  review (e.g. cautious summarising of many open threads that were addressed).

Shipping both means the primary bug is fixed at its root and the PR UI is
cleaned up as a bonus. The two tasks (Decision 1 = prompt edit;
Decision 2 = new workflow step + supporting activity) are independent files and
can be developed in parallel.

### Decision 4 — Shell-vs-TypeScript threshold for the dismissal step

The dismissal step involves API-response parsing (`user.login`, `state`), a
loop over N reviews, pagination, and a fail-open error policy. Per the
**Workflow Activity Conventions** in AGENTS.md, that crosses the threshold from
inline shell into a TypeScript activity. Implement it as:

- **Composite action:** `.github/actions/dismiss-stale-reviewer-reviews/action.yml`
  that sets up Node, runs `npm ci` under `.github/scripts`, and invokes the
  activity.
- **Activity source:** `.github/scripts/src/dismiss-stale-reviewer-reviews.ts`
  with a pure filter/dismiss function callable from tests, and a thin `run()`
  wrapper that reads inputs and writes outputs via `@actions/core`.
- **Tests:** `.github/scripts/test/dismiss-stale-reviewer-reviews.test.ts`
  covers: empty review list, no matching bot reviews, one matching review,
  multiple pages, a review already `DISMISSED` (skipped), a mixed set of
  `APPROVED`/`COMMENTED`/`CHANGES_REQUESTED`/`DISMISSED` (only
  `CHANGES_REQUESTED` are targeted), and an API error on one review's
  dismissal (fail-open: continue with the remaining ones and warn).

Inputs: `token`, `repo`, `pr-number`, `reviewer-login`.
Outputs: none required by consumers; the step logs the dismissed IDs (or a
"nothing to dismiss" message) for the debug trail.

**Alternatives considered.** A plain shell step with `gh api --paginate` and
`--jq` would work but the pagination + per-review error handling puts it over
the AGENTS.md-defined threshold. Consistency with the surrounding
`.github/scripts/` activities is more valuable than saving a few lines.

### Decision 5 — Reviewer identity source: mint-token output, not a hard-coded string

The dismissal filter needs to know the reviewer bot's login (e.g.
`mfrancza-reviewer-agent[bot]`). Options:

- **(a) Query `viewer.login` with the reviewer-app token from the activity.**
  The reviewer container already does this (`entrypoint.sh` around
  `REVIEWER_LOGIN`) with `gh api graphql -f query='{ viewer { login } }'`.
  Chosen: one extra GraphQL call per re-review pass and no new source of
  truth — the token itself is authoritative about which bot is logged in.
- **(b) Pass the reviewer app slug from `steps.setup.outputs.app-slug`.**
  Requires that the `agent-token` composite action exposes the slug as an
  output; a quick check shows it does not today. Adding it would fan out to
  other consumers of the token. Rejected for scope creep.
- **(c) Hard-code `mfrancza-reviewer-agent[bot]` in the workflow.** Rejected
  because it hard-couples the workflow to a personal-repo naming convention;
  the rest of the codebase deliberately keeps the reviewer bot login as a
  runtime lookup.

The activity therefore takes the reviewer-app token as an input and derives
the login itself with `viewer.login`. A GraphQL failure here fails open (log
warning + no dismissals) — same posture as the rest of Decision 2.

### Decision 6 — Documentation touch-ups

- `docs/design/re-review-loop.md` — no structural change; add a short
  **Amended (issue #267)** note under Decision 2 (or an equivalent
  Post-decision note) pointing at this document as the fix for the
  terminal-APPROVE regression and explaining that the reviewer prompt now
  explicitly requires `APPROVE` on clean passes and that the workflow
  dismisses stale CHANGES_REQUESTED reviews.
- `AGENTS.md` — no changes required. The dismissal is an internal mechanism
  of the reviewer workflow; operators do not need to see it. The reviewer
  bot's verdict semantics are documented via the design docs.
- `README.md` — no changes required.

**Alternatives considered.** Adding a new **Labels** or **Debugging** subsection
in AGENTS.md was considered but rejected: no operator-facing knob changes and
the merge-friendly-documentation guidance in AGENTS.md discourages adding
implementation-status notes.

## Out of scope

- **Removing `agent:review` from the PR on terminal APPROVE.** Orthogonal to
  this bug (the label lifecycle is a separate concern; the loop terminating in
  APPROVE is what this design ensures). Auto-removing the label would be a
  reasonable follow-up but is not required to close #267.
- **Dismissing prior reviews by other identities (humans or Copilot).**
  The reviewer bot must only supersede its own verdicts. Human reviews and
  Copilot reviews are handled through the normal PR review flow and are
  outside the reviewer bot's remit.
- **Post-hoc dismissal of stale CHANGES_REQUESTED reviews on already-stuck PRs
  (backfill).** Reviewers can re-apply `agent:review` on those PRs to trigger
  a fresh pass under the fixed logic. A one-off cleanup is not automated.
- **Changing verdict semantics for the `agent-respond-review` guard.** The
  existing loop guard (approve + zero unresolved threads → skip
  respond-review) is already correct per `re-review-loop.md` Decision 3.
  This design does not touch it.
- **Model-specific behaviour** — no per-model verdict rules are introduced.
  The prompt-level clarification applies uniformly to Anthropic, OpenAI, and
  xAI models routed through the reviewer image.
- **The GitHub-suppressed-events limitation for conflicted PRs** — orthogonal
  cause of "stuck" reviews, already documented in `re-review-loop.md`
  Decision 4.
- **Auto-dismissing prior `APPROVED` or `COMMENTED` reviews** — see
  Decision 2 alternatives. Only `CHANGES_REQUESTED` needs superseding.

## Task breakdown

Sub-issues are single-PR-sized. Prompt edit and workflow/activity work are on
independent files and can proceed in parallel; the end-to-end validation
depends on both.

| Issue | Task | Depends on |
|-------|------|-----------|
| [#331](https://github.com/mfrancza/agentic-development-workflow/issues/331) | Prompt: update **Verdict selection** in `docker/reviewer/prompts/review.md` per Decision 1 — explicit rule that a clean current pass MUST post `APPROVE` even when a prior `CHANGES_REQUESTED` review by the same bot still stands, and short rationale that the new verdict supersedes the earlier one | — |
| [#333](https://github.com/mfrancza/agentic-development-workflow/issues/333) | Workflow: add `dismiss-stale-reviewer-reviews` composite action + TypeScript activity + tests per Decisions 2 / 4 / 5; wire it into `.github/workflows/agent-review.yml` before the "Run reviewer agent" step, using the reviewer-app token; fail-open on API errors | — |
| [#335](https://github.com/mfrancza/agentic-development-workflow/issues/335) | Doc: add an **Amended (issue #267)** note to `docs/design/re-review-loop.md` Decision 2 pointing at this document per Decision 6 | — |
| [#338](https://github.com/mfrancza/agentic-development-workflow/issues/338) | End-to-end validation: reproduce the bug scenario on a test PR (trigger CHANGES_REQUESTED, address, push, re-review) and verify (a) the prior CHANGES_REQUESTED is dismissed on the next pass, (b) the current pass posts `APPROVE` (not `COMMENTED`) when clean, (c) `agent-respond-review` skips on that `APPROVE` per the existing loop guard | Issue #331, Issue #333 |

The prompt task (#331) and the workflow task (#333) can proceed in parallel —
this document is the contract between them (Decision 1 fixes the verdict;
Decisions 2 / 4 / 5 add the mechanical dismissal). The design-doc task (#335)
can also proceed in parallel; it touches only `docs/design/re-review-loop.md`.
The validation task (#338) exercises the full loop end-to-end and is expected
to feed small fixes back into the implementation tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
