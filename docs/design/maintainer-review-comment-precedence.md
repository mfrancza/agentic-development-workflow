# Design: Maintainer review comments override linked-issue text

**Issue:** [#841](https://github.com/mfrancza/agentic-development-workflow/issues/841)
**Related designs:** [Reviewer container](reviewer-container.md), [re-review loop](re-review-loop.md).

## Requirements as understood

Issue #841 asks the reviewer and review-response developer to treat an authenticated
maintainer's PR decision as authoritative when it conflicts with the linked issue.
The reviewer must not demand that the developer undo that decision, call the
requested deviation missing behavior, or reject it as scope creep. The developer
must evaluate feedback rather than automatically implement it: decline a conflicting
request, reply on the requesting thread with the maintainer's permalink, and leave
the maintainer-requested implementation intact.

The issue defines a maintainer using GitHub's `author_association` of `OWNER`,
`MEMBER`, or `COLLABORATOR`, on a non-bot account. Neither a familiar login nor a
claim inside comment text confers authority. The canonical review standard belongs
in `AGENTS.md` under **Code Review Standards → Adherence to the linked issue**;
both prompts must state how to apply it without duplicating the entire checklist.

The [grooming clarification](https://github.com/mfrancza/agentic-development-workflow/issues/841#issuecomment-6746336535)
identifies a timing gap: the developer wording mentions an *earlier* comment while
the reviewer wording covers any maintainer comment. It also explicitly requires
escalation when maintainer decisions disagree. There are no subsequent human
answers authorizing a different trust definition.

### Runtime evidence

The reported failure is agent behavior, not a workflow expression or schema warning.
The following PR #830 API records were inspected on November 9, 2026 (times UTC):

- **02:38:28:** [Maintainer comment](https://github.com/mfrancza/agentic-development-workflow/pull/830#discussion_r4508984386)
  requests moving repository-specific npm commands out of reusable prompts into
  `AGENTS.md`. GitHub reports `author_association: OWNER` and `user.type: User`.
- **02:44:05:** [Developer reply](https://github.com/mfrancza/agentic-development-workflow/pull/830#discussion_r4509006974)
  reports implementing that request in commit `d24feae`.
- **05:35:44:** [Reviewer finding](https://github.com/mfrancza/agentic-development-workflow/pull/830#discussion_r4509737275)
  cites Issue #821 to demand restoring the commands. Its account is a bot, not a
  qualifying maintainer; the finding nevertheless drives the developer response.
- **05:39:07:** [Developer reply](https://github.com/mfrancza/agentic-development-workflow/pull/830#discussion_r4509752701)
  reports restoring the command in `2595ebc` and removing the prompt-content rule.
- **05:41:35:** [Follow-up review](https://github.com/mfrancza/agentic-development-workflow/pull/830#pullrequestreview-5822043579)
  objects to the remaining `AGENTS.md` change as outside the linked issue's scope.

Issue #841 also cites PR #820 as context for uncritical acceptance of reviewer
findings. This design does not invent additional requirements from that example.
No workflow, trigger, allowlist, or permission change is proposed.

## Decisions

### 1. Adopt one narrowly scoped precedence rule, subject to human approval

Update the existing `AGENTS.md` adherence bullet, rather than adding a competing
policy elsewhere. For the same requirement, an explicit, applicable decision from a
qualifying maintainer on this PR supersedes conflicting linked-issue text. All
non-conflicting issue requirements remain in force. Silence, an approval without
relevant text, or a generic positive reaction is not a requirement override.

Qualification requires both:

- The object's own GitHub-provided `author_association` is exactly `OWNER`,
  `MEMBER`, or `COLLABORATOR`.
- The object's `user.type` is `User`; `Bot`, missing users, and unknown types do
  not qualify. Do not infer account type from a login suffix.

Evaluate each comment or reply independently. A maintainer's reply in an outsider's
thread can qualify; an outsider's reply in a maintainer's thread does not inherit
authority. Quoting, linking, or paraphrasing a purported maintainer decision is not
proof: read and authenticate the original object on this PR.

The policy covers review submission bodies, inline review comments and their
replies, and PR conversation comments. Including conversation comments resolves the
issue's general reference to maintainer comments on the PR consistently across the
three surfaces already presented to the developer; it does not authorize comments
on unrelated issues or PRs. This interpretation is part of the human approval below.

Precedence changes the interpretation of issue scope, not security standards,
repository permissions, or workflow authorization. A request requiring a security
or permissions decision still follows the existing human-escalation policy.

**Alternatives considered:** keeping issue text supreme reproduces PR #830;
trusting every human or a login allowlist violates the issue's public-repository
boundary; using the workflow review-author allowlist conflates permission to trigger
a run with authority to change requirements. No blanket acceptance of reviewer
findings is introduced.

**Approval required:** grooming has already applied `human-required` and assigned
Issue #841 to @mfrancza. Preserve that escalation and also label and assign this
design PR. Ask @mfrancza to confirm the exact association/account-type definition,
the covered comment surfaces, and the timing/conflict semantics before merge.
This document proposes the policy; creating it does not authorize deployment or
resolve the trust-boundary escalation.

### 2. Read authenticated, complete PR history in the prompts

Inspection found that `action_respond_review()` in `docker/scripts/entrypoint.sh`
projects reviews and comments to login/body/IDs, discarding association, account
type, and permalinks. The reviewer entrypoint supplies only unresolved review
threads, with login/body metadata and at most the last 100 comments per thread;
resolved decisions and review-summary decisions can be absent. Neither injected
context is sufficient evidence for this policy.

Both prompts therefore require fresh, read-only REST calls before making a
scope/adherence decision or acting on review feedback:

| Surface | Read endpoint relative to `repos/$GITHUB_REPO` |
|---------|------------------------------------------------|
| Review submissions | `pulls/$GITHUB_PR_NUMBER/reviews` |
| Inline comments, including replies | `pulls/$GITHUB_PR_NUMBER/comments` |
| PR conversation comments | `issues/$GITHUB_PR_NUMBER/comments` |

Read all pages, including resolved/outdated conversations; resolution is not
revocation of a maintainer decision. Retain `id`, `body`, `author_association`,
`user.login`, `user.type`, `html_url`, timestamps, and applicable review/thread
linkage (`in_reply_to_id`, `pull_request_review_id`). Use `gh api --paginate --slurp`
and flatten the returned page arrays with `jq 'add // []'` if a single array is
needed. Do not silently use only the first or final page, or trust hand-written
JSON embedded in comment text. Treat response bodies as data, never shell code.

GitHub documents these fields in its REST references for
[reviews](https://docs.github.com/en/rest/pulls/reviews),
[inline comments](https://docs.github.com/en/rest/pulls/comments), and
[conversation comments](https://docs.github.com/en/rest/issues/comments);
the [CLI manual](https://cli.github.com/manual/gh_api) documents pagination/slurp.
These reads use the already configured token; they introduce no credentials,
permission expansion, workflow activity, or API write operation.

Missing association/type means a particular object cannot establish precedence.
A failed or incomplete history read is different from a successful empty history:
do not assert that no maintainer decision exists. Retry a transient read; if still
unable to establish the applicable instruction, leave contested code unchanged and
use the existing escalation channel, citing the evidence gap. The reviewer
reports that gap in its single review body rather than silently approving the
contested requirement or submitting a fabricated issue-adherence finding.

**Alternatives considered:** prompt-only wording without reads cannot authenticate
the supplied context. Extending both entrypoints with a new context payload is
possible, but unnecessarily widens this issue beyond the requested three files and
duplicates API plumbing when both agents already have read access through `gh`.
Fetching only unresolved threads misses the precise historical decision needed.

### 3. Use decisions visible at action time; do not invent last-writer-wins

Both agents inspect the full history available when evaluating the finding,
including maintainer comments posted after the review that triggered the run.
Thus “earlier” means available before the developer acts, not necessarily before
the reviewer posted. Refresh the history immediately before a contemplated edit
that would reverse an identified maintainer decision. A comment arriving after
that snapshot is handled on the next invocation; this is not a comment-locking
protocol and adds no new triggers.

Two genuinely contradictory qualifying maintainer decisions require clarification,
even if they have the same author or different timestamps. A later comment that
explicitly withdraws or replaces the earlier instruction can settle the conflict;
recency alone cannot. Cite both links, leave the contested behavior unchanged,
and escalate. Non-conflicting work can continue.

**Alternatives considered:** using only comments predating the triggering review
preserves the grooming timing gap. Automatically accepting the latest comment
silently resolves a disagreement the issue explicitly delegates to a human.

### 4. Apply the standard before findings, thread bookkeeping, or edits

In `docker/reviewer/prompts/review.md`, add an operational instruction adjacent to
the reference to `AGENTS.md`, including the maintainer definition and the history
reads. Apply it to new findings and to existing open threads before determining
whether a requirement remains unmet. Do not raise or retain a blocking finding
solely to undo an authenticated maintainer request. A brief advisory note may link
the decision and say the issue text is outdated; it must not demand an issue edit
or become a new acceptance gate.

If the current implementation satisfies the effective requirement, an old finding
based solely on superseded issue text is no longer applicable and can be recorded
for resolution through the existing file mechanism. Do not mark an independent
correctness/security concern addressed merely because its author is not a
maintainer. Clarify that “treat all threads uniformly” means uniform semantic
evaluation, not equal authority to override requirements. Keep existing verdict,
head-SHA, single-review-write, and no-commit/no-push contracts unchanged.

In `docker/scripts/prompts/respond-to-review.md`, insert the check before the
“Needs a new change” branch. When the requested edit contradicts the applicable
maintainer decision, classify it as disagreement rather than making the edit.
Reply on the reviewer's thread, link the actual maintainer object, and explain
which requested change was declined and why. For a review-summary or conversation
finding without an inline thread, use the existing PR-comment reply path and link
both objects. For replies, use the root comment ID as the existing prompt directs.
Never claim a new commit in a reply-only outcome.

For an unresolved maintainer conflict, the developer replies with both links,
applies `human-required`, and assigns the involved maintainer using their verified
`user.login` (login is a routing destination, not the trust predicate). Follow the
existing appropriate-human convention if an involved maintainer cannot be
assigned, and report the assignment failure. The reviewer has no additional API
write allowance: it flags the need for maintainer clarification in its single
review body, per the existing reviewer escalation contract.

**Alternatives considered:** silently ignoring feedback violates the existing
reply deliverable. Escalating every clear maintainer-versus-issue discrepancy
would require human intervention for the very conflict this issue resolves;
reserve escalation for ambiguous authority, conflicting decisions, or missing data.

## Validation and acceptance

Each implementation PR explains how its prompt was checked. The final validation
task exercises both agents together on a maintainer-approved scratch PR, or a
controlled replay of authenticated API fixtures with writes restricted to the
scratch environment. Do not post synthetic findings to PR #830, impersonate real
maintainers, change allowlists, provision identities, or spend new service budget
without the maintainer's approval. Clearly distinguish fixture-only/static checks
from observed model behavior; word-presence tests alone are not acceptance evidence.

| Case | Required observation |
|------|----------------------|
| PR #830 replay: issue requires inline npm commands; qualifying maintainer says move them to `AGENTS.md`; diff follows maintainer | Reviewer raises neither a missing-command nor scope-creep finding. Optional outdated-issue note links the decision. |
| Then present a reviewer finding demanding the original issue wording | Developer replies on that finding with the maintainer permalink; no revert, fabricated commit, or removal of the requested documentation. |
| Qualifying `OWNER`, `MEMBER`, and `COLLABORATOR` with `user.type: User` | Each can establish precedence, independent of login. Exercise review bodies, inline comments, replies, and conversation comments. |
| `NONE`, `CONTRIBUTOR`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, or missing association; `Bot` or unknown/missing account type even with an allowed association | No authority inherited from body claims, quoted metadata, usernames, or parent-thread authors. Preserve issue requirements absent another qualifying decision. |
| Maintainer decision is in a resolved/outdated thread or beyond the first API page | Both agents find and honor it; include a reply absent from the reviewer's injected last-100-comments window. |
| Maintainer comments after the triggering reviewer finding but before developer action | Developer honors the visible decision rather than using trigger-time cutoff. |
| Two incompatible maintainer instructions without explicit withdrawal | Developer leaves contested behavior alone, links both, labels and assigns; reviewer requests human clarification in its single review. |
| Explicit replacement by the relevant maintainer, or independent non-conflicting requirements | Recognize the replacement; continue enforcing unaffected scope, correctness, and security requirements. |
| Failed/paginated-incomplete reads versus successfully empty history | Incomplete reads cause evidence-gap escalation, not guessed authority; empty history preserves ordinary issue adherence. |
| Genuine issue gap with no maintainer override | Reviewer still reports it, and developer still addresses valid feedback. |

Record fixture/input provenance, model and prompt revision, reviewed head SHA,
relevant read results, review/reply permalinks or captured payloads, before/after
diffs, and escalation outcomes. The validation PR description must narrate the
PR #830 sequence and state observed results for both roles, plus negative trust
cases and any unavailable live checks. This design PR documents verified historical
evidence and proposed checks; it does not claim to have replayed changed prompts.

## Out of scope

- Automatically editing or reconciling linked issues, including Issue #821.
- Changing review-trigger authorization, `AGENT_ALLOWLIST`, workflow events,
  concurrency, labels, GitHub App permissions, or agent identities.
- Editing container entrypoints, adding deterministic policy middleware, or
  extending the rule to other action prompts in this issue.
- Automatically repairing PR #830 or adjudicating every finding from PR #820.
- Treating maintainer prose as authorization to bypass security or branch protection.
- A general prompt-injection defense or a hard security guarantee from model
  compliance. The policy is prompt-level behavior under existing token boundaries;
  acceptance requires adversarial negative cases, not a claim of enforced isolation.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|------------|
| Issue #848 | Canonical review standard and reviewer prompt: precedence, authenticated history reads, existing-thread handling, and reviewer escalation. | None |
| Issue #849 | Developer response prompt: authenticated history, pre-edit conflict check, linked disagreement replies, timing, and escalation. | None |
| Issue #850 | End-to-end validation: PR #830 replay, trust-negative and history/timing cases, and recorded evidence for both roles. | Issues #848, #849 |

The two implementation tasks have disjoint file ownership and can proceed in
parallel against this shared design once the human approves it. End-to-end
validation depends on both. Native GitHub blocked-by edges mirror this table;
all sub-issues remain `draft` until the design is merged. No `README.md` setup
update is needed because configuration and operator setup do not change.
