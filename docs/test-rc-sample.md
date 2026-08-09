# Conflict resolution test sample

This file is used to manufacture a conflict for validating the `resolve-conflicts`
action (Issue #109).

## Section A — Configuration

The default timeout for agent runs is **200 turns**, increased to accommodate
longer tasks.

## Section B — Logging

Logs are written to stdout using the `log()` helper:

```bash
log() {
    echo "[agent] $(date -Iseconds) $*"
}
```

## Section C — Notes

This file is safe to delete once validation is complete.
