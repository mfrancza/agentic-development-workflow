#!/bin/bash
set -euo pipefail

# =============================================================================
# Developer Agent Entrypoint
# Dispatches to the appropriate action based on AGENT_ACTION.
# Each invocation is a short-lived container triggered by a GitHub event.
# =============================================================================

# Required environment variables
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPO:?GITHUB_REPO is required}"
: "${AGENT_ACTION:?AGENT_ACTION is required (implement|fix-checks|respond-review|fix-deployment|groom)}"

# Optional configuration
CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
CLAUDE_MAX_TURNS="${CLAUDE_MAX_TURNS:-100}"
REVIEWERS="${REVIEWERS:-}"

SCRIPTS_DIR="/opt/agent"
WORK_DIR="/home/agent/work"

export GH_TOKEN

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() {
    echo "[agent] $(date -Iseconds) $*"
}

run_claude() {
    local prompt_file="$1"
    shift
    local user_prompt="$*"

    printf '%s\n' "$user_prompt" | claude --print \
        --dangerously-skip-permissions \
        --model "$CLAUDE_MODEL" \
        --max-turns "$CLAUDE_MAX_TURNS" \
        --system-prompt-file "${SCRIPTS_DIR}/prompts/${prompt_file}"
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
# Actions
# -----------------------------------------------------------------------------

action_implement() {
    : "${GITHUB_ISSUE_NUMBER:?GITHUB_ISSUE_NUMBER is required for implement}"

    setup_repo

    log "Fetching issue #${GITHUB_ISSUE_NUMBER}"
    ISSUE_JSON="$(gh issue view "$GITHUB_ISSUE_NUMBER" --repo "$GITHUB_REPO" --json title,body)"
    ISSUE_TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
    ISSUE_BODY="$(echo "$ISSUE_JSON" | jq -r '.body')"

    BRANCH_NAME="agent/issue-${GITHUB_ISSUE_NUMBER}"
    log "Creating branch ${BRANCH_NAME}"
    git checkout -b "$BRANCH_NAME"

    log "Running Claude to implement solution"
    run_claude "implement.md" \
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
    run_claude "respond-to-checks.md" \
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

    log "Running Claude to address review feedback"
    run_claude "respond-to-review.md" \
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

    log "Pushing changes"
    git push origin "$BRANCH_NAME"
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
    run_claude "fix-deployment.md" \
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
    run_claude "groom.md" \
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
    *)
        log "ERROR: Unknown action '${AGENT_ACTION}'"
        echo "Usage: AGENT_ACTION=(implement|fix-checks|respond-review|fix-deployment|groom)" >&2
        exit 1
        ;;
esac

log "Agent finished successfully"
exit 0
