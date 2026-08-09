# Conflict resolution test sample

This file is used to manufacture a conflict for validating the `resolve-conflicts`
action (Issue #109).

## Retry policy — base branch version

The agent uses exponential backoff with a **maximum of 5 retries**.

```bash
MAX_RETRIES=5
BACKOFF_SECONDS=2
```

## Section C — Notes

This file is safe to delete once validation is complete.
