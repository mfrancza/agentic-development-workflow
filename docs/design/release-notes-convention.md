# Design: Release Notes Convention

**Issue:** [#229](https://github.com/mfrancza/agentic-development-workflow/issues/229)

## Summary

Establish a lightweight release notes convention for this repository: where release notes live (a `CHANGELOG.md` file at the repo root), when they are written (each PR that lands on `main`), and how agents and contributors should add notes to them. The convention is documented in a short `CONTRIBUTING.md` addition and does not require automation or release tooling.

## Requirements (from issue #229)

1. Define **where** release notes live — a single location contributors and agents can easily find and update.
2. Define **when** notes are written — per PR, per milestone, or another cadence.
3. Define **how agents should contribute** — clear instructions for agents to follow when writing or updating notes.
4. Keep scope lightweight — a single short design doc and at most two follow-up tasks.

## Design

### Release notes location: a single `CHANGELOG.md` file

Release notes live in a **`CHANGELOG.md` file at the repository root**. This follows the [Keep a Changelog](https://keepachangelog.com/) convention — a simple, widely recognized format that does not require custom parsing or build tooling.

**Structure:** The file uses semantic versioning sections (e.g., `## [0.1.0] — 2026-08-02`) with categories for types of changes:

```markdown
## [Unreleased]

### Added
- New features for end users or operators.

### Changed
- Existing features that were enhanced or altered.

### Fixed
- Bug fixes.

### Deprecated
- Features marked for future removal.

### Removed
- Previously deprecated features that were deleted.

### Security
- Security vulnerability fixes.

## [0.1.0] — 2026-08-02
...
```

**Why this location:**
- Central, visible at repo root — no hunting through directories.
- Single file avoids fragment merging tooling.
- Keep a Changelog is a well-known standard.
- Manual-friendly: reviewers can easily audit notes for accuracy and tone during PR review.

### Release notes cadence: per PR, `Unreleased` section

Notes are **added or updated each time a PR lands on `main`**. The section is always called `Unreleased`; when a version is released (out of scope for this design), a maintainer renames `Unreleased` to a versioned section with a date.

**Responsibility:**
- **Developers and agents:** each PR author (or the agent on the developer's behalf) updates the appropriate subsection of `Unreleased` in `CHANGELOG.md` to summarize user-facing changes — what a user or operator would care about when upgrading.
- **Reviewers:** verify during PR review that notes are present, accurate, and categorized correctly (or request updates before merging).

**Guidance for deciding what to include:**
- **Include:** new agent actions, new workflow features, changes to configuration, API/flag additions or changes, bug fixes that affect behavior, security fixes, breaking changes.
- **Skip:** internal refactorings, test improvements, documentation-only changes (unless they document a new user-facing feature or deprecation), CI/tooling improvements not observable by users.

**Example:** A PR that adds the `agent:design` label would add:
```markdown
### Added
- `agent:design` label to trigger the designer agent on issues classified as `plan`.
```

### How agents contribute to release notes

**For the designer and developer agents:**

1. **Read the issue and PR scope.** If the change is user-facing (new labels, new agent actions, config changes, bug fixes), add a note. Internal improvements, test additions, and refactorings do not need notes.

2. **Determine the category.** Most agent work falls into `Added` (new feature) or `Fixed` (bug fix). Use `Changed` for backward-incompatible modifications, `Deprecated` for planned removals, `Removed` for deletions, and `Security` for vulnerability fixes.

3. **Write a one-line summary.** Agents should write clear, concise bullet points (1–2 sentences) that explain what changed and why a user cares. Avoid jargon; link to the issue if context is essential.

4. **Update the file in the PR.** When the agent opens a PR, it modifies `CHANGELOG.md` to add the note to the appropriate `Unreleased` subsection. If the file does not exist yet, the agent creates it with the template structure above.

5. **Reviewers verify.** Human or agent reviewers check the note during PR review and request changes if it is missing, inaccurate, or miscategorized.

**For humans contributing via PRs:**
- Follow the same guidance above: determine category, write a clear bullet, update `CHANGELOG.md` in the PR.

### Examples of what agents should write

**Scenario 1: Developer agent implementing a new feature (new agent action)**
- Issue: "Add a fix-deployment action to handle deployment failures"
- Change: new `AGENT_ACTION=fix-deployment` workflow
- Note: `### Added` → "New `agent-fix-deployment` workflow handles deployment failures and opens fix-up PRs automatically."

**Scenario 2: Developer agent fixing a bug**
- Issue: "Fix race condition in draft-label removal on design-PR merge"
- Change: fixed timing issue in `agent-design.yml`
- Note: `### Fixed` → "Fixed race condition when removing `draft` labels from sub-issues on design-PR merge."

**Scenario 3: Designer agent creating a new sub-issue for Terraform labels**
- Issue: "Design: Code Review Agent"
- Change: new Terraform resource for `agent:review` label
- Note: In the design PR for the Code Review Agent, the designer adds: `### Added` → "New `agent:review` label routes PRs to the code review agent for automated review."

## Out of scope

- **Release tooling and automation.** This design does not cover how to bump versions, tag releases, or generate release pages from the CHANGELOG. Those decisions are deferred to the first release; for now, maintainers manually decide versioning and release timing.
- **Multi-file CHANGELOG fragments and tooling** (like [towncrier](https://towncrier.readthedocs.io/)). The repo is not yet large enough to justify per-PR fragment files; a single file works for now.
- **Automated agent enforcement.** The design does not add CI rules that reject PRs missing CHANGELOG entries. Reviewers enforce the convention manually during PR review.
- **Retroactive release notes generation** from commit history or PR titles. Notes are curated by humans and agents during PR review, not machine-generated.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#230](https://github.com/mfrancza/agentic-development-workflow/issues/230) | Add CHANGELOG.md template to repo root; document convention in CONTRIBUTING.md | — |
| [#231](https://github.com/mfrancza/agentic-development-workflow/issues/231) | Update AGENTS.md + README.md to include release notes guidance for agents | [#230](https://github.com/mfrancza/agentic-development-workflow/issues/230) |
| [#232](https://github.com/mfrancza/agentic-development-workflow/issues/232) | Validation: submit a PR with release notes, verify review flow and format | [#230](https://github.com/mfrancza/agentic-development-workflow/issues/230), [#231](https://github.com/mfrancza/agentic-development-workflow/issues/231) |

**Parallelization:** Issue #230 (create CHANGELOG template and docs) is independent and can start immediately. Issue #231 (update agent/contributor docs) depends on #230 being complete (so docs reference a working example). Issue #232 (validation) depends on both.

The validation task should be a human-authored PR that exercises the convention end-to-end: it should include a substantive change (e.g., documentation update or small feature), add a CHANGELOG entry in the appropriate category, and verify that reviewers can easily audit it.
