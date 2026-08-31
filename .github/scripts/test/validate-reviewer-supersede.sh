#!/bin/bash
# Validation helper for E2E test of issue #338.
# Intentionally missing set -euo pipefail — this is the seed defect
# that triggers a CHANGES_REQUESTED from the reviewer bot.

echo "Reviewer supersede validation: OK"
