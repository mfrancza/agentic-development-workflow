#!/bin/bash

# Freshness guard for action_fix_checks().  Keep this separate from the
# entrypoint so the post-lock behaviour can be exercised without starting an
# agent container.

fix_checks_allowlist_is_valid() {
    jq -e '
        type == "array" and
        length > 0 and
        all(.[]; type == "string")
    ' >/dev/null 2>&1 <<< "${FIX_CHECKS_ALLOW:-}"
}

# Populates FIX_CHECKS_SNAPSHOT with allowed check runs for $1.  The Checks API
# name is deliberately the only name considered here: gh pr checks can return
# a rendered/decorated label rather than the canonical check-run name.
fix_checks_snapshot() {
    local head_sha="$1"
    local check_runs

    check_runs="$(gh api --paginate \
        "repos/${GITHUB_REPO}/commits/${head_sha}/check-runs?per_page=100" \
        --jq '.check_runs[] | {name, status, conclusion}')"

    FIX_CHECKS_SNAPSHOT="$(printf '%s\n' "$check_runs" | jq -cs \
        --argjson allowed "$FIX_CHECKS_ALLOW" \
        '[.[] | select(.name as $name | $allowed | index($name))]')"
}

fix_checks_snapshot_count() {
    local filter="$1"
    jq -r "$filter" <<< "$FIX_CHECKS_SNAPSHOT"
}

# Returns 0 when action_fix_checks() should invoke the agent, and 1 when this
# queued run is obsolete or not authorised to do work.
fix_checks_should_run() {
    local head_sha trigger_sha wait_seconds deadline pending_count failure_count

    if gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --json labels \
        --jq '.labels[].name' | grep -Fxq 'human-required'; then
        log "PR #${GITHUB_PR_NUMBER} is labeled 'human-required' — skipping fix-checks"
        return 1
    fi

    if ! fix_checks_allowlist_is_valid; then
        log "FIX_CHECKS_ALLOW is missing, malformed, or empty — skipping fix-checks"
        return 1
    fi

    head_sha="$(git rev-parse HEAD)"
    trigger_sha="${GITHUB_HEAD_SHA_AT_TRIGGER:-}"
    fix_checks_snapshot "$head_sha"
    pending_count="$(fix_checks_snapshot_count '[.[] | select(.status != "completed")] | length')"
    failure_count="$(fix_checks_snapshot_count '[.[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required")] | length')"

    if [[ -n "$trigger_sha" && "$head_sha" != "$trigger_sha" ]]; then
        # A run queued for an older head can only be waiting on the previous
        # agent's replacement checks.  If neither kind of relevant check is
        # present, it is simply obsolete.
        if (( pending_count == 0 && failure_count == 0 )); then
            log "HEAD changed since trigger and no allowed checks remain actionable or pending — skipping fix-checks"
            return 1
        fi

        wait_seconds="${FIX_CHECKS_WAIT_SECONDS:-900}"
        if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]]; then
            log "FIX_CHECKS_WAIT_SECONDS='${wait_seconds}' is invalid; using 900 seconds"
            wait_seconds=900
        fi

        if (( pending_count > 0 )); then
            log "HEAD changed since trigger; waiting up to ${wait_seconds}s for ${pending_count} allowed replacement check(s)"
            deadline=$((SECONDS + wait_seconds))
            while (( pending_count > 0 && SECONDS < deadline )); do
                sleep 5
                fix_checks_snapshot "$head_sha"
                pending_count="$(fix_checks_snapshot_count '[.[] | select(.status != "completed")] | length')"
            done
            if (( pending_count > 0 )); then
                log "Timed out waiting for allowed replacement checks; re-evaluating current failures"
            fi
        fi
    else
        log "HEAD matches trigger (or trigger SHA is unavailable); allowed pending checks do not block this fix"
    fi

    # Always use a fresh snapshot for the final decision, including after a
    # zero-second wait and after a stale-head no-pending snapshot.
    fix_checks_snapshot "$head_sha"
    failure_count="$(fix_checks_snapshot_count '[.[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required")] | length')"
    if (( failure_count == 0 )); then
        log "No allowed actionable checks remain on ${head_sha} — skipping fix-checks"
        return 1
    fi

    log "Found ${failure_count} allowed actionable check(s) on ${head_sha}"
    return 0
}
