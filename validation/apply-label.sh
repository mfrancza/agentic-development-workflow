#!/bin/bash
set -euo pipefail
# apply-label.sh — helper to apply a label to an issue or PR
#
# Usage: apply-label.sh <repo> <number> <label>

REPO=$1
ISSUE_NUMBER=$2
LABEL=$3

gh api -X POST "repos/$REPO/issues/$ISSUE_NUMBER/labels" \
  --field "labels[]=$LABEL"

echo "Applied label $LABEL to $REPO#$ISSUE_NUMBER"
