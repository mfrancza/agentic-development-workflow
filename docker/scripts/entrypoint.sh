#!/bin/bash
set -euo pipefail

# =============================================================================
# Developer Agent Entrypoint
# Orchestrates the agent lifecycle: implement → PR → feedback loop → deploy
# =============================================================================

# Required environment variables
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPO:?GITHUB_REPO is required}"
: "${GITHUB_ISSUE_NUMBER:?GITHUB_ISSUE_NUMBER is required}"

# Optional configuration
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-20}"
IMPLEMENT_BUDGET="${IMPLEMENT_BUDGET:-12}"
REVIEW_BUDGET="${REVIEW_BUDGET:-3}"
DEPLOY_FIX_BUDGET="${DEPLOY_FIX_BUDGET:-5}"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
MAX_POLL_TIME="${MAX_POLL_TIME:-14400}"  # 4 hours
REVIEWERS="${REVIEWERS:-}"

SCRIPTS_DIR="/opt/agent"
WORK_DIR="/home/agent/work"

export GH_TOKEN

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

gh_cmd() {
    gh "$@"
}

log() {
    echo "[agent] $(date -Iseconds) $*"
}

run_claude() {
    local budget="$1"
    local prompt_file="$2"
    shift 2
    local user_prompt="$*"

    claude --print \
        --dangerously-skip-permissions \
        --model "$CLAUDE_MODEL" \
        --max-turns 100 \
        --system-prompt "$(cat "${SCRIPTS_DIR}/prompts/${prompt_file}")" \
        "$user_prompt"
}

# -----------------------------------------------------------------------------
# Phase 1: Setup
# -----------------------------------------------------------------------------

log "Starting developer agent for ${GITHUB_REPO}#${GITHUB_ISSUE_NUMBER}"

# Configure git identity
git config --global user.name "claude-dev-agent[bot]"
git config --global user.email "claude-dev-agent[bot]@users.noreply.github.com"

# Fetch issue details
log "Fetching issue #${GITHUB_ISSUE_NUMBER}"
ISSUE_JSON="$(gh_cmd issue view "$GITHUB_ISSUE_NUMBER" --repo "$GITHUB_REPO" --json title,body)"
ISSUE_TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
ISSUE_BODY="$(echo "$ISSUE_JSON" | jq -r '.body')"

log "Issue: ${ISSUE_TITLE}"

# Clone the repository
log "Cloning ${GITHUB_REPO}"
gh_cmd repo clone "$GITHUB_REPO" "$WORK_DIR"
cd "$WORK_DIR"

# Configure git credentials for push using GH_TOKEN
git config credential.helper '!f() { echo "password=${GH_TOKEN}"; echo "username=x-access-token"; }; f'

# -----------------------------------------------------------------------------
# Phase 2: Implement
# -----------------------------------------------------------------------------

BRANCH_NAME="agent/issue-${GITHUB_ISSUE_NUMBER}"
log "Creating branch ${BRANCH_NAME}"
git checkout -b "$BRANCH_NAME"

log "Running Claude to implement solution"
run_claude "$IMPLEMENT_BUDGET" "implement.md" \
    "Implement a solution for this GitHub issue.

Repository: ${GITHUB_REPO}
Issue #${GITHUB_ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}"

# Push and create PR
log "Pushing branch"
git push origin "$BRANCH_NAME"

log "Creating PR"
PR_URL="$(gh_cmd pr create \
    --repo "$GITHUB_REPO" \
    --head "$BRANCH_NAME" \
    --title "Fix #${GITHUB_ISSUE_NUMBER}: ${ISSUE_TITLE}" \
    --body "Automated implementation for #${GITHUB_ISSUE_NUMBER}.

## Issue
${ISSUE_TITLE}

## Summary
This PR was created by the developer agent to address the linked issue.

Closes #${GITHUB_ISSUE_NUMBER}")"

PR_NUMBER="$(echo "$PR_URL" | grep -oE '[0-9]+$')"
log "Created PR #${PR_NUMBER}: ${PR_URL}"

# Request reviewers if configured
if [ -n "$REVIEWERS" ]; then
    log "Requesting reviewers: ${REVIEWERS}"
    gh_cmd pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --add-reviewer "$REVIEWERS"
fi

# -----------------------------------------------------------------------------
# Phase 3: Feedback Loop
# -----------------------------------------------------------------------------

log "Entering feedback loop"
poll_start=$(date +%s)
last_check_sha=""
last_review_count=0

while true; do
    elapsed=$(( $(date +%s) - poll_start ))
    if [ "$elapsed" -ge "$MAX_POLL_TIME" ]; then
        log "ERROR: Exceeded maximum poll time (${MAX_POLL_TIME}s). Exiting."
        exit 1
    fi

    # Check PR state
    PR_STATE="$(gh_cmd pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json state --jq '.state')"
    if [ "$PR_STATE" = "MERGED" ]; then
        log "PR has been merged"
        break
    elif [ "$PR_STATE" = "CLOSED" ]; then
        log "PR was closed without merging. Exiting."
        exit 0
    fi

    # Check CI status
    CHECKS_JSON="$(gh_cmd pr checks "$PR_NUMBER" --repo "$GITHUB_REPO" --json name,state,conclusion 2>/dev/null || echo "[]")"
    CURRENT_SHA="$(git rev-parse HEAD)"

    FAILED_CHECKS="$(echo "$CHECKS_JSON" | jq -r '.[] | select(.conclusion == "failure") | .name' 2>/dev/null || true)"
    if [ -n "$FAILED_CHECKS" ] && [ "$CURRENT_SHA" != "$last_check_sha" ]; then
        log "CI checks failed: ${FAILED_CHECKS}"

        # Get failure details
        FAILURE_DETAILS="$(gh_cmd pr checks "$PR_NUMBER" --repo "$GITHUB_REPO" 2>/dev/null || echo "No details available")"

        run_claude "$REVIEW_BUDGET" "respond-to-checks.md" \
            "The following CI checks failed on PR #${PR_NUMBER}:

${FAILURE_DETAILS}

Fix the issues and commit the changes."

        git push origin "$BRANCH_NAME"
        last_check_sha="$(git rev-parse HEAD)"
        log "Pushed fixes for CI failures"
        continue
    fi

    # Check for new reviews
    REVIEWS_JSON="$(gh_cmd api "repos/${GITHUB_REPO}/pulls/${PR_NUMBER}/reviews" 2>/dev/null || echo "[]")"
    REVIEW_COUNT="$(echo "$REVIEWS_JSON" | jq 'length')"

    if [ "$REVIEW_COUNT" -gt "$last_review_count" ]; then
        # Get new review comments
        REVIEW_COMMENTS="$(gh_cmd pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json reviews --jq '.reviews[] | "\(.author.login) (\(.state)): \(.body)"')"
        PR_COMMENTS="$(gh_cmd api "repos/${GITHUB_REPO}/pulls/${PR_NUMBER}/comments" --jq '.[] | "\(.user.login): \(.body) (at \(.path):\(.line))"' 2>/dev/null || true)"

        if [ -n "$REVIEW_COMMENTS" ] || [ -n "$PR_COMMENTS" ]; then
            log "New review feedback detected"

            run_claude "$REVIEW_BUDGET" "respond-to-review.md" \
                "Review feedback on PR #${PR_NUMBER} in ${GITHUB_REPO}:

Reviews:
${REVIEW_COMMENTS}

Inline comments:
${PR_COMMENTS}

Address the feedback, commit changes, and reply to the comments using the gh CLI."

            git push origin "$BRANCH_NAME"
            log "Pushed review feedback fixes"
        fi
        last_review_count="$REVIEW_COUNT"
        continue
    fi

    log "Waiting ${POLL_INTERVAL}s for updates on PR #${PR_NUMBER}..."
    sleep "$POLL_INTERVAL"
done

# -----------------------------------------------------------------------------
# Phase 4: Deployment Monitoring
# -----------------------------------------------------------------------------

log "Monitoring deployment on main branch"
poll_start=$(date +%s)

while true; do
    elapsed=$(( $(date +%s) - poll_start ))
    if [ "$elapsed" -ge "$MAX_POLL_TIME" ]; then
        log "ERROR: Exceeded maximum poll time for deployment. Exiting."
        exit 1
    fi

    # Check latest workflow runs on main
    RUNS_JSON="$(gh_cmd api "repos/${GITHUB_REPO}/actions/runs?branch=main&per_page=5" 2>/dev/null || echo '{"workflow_runs":[]}')"
    LATEST_STATUS="$(echo "$RUNS_JSON" | jq -r '.workflow_runs[0].status // "none"')"
    LATEST_CONCLUSION="$(echo "$RUNS_JSON" | jq -r '.workflow_runs[0].conclusion // "none"')"

    if [ "$LATEST_STATUS" = "none" ]; then
        log "No workflow runs found on main. Deployment monitoring complete."
        break
    fi

    if [ "$LATEST_STATUS" = "completed" ]; then
        if [ "$LATEST_CONCLUSION" = "success" ]; then
            log "Deployment succeeded"
            break
        elif [ "$LATEST_CONCLUSION" = "failure" ]; then
            log "Deployment failed. Creating fix PR."

            git checkout main
            git pull origin main
            FIX_BRANCH="agent/fix-deploy-issue-${GITHUB_ISSUE_NUMBER}"
            git checkout -b "$FIX_BRANCH"

            RUN_ID="$(echo "$RUNS_JSON" | jq -r '.workflow_runs[0].id')"
            LOGS="$(gh_cmd run view "$RUN_ID" --repo "$GITHUB_REPO" --log-failed 2>/dev/null || echo "Could not retrieve logs")"

            run_claude "$DEPLOY_FIX_BUDGET" "fix-deployment.md" \
                "Deployment failed on main after merging PR #${PR_NUMBER} for issue #${GITHUB_ISSUE_NUMBER}.

Workflow run: ${RUN_ID}
Failed logs:
${LOGS}

Diagnose and fix the deployment failure."

            git push origin "$FIX_BRANCH"

            gh_cmd pr create \
                --repo "$GITHUB_REPO" \
                --head "$FIX_BRANCH" \
                --title "Fix deployment failure from #${PR_NUMBER}" \
                --body "Automated fix for deployment failure after merging #${PR_NUMBER}.

Related issue: #${GITHUB_ISSUE_NUMBER}"

            log "Created deployment fix PR. Exiting."
            break
        fi
    fi

    log "Deployment in progress (status: ${LATEST_STATUS}). Waiting ${POLL_INTERVAL}s..."
    sleep "$POLL_INTERVAL"
done

# -----------------------------------------------------------------------------
# Phase 5: Shutdown
# -----------------------------------------------------------------------------

log "Posting summary comment on issue #${GITHUB_ISSUE_NUMBER}"
gh_cmd issue comment "$GITHUB_ISSUE_NUMBER" --repo "$GITHUB_REPO" \
    --body "Developer agent completed work on this issue. PR: #${PR_NUMBER}"

log "Agent finished successfully"
exit 0
