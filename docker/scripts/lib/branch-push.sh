#!/usr/bin/env bash

branch_push_review_failure() {
    log "branch-push: $1; branch=$2 start=$3 observed=$4 local=$5. Publication failed; rerun from the current remote or recover local commits from the run."
    return 1
}

branch_push_review() {
    local branch="${1:-}" start="${2:-}" observed="unavailable" head="unavailable"
    local resolved_start remote_ref ancestry_status
    head="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || head="unavailable"

    if [[ -z "$branch" ]] || ! git check-ref-format "refs/heads/${branch}"; then
        branch_push_review_failure "invalid branch; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi
    if [[ -z "$start" ]] || ! resolved_start="$(git rev-parse --verify --end-of-options "${start}^{commit}" 2>/dev/null)" || [[ "$resolved_start" != "$start" ]]; then
        branch_push_review_failure "invalid original commit; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi
    if [[ "$head" == "unavailable" ]]; then
        branch_push_review_failure "cannot resolve local HEAD; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi

    remote_ref="refs/remotes/origin/${branch}"
    if ! git fetch --no-tags origin "+refs/heads/${branch}:${remote_ref}"; then
        branch_push_review_failure "fetch failed; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi
    if ! observed="$(git rev-parse --verify --end-of-options "${remote_ref}^{commit}" 2>/dev/null)"; then
        observed="unavailable"
        branch_push_review_failure "cannot resolve remote commit; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi

    if git merge-base --is-ancestor "$observed" "$head"; then
        if git push origin "HEAD:refs/heads/${branch}"; then
            return 0
        fi
        branch_push_review_failure "normal push rejected; no force push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    else
        ancestry_status=$?
    fi
    if [[ "$ancestry_status" -ne 1 ]]; then
        branch_push_review_failure "remote ancestry check failed; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi
    if git merge-base --is-ancestor "$head" "$observed"; then
        branch_push_review_failure "remote is ahead; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    else
        ancestry_status=$?
    fi
    if [[ "$ancestry_status" -ne 1 ]]; then
        branch_push_review_failure "local ancestry check failed; no push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi
    if [[ "$observed" != "$start" ]]; then
        branch_push_review_failure "remote changed during the run; no force push attempted" "$branch" "$start" "$observed" "$head"
        return 1
    fi
    if git push --force-with-lease="refs/heads/${branch}:${start}" origin "HEAD:refs/heads/${branch}"; then
        return 0
    fi
    branch_push_review_failure "explicit-lease push rejected; no retry attempted" "$branch" "$start" "$observed" "$head"
    return 1
}
