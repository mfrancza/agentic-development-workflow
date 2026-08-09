# Conflict resolution test sample

This file is used to manufacture a conflict for validating the `resolve-conflicts`
action (Issue #109).

## Retry policy — PR branch version

The agent uses a **no-retry policy**: on failure, exit immediately and let the
workflow restart the container with a clean state.

```bash
MAX_RETRIES=0
FAIL_FAST=true
```

## Section C — Notes

This file is safe to delete once validation is complete.
