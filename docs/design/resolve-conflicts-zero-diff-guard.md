# Design: resolve-conflicts zero-diff guard — justified ours-equal resolutions

**Issue:** [#260](https://github.com/mfrancza/agentic-development-workflow/issues/260)
**Parent designs:** [docs/design/resolve-conflicts.md](resolve-conflicts.md) (Issue #54), [docs/design/resolve-conflicts-entrypoint.md](resolve-conflicts-entrypoint.md) (Issue #63)

## Requirements as understood

The zero-diff verification in `action_resolve_conflicts`
(`docker/scripts/entrypoint.sh`, lines ~780–812) escalates any conflicted file
whose staged resolution is identical to the PR branch's version
(`git diff --cached --quiet HEAD -- <file>`). The guard was added in PR #239 to
catch wholesale "ours" resolutions that silently discard the base side's
changes. Per `docs/design/resolve-conflicts.md`, such a result requires
escalation rather than a silent merge commit — this is by design, not a bug.

The problem (issue #260) is that the guard cannot distinguish:

- **Lazy/wrong ours-wholesale**: Claude kept the PR side without considering
  the incoming hunk, silently discarding a real change from the base branch.
- **Correct ours**: The PR side's version is the right resolution — the
  incoming hunk contained something that the PR already superseded, reverted,
  or correctly overrode — and no preservation is needed.

Evidence cited in the issue:

- **Test PR #237**: Three runs (2026-08-10 and 2026-08-26 twice) all ended in
  zero-diff escalation. The fixture's only conflicting difference was one
  sentence whose correct resolution was the PR side's text — a genuine
  correct-ours case that always escalated. (The fixture is being rebuilt in
  issue #65 so both sides carry must-combine changes; the guard still needs
  fixing independently.)
- **Real PR #251** (2026-08-23): Escalated with the zero-diff signature and
  was resolved manually in-session. Conflicts where one side is simply correct
  (e.g. a PR that bumps a version higher than the base branch's concurrent
  patch bump) are common in practice.

The parent design doc (`resolve-conflicts.md`, "Fallback: abort and flag")
says "merge produces an empty diff for a file that had conflicts" → escalate.
That spec must be updated to reflect this design.

## Decisions

### Decision 1 — Adopt option 2: Claude explicitly justifies ours-equal resolutions

The issue names three options. This design adopts **option 2** (Claude
justifies ours-equal resolutions). Options 1 and 3 are rejected:

**Option 1 (keep guard, document the limitation):** The escalation comment is
reworded to say "this may be correct" to ease the human's confirm step.
Accepted if escalation volume is low. Rejected here because PR #251 shows
this class recurs on real PRs, not just fixtures. "Low volume" is not
guaranteed, and requiring a human for every correct ours-resolution adds
friction that accumulates.

**Option 3 (compare against both parents, per-hunk analysis):** Would require
reconstructing which parts of the file were inside the conflict markers (vs.
outside), comparing the incoming parent's content against the staged result,
and distinguishing hunk-level from file-level differences. The issue
acknowledges this "requires per-hunk analysis" and `git merge-file` replay.
The implementation complexity is high relative to the value, especially given
that option 2 provides the same safety guarantee (an explicit human-readable
justification that reviewers can verify) with a much simpler entrypoint change.
Deferred as a future enhancement if option 2's false-negative rate (wrongly
accepted ours resolutions) becomes a problem.

**Option 2 (Claude justifies):** When the staged result equals HEAD for a
file, Claude must have already explained *why* in the resolution summary.
The entrypoint checks for the structured marker and accepts if found; it
escalates (as before, but with improved comment) if no justification is
present. This:
- Unblocks the common case of genuinely-correct ours resolutions.
- Keeps a real check: Claude must acknowledge it is keeping the PR side and
  name the incoming content it is discarding.
- Adds zero new Claude invocations (the justification lives in the existing
  resolution summary, which is already required for every run).
- Makes the justification visible to PR reviewers (the resolution summary
  is posted as a PR comment), so a wrong justification can be caught in review.

### Decision 2 — Justification required in the original prompt; no second invocation

Two implementation sub-options for option 2:

**(a) Require justification in the original prompt** (chosen): Add a new rule
to `docker/scripts/prompts/resolve-conflicts.md` that says: whenever you
resolve a file as identical to the current PR branch version (i.e. you are
keeping `ours` wholesale), your resolution summary section for that file
**must** include a `**Kept PR side (ours):**` line explaining what the incoming
content was and why it needs no preservation.

The entrypoint then checks, for each zero-diff file, whether that marker
appears in Claude's output in association with the file name. If found → accept;
if missing → escalate (same behavior as today but with improved comment).

**(b) Second invocation for zero-diff files**: After the primary resolution
run, re-invoke `run_agent` with a targeted prompt for each zero-diff file,
asking Claude to justify keeping the PR side. Accept if Claude provides a
justification; escalate otherwise.

Approach (b) adds one full Claude API round trip per zero-diff file, increases
latency, and requires the entrypoint to have captured the conflict context
(e.g., the incoming file's content via `git show MERGE_HEAD:<file>`) before
Claude edited the files. Approach (a) is cheaper, faster, and just as
verifiable by humans — the resolution summary is already posted as a PR comment.

### Decision 3 — Marker check: file name + marker in the same output block

The entrypoint's zero-diff check is modified as follows. After collecting
`ZERO_DIFF_FILES`, for each file in that list the check is:

1. Does `CLAUDE_OUTPUT` contain `**Kept PR side (ours):**` at all?
2. Does the section of `CLAUDE_OUTPUT` for this file (the `### <file-path>`
   block, bounded by the next `###` heading) contain that marker?

Files where the marker is present in the correct section are removed from
`ZERO_DIFF_FILES` before the escalation check; files where it is missing
remain in the list and escalate.

A stronger alternative — verifying that the justification text contains a
verbatim substring from `git show MERGE_HEAD:<file>` (proving Claude actually
named the incoming content rather than writing a generic justification) — is
not adopted here. It would require capturing the incoming content of every
conflicted file before Claude runs and doing multi-line string matching in
bash. The value-to-complexity ratio is not proportionate given that PR review
already provides the human verification layer. This can be revisited if
unjustified-but-marked escalation evasion (a lazy agent writes `**Kept PR side
(ours):** looks fine` without naming the hunk) proves to be a real problem.

### Decision 4 — Escalation comment wording for unjustified zero-diff files

When a zero-diff file has no justification and escalation fires, the comment
is reworded from:

> "the conflict-resolution agent resolved the following files with no staged
> change relative to HEAD (possible wholesale 'ours' selection — conflicting
> changes may have been silently discarded)"

to:

> "the conflict-resolution agent resolved the following files with the result
> identical to the PR branch's version and no explicit justification for
> keeping the PR side. This may be correct if the incoming hunk needed no
> preservation, or may indicate a silent discard. Please verify whether the
> incoming changes should be retained."

This helps the human decide whether a quick confirm or a real fix is needed.

### Decision 5 — Update parent design docs to reflect the relaxed spec

`docs/design/resolve-conflicts.md` currently says "merge produces an empty diff
for a file that had conflicts" triggers the fallback. That clause is amended by
this design: "an empty diff with no justification triggers the fallback; an
empty diff with a valid justification in the resolution summary is accepted."

`docs/design/resolve-conflicts-entrypoint.md` Decision 4 describes the
verification steps. A note is added to that decision stating that the zero-diff
check accepts ours-equal resolutions when Claude includes the structured
justification marker — deferring the full detail to this document (which is
the design-level reference for the guard refinement).

Neither `AGENTS.md` nor `README.md` needs updating: the zero-diff guard is an
internal implementation detail of `action_resolve_conflicts`, not a
configuration surface visible to operators. The observable behavior change
(fewer false-positive escalations) is self-describing through the PR comments
the entrypoint generates.

## Out of scope

- **Option 3** (per-hunk comparison against both parents using `git merge-file`
  or MERGE_HEAD content verification) — deferred as a future enhancement.
- **Second Claude invocation** for zero-diff validation — rejected in Decision 2.
- **Changes to `agent-resolve-conflicts.yml`** — the workflow is unchanged; the
  fix is entirely inside the container entrypoint and prompt.
- **Conflicts on human-authored PRs** — out of scope for the whole
  `resolve-conflicts` feature.
- **Fixture repair for issue #65** — the test fixture is being rebuilt
  independently; this design improves the guard regardless of fixture state.
- **Model-specific behavior** — no per-PR model override is introduced (deferred
  per parent design).

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#320](https://github.com/mfrancza/agentic-development-workflow/issues/320) | Prompt: add ours-equal justification requirement to `docker/scripts/prompts/resolve-conflicts.md` (new `Critical rules` item + updated summary format section requiring `**Kept PR side (ours):**` when staged result equals HEAD) | — |
| [#322](https://github.com/mfrancza/agentic-development-workflow/issues/322) | Entrypoint: modify zero-diff check in `docker/scripts/entrypoint.sh` — for each zero-diff file check for the justification marker in `CLAUDE_OUTPUT`; remove justified files from escalation list; improve escalation comment per Decision 4 | — |
| [#323](https://github.com/mfrancza/agentic-development-workflow/issues/323) | Design doc updates: amend `docs/design/resolve-conflicts.md` fallback spec and add a note to `docs/design/resolve-conflicts-entrypoint.md` Decision 4 referencing this document | — |
| [#324](https://github.com/mfrancza/agentic-development-workflow/issues/324) | End-to-end validation: run the conflict resolver against a test PR whose correct resolution is the PR side's version; verify the resolver completes without escalation when Claude provides the justification marker; also verify that an ours-equal resolution with no justification still escalates | Issue #320, Issue #322, Issue #323 |

The prompt task and the entrypoint task can proceed in parallel — the prompt file
is read at runtime, not compiled into the entrypoint logic, and this design
document is the contract between them (the exact marker string is
`**Kept PR side (ours):**`). The design-doc-updates task can also proceed in
parallel; it touches only documentation files. The validation task depends on
all three implementation tasks.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.
