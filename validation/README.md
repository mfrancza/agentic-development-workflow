# Validation artifacts — issue #98

This directory holds scratch files used for end-to-end validation of the
reviewer re-review loop (issue #98 / #41).  **These files are throwaway test
fixtures and must not be merged to main** — the PR is opened, exercised, and
then closed without merging.

## Files

- `apply-label.sh` — intentionally defective shell script used to give the
  reviewer something to flag: it is missing `set -euo pipefail`, uses
  unquoted positional parameters in a URL, and embeds a user-controlled value
  into a JSON string via shell interpolation.  Two distinct findings allow the
  validation to exercise:
  1. Initial review → two `REQUEST_CHANGES` threads
  2. First push (fix finding 1) → one thread resolved, one still open
  3. Second push (fix finding 2) → all threads resolved, `APPROVE`

## Validation steps

See issue #98 for the full acceptance checklist.
