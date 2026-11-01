# Design: Release commit self-pins the review worker to its own tag

**Issue:** [#750](https://github.com/mfrancza/agentic-development-workflow/issues/750)

## Summary

`agent-review-reusable.yml` calls its worker by full reference pinned to a release
tag (because `./` resolves against the caller's repository and `uses:` cannot
read `helpers-ref`; see Issue #725 and PR #726). `main` can only pin a tag that
already exists, so the pin on `main` always lags one release — for example,
`v0.4.0` ships with `uses: …/agent-review-worker-reusable.yml@v0.3.0` because
`v0.4.0` did not exist at the moment `main` was tagged. The lag is harmless to
this repo (the worker contract has not drifted and the helpers all run from
`helpers-ref`), but it breaks adopters in two concrete ways:

1. Run pages and tagged source read as a forgotten bump — the `v0.4.0`
   adopter sees `…-worker-reusable.yml@v0.3.0` in both the job breadcrumbs
   and the tagged file on disk.
2. Adopters whose Actions policy narrows the guide's
   `…/.github/workflows/*@*` pattern to an exact-tag pin (e.g. `@v0.4.0`)
   get `startup_failure` on every review call because `@v0.3.0` is not on
   the allowlist. That is the exact failure PR #746 fixed by hand for this
   repo's own runs.

The historical pattern across tags (see Decision 1) confirms this is random
rather than disciplined: `v0.2.1` lagged, `v0.3.0` did not (because PR #746
force-bumped it just before the tag was cut), and `v0.4.0` lagged again.
README "Releasing" documents the manual "bump the pin first" step, but
nothing enforces it.

This design makes every release tag self-reference its own version by
having `release.yml` **build a dangling release commit** on top of the
target ref, **rewrite the self-pin to `vX.Y.Z`**, and **tag that commit**
rather than the input ref. `main` is unchanged by the release; this repo's
own reviews keep working off `main`'s pin to the latest existing tag (which
the #745 CI test keeps honest between releases).

## Requirements as understood

From issue #750, its grooming Q&A, and the maintainer's answer in the
grooming thread (Option A — dedicated release App identity):

1. **Self-pin invariant.** For every release tag `vX.Y.Z`, the file
   `.github/workflows/agent-review-reusable.yml` at that tag must contain
   `uses: mfrancza/agentic-development-workflow/.github/workflows/agent-review-worker-reusable.yml@vX.Y.Z`
   (and every other `mfrancza/agentic-development-workflow/.github/workflows/*@<ref>`
   self-reference on that commit must also resolve to `@vX.Y.Z`). The
   invariant applies to the exact tag; the moving major tag `vX` points at
   the same commit so the invariant transits.
2. **`main` must stay the way it is today.** The release commit is dangling
   (its only reachable parent is the input ref; no branch is updated), so
   nothing from this flow lands on `main`. `main`'s pin stays at the
   latest already-published tag, and the #745 contract test continues to
   guard that pin between releases.
3. **Rewrite is scoped to self-references.** Only
   `mfrancza/agentic-development-workflow/.github/workflows/*@<ref>` lines
   are rewritten. External `uses:` lines (e.g.
   `actions/checkout@…`), local `uses:` (e.g. `./…`), and non-workflow
   self-references (`.github/actions/…` paths — which do not appear in a
   `uses:` for a workflow) are left untouched.
4. **No-op is a no-op.** When the rewrite finds nothing to change
   (the self-pin already matches the target version, which is the state
   PR #746 established manually at `v0.3.0`), **no release commit is
   created**; the tag points at the input ref directly. The release
   workflow must not emit an empty commit.
5. **Verify the rewritten tree with the #745 test before pushing.** The
   pinned-worker-contracts test must pass against the release commit —
   catching rewrite bugs (e.g. a typo in the regex that leaves a stale
   pin) before any tag reaches `origin`.
6. **A `dry-run` input must exist.** It builds the release commit locally
   on the runner, runs the #745 verification against it, prints the
   resulting SHA + diff, and exits without pushing anything. Acceptance
   requires that a dry run produces a tag-eligible commit whose rewritten
   file pins `@<the-dry-run-version>`.
7. **An adopter caller on the new tag must see worker jobs on the same
   tag.** The practical acceptance test is that an external repo pinning
   `agent-review-reusable.yml@vX.Y.Z` runs a review whose worker job
   shows the same `vX.Y.Z` in its breadcrumbs.
8. **Token strategy — a dedicated release App (Option A).** The
   maintainer confirmed in the grooming thread that a separate release
   App identity is the right choice over the Option B REST-API workaround.
   The workflow mints the App's installation token for the push of the
   release commit's tag; the token holds `Contents: Write` **and
   `Workflows: Write`** (the latter is what `GITHUB_TOKEN` is denied, and
   is what makes tagging a commit that creates/modifies a file under
   `.github/workflows/` possible). Decision 3 covers the identity in
   detail.
9. **README "Releasing" is updated.** The manual "bump the pin first"
   step is removed, and the section explains that release tags are not
   on `main`'s first-parent history, so `git describe --tags` on `main`
   will not find the newest tag.

### Ambiguity resolutions

- **Which self-reference patterns count.** The grooming checklist says
  "the worker `uses:` line (and any other
  `mfrancza/agentic-development-workflow/.github/workflows/*@<ref>`
  self-reference)." Today only `agent-review-reusable.yml` has one such
  line (confirmed via grep; `test-reusable-portability.yml` has only a
  comment example that must not be rewritten). The rewrite logic treats
  the pattern as generic from the start so future self-references
  automatically get the same treatment, rather than hardcoding a single
  file/line.
- **Rewrite comments as well as `uses:` lines?** No. The pattern must
  only match live `uses:` lines, not matching strings inside comments
  (`#…`) — the comment on line 139 of `agent-review-reusable.yml` includes
  the literal `agent-review-worker-reusable.yml@<version>` as prose, and
  the #745 test already skips comment lines for the same reason. The
  rewrite step uses the same "skip lines whose first non-whitespace char
  is `#`" rule.
- **Dry-run vs throwaway real tag for acceptance.** Both are listed in
  the issue; the design implements **dry-run** as the primary acceptance
  path and leaves "cut a throwaway `vX.Y.Z` and delete it" available as
  a secondary smoke test. Dry-run is cheaper, repeatable, and does not
  pollute the Releases page; it is also a lasting capability the
  maintainer can re-run on any future release.
- **Should the `release-images.yml` workflow change?** No. Per the issue:
  `release-images.yml --ref vX.Y.Z` builds from whichever commit the
  tag points at, so pointing the tag at the dangling release commit
  (instead of the input ref) is transparent to image builds. The image
  workflow is unchanged.
- **Should `main`'s pin be auto-advanced after a release?** No. The
  grooming notes and issue body both describe this as "`main` keeps
  pinning the latest existing tag, so this repo's reviews keep working.
  #745's CI check still guards `main` between releases." The pin on
  `main` continues to be bumped on the normal PR cadence (and the #745
  CI test blocks a merge that drops behind). Automating the main-side
  bump is a separate concern (and would reintroduce the same `Workflows:
  Write` problem on the merge path); explicitly out of scope.

## Decisions

### Decision 1 — Rewrite inside `release.yml`; land on a dangling commit

**Decision.** `release.yml` creates the tag against a **release commit**
whose parent is the input ref (default `main` tip). The release commit is
produced by:

1. Checking out the input ref.
2. Running a rewrite step that updates every self-pin to the target
   version.
3. If `git diff` is non-empty, committing the changes with
   `github-actions[bot]` identity and a message of the shape
   `Release vX.Y.Z: self-pin workflow references`.
4. If no changes were produced, skipping the commit entirely; the tag
   points at the input ref SHA.

The release commit's only reachable parent is the input ref SHA; it is
never pushed to a branch. Only the tags (`vX.Y.Z` and the moving
`vX`) are pushed, and they point at the release commit (or the input
ref when no rewrite was needed).

**Rationale.** The invariant "every release tag reads its own version in
its own workflows" is enforceable only if the tag points at a commit
whose files are consistent with the tag's name. `main` cannot bear that
commit, because `main` must stay unchanged by the release flow (the
whole reason the lag exists is that at tag-cut time no previous commit
on `main` could reference the-tag-about-to-exist). A dangling commit
owned by the tag is the standard git pattern for this: identical to how
`git tag -s v1 && git checkout --detach … && git commit` would work by
hand, just performed inside the workflow with no human toil.

**Alternatives considered.**

- **Create and push a `release/vX.Y.Z` branch, tag its tip.** Rejected:
  adds a long-lived branch per release that nothing on this repo
  consumes, triples the per-release ref traffic for no observable
  benefit, and makes `git fetch` output noisier for consumers. The tag
  alone is the only ref an adopter pins against.
- **Rewrite on `main` first (via a bot-authored PR), then tag the merge
  commit.** Rejected: this is what README "Releasing" asked humans to
  do, and it is exactly the step that gets forgotten (confirmed by the
  v0.2.1 and v0.4.0 skews — see the historical pattern in the Summary).
  Shifting that to an agent-authored PR still blocks on branch
  protection's "require review" rule, so every release would require a
  rubber-stamp PR to merge before the tag could be cut. The dangling
  commit avoids the ceremony entirely.
- **Keep the pin bump as a hand-written release-prep PR, and have
  `release.yml` only check that it was done.** Rejected: the check-only
  variant is already what the #745 test provides on `main`. The problem
  the issue reports is that even when the check passes, cutting a
  release that pins `@vX.Y.Z` requires the tag to exist before the
  commit does — a chicken-and-egg that the dangling-commit approach is
  the only clean resolution for.

### Decision 2 — Rewrite logic lives in a TypeScript activity

**Decision.** The rewrite is implemented as
`.github/scripts/src/rewrite-self-ref-pins.ts` with
`.github/scripts/test/rewrite-self-ref-pins.test.ts`, wrapped by a
composite action at
`.github/actions/rewrite-self-ref-pins/action.yml`. The activity:

1. Takes two inputs: `workflows-dir` (default
   `.github/workflows`) and `target-version` (`vX.Y.Z`).
2. Enumerates every `.yml`/`.yaml` file in the directory.
3. For each file, scans line-by-line and applies the same
   `PINNED_SELF_REF_RE` pattern that `pinned-worker-contracts.test.ts`
   already uses:
   `/uses:\s+mfrancza\/agentic-development-workflow\/\.github\/workflows\/([\w.-]+\.ya?ml)@(\S+)/`.
4. Skips lines whose first non-whitespace character is `#` (comment
   lines must never be rewritten; this matches the #745 test's own
   skip rule).
5. Rewrites each match's `@<ref>` to `@<target-version>` in place.
6. Emits two outputs: `changed=true|false` and `files-changed=<count>`.

**Rationale.** This crosses the AGENTS.md shell-vs-TypeScript
threshold on at least two axes: it must parse YAML lines, apply a
regex pattern that must stay in step with the #745 test's regex, and
make a conditional "nothing to do" decision that becomes a shell
`if:` in the workflow. The repo pattern for this shape is a
TypeScript activity with Vitest coverage.

Co-locating the rewrite pattern as a TypeScript constant also lets
`rewrite-self-ref-pins.ts` and `pinned-worker-contracts.test.ts` share
the regex via `.github/scripts/src/lib/`, so a change to the matcher
cannot drift between the rewriter and its verifier.

**Alternatives considered.**

- **Inline `sed -i -E 's|…|…|'` in `release.yml`.** Rejected: the
  pattern already contains `/`, `.`, and `@`, so the sed escaping
  would be unreadable; a zero-match substitution would silently
  succeed without indicating that nothing was done (the "no changes"
  path then relies on `git diff --quiet`, which is fine for correctness
  but gives no diagnostic when the regex is subtly wrong); and the
  regex pattern lives in two places with no cross-check.
- **Inline shell with `yq` + jq.** Rejected: `yq` is not installed on
  `ubuntu-24.04` by default and would need an extra setup step. The
  value yq would add over the regex approach (full YAML parsing) is
  not needed — the self-pin line is a single-line scalar; there is no
  anchor/alias/multiline wrapping to worry about.
- **Reuse the existing `pinned-worker-contracts.test.ts` parser
  verbatim.** Rejected: the test file is scoped to assertions and
  does not expose the parse-rewrite primitive. Extract the shared
  regex and site-finding logic into `.github/scripts/src/lib/` and
  consume it from both; otherwise the two code paths drift.

### Decision 3 — Dedicated `release-agent` GitHub App (Option A)

**Decision.** Add a new GitHub App identity `release-agent`, scoped to:

- **Contents: Read & Write** — needed to create the dangling release
  commit on the runner (via `git`) and to push the tags.
- **Workflows: Read & Write** — the sole reason this App exists.
  GitHub rejects a push that creates or updates a file under
  `.github/workflows/` with any token (including `GITHUB_TOKEN`) that
  lacks the `workflows` permission. Updating `agent-review-reusable.yml`
  on the dangling release commit triggers that check for the tag push,
  because the tag points at a commit whose tree differs under
  `.github/workflows/` from any parent reachable on the server.
- **Metadata: Read** — standard App baseline (always required).

The App's Client ID and private key are stored as repo secrets
`RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`. `release.yml` is the
**only** workflow that mints a token from this App — the mint happens
in a single step that passes the token to the push step and nothing
else, and the token is **never injected into an agent container**
(same discipline as the `terraform-ci` App; see AGENTS.md § "Least-privilege
tokens").

**Rationale.** The maintainer confirmed Option A in the grooming
thread: "Let's go with option A — a separate identity is the better
solution here since the release process is specific to this repo."
This matches AGENTS.md's least-privilege principle (each privileged
scope lives on a dedicated identity rather than being appended to an
existing one), parallels the `terraform-ci` App's role as the single
holder of `Administration: Write`, and keeps the `developer-agent`
and `reviewer-agent` Apps free of the `Workflows: Write` scope — a
scope that would otherwise let any compromised developer-agent run
push arbitrary workflow files to any branch the App has write access
to. The release App never enters a container and is only used by
`release.yml`, which runs on manual `workflow_dispatch` from the
maintainer; the attack surface is the smallest possible for a scope
of this power.

**Threat model note.** `release.yml` runs on `workflow_dispatch` from
the base branch (there is no `pull_request_target`), so the attack
surface is "any workflow run authored by a maintainer with push
access." A compromised actor with push to `main` could already do
worse than modify a release — this scope does not expand the blast
radius beyond that. The App token's TTL is one hour (default for
`actions/create-github-app-token`), used in one push step inside a
single workflow run.

**Alternatives considered.**

- **Option B — REST API tag creation (`POST /git/commits` +
  `POST /git/refs`) with the workflow `GITHUB_TOKEN`.** Rejected per
  the maintainer's grooming decision. The grooming notes also flagged
  that the workflows-permission check "may apply via the API" — in
  practice GitHub's `git/commits` endpoint rejects a tree that
  changes files under `.github/workflows/` for any token without the
  `workflows` permission, so Option B would not sidestep the problem;
  it would move the failure from the push step to the API call. The
  maintainer's answer removes any need to test this edge case.
- **Reuse the `developer-agent` App with `Workflows: Write`
  appended.** Rejected: the developer App's token enters every agent
  container (see AGENTS.md § "Claude Code Identity"), so appending
  `Workflows: Write` would let any `AGENT_ACTION=implement` run push
  arbitrary workflow changes to any ref the App can write — the
  exact scope-split hygiene the reviewer/developer separation
  guards.
- **Use a human PAT with `workflow` scope.** Rejected per AGENTS.md
  defaults: PATs are long-lived, tied to a human account, and hard
  to rotate; the whole App-identity pattern exists to avoid this.
- **Only mint the release token when `inputs.dry-run == false`.**
  Partially adopted: the token mint step runs always, but the push
  step is gated on `dry-run != true`. The mint-always posture keeps
  the token-plumbing branch out of the hot path and makes dry-run
  exercise the identical setup to a real release except for the
  push.

### Decision 4 — Verify the release commit with the #745 test before pushing

**Decision.** After the rewrite step (and the possible release commit)
completes, `release.yml` runs the existing
`pinned-worker-contracts.test.ts` via `vitest run` against the release
commit's working tree. The verification runs even on `dry-run: true`,
and a failure aborts the run **before** any tag or Release is
created. The dry-run path exercises identical verification but
skips the push.

**Rationale.** The acceptance criterion says "Verify the tagged
commit with the #745 test before pushing: the pinned worker must
exist at `<version>`, which is the release commit itself." The #745
test already encodes the right semantics (parse the self-pin,
validate the inputs/secrets against the pinned worker's contract);
adding a second checker here would drift from it. A green #745 test
against the release commit's tree is exactly the evidence that the
rewrite put the tree in the shape downstream adopters expect.

A thin inline sanity check *also* runs — after rewrite, assert that
`grep -c "@${_VERSION}"` on every workflow file that previously
matched the pattern returns at least one hit per file. This catches
the degenerate "regex matched zero things" bug that the #745 test
alone would miss on a repo that happens to have no self-references
(not today's state, but a defensive guard against future changes).

**Alternatives considered.**

- **Trust the rewrite and skip verification.** Rejected: a silently
  wrong rewrite publishes a broken tag, which is the exact failure
  class this design exists to prevent. The cost of running vitest
  once per release is seconds.
- **Reimplement the check inline in shell.** Rejected per Decision 2's
  reasoning — the regex and parser must stay in step across
  rewriter, tester, and workflow verifier; sharing one TypeScript
  implementation is the way.

### Decision 5 — `dry-run` input shape and semantics

**Decision.** Add `inputs.dry-run: boolean` (default `false`) to
`release.yml`. When `true`:

1. The rewrite step runs normally.
2. The release commit is created locally (so there is a real SHA to
   verify).
3. The #745 verification runs against that SHA.
4. The workflow prints a diagnostic block containing: the release
   commit SHA, the output of `git diff <input-ref> <release-commit>`,
   and a confirmation line like
   `Dry run complete: release commit <SHA> would be tagged as vX.Y.Z and v<X>.`.
5. **Neither tag is created**, **nothing is pushed**, and **no
   GitHub Release is created**.
6. The workflow exits 0 if the rewrite + verification succeeded,
   non-zero otherwise.

**Rationale.** The acceptance criterion makes `dry-run` first-class:
"A dry run (a `dry-run` input that builds the release commit without
pushing, or a throwaway version deleted afterwards) produces a tag
whose `agent-review-reusable.yml` pins `@<that tag>`." Including the
diff in the output makes the rewrite auditable at a glance without
anyone needing to check out the dangling SHA by hand.

The alternative — a throwaway real tag that gets deleted after
inspection — is slower, pollutes the Releases page (even deleted
releases leave UI residue and may remain in caches), and is
irreversible on image publication because `release-images.yml`
auto-fires on tag push and would publish `developer:vX.Y.Z` to GHCR
that then has to be deleted. Dry-run avoids all of that.

### Decision 6 — README "Releasing" updates

**Decision.** Update the "Releasing" section of `README.md`:

1. **Remove the first bullet** ("Bump the nested worker pin first…"
   through "…tag promptly after merging") — the rewrite inside
   `release.yml` makes this step unnecessary.
2. **Add a short note** that release tags are **not** on `main`'s
   first-parent history. Specifically: `git describe --tags` on
   `main` will not find the newest tag because the tag points at a
   dangling release commit, not at a `main` commit. The expected
   lookups are `gh release list` or `git ls-remote --tags origin`.
3. **Add a `dry-run` instruction** to the "Tag and publish" bullet
   showing how to preview the rewrite before cutting a real release:
   `gh workflow run release.yml -f version=vX.Y.Z -f dry-run=true`.
4. **Document the release-agent App** in README §1 (App creation
   list) and §3 (secrets list). Follows the terraform-ci App pattern
   verbatim.

**Rationale.** Per AGENTS.md § "Keeping Documentation Current", any
change that alters workflow behavior, secrets, or App permissions
updates README in the same PR. The three changes above cover each of
those axes.

**Alternatives considered.**

- **Leave the manual pin-bump bullet in place "just in case".**
  Rejected: README drift is harder to detect than code drift, and
  leaving a mutually-contradictory instruction next to the real
  flow invites error. The whole point of this design is to make the
  manual step unnecessary; the README must say so.

### Decision 7 — No change to `release-images.yml`, no change to `main`

**Decision.** `release-images.yml` and the `main` branch's pin are
both out of scope for this change. The image workflow fires on
`push: tags: 'v*'` and builds from whatever SHA the tag points at —
pointing the tag at the dangling release commit instead of the
input ref is transparent to it. `main`'s pin stays at the
latest-already-published tag and continues to be bumped on the
normal PR cadence, with the #745 CI test guarding it between
releases.

**Rationale.** The issue body is explicit: "`release-images.yml
--ref vX.Y.Z` builds from the tag, so it's unaffected" and "`main`
keeps pinning the latest existing tag, so this repo's reviews keep
working." Honoring this scope keeps the design surface tight and
leaves the two separately-maintained workflows alone. AGENTS.md
§ "Reverting or replacing code with a passing live-run history"
also applies: both files have passing live-run histories and no
runtime evidence requires changing them.

## Out of scope

- **Automatically bumping `main`'s pin after a release.** The grooming
  notes and the issue body both leave this to the normal PR cadence
  guarded by #745. Automating it is a separate design (and would
  reintroduce the same `Workflows: Write` push problem on the merge
  path, requiring the release-agent App to run on the merge event too).
- **Any change to `release-images.yml`.** The image workflow is
  unaffected by this change (Decision 7).
- **Rewriting non-workflow self-references.** Only
  `uses: mfrancza/agentic-development-workflow/.github/workflows/*@<ref>`
  patterns are rewritten. Terraform `source = "git::…?ref="` references
  and composite-action `uses: owner/repo/.github/actions/<name>@<ref>`
  references outside this repo are not in scope today; if a future
  self-pin lands in one of those surfaces, extend the activity in the
  PR that adds it.
- **Backfilling the invariant on existing tags.** `v0.2.1` and `v0.4.0`
  will remain as they are. The design covers all **future** release
  tags from the first release in which the new workflow lands.
- **Enforcing the invariant with a post-release check.** The #745
  pre-push verification (Decision 4) is the primary guard. A follow-up
  check that re-reads the published tag's `agent-review-reusable.yml`
  after the push would catch nothing new — if the pre-push verifier
  passes and the push succeeds, the pushed commit's tree is by
  definition what was verified. Not worth the extra step.
- **Migrating the existing #745 skip-on-missing-tag behavior.** The
  "tag not found; using branch copy" fallback in
  `pinned-worker-contracts.test.ts` stays as-is — it exists for the
  separate case where a PR *on main* bumps the pin to the next
  release before that release is cut, and is unrelated to the
  dangling-commit flow this design introduces.

## Task breakdown

Dependencies are recorded natively as GitHub blocked-by relationships
on the issues after creation. All agent-authorable sub-issues carry
`draft` + `enhancement`; the App-identity sub-issue additionally
carries `human-required` and is assigned to @mfrancza (parallel to
the terraform-ci App sub-issue #424).

| Task # | Issue | Task | Depends on |
|--------|-------|------|------------|
| 1 | Issue [#754](https://github.com/mfrancza/agentic-development-workflow/issues/754) | **Create the `release-agent` GitHub App identity (human, `human-required`).** Create the App in Settings → Developer settings → GitHub Apps with Repository permissions: Contents (R/W), Workflows (R/W), Metadata (R). Subscribe to no events. Uncheck the Webhook "Active" box. Install the App on this repository. Add `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` as repo Actions secrets. Update README §1 (App creation list) and §3 (secrets list) following the terraform-ci App's structure. Comment the App's slug (e.g. `mfrancza-release-agent[bot]`) and installation ID on the parent design-doc PR so Task 3 can wire it in. | — |
| 2 | Issue [#755](https://github.com/mfrancza/agentic-development-workflow/issues/755) | **Rewrite activity + tests.** Add `.github/scripts/src/rewrite-self-ref-pins.ts` with the inputs/outputs described in Decision 2, extract the shared `PINNED_SELF_REF_RE` pattern into `.github/scripts/src/lib/` and update `pinned-worker-contracts.test.ts` to import it (same regex, one source), add `.github/scripts/test/rewrite-self-ref-pins.test.ts` with Vitest coverage for: single-match file, multi-match file, no-match file, file with the pattern only inside a comment (must not rewrite), unrelated `uses:` lines (must not rewrite), unchanged pin (output `changed=false`). Add the composite wrapper `.github/actions/rewrite-self-ref-pins/action.yml` using the shared-scripts bootstrap pattern (per AGENTS.md § "Working-directory portability"). | — |
| 3 | Issue [#756](https://github.com/mfrancza/agentic-development-workflow/issues/756) | **Wire the rewrite + release commit + verification into `release.yml`.** After the existing checkout step, invoke the rewrite activity with `target-version: ${{ inputs.version }}`. When `changed == 'true'`, configure the `github-actions[bot]` identity and create the release commit with `git commit -m "Release ${_VERSION}: self-pin workflow references"`; the commit's parent is the input ref SHA, and no branch is updated. Run `vitest run test/pinned-worker-contracts.test.ts` from the release commit's working tree; abort on failure. Add the `dry-run` input (Decision 5) and gate the token-mint + push + Release-create steps on `inputs.dry-run != 'true'`. Replace the push identity for the tag push with the release-agent App token (via `.github/actions/agent-token` using `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`). Update README "Releasing" per Decision 6 in the same PR. | Task 1, Task 2 |
| 4 | Issue [#757](https://github.com/mfrancza/agentic-development-workflow/issues/757) | **End-to-end validation via dry-run and throwaway real tag.** Dispatch `release.yml` with `version=v99.99.99` and `dry-run=true` against `main`. Verify from the run logs: (a) the rewrite step reported `changed=true` (the current `main` pin is `@v0.3.0`, so a rewrite to `@v99.99.99` is expected), (b) the #745 verifier passed on the release commit, (c) the diagnostic diff shows exactly the self-pin line changing from `@v0.3.0` to `@v99.99.99`, (d) no tag, Release, or push happened. Then dispatch again with `dry-run=false` for a throwaway tag `v99.99.99` (immediately deleted via `gh release delete v99.99.99 --cleanup-tag` after inspection), confirming (a) the real tag was created, (b) `git show v99.99.99:.github/workflows/agent-review-reusable.yml` contains `@v99.99.99`, (c) the release-agent App token path worked. Comment the two run URLs on issue #750. If any failure surfaces, escalate with `human-required` for the maintainer to decide whether to re-run or re-design. | Task 3 |

Task 1 and Task 2 are independent and can proceed in parallel —
Task 1 is a one-maintainer-click App creation; Task 2 is agent-authorable
TypeScript. Task 3 depends on both: it needs the App secrets available
and it needs the rewrite activity to call. Task 4 is the end-to-end
validation and depends on everything else being in place.
