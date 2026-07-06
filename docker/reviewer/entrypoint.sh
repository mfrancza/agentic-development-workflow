#!/bin/bash
set -euo pipefail

# =============================================================================
# Reviewer Agent Entrypoint
#
# Runs a single Claude review pass on a PR: clones the repo read-only, checks
# out the PR head, gathers context (diff vs merge-base, existing review
# threads with IDs, CI check status), invokes Claude with the `review.md`
# system prompt, and — after Claude exits — verifies that a review by this
# bot identity was recorded against the PR head SHA. Exits non-zero if not.
#
# Design contract: docs/design/reviewer-container.md
#   - Decision 1: Claude posts the review; the entrypoint only verifies.
#   - Decision 3: no `git-askpass.sh`, no `git config user.*`, no credential
#     helper for push, no `git commit` / `git push` anywhere in this image.
#   - Decision 5: `CLAUDE_MODEL` / `CLAUDE_MAX_TURNS` knobs mirror the
#     developer image; no `AGENT_ACTION` dispatch — this image does one thing.
# =============================================================================

# Required environment variables
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPO:?GITHUB_REPO is required (owner/repo)}"
: "${GITHUB_PR_NUMBER:?GITHUB_PR_NUMBER is required}"

# Optional configuration
CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
CLAUDE_MAX_TURNS="${CLAUDE_MAX_TURNS:-100}"

SCRIPTS_DIR="/opt/agent"
WORK_DIR="/home/agent/work"

export GH_TOKEN

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() {
    echo "[reviewer] $(date -Iseconds) $*"
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

# -----------------------------------------------------------------------------
# Review
# -----------------------------------------------------------------------------

log "Reviewing PR #${GITHUB_PR_NUMBER} in ${GITHUB_REPO}"

# --- Read-only clone. `gh repo clone` uses gh's authenticated git wrapper so
#     no persistent credential helper is written into .git/config. Subsequent
#     git operations that need auth (e.g. gh pr checkout) also go through gh,
#     preserving the no-credential-helper posture.
log "Cloning ${GITHUB_REPO} (read-only)"
rm -rf "$WORK_DIR"
gh repo clone "$GITHUB_REPO" "$WORK_DIR"
cd "$WORK_DIR"

# --- Fetch PR metadata + check out the PR head.
log "Fetching PR metadata"
PR_JSON="$(gh pr view "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" \
    --json baseRefName,headRefName,headRefOid,title,body,author,url,isDraft,state)"
BASE_REF="$(echo "$PR_JSON"  | jq -r '.baseRefName')"
HEAD_REF="$(echo "$PR_JSON"  | jq -r '.headRefName')"
HEAD_SHA="$(echo "$PR_JSON"  | jq -r '.headRefOid')"
PR_TITLE="$(echo "$PR_JSON"  | jq -r '.title')"
PR_BODY="$(echo "$PR_JSON"   | jq -r '.body')"
PR_AUTHOR="$(echo "$PR_JSON" | jq -r '.author.login')"
PR_URL="$(echo "$PR_JSON"    | jq -r '.url')"
PR_STATE="$(echo "$PR_JSON"  | jq -r '.state')"
PR_IS_DRAFT="$(echo "$PR_JSON" | jq -r '.isDraft')"

log "Checking out PR #${GITHUB_PR_NUMBER} head ${HEAD_SHA}"
gh pr checkout "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO"
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"

# --- Resolve merge-base against the PR's base branch. `origin/${BASE_REF}` is
#     populated by the full clone above; no additional fetch is needed for
#     same-repo PRs. For safety we still refresh it (via gh's git wrapper) so
#     that the merge-base reflects any commits landed on the base branch
#     between clone start and now.
log "Refreshing origin/${BASE_REF} and resolving merge-base"
gh repo sync --source "$GITHUB_REPO" --branch "$BASE_REF" >/dev/null 2>&1 || true
git fetch origin "$BASE_REF" 2>/dev/null || true
BASE_SHA="$(git merge-base "origin/${BASE_REF}" HEAD)"

# --- Gather the diff, changed files, and the commit series on the PR.
log "Computing diff ${BASE_SHA}..HEAD"
DIFF_STAT="$(git diff --stat "${BASE_SHA}..HEAD")"
CHANGED_FILES="$(git diff --name-only "${BASE_SHA}..HEAD")"
DIFF="$(git diff "${BASE_SHA}..HEAD")"
COMMITS_ON_PR="$(git log --pretty='format:%h %s' "${BASE_SHA}..HEAD")"

# --- Gather existing review threads WITH IDs. GraphQL is the only place the
#     thread IDs (used by #41's resolve-thread flow) surface; the REST
#     /pulls/{n}/comments endpoint returns comment IDs but not thread IDs. We
#     include resolved/outdated flags so the prompt can decide what's still
#     open. Per design decision 4 these are context only — the initial-review
#     prompt must not reply to or resolve them.
OWNER="${GITHUB_REPO%%/*}"
REPO_NAME="${GITHUB_REPO#*/}"

log "Fetching existing review threads (with IDs)"
REVIEW_THREADS_JSON="$(gh api graphql \
    -F owner="$OWNER" -F name="$REPO_NAME" -F number="$GITHUB_PR_NUMBER" \
    -f query='
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                startLine
                diffSide
                comments(first: 50) {
                  nodes {
                    databaseId
                    author { login }
                    body
                    createdAt
                  }
                }
              }
            }
          }
        }
      }' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes')"

# --- Gather CI check status. `gh pr checks` prints a non-zero exit when
#     checks are failing/pending; that's not a script error for us, so swallow
#     the exit code and fall back to an empty array.
log "Fetching CI check status"
CHECKS_JSON="$(gh pr checks "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" \
    --json name,state,link,workflow,startedAt,completedAt 2>/dev/null \
    || echo '[]')"

# --- Identify this bot so we can verify our own review afterwards. GraphQL's
#     `viewer` works with GitHub App installation tokens and returns the bot
#     login (e.g. `mfrancza-reviewer-agent[bot]`); REST's `/user` does not.
REVIEWER_LOGIN="$(gh api graphql -f query='{ viewer { login } }' --jq '.data.viewer.login')"
log "Reviewer identity: ${REVIEWER_LOGIN}"

# -----------------------------------------------------------------------------
# Invoke Claude
# -----------------------------------------------------------------------------

log "Running Claude to review PR"
run_claude "review.md" \
    "Review PR #${GITHUB_PR_NUMBER} in ${GITHUB_REPO}.

PR URL: ${PR_URL}
PR title: ${PR_TITLE}
PR author: ${PR_AUTHOR}
PR state: ${PR_STATE} (draft: ${PR_IS_DRAFT})
Base ref: ${BASE_REF}
Head ref: ${HEAD_REF}
Local branch (checked out): ${BRANCH_NAME}
Base SHA (merge-base with origin/${BASE_REF}): ${BASE_SHA}
Head SHA: ${HEAD_SHA}
Reviewer identity (this bot): ${REVIEWER_LOGIN}

Post the review against Head SHA ${HEAD_SHA}. Submit it as a single
POST /repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/reviews call so the
verdict and its inline comments land atomically.

PR body:
${PR_BODY}

Commits on this PR since base:
${COMMITS_ON_PR}

Diff stat:
${DIFF_STAT}

Changed files:
${CHANGED_FILES}

Full diff (base..head):
${DIFF}

Existing review threads (context only — do not reply to or resolve them;
skip any finding already covered by an open thread):
${REVIEW_THREADS_JSON}

CI check status:
${CHECKS_JSON}"

# -----------------------------------------------------------------------------
# Verify the review was posted (design decision 1)
# -----------------------------------------------------------------------------
#
# Look for at least one review authored by this bot against the PR head SHA.
# Filtering on commit_id (rather than just \"any review by us\") means a stale
# review from an earlier head — e.g. if the workflow re-runs after new commits
# but before Claude posts — does not falsely satisfy the check.

log "Verifying a review by ${REVIEWER_LOGIN} exists on ${HEAD_SHA}"
REVIEW_MATCHES="$(gh api --paginate "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/reviews" \
    --jq "[.[] | select(.user.login == \"${REVIEWER_LOGIN}\" and .commit_id == \"${HEAD_SHA}\")] | length")"

if [ "${REVIEW_MATCHES:-0}" -eq 0 ]; then
    log "ERROR: no review by ${REVIEWER_LOGIN} found on ${HEAD_SHA} for PR #${GITHUB_PR_NUMBER} — agent did not complete the review"
    exit 1
fi

log "Verified: ${REVIEW_MATCHES} review(s) by ${REVIEWER_LOGIN} on ${HEAD_SHA}"
log "Reviewer agent finished successfully"
exit 0
