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
3. **Rewrite is scoped to self-references and is anchor-driven.** Only
   `mfrancza/agentic-development-workflow/.github/workflows/*@<ref>` lines
   are rewritten, and only when the line is **explicitly marked** by a
   sentinel comment (`# release-self-pin`) on the line directly above it
   (see Decision 2). External `uses:` lines (e.g. `actions/checkout@…`),
   local `uses:` (e.g. `./…`), unanchored self-pins (none today, but if
   one were added the completeness test fails on PR), and non-workflow
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
  the issue, but a throwaway real tag is **not** safely disposable under
  this design, so the design implements **dry-run only**. The reason:
  the release-ci App token push (unlike the current `GITHUB_TOKEN`
  push — see README "Releasing", "tags pushed with the workflow
  `GITHUB_TOKEN` don't trigger other workflows") **does** fire
  downstream workflows. A throwaway `vX.Y.Z` would therefore auto-fire
  `release-images.yml` and publish `developer:vX.Y.Z`, `reviewer:vX.Y.Z`,
  and the moving `developer:vX` / `reviewer:vX` image tags to GHCR; the
  release workflow itself also advances the moving `vX` git tag.
  `gh release delete vX.Y.Z --cleanup-tag` only removes the Release and
  the exact tag — it does **not** revert the moving git tag or the
  GHCR artifacts, so a throwaway `v99.99.99` would leave `v99`, four
  GHCR image tags, and the manifest history behind. Dry-run is the
  primary acceptance path; it is cheaper, repeatable, does not pollute
  the Releases page or GHCR, and is a lasting capability the maintainer
  can re-run on any future release. Validation of the App-token push
  itself happens on the first real release (and if that push fails,
  the recovery path is the same `gh workflow run release-images.yml`
  escape hatch that exists today).
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

### Decision 2 — Anchor-driven rewrite in a TypeScript activity

**Decision.** The rewrite is implemented as
`.github/scripts/src/rewrite-self-ref-pins.ts` with
`.github/scripts/test/rewrite-self-ref-pins.test.ts`, wrapped by a
composite action at
`.github/actions/rewrite-self-ref-pins/action.yml`. Crucially the
rewrite target is **declared in-source** by a sentinel anchor
comment, not inferred from a global pattern scan. The pattern on
every self-pin is:

```yaml
# release-self-pin: <worker-filename>  # rewritten at release by .github/actions/rewrite-self-ref-pins
uses: mfrancza/agentic-development-workflow/.github/workflows/<worker-filename>@v0.3.0
```

The activity:

1. Takes two inputs: `workflows-dir` (default `.github/workflows`)
   and `target-version` (`vX.Y.Z`).
2. Enumerates every `.yml`/`.yaml` file in the directory and, for
   each file, scans only for the anchor comment pattern
   `# release-self-pin: <worker-filename>` (first non-whitespace `#`,
   literal `release-self-pin:` tag).
3. For each anchor hit, examines the **next non-blank line**. It
   must be a `uses:` line that matches
   `mfrancza/agentic-development-workflow/.github/workflows/<worker-filename>@<ref>`
   where `<worker-filename>` equals what the anchor declared. If it
   does not, the activity **aborts with a diagnostic** citing the
   file and line — the anchor is a hard contract, not a hint.
4. Rewrites each matched `@<ref>` to `@<target-version>` in place.
   An anchor that is already at the target version is a no-op (and
   counts toward `changed=false`).
5. Emits two outputs: `changed=true|false` and `files-changed=<count>`.

The anchor comment is added to `agent-review-reusable.yml` in the
same PR as the rewrite activity (Task 2); the completeness test
below guards that no future self-pin can be added without one.

**Why anchor-driven, not pattern-scanned.** A broad "find every
`uses: mfrancza/…@<ref>` and rewrite it" step is hard to review in
isolation — a reader of a workflow file cannot tell which lines the
release process will mutate. The anchor flips that: every
rewrite-target is marked in-source and names the worker it is
pinning, so the rewrite surface is auditable from the workflow file
alone. The rewriter's own logic shrinks to "find the anchor, verify
the next line, swap the `@<ref>` suffix" — a function with a tiny
test matrix (match / anchor-without-matching-uses / already-at-target
/ unrelated `uses:` left alone).

The version itself cannot be factored out of the `uses:` line into a
variable: GitHub Actions does not interpolate expressions in `uses:`
values, so the version must physically live inside the pin string.
What *can* be factored out is the **location** of the pin — which is
exactly what the anchor does.

**Companion completeness test (co-located with the #745 test).** A
test added alongside `pinned-worker-contracts.test.ts` enumerates
every `uses: mfrancza/agentic-development-workflow/.github/workflows/*@<ref>`
line in the repo (reusing the existing `PINNED_SELF_REF_RE` scan)
and asserts each is immediately preceded by a matching
`# release-self-pin: <worker-filename>` anchor. A new self-pin added
without an anchor fails on PR before merge, and the rewriter can
rely on the invariant that every self-pin it should touch is
anchored.

The regex `PINNED_SELF_REF_RE` thus has two consumers (the #745
contract test and the new completeness test). It is extracted into
`.github/scripts/src/lib/` so both import the same source; the
rewriter itself does not use the regex because its target is the
anchor, not the pattern.

**Rationale.** This crosses the AGENTS.md shell-vs-TypeScript
threshold on at least two axes: it must parse YAML lines, enforce
the anchor-matches-next-line contract with a clear diagnostic on
violation, and make a conditional "nothing to do" decision that
becomes a shell `if:` in the workflow. The repo pattern for this
shape is a TypeScript activity with Vitest coverage. Fixture-based
tests (anchor + matching uses: line → rewrite; anchor + mismatched
next line → abort; uses: line without anchor → ignored; anchor +
already-target → no-op; etc.) are self-contained and don't require
constructing realistic full workflow files.

**Alternatives considered.**

- **Broad regex scan with no anchor** (original design in this
  doc's first draft). Rejected per maintainer review feedback: the
  rewrite surface is implicit and un-auditable from workflow files.
  Any `uses:` matching the pattern would be rewritten whether that
  was the author's intent or not. The anchor makes intent explicit
  and keeps a reader of the workflow file in the loop.
- **Factor the version into a separate file (e.g.
  `.github/release-pin-version`) that `uses:` lines reference.**
  Rejected because GitHub Actions does not interpolate expressions
  in `uses:`; the version must be a literal substring of the pin
  string. A separate version file would still require a rewrite
  step to propagate the value into `uses:` lines, so it adds a
  surface without removing one.
- **Workflow-template generation** (`agent-review-reusable.yml.template`
  → `agent-review-reusable.yml` at release). Rejected as
  disproportionate: every day-to-day edit to a workflow would need
  to go through the template and be regenerated. The anchor
  approach achieves the same reviewability (humans see what the
  release will change) with zero day-to-day friction.
- **Explicit pin manifest** (`.github/release-pins.yaml` listing
  `(file, workflow)` targets). Rejected as a second source of
  truth: a reader of `agent-review-reusable.yml` would still not
  know the line is rewrite-managed without opening the manifest.
  The in-source anchor is where that information actually belongs,
  and the completeness test substitutes for the manifest's role of
  enumerating expected targets.
- **Inline `sed -i -E 's|…|…|'` in `release.yml`.** Rejected: no
  diagnostic on zero-match, no anchor contract to enforce, and
  escaping of `/`, `.`, and `@` makes the one-liner unreadable.
- **Inline shell with `yq` + jq.** Rejected: `yq` is not installed
  on `ubuntu-24.04` by default and the self-pin line is a
  single-line scalar; full YAML parsing adds no value.
- **Reuse the existing `pinned-worker-contracts.test.ts` parser
  verbatim.** Rejected: the test file is scoped to assertions and
  does not expose the parse-rewrite primitive. The regex extraction
  into `.github/scripts/src/lib/` covers the shared piece (used by
  the #745 test and by the new completeness test); the rewriter
  itself does not consume the regex.

### Decision 3 — Dedicated `release-ci` GitHub App (Option A)

**Decision.** Add a new GitHub App identity `release-ci`, scoped to:

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

The name follows the `terraform-ci` convention: this App is a
credential for a CI job, not an agent identity — no agent container or
model is involved in a release. In this repository the App is named
`mfrancza-release-ci` (bot login `mfrancza-release-ci[bot]`); adopters
who fork the release process choose their own name.

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
4. **Document the release-ci App** in README §1 (App creation
   list) and §3 (secrets list). Follows the terraform-ci App pattern
   verbatim.
5. **Replace the "Build the images" manual-dispatch bullet.** Under
   the release-ci App token, the tag push now triggers
   `release-images.yml` automatically — the rationale in the current
   bullet ("tags pushed with the workflow `GITHUB_TOKEN` don't trigger
   other workflows") no longer applies to the real-release path.
   Replace the bullet with a one-line note: "Images build
   automatically on tag push; use `gh workflow run release-images.yml
   --ref vX.Y.Z -f tag=vX.Y.Z` only for a recovery re-push after a
   registry incident."

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

**Behavior note (not a file change).** `release-images.yml` is
triggered by `on: push: tags: 'v*'`. Today it is manually dispatched
after each release because the current `GITHUB_TOKEN`-based tag push
does not fan out to downstream workflows. Under the release-ci App
token (Decision 3), the tag push **does** fan out, so
`release-images.yml` will auto-fire on every real release. This is a
positive side effect (one fewer manual step), but it is why a
throwaway real tag is not disposable (see the ambiguity resolution
above) and why the README's "Build the images" bullet is replaced
rather than left in place (Decision 6, item 5).

## Out of scope

- **Automatically bumping `main`'s pin after a release.** The grooming
  notes and the issue body both leave this to the normal PR cadence
  guarded by #745. Automating it is a separate design (and would
  reintroduce the same `Workflows: Write` push problem on the merge
  path, requiring the release-ci App to run on the merge event too).
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
| 1 | Issue [#754](https://github.com/mfrancza/agentic-development-workflow/issues/754) | **Create the `release-ci` GitHub App identity (human, `human-required`).** Create the App in Settings → Developer settings → GitHub Apps with Repository permissions: Contents (R/W), Workflows (R/W), Metadata (R). Subscribe to no events. Uncheck the Webhook "Active" box. Install the App on this repository. Add `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` as repo Actions secrets. Update README §1 (App creation list) and §3 (secrets list) following the terraform-ci App's structure. Comment the App's slug (e.g. `mfrancza-release-ci[bot]`) and installation ID on the parent design-doc PR so Task 3 can wire it in. | — |
| 2 | Issue [#755](https://github.com/mfrancza/agentic-development-workflow/issues/755) | **Anchor + rewrite activity + completeness test.** (a) Add the `# release-self-pin: agent-review-worker-reusable.yml` anchor comment immediately above the existing self-pin line in `.github/workflows/agent-review-reusable.yml` (the one line of code change this release design puts on `main`). (b) Extract `PINNED_SELF_REF_RE` from `pinned-worker-contracts.test.ts` into `.github/scripts/src/lib/` and update the #745 test to import it. (c) Add `.github/scripts/test/anchor-completeness.test.ts` co-located with the #745 test, which uses the shared regex to scan every workflow file and asserts each self-pin `uses:` line is immediately preceded by a matching `# release-self-pin: <worker-filename>` anchor (fails the PR if any new self-pin lacks an anchor). (d) Add `.github/scripts/src/rewrite-self-ref-pins.ts` implementing the anchor-driven rewrite from Decision 2 (anchor locator → verify next non-blank line is the declared worker's `uses:` self-pin → rewrite the `@<ref>` suffix; abort on anchor-without-matching-uses). (e) Add `.github/scripts/test/rewrite-self-ref-pins.test.ts` with fixture coverage for: anchor + matching uses: → rewrite, anchor + already-target → no-op, anchor + mismatched next line → abort with diagnostic, uses: without anchor → left alone, multiple anchors in one file → all rewritten, no anchors in a file → file untouched. (f) Add the composite wrapper `.github/actions/rewrite-self-ref-pins/action.yml` using the shared-scripts bootstrap pattern (per AGENTS.md § "Working-directory portability"). | — |
| 3 | Issue [#756](https://github.com/mfrancza/agentic-development-workflow/issues/756) | **Wire the rewrite + release commit + verification into `release.yml`.** After the existing checkout step, invoke the rewrite activity with `target-version: ${{ inputs.version }}`. When `changed == 'true'`, configure the `github-actions[bot]` identity and create the release commit with `git commit -m "Release ${_VERSION}: self-pin workflow references"`; the commit's parent is the input ref SHA, and no branch is updated. Run `vitest run test/pinned-worker-contracts.test.ts` from the release commit's working tree; abort on failure. Add the `dry-run` input (Decision 5) and gate the **push + Release-create** steps on `inputs.dry-run != 'true'`; the token-mint step itself runs **always** (per Decision 3 and Task 4 acceptance item (e), the mint-always posture keeps the token-plumbing branch out of the hot path and makes dry-run exercise the identical setup to a real release except for the push). Replace the push identity for the tag push with the release-ci App token (via `.github/actions/agent-token` using `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`). Update README "Releasing" per Decision 6 in the same PR. | Task 1, Task 2 |
| 4 | Issue [#757](https://github.com/mfrancza/agentic-development-workflow/issues/757) | **End-to-end validation via dry-run only.** Dispatch `release.yml` with `version=v99.99.99` and `dry-run=true` against `main`. Verify from the run logs: (a) the rewrite step reported `changed=true` (the current `main` pin is `@v0.3.0`, so a rewrite to `@v99.99.99` is expected), (b) the #745 verifier passed on the release commit, (c) the diagnostic diff shows exactly the self-pin line changing from `@v0.3.0` to `@v99.99.99`, (d) no tag, Release, or push happened, (e) the release-ci App token-mint step still executed (the mint runs always; only the push is gated on `dry-run != true` per Decision 3), so the identity plumbing is exercised end-to-end even without the push. A throwaway real tag is **deliberately not** part of acceptance: under the release-ci App token the tag push auto-fires `release-images.yml` (publishing `developer:v99.99.99`, `reviewer:v99.99.99`, and the moving `developer:v99` / `reviewer:v99` image tags to GHCR) and the release workflow advances the moving `v99` git tag — `gh release delete --cleanup-tag` reverts neither, so the "throwaway" would leave `v99`, four GHCR image tags, and manifest history behind (see the ambiguity-resolution bullet). The App-token **push** itself is validated on the first real release instead; if that push fails, the recovery path is `gh workflow run release-images.yml --ref vX.Y.Z -f tag=vX.Y.Z` (the same escape hatch used today). Comment the dry-run run URL on issue #750. If any failure surfaces, escalate with `human-required` for the maintainer to decide whether to re-run or re-design. | Task 3 |

Task 1 and Task 2 are independent and can proceed in parallel —
Task 1 is a one-maintainer-click App creation; Task 2 is agent-authorable
TypeScript. Task 3 depends on both: it needs the App secrets available
and it needs the rewrite activity to call. Task 4 is the end-to-end
validation and depends on everything else being in place.
