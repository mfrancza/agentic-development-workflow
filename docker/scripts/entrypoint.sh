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
: "${AGENT_ACTION:?AGENT_ACTION is required (implement|fix-checks|respond-review|fix-deployment)}"

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

${ISSUE_BODY}"

    log "Pushing branch"
    git push origin "$BRANCH_NAME"

    log "Creating PR"
    PR_URL="$(gh pr create \
        --repo "$GITHUB_REPO" \
        --head "$BRANCH_NAME" \
        --title "Fix #${GITHUB_ISSUE_NUMBER}: ${ISSUE_TITLE}" \
        --body "Automated implementation for #${GITHUB_ISSUE_NUMBER}.

## Issue
${ISSUE_TITLE}

## Summary
This PR was created by the developer agent to address the linked issue.

Closes #${GITHUB_ISSUE_NUMBER}")"

    PR_NUMBER="$(gh pr view "$PR_URL" --json number --jq .number)"
    log "Created PR #${PR_NUMBER}: ${PR_URL}"

    if [ -n "$REVIEWERS" ]; then
        log "Requesting reviewers: ${REVIEWERS}"
        gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --add-reviewer "$REVIEWERS"
    fi
}

action_fix_checks() {
    : "${GITHUB_PR_NUMBER:?GITHUB_PR_NUMBER is required for fix-checks}"

    setup_repo

    BRANCH_NAME="$(gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --json headRefName --jq '.headRefName')"
    log "Checking out branch ${BRANCH_NAME}"
    git checkout "$BRANCH_NAME"

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

    BRANCH_NAME="$(gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --json headRefName --jq '.headRefName')"
    log "Checking out PR #${GITHUB_PR_NUMBER} branch ${BRANCH_NAME}"
    gh pr checkout "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO"

    log "Fetching review comments"
    REVIEW_COMMENTS="$(gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --json reviews --jq '.reviews[] | "\(.author.login) (\(.state)): \(.body)"')"
    PR_COMMENTS="$(gh api "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/comments" --jq '.[] | "\(.user.login): \(.body) (at \(.path):\(.line))"' 2>/dev/null || true)"
    CONVERSATION_COMMENTS="$(gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --json comments --jq '.comments[] | "\(.author.login): \(.body)"' 2>/dev/null || true)"

    log "Running Claude to address review feedback"
    run_claude "respond-to-review.md" \
        "Review feedback on PR #${GITHUB_PR_NUMBER} in ${GITHUB_REPO}:

Reviews:
${REVIEW_COMMENTS}

Inline comments:
${PR_COMMENTS}

Conversation comments:
${CONVERSATION_COMMENTS}

Address the feedback, commit changes, and reply to the comments using the gh CLI."

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
    *)
        log "ERROR: Unknown action '${AGENT_ACTION}'"
        echo "Usage: AGENT_ACTION=(implement|fix-checks|respond-review|fix-deployment)" >&2
        exit 1
        ;;
esac

log "Agent finished successfully"
exit 0
