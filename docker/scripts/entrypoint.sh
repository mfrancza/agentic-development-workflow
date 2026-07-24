#!/bin/bash
set -euo pipefail

# =============================================================================
# Developer Agent Entrypoint
# Dispatches to the appropriate action based on AGENT_ACTION.
# Each invocation is a short-lived container triggered by a GitHub event.
# =============================================================================

# Optional configuration (accept old names as a transient fallback; see #82)
AGENT_MODEL="${AGENT_MODEL:-${CLAUDE_MODEL:-sonnet}}"
AGENT_MAX_TURNS="${AGENT_MAX_TURNS:-${CLAUDE_MAX_TURNS:-100}}"
REVIEWERS="${REVIEWERS:-}"

SCRIPTS_DIR="/opt/agent"
WORK_DIR="/home/agent/work"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() {
    echo "[agent] $(date -Iseconds) $*"
}

resolve_provider() {
    local model="$1"
    case "$model" in
        sonnet|opus|haiku)
            echo "anthropic"
            ;;
        *)
            log "ERROR: Unknown model '${model}'. Supported values: sonnet, opus, haiku" >&2
            exit 1
            ;;
    esac
}

run_anthropic() {
    local prompt_file="$1"
    shift
    local user_prompt="$*"

    printf '%s\n' "$user_prompt" | claude --print \
        --dangerously-skip-permissions \
        --model "$AGENT_MODEL" \
        --max-turns "$AGENT_MAX_TURNS" \
        --system-prompt-file "${SCRIPTS_DIR}/prompts/${prompt_file}"
}

run_openai() {
    log "OpenAI runner not yet implemented (see issue #81)"
    exit 1
}

run_agent() {
    local prompt_file="$1"
    shift

    case "$AGENT_PROVIDER" in
        anthropic)
            run_anthropic "$prompt_file" "$@"
            ;;
        openai)
            run_openai "$prompt_file" "$@"
            ;;
        *)
            log "ERROR: Unknown provider '${AGENT_PROVIDER}'"
            exit 1
            ;;
    esac
}

setup_repo() {
    git config --global user.name "claude-dev-agent[bot]"
    git config --global user.email "claude-dev-agent[bot]@users.noreply.github.com"

    # Set up credential handling before any git operations
    export GIT_ASKPASS="${SCRIPTS_DIR}/git-askpass.sh"
    export GIT_TERMINAL_PROMPT=0

    log "Cloning ${GITHUB_REPO}"
    rm -rf "$WORK_DIR"
    gh repo clone "$GITHUB_REPO" "$WORK_DIR"
    cd "$WORK_DIR"
}

# -----------------------------------------------------------------------------
# Preamble: resolve provider and validate credentials/required vars
# (before any gh call, clone, or Claude invocation)
# -----------------------------------------------------------------------------

# 1. Resolve the provider from AGENT_MODEL; unknown model → fail loud
AGENT_PROVIDER="$(resolve_provider "$AGENT_MODEL")"

# 2. Validate the selected provider's API key
case "$AGENT_PROVIDER" in
    anthropic)
        : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
        ;;
esac

# 3. Validate remaining required vars
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPO:?GITHUB_REPO is required}"
: "${AGENT_ACTION:?AGENT_ACTION is required (implement|fix-checks|respond-review|fix-deployment|groom|design)}"

export GH_TOKEN

# -----------------------------------------------------------------------------
# Actions
# -----------------------------------------------------------------------------

action_implement() {
    : "${GITHUB_ISSUE_NUMBER:?GITHUB_ISSUE_NUMBER is required for implement}"

    log "Fetching issue #${GITHUB_ISSUE_NUMBER}"
    ISSUE_JSON="$(gh issue view "$GITHUB_ISSUE_NUMBER" --repo "$GITHUB_REPO" --json title,body,labels)"
    ISSUE_TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
    ISSUE_BODY="$(echo "$ISSUE_JSON" | jq -r '.body')"

    # Skip issues labeled 'draft' — they are awaiting design-PR merge.
    # Guard runs before setup_repo to avoid an unnecessary clone for skipped issues.
    if echo "$ISSUE_JSON" | jq -e '[.labels[].name] | any(. == "draft")' > /dev/null; then
        log "Issue #${GITHUB_ISSUE_NUMBER} is labeled 'draft' — skipping until design PR merges"
        return 0
    fi

    setup_repo

    BRANCH_NAME="agent/issue-${GITHUB_ISSUE_NUMBER}"
    log "Creating branch ${BRANCH_NAME}"
    git checkout -b "$BRANCH_NAME"

    log "Running Claude to implement solution"
    run_agent "implement.md" \
        "Implement a solution for this GitHub issue.

Repository: ${GITHUB_REPO}
Issue #${GITHUB_ISSUE_NUMBER}: ${ISSUE_TITLE}
Branch: ${BRANCH_NAME}

${ISSUE_BODY}"

    log "Verifying PR was opened for ${BRANCH_NAME}"
    # Query by branch name only (owner:branch is treated as a literal name by
    # gh and never matches).  Use a jq filter on headRepositoryOwner to exclude
    # PRs from forks with the same branch name.
    OWNER="${GITHUB_REPO%%/*}"
    PR_URL="$(gh pr list --repo "$GITHUB_REPO" --head "$BRANCH_NAME" --state open \
        --json url,headRepositoryOwner \
        --jq "[.[] | select(.headRepositoryOwner.login == \"$OWNER\")][0].url // empty")"
    if [ -z "$PR_URL" ]; then
        log "ERROR: no open PR found for ${BRANCH_NAME} (owner: ${OWNER}) — agent did not complete the issue→PR flow"
        exit 1
    fi
    log "Verified PR: ${PR_URL}"
}

action_fix_checks() {
    : "${GITHUB_PR_NUMBER:?GITHUB_PR_NUMBER is required for fix-checks}"

    setup_repo

    log "Checking out PR #${GITHUB_PR_NUMBER}"
    gh pr checkout "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO"
    BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"

    log "Fetching check failure details"
    FAILURE_DETAILS="$(gh pr checks "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" 2>/dev/null || echo "No details available")"

    log "Running Claude to fix check failures"
    run_agent "respond-to-checks.md" \
        "The following CI checks failed on PR #${GITHUB_PR_NUMBER}:

${FAILURE_DETAILS}

Fix the issues and commit the changes."

    log "Pushing fixes"
    git push origin "$BRANCH_NAME"
}

action_respond_review() {
    : "${GITHUB_PR_NUMBER:?GITHUB_PR_NUMBER is required for respond-review}"

    setup_repo

    log "Checking out PR #${GITHUB_PR_NUMBER}"
    gh pr checkout "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO"
    BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"

    log "Resolving merge-base against the PR's base branch"
    BASE_REF="$(gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --json baseRefName --jq '.baseRefName')"
    git fetch origin "$BASE_REF"
    BASE_SHA="$(git merge-base "origin/${BASE_REF}" HEAD)"
    COMMITS_SINCE_BASE="$(git log --pretty='format:%h %s' "${BASE_SHA}..HEAD")"

    log "Fetching reviews and comments (IDs preserved for replies)"
    REVIEWS_JSON="$(gh api "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/reviews" --jq '[.[] | {id, user: .user.login, state, body, submitted_at}]')"
    INLINE_COMMENTS_JSON="$(gh api --paginate "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/comments" --jq '[.[] | {id, in_reply_to_id, pull_request_review_id, user: .user.login, path, line, body, created_at}]')"
    ISSUE_COMMENTS_JSON="$(gh api --paginate "repos/${GITHUB_REPO}/issues/${GITHUB_PR_NUMBER}/comments" --jq '[.[] | {id, user: .user.login, body, created_at}]')"

    # Capture HEAD before Claude runs so we can detect whether HEAD changed
    # (new commits, amends, rebases, or any other history rewrite) — we only
    # re-request review when the agent actually changed the branch tip.
    HEAD_BEFORE_CLAUDE="$(git rev-parse HEAD)"

    log "Running Claude to address review feedback"
    run_agent "respond-to-review.md" \
        "Address review feedback on PR #${GITHUB_PR_NUMBER} in ${GITHUB_REPO}.

Branch: ${BRANCH_NAME}
Base ref: ${BASE_REF}
Base SHA (merge-base): ${BASE_SHA}

Commits already on this branch since base:
${COMMITS_SINCE_BASE}

Reviews (top-level review submissions):
${REVIEWS_JSON}

Inline review comments (each has an \`id\` for replying):
${INLINE_COMMENTS_JSON}

PR conversation comments:
${ISSUE_COMMENTS_JSON}"

    HEAD_AFTER_CLAUDE="$(git rev-parse HEAD)"
    if [ "$HEAD_BEFORE_CLAUDE" = "$HEAD_AFTER_CLAUDE" ]; then
        log "HEAD unchanged; skipping push and re-review request"
    else
        log "HEAD changed; determining push strategy"
        # Fetch the latest remote tip before the ancestry check so that any
        # concurrent pushes that landed during the Claude run are reflected;
        # failure here is non-fatal — we'll still attempt the push.
        git fetch origin "$BRANCH_NAME" 2>/dev/null || true
        # Determine the correct push strategy by examining the ancestry relationship
        # between the local HEAD and origin/$BRANCH_NAME:
        #   1. origin is ancestor of HEAD (fast-forward) → plain push
        #   2. HEAD is ancestor of origin (remote advanced beyond local) → fail;
        #      force-with-lease would silently drop those remote commits, and
        #      silently skipping would lose the agent's local commits — exit so
        #      the action can be retried after rebasing
        #   3. Neither is an ancestor of the other (diverged / history rewrite)
        #      → --force-with-lease (safe because we own the branch and the lease
        #      SHA matches exactly what we fetched above)
        if git merge-base --is-ancestor "origin/${BRANCH_NAME}" HEAD 2>/dev/null; then
            git push origin "$BRANCH_NAME"
            request_rereview "$GITHUB_PR_NUMBER"
        elif git merge-base --is-ancestor HEAD "origin/${BRANCH_NAME}" 2>/dev/null; then
            log "ERROR: remote branch has advanced beyond local HEAD; cannot push without losing remote commits — rebase local changes onto the updated remote branch and retry"
            exit 1
        else
            log "History rewrite detected; pushing with --force-with-lease"
            git push --force-with-lease origin "$BRANCH_NAME"
            request_rereview "$GITHUB_PR_NUMBER"
        fi
    fi
}

# Re-request review from every user and team currently assigned as a reviewer
# on the PR. "Currently assigned" is the union of:
#   - reviewers with a pending request (GitHub's `requested_reviewers` endpoint)
#   - reviewers who have already submitted a review (from `reviews`)
# GitHub removes a user from `requested_reviewers` once they submit a review, so
# both sources are needed to cover reviewers who already responded to an earlier
# round. Re-requesting a currently-pending reviewer is a harmless no-op.
#
# The PR author is excluded (an app cannot request a review from itself), and
# any error from the GitHub API is logged but does not fail the run — the code
# and replies have already been pushed at this point, so a failed re-review
# request should not mask the successful work.
request_rereview() {
    local pr_number="$1"

    log "Detected HEAD change; requesting re-review from all currently assigned reviewers on PR #${pr_number}"

    local pr_author_login auth_login pending_json reviewed_json users_json teams_json
    pr_author_login="$(gh api "repos/${GITHUB_REPO}/pulls/${pr_number}" --jq '.user.login' 2>/dev/null || echo "")"
    auth_login="$(gh api user --jq '.login' 2>/dev/null || echo "")"

    pending_json="$(gh api "repos/${GITHUB_REPO}/pulls/${pr_number}/requested_reviewers" 2>/dev/null)" || pending_json='{"users":[],"teams":[]}'
    reviewed_json="$(gh api --paginate "repos/${GITHUB_REPO}/pulls/${pr_number}/reviews" 2>/dev/null | jq -s 'add // []')" || reviewed_json='[]'

    users_json="$(jq -nc \
        --argjson pending "$pending_json" \
        --argjson reviewed "$reviewed_json" \
        --arg pr_author "$pr_author_login" \
        --arg auth_user "$auth_login" \
        '($pending.users // []) + ($reviewed // [])
         | map(.user.login // .login)
         | map(select(. != null and . != "" and . != $pr_author and . != $auth_user))
         | unique')"
    teams_json="$(jq -nc --argjson pending "$pending_json" \
        '($pending.teams // []) | map(.slug) | unique')"

    local user_count team_count
    user_count="$(echo "$users_json" | jq 'length')"
    team_count="$(echo "$teams_json" | jq 'length')"

    if [ "$user_count" -eq 0 ] && [ "$team_count" -eq 0 ]; then
        log "No prior reviewers found; nothing to re-request"
        return 0
    fi

    log "Re-requesting review from users=${users_json} teams=${teams_json}"
    local payload
    payload="$(jq -nc --argjson reviewers "$users_json" --argjson team_reviewers "$teams_json" \
        '{reviewers: $reviewers, team_reviewers: $team_reviewers}')"
    if ! echo "$payload" | gh api -X POST "repos/${GITHUB_REPO}/pulls/${pr_number}/requested_reviewers" --input -; then
        log "WARNING: failed to request re-review; continuing"
    fi
}

action_fix_deployment() {
    : "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required for fix-deployment}"
    : "${GITHUB_ISSUE_NUMBER:?GITHUB_ISSUE_NUMBER is required for fix-deployment}"

    setup_repo

    log "Fetching failed deployment logs"
    LOGS="$(gh run view "$GITHUB_RUN_ID" --repo "$GITHUB_REPO" --log-failed 2>/dev/null || echo "Could not retrieve logs")"

    FIX_BRANCH="agent/fix-deploy-issue-${GITHUB_ISSUE_NUMBER}"
    log "Creating fix branch ${FIX_BRANCH}"
    git checkout -b "$FIX_BRANCH"

    log "Running Claude to fix deployment"
    run_agent "fix-deployment.md" \
        "Deployment failed on main for issue #${GITHUB_ISSUE_NUMBER}.

Workflow run: ${GITHUB_RUN_ID}
Failed logs:
${LOGS}

Diagnose and fix the deployment failure."

    log "Pushing fix branch"
    git push origin "$FIX_BRANCH"

    gh pr create \
        --repo "$GITHUB_REPO" \
        --head "$FIX_BRANCH" \
        --title "Fix deployment failure for issue #${GITHUB_ISSUE_NUMBER}" \
        --body "Automated fix for deployment failure.

Related issue: #${GITHUB_ISSUE_NUMBER}"

    log "Created deployment fix PR"
}


action_design() {
    : "${GITHUB_ISSUE_NUMBER:?GITHUB_ISSUE_NUMBER is required for design}"

    BRANCH_NAME="design/issue-${GITHUB_ISSUE_NUMBER}"

    # Preflight: skip (return 0) if an open PR for this branch already exists.
    # Branch name is load-bearing — the un-draft job parses it — so never deviate.
    OWNER="${GITHUB_REPO%%/*}"
    EXISTING_PR="$(gh pr list --repo "$GITHUB_REPO" --head "$BRANCH_NAME" --state open \
        --json url,headRepositoryOwner \
        --jq "[.[] | select(.headRepositoryOwner.login == \"$OWNER\")][0].url // empty")"
    if [ -n "$EXISTING_PR" ]; then
        log "Open PR already exists for ${BRANCH_NAME}: ${EXISTING_PR} — skipping"
        return 0
    fi

    setup_repo

    log "Fetching issue #${GITHUB_ISSUE_NUMBER} (title, body, labels, comments)"
    ISSUE_JSON="$(gh issue view "$GITHUB_ISSUE_NUMBER" --repo "$GITHUB_REPO" --json title,body,labels,comments)"
    ISSUE_TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
    ISSUE_BODY="$(echo "$ISSUE_JSON" | jq -r '.body')"
    ISSUE_LABELS="$(echo "$ISSUE_JSON" | jq -r '[.labels[].name] | join(", ")')"
    ISSUE_COMMENTS="$(echo "$ISSUE_JSON" | jq -r '[.comments[] | "**@\(.author.login):** \(.body)"] | join("\n\n---\n\n")')"

    log "Creating branch ${BRANCH_NAME}"
    git checkout -b "$BRANCH_NAME"

    log "Running Claude to produce design"
    run_agent "design.md" \
        "Design a solution for this GitHub issue.

Repository: ${GITHUB_REPO}
Issue #${GITHUB_ISSUE_NUMBER}: ${ISSUE_TITLE}
Branch: ${BRANCH_NAME}

Labels: ${ISSUE_LABELS:-none}

Issue body:
${ISSUE_BODY}

Issue comments (including grooming Q&A):
${ISSUE_COMMENTS:-none}"

    log "Verifying design PR was opened for ${BRANCH_NAME}"
    PR_URL="$(gh pr list --repo "$GITHUB_REPO" --head "$BRANCH_NAME" --state open \
        --json url,headRepositoryOwner \
        --jq "[.[] | select(.headRepositoryOwner.login == \"$OWNER\")][0].url // empty")"
    if [ -z "$PR_URL" ]; then
        log "ERROR: no open PR found for ${BRANCH_NAME} (owner: ${OWNER}) — agent did not open a design PR"
        exit 1
    fi
    log "Verified design PR: ${PR_URL}"

    log "Verifying at least one sub-issue was created for issue #${GITHUB_ISSUE_NUMBER}"
    if ! SUB_ISSUE_COUNT="$(gh api "repos/${GITHUB_REPO}/issues/${GITHUB_ISSUE_NUMBER}/sub_issues" --jq 'length')"; then
        log "ERROR: GitHub API call failed while querying sub-issues for issue #${GITHUB_ISSUE_NUMBER} (check permissions, preview headers, and network)"
        exit 1
    fi
    if [ "$SUB_ISSUE_COUNT" -eq 0 ]; then
        log "ERROR: issue #${GITHUB_ISSUE_NUMBER} has no sub-issues — agent did not create the task breakdown"
        exit 1
    fi
    log "Verified ${SUB_ISSUE_COUNT} sub-issue(s) for issue #${GITHUB_ISSUE_NUMBER}"
}

action_groom() {
    : "${GITHUB_ISSUE_NUMBER:?GITHUB_ISSUE_NUMBER is required for groom}"

    setup_repo
    cd "$WORK_DIR"

    log "Fetching issue #${GITHUB_ISSUE_NUMBER}"
    ISSUE_JSON="$(gh issue view "$GITHUB_ISSUE_NUMBER" --repo "$GITHUB_REPO" --json title,body,labels)"
    ISSUE_TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
    ISSUE_BODY="$(echo "$ISSUE_JSON" | jq -r '.body')"
    EXISTING_LABELS="$(echo "$ISSUE_JSON" | jq -r '[.labels[].name] | join(", ")')"

    log "Running Claude to groom issue"
    run_agent "groom.md" \
        "Groom GitHub issue #${GITHUB_ISSUE_NUMBER} in ${GITHUB_REPO}.

Issue title: ${ISSUE_TITLE}

Issue body:
${ISSUE_BODY}

Existing labels: ${EXISTING_LABELS:-none}

Label criteria are defined in: agents/grooming/label-criteria.json (already checked out in your working directory at ${WORK_DIR})"
}

# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------

log "Agent action: ${AGENT_ACTION}"

case "$AGENT_ACTION" in
    implement)
        action_implement
        ;;
    fix-checks)
        action_fix_checks
        ;;
    respond-review)
        action_respond_review
        ;;
    fix-deployment)
        action_fix_deployment
        ;;
    groom)
        action_groom
        ;;
    design)
        action_design
        ;;
    *)
        log "ERROR: Unknown action '${AGENT_ACTION}'"
        echo "Usage: AGENT_ACTION=(implement|fix-checks|respond-review|fix-deployment|groom|design)" >&2
        exit 1
        ;;
esac

log "Agent finished successfully"
exit 0
