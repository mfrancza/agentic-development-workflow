# Contributing

## Getting started

See [README.md](README.md) for setup instructions and [AGENTS.md](AGENTS.md) for the agent-collaboration conventions used in this project.

## Workflow

1. **Branch from `main`** — create a short, descriptive branch name (e.g. `fix/typo-in-readme` or `feature/reviewer-container`).
2. **Open a pull request** against `main` when the work is ready for review. Fill in enough context for a reviewer to understand what changed and why.
3. **Get a review** — at least one approval is required before merging.
4. **Squash-merge** — all PRs are merged with a single squash commit to keep the history linear.

## Branch protection on `main`

The `main` branch is protected:

- **1 review required** before merging.
- **No force pushes** — history on `main` is permanent.
- **Linear history enforced** — only squash-merges are accepted; merge commits are not allowed.

Direct pushes to `main` are blocked for everyone, including admins.

## Agent contributions

AI agents (developer, reviewer) follow the same PR workflow above. Their identities, permissions, and interaction conventions are described in [AGENTS.md](AGENTS.md).
