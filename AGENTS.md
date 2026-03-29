# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

This project builds a system for integrating coding agents into an issue-based software development lifecycle using GitHub. Agents have their own identities and isolated development environments, enabling human review policies and least-privilege access control.

## MVP Workflow

1. User creates a GitHub issue and assigns it to the developer agent
2. A container runs with the issue as a parameter
3. Agent reads the issue, creates a branch, implements a solution, and opens a PR
4. Developer agent responds to check failures and reviewer feedback
5. AI reviewer reviews code, closes resolved conversations, and approves when ready
6. PR is merged after all approvals; agent monitors deployment and fixes failures

## Expected Deliverables

- **Dockerfile** for the development agent container
- **Terraform** for GitHub repo setup, branch protection rules, agent identities, and GitHub Actions triggers
- **Local development guide** for running developer and code reviewer agents locally

## Claude Code Identity

When interacting with GitHub (PRs, comments, API calls), use the Claude Code app identity:

```sh
GH_TOKEN="$(~/.claude-code/get-token.sh)" gh <command>
```

## Key Design Constraints

- Agents must have separate GitHub identities from the user (distinct credentials, limited permissions)
- Agent containers must be isolated from user credentials
- All agent-human and agent-agent interaction happens via GitHub issue/PR comments
- Branch protection must require independent PR approval and prevent agents from pushing directly to main
