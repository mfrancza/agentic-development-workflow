# Auto-review canary: agent-authored non-standard branch prefix

**Purpose:** E2E validation that the auto-review gate change from Issue #561 enrolls agent-authored PRs on non-standard branch prefixes (PR from `validate/auto-review-canary`, not `agent/` or `design/`).

**Related issue:** #562
**Design reference:** `docs/design/auto-review-author-gate.md`

## What this file validates

This canary document exists solely to carry a commit on the `validate/auto-review-canary` branch so that a same-repo PR can be opened by `mfrancza-developer-agent[bot]`. The PR is expected to trigger the `auto-review` job in `agent-auto-trigger.yml` via the **author-identity clause** introduced in PR #604:

```yaml
github.event.pull_request.user.login == 'mfrancza-developer-agent[bot]'
```

Since this branch name does **not** start with `agent/` or `design/`, only the new author-identity OR clause can cause the job to fire. A skipped `auto-review` job on this PR would constitute a regression of the fix.

## Expected outcome

- `auto-review` job in `agent-auto-trigger.yml`: **runs** (not skipped)
- `agent:review` label applied to this PR: **yes**
- `agent-review.yml` downstream run: **scheduled**
