#!/bin/bash
set -euo pipefail
# scratch-validation-helper.sh
#
# Scratch helper used during end-to-end validation of the respond-review
# self-trigger guard (issue #574).  DO NOT MERGE — this file exists only to
# provide reviewable code for case 1 of the validation plan; it will be removed
# before PR #579 is merged.

# Fetch the list of open agent-respond-review runs for a given PR.
# Usage: fetch_runs <pr_number>
fetch_runs() {
    pr=$1
    gh run list --workflow=agent-respond-review.yml \
        --branch "$(gh pr view "$pr" --json headRefName --jq .headRefName)" \
        --limit 10 \
        --json databaseId,conclusion,status,createdAt
}

# Check if a given run's respond-review job was skipped at the job gate.
# A Guard 1 skip means the caller if: evaluated to false — the job is not
# present in the run's job list at all (or has status 'skipped').
check_guard1() {
    run_id=$1
    jobs=$(gh run view "$run_id" --json jobs)
    echo "$jobs" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for job in d['jobs']:
    print(job['name'], job['conclusion'])
"
}

# Print a summary of evidence for each guard validation case.
summarize() {
    echo "=== Guard validation summary ==="
    echo "Case 1 (Guard 1): run IDs where respond-review job was skipped:"
    for run in "$@"; do
        check_guard1 "$run"
    done
}
