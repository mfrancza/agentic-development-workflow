#!/bin/bash
# apply-label.sh — helper to apply a label to an issue or PR
#
# Usage: apply-label.sh <repo> <number> <label>
#
# Intentional issues for reviewer validation exercise (issue #98).
# Two distinct defects are present to allow multi-round re-review testing:
#
#   Issue A (bash safety): Missing "set -euo pipefail" — the script will
#   silently continue past failed commands and use unset variables.
#
#   Issue B (output-injection / security): The LABEL value is embedded
#   into a JSON string via shell interpolation — a label value containing
#   a double-quote or backslash would corrupt the JSON payload sent to the
#   GitHub API, constituting an injection vulnerability.

REPO=$1
ISSUE_NUMBER=$2
LABEL=$3

gh api -X POST repos/$REPO/issues/$ISSUE_NUMBER/labels \
  --field "labels=[\"$LABEL\"]"

echo "Applied label $LABEL to $REPO#$ISSUE_NUMBER"
