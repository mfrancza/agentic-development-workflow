# Design: Enroll agent-authored PRs for auto-review by author identity, not just branch prefix

**Issue:** [#559](https://github.com/mfrancza/agentic-development-workflow/issues/559)

## Summary

The `auto-review` job in `agent-auto-trigger.yml` currently gates on
`startsWith(head.ref, 'agent/') || startsWith(head.ref, 'design/')`. The branch
prefix is a proxy for "agent-created". Any agent flow that opens a PR from a
non-standard branch prefix (e.g. `validate/…`, `test/…`) silently bypasses
enrollment — no `agent:review` label, no reviewer run, no failure. Extend the
gate with a same-repo author-identity OR clause so agent-authored PRs enrol
regardless of branch name. Keep the existing prefix clauses and the fork-safety
head-repo guard unchanged.

No new workflows, no new inputs, no reusable-workflow changes. One `if:` clause
change in the caller stub and matching prose updates in `docs/design/auto-trigger-agents.md`
and `AGENTS.md`.

## Requirements (from issue #559 and grooming notes)

1. **Missed enrollment is the observed defect.** PR
   [#557](https://github.com/mfrancza/agentic-development-workflow/pull/557) —
   the issue #551 E2E canary — opened from `validate/terraform-ci-canary` under
   the `mfrancza-developer-agent[bot]` identity. The `auto-review` gate did
   not match the branch prefix, so no `agent:review` label was applied and no
   reviewer run was scheduled. The failure was silent (a `skipped` job with no
   diagnostic), which is the exact recurrence class this repo has explicitly
   called out as high-cost (`AGENTS.md` "silent skip" language, and the same
   framing in the issue body).
2. **Extend, do not replace, the branch-prefix predicate.** The existing
   `agent/` and `design/` clauses cover every branch the `implement` and
   `design` actions produce today, and — importantly — cover the "human pushes
   a rescue commit and opens a PR from the same `agent/…` branch" case
   (`docs/design/auto-trigger-agents.md` Decision 5). Removing the prefix
   clause would regress that case. The fix is additive: `prefix OR
   agent-author`, gated by the existing head-repo guard.
3. **Keep the same-repo head-repo guard unchanged.** It does the fork-safety
   work independently of the prefix/author check. A same-repo guard on top of
   the OR-of-predicates preserves the property that a fork PR cannot enroll
   via a matching branch name **or** via a spoofed author (fork PRs report the
   PR author in `pull_request.user.login`, but the fork is what makes the diff
   attacker-controlled — the head-repo guard blocks it regardless of who
   opened it).
4. **The bot identity to match is `mfrancza-developer-agent[bot]`.** This is
   the login already used verbatim in three other places in this repo
   (`agent-pr-merged.yml`, `agent-respond-review.yml`,
   `agent-fix-checks.yml`), all of which hardcode it in the caller stub for
   the same reason: the App slug is per-install and known statically at the
   caller-stub level. Grooming confirms this is the identity that opened PR
   #557.
5. **Update the documentation surfaces.** The transitions table (Decision 5)
   in `docs/design/auto-trigger-agents.md` and the auto-trigger gates table
   in `AGENTS.md` both describe the current branch-prefix gate. Both must
   describe the new OR-of-predicates gate in the same PR that changes the
   workflow.
6. **Runtime evidence is on record.** Per the "Reverting or replacing code
   with a passing live-run history" rule in `AGENTS.md`, a change to working
   workflow expressions needs runtime evidence of the failure it fixes. PR
   #557 is that evidence — the canary PR is agent-authored on `validate/…`
   and `auto-review` did not fire on it. This is a runtime miss, not a
   linter or schema-only concern.

## Design decision: parameterize the bot login vs. hardcode it in the caller

**Decision.** Hardcode `mfrancza-developer-agent[bot]` in the caller stub's
`if:` expression. Do not parameterize the reusable
(`agent-auto-trigger-reusable.yml`).

**Chosen shape of the new `if:` for the `auto-review` job in
`agent-auto-trigger.yml`:**

```yaml
if: >
  github.event_name == 'pull_request' &&
  github.event.action == 'opened' &&
  github.event.pull_request.head.repo.full_name == github.repository &&
  (startsWith(github.event.pull_request.head.ref, 'agent/') ||
   startsWith(github.event.pull_request.head.ref, 'design/') ||
   github.event.pull_request.user.login == 'mfrancza-developer-agent[bot]') &&
  vars.AUTO_TRIGGER_AGENTS != '' &&
  fromJSON(vars.AUTO_TRIGGER_AGENTS).review == true
```

Note the head-repo guard is lifted **outside** the OR so it applies uniformly
to all three enrollment paths, closing the "fork PR that happens to author-match
the string `mfrancza-developer-agent[bot]`" edge case (a fork attacker cannot
actually author a PR as our bot, but the guard belongs outside the OR either
way for clarity and future-proofing).

### Alternatives considered

| Alternative | Reason rejected |
|-------------|-----------------|
| Parameterize the reusable with a required `developer-bot-login` input; caller stubs pass their own login | The reusable's `auto-review` job today runs no author check — the caller's `if:` block is the sole predicate. Adding an input the reusable does not consume gives external consumers a false sense of protection: whatever they pass never runs against `head.user.login`. If we ever move the check into the reusable, we can add the input at that time. |
| Replace the branch-prefix clauses with the author-identity check only | Regresses the "human pushes a rescue commit on `agent/issue-N`" path documented in Decision 5 of `docs/design/auto-trigger-agents.md`. Also regresses the case where a future agent flow authors under a different bot identity (unlikely today, but the prefix clauses cost nothing to keep). |
| Keep the current gate and require every agent flow to conform to the `agent/` or `design/` prefix convention | Puts the burden on the caller side of every new agent flow; a single deviation reproduces the silent skip. The issue explicitly identifies `resolve-conflicts` and validation/canary flows as the recurrence surface. Prefix conformance is fine as a convention, but the review gate should not depend on it for correctness. |
| Add a Terraform-managed Actions variable (e.g. `DEVELOPER_BOT_LOGIN`) so the login is not hardcoded in YAML | The App slug is already load-bearing (Terraform provisions the App identity itself in `AGENT_ALLOWLIST`), and three other workflows already hardcode the same string. Adding a variable for one more use site is more surface than it saves — and each of those three call sites (`agent-pr-merged.yml`, `agent-respond-review.yml`, `agent-fix-checks.yml`) is a natural candidate for the same "should we variable-ize this?" question. Out of scope for this fix; if the answer becomes yes, a follow-up can convert all four sites at once. |

### Why hardcoding is safe here

- The `mfrancza-developer-agent[bot]` string appears verbatim in
  [`agent-pr-merged.yml:37`](../../.github/workflows/agent-pr-merged.yml),
  [`agent-respond-review.yml:44`](../../.github/workflows/agent-respond-review.yml),
  and [`agent-fix-checks.yml:31`](../../.github/workflows/agent-fix-checks.yml).
  Consistency with the existing pattern is more valuable than avoiding
  one more instance.
- External consumers of the reusable workflow (`agent-auto-trigger-reusable.yml`)
  write their own thin caller stubs today — the caller stub is where every
  `if:` predicate lives (event type, allowlist, draft guard, blocker check).
  Adjusting the author-identity string to their own bot is a one-line change
  in their own caller stub. The reusable does not need to know about it.
- The head-repo guard remains the fork-safety boundary. Author identity is a
  correctness signal (agent-authored PRs enroll), not a security signal (fork
  code never enrols regardless of the branch or claimed author).

## What the reusable does NOT need

`agent-auto-trigger-reusable.yml`'s `auto-review` job today just mints a token
and applies the `agent:review` label; it makes no branch-prefix or author
decisions. Because the caller's `if:` block is the sole predicate, extending
the gate does not require any reusable-workflow change. This keeps the fix
small and reversible.

If a future change relocates the predicate into the reusable (e.g. to expose
a single opinionated auto-trigger to external consumers), the parameterized
form from the "alternatives considered" table above becomes the right shape
at that time. That is deliberately out of scope here.

## Impact on cross-references

- `docs/design/auto-trigger-agents.md` — transition #5 row in "The six
  transitions we are gating" table, and Decision 5 ("`pull_request.opened`
  fires from any actor on an agent branch"). The prose currently frames the
  branch-prefix predicate as the sole enrollment key and explicitly rejects
  a sender-login check on the grounds that the App slug varies per install.
  The updated prose keeps that framing for external consumers (prefix is the
  portable predicate) and documents this repo's hardcoded caller-stub OR
  clause as the belt to the prefix's suspenders, motivated by the PR #557
  incident.
- `AGENTS.md` § "Auto-trigger gates (`AUTO_TRIGGER_AGENTS`)" table — the
  `review` row currently reads "on a branch whose name starts with `agent/`
  or `design/` (same-repo PRs only)". Update to reflect the OR-of-predicates.

## Out of scope

- **Parameterizing the bot login as a workflow input or Actions variable.**
  If we later want to abstract it, we should do it for all four current
  hardcoded call sites in one pass. This design deliberately leaves the
  existing sites as they are and adds one more consistent site.
- **Retroactively enrolling PR #557 or any other historical
  agent-authored-but-missed PR.** The `agent:review` label can be applied
  manually to any of them by an allowlisted actor; auto-enrollment is
  prospective.
- **Renaming or normalising the `resolve-conflicts` and validation/canary
  branch prefixes to match `agent/…`.** The issue names this as an optional
  "belt" — worth considering, but a separate housekeeping task. The
  correctness of auto-review must not depend on it.
- **Any change to the reusable workflow `agent-auto-trigger-reusable.yml`.**
  See "What the reusable does NOT need" above.
- **Any change to other transitions' gates (auto-groom, auto-design,
  auto-developer-*, auto-developer-unblock).** They already gate on
  `contains(fromJSON(vars.AGENT_ALLOWLIST), github.event.sender.login)` for
  issue events, which is the equivalent authorship signal for that event
  class. The gap this issue closes is unique to `pull_request.opened`
  (transition #5), which uses a branch predicate instead of a sender check
  by explicit design.
- **Changes to the reviewer container, the reviewer identity, the
  `agent:review` label semantics, or the reviewer's re-review loop.** The
  fix is entirely inside the enrollment gate.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#561](https://github.com/mfrancza/agentic-development-workflow/issues/561) | Extend the `auto-review` job `if:` in `.github/workflows/agent-auto-trigger.yml` to add the same-repo bot-author OR clause; move the head-repo guard outside the branch/author OR; update `docs/design/auto-trigger-agents.md` (transition #5 row and Decision 5 prose) and the `AGENTS.md` auto-trigger gates table `review` row in the same PR. | — |
| [#562](https://github.com/mfrancza/agentic-development-workflow/issues/562) | End-to-end validation: with `auto_trigger_agents.review = true`, open an agent-authored PR from a non-`agent/`/non-`design/` branch (e.g. `validate/*`) and confirm `agent:review` is applied and the reviewer run is scheduled. Also confirm a fork PR on an `agent/…` branch still does **not** enroll (fork guard regression check). | Issue #561 |

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
