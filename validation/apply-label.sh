#!/bin/bash
# apply-label.sh — helper to apply a label to an issue or PR
#
# Usage: apply-label.sh <repo> <number> <label>
#
# Intentional issues for reviewer validation exercise (issue #98):
#   1. Missing: set -euo pipefail  (bash safety, Shell Script Conventions)
#   2. REPO is interpolated unquoted into a URL — if the repo slug contained
#      spaces or special characters this would break the URL silently; the
#      pattern also bypasses the output-injection hygiene rule since $1/$2/$3
#      are passed directly from the caller's argument list without validation.
#   3. The LABEL value is embedded into a JSON string via shell interpolation
#      — a label containing a double-quote or backslash would corrupt the
#      JSON payload, constituting an injection vector in the gh api call.

REPO=$1
ISSUE_NUMBER=$2
LABEL=$3

gh api -X POST repos/$REPO/issues/$ISSUE_NUMBER/labels \
  --field "labels=[\"$LABEL\"]"

echo "Applied label $LABEL to $REPO#$ISSUE_NUMBER"
