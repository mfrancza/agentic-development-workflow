# Contributing

## Outside contributions

This is a demonstration project — pull requests from outside collaborators are not accepted, and issue reports will not necessarily be acted on. If you have found a bug or want to suggest an improvement, you are welcome to open an issue to note it, but please be aware that the maintainers are under no obligation to act on external reports.

If you want to run the same agent-driven workflow in your own repository, see the [Reproduce this yourself](README.md#reproduce-this-yourself) section of the README. Most repo-side configuration is in this repo; a few one-time manual steps outside version control (creating GitHub Apps, adding secrets) are also required — the guide covers them.

## Collaborator workflow

Collaborators (those with write access to this repository) follow the workflow below.

See the [Reproduce this yourself](README.md#reproduce-this-yourself) section of [README.md](README.md) for setup instructions and [AGENTS.md](AGENTS.md) for the agent-collaboration conventions used in this project.

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
