#!/bin/bash
set -euo pipefail

# =============================================================================
# Reviewer Agent Entrypoint
#
# Runs a single review pass on a PR: clones the repo read-only, checks out
# the PR head, gathers context (diff vs merge-base, existing review threads
# with IDs, CI check status), invokes the agent with the `review.md` system
# prompt, and — after the agent exits — verifies that a review by this bot
# identity was recorded against the PR head SHA. Exits non-zero if not.
#
# Design contract: docs/design/reviewer-container.md
#   - Decision 1: the agent posts the review; the entrypoint only verifies.
#   - Decision 3: no `git-askpass.sh`, no `git config user.*`, no credential
#     helper for push, no `git commit` / `git push` anywhere in this image.
#   - Decision 5: `AGENT_MODEL` / `AGENT_MAX_TURNS` knobs mirror the
#     developer image; no `AGENT_ACTION` dispatch — this image does one thing.
# =============================================================================

# Optional configuration (accept old names as a transient fallback; see #82)
AGENT_MODEL="${AGENT_MODEL:-${CLAUDE_MODEL:-sonnet}}"
AGENT_MAX_TURNS="${AGENT_MAX_TURNS:-${CLAUDE_MAX_TURNS:-100}}"

SCRIPTS_DIR="/opt/agent"
WORK_DIR="/home/agent/work"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() {
    echo "[reviewer] $(date -Iseconds) $*"
}

# resolve_provider: maps a model name to its provider string ("anthropic" or
# "openai"). Fails loudly on unknown models — consistent with the fail-loud
# security default.
#
# NOTE: This function is duplicated in docker/scripts/entrypoint.sh (developer
# image). Keep both in sync when adding a model. Per design decision 2 in
# docs/design/multi-provider-models.md, if a third image ever requires it,
# promote to a shared lib COPYed into both images.
resolve_provider() {
    local model="$1"
    case "$model" in
        # Anthropic — top-level aliases (Claude Code CLI resolves to the latest
        # snapshot of each series) plus every model ID that begins with the
        # stable `claude-` namespace. This covers generic series tags
        # (e.g. `claude-sonnet-4-5`, `claude-3-5-haiku-latest`) and pinned
        # snapshots (e.g. `claude-sonnet-4-5-20250929`) alike. See
        # docs/design/anthropic-model-labels.md for the rationale — the
        # explicit-allowlist trade-off from docs/design/multi-provider-models.md
        # is inverted here because the Anthropic model list grows every quarter
        # and the `claude-*` prefix is a stable, namespace-scoped guard.
        sonnet|opus|haiku|claude-*)
            echo "anthropic"
            ;;
        gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5|o3)
            echo "openai"
            ;;
        grok-3|grok-3-mini|grok-code-fast-1)
            echo "xai"
            ;;
        *)
            log "ERROR: Unknown model '${model}'. Anthropic models must be one of the aliases 'sonnet', 'opus', 'haiku', or a model ID beginning with 'claude-' (e.g. 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku-latest'). Other supported values: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5, o3, grok-3, grok-3-mini, grok-code-fast-1" >&2
            exit 1
            ;;
    esac
}

run_anthropic() {
    local prompt_file="$1"
    local user_prompt_file="$2"

    claude --print \
        --dangerously-skip-permissions \
        --model "$AGENT_MODEL" \
        --max-turns "$AGENT_MAX_TURNS" \
        --system-prompt-file "${SCRIPTS_DIR}/prompts/${prompt_file}" \
        < "$user_prompt_file"
}

run_openai() {
    local prompt_file="$1"
    local user_prompt_file="$2"

    local system_prompt
    system_prompt="$(cat "${SCRIPTS_DIR}/prompts/${prompt_file}")"
    # Codex exec has no --system-prompt flag; prepend the per-action system
    # prompt to the task prompt with a clear separator.
    # Sandbox is workspace-write: confines any file writes to the workspace,
    # preserving the structural no-write guarantee (no git-askpass.sh, no
    # push credentials in the image, Contents-read-only reviewer token).
    {
        printf '%s\n\n---\n\n' "$system_prompt"
        cat "$user_prompt_file"
    } | codex exec \
        --model "$AGENT_MODEL" \
        --sandbox workspace-write \
        -
}

run_xai() {
    local prompt_file="$1"
    local user_prompt_file="$2"

    local system_prompt
    system_prompt="$(cat "${SCRIPTS_DIR}/prompts/${prompt_file}")"
    # Codex exec has no --system-prompt flag; prepend the per-action system
    # prompt to the task prompt with a clear separator (same convention as
    # run_openai).
    # Sandbox is workspace-write: preserves the reviewer image's structural
    # no-write guarantee (no git-askpass.sh, no push credentials, Contents:read
    # reviewer token — see docs/design/reviewer-container.md decision 3).
    # --config model_provider="xai" points Codex at the [model_providers.xai]
    # block in ~/.codex/config.toml (base_url = xAI's OpenAI-compatible endpoint;
    # env_key = XAI_API_KEY). No codex login step needed — custom model_providers
    # read credentials from the process environment via env_key, not auth.json
    # (contrast run_openai above; see docs/design/grok-models.md decision 2).
    {
        printf '%s\n\n---\n\n' "$system_prompt"
        cat "$user_prompt_file"
    } | codex exec \
        --config model_provider="xai" \
        --model "$AGENT_MODEL" \
        --sandbox workspace-write \
        -
}

run_agent() {
    local prompt_file="$1"
    local user_prompt_file="$2"

    case "$AGENT_PROVIDER" in
        anthropic)
            run_anthropic "$prompt_file" "$user_prompt_file"
            ;;
        openai)
            run_openai "$prompt_file" "$user_prompt_file"
            ;;
        xai)
            run_xai "$prompt_file" "$user_prompt_file"
            ;;
        *)
            log "ERROR: Unknown provider '${AGENT_PROVIDER}'" >&2
            exit 1
            ;;
    esac
}

# -----------------------------------------------------------------------------
# Log capture (docs/design/agent-container-logs.md, decisions 3 & 4)
# Installed before the preamble so env-validation errors are captured too.
# -----------------------------------------------------------------------------

mkdir -p /home/agent/logs

# Save original stderr to fd 3, then wire both stdout and stderr through tee
# so every line lands in the bind-mounted log file AND on the workflow log.
exec 3>&2
exec > >(tee -a /home/agent/logs/container.log) 2>&1

_log_capture_exit() {
    # Clean up temp context file if it was created (mirrors the original
    # trap 'rm -f "$CONTEXT_FILE"' EXIT that this trap supersedes).
    rm -f "${CONTEXT_FILE:-}"

    # 1. Emit any final messages before closing the fds — once stdout is
    #    closed, further echo/log calls no longer appear in container.log.
    log "Container exiting — harvesting session files and redacting secrets"

    # 2. Signal EOF to tee by closing both fds that write into its stdin pipe.
    #    stdout must be closed before restoring stderr; leaving either fd open
    #    keeps the pipe open and tee will never see EOF, causing wait to hang.
    #    Re-open stdout to /dev/null after closing so that child processes
    #    (find, sed) have a valid fd and do not emit "bad file descriptor" on exit.
    exec >&-          # close stdout — signals EOF on the pipe to tee
    exec 1>/dev/null  # reopen stdout to /dev/null for subsequent child processes
    exec 2>&3         # restore stderr to the saved original (fd 3)
    exec 3>&-         # close the saved fd

    # 3. Block until the tee subprocess has flushed everything to container.log.
    wait

    # 4. Copy Claude session files into the log directory.  Non-fatal if the
    #    projects directory does not exist (a run that never invoked Claude has
    #    no ~/.claude/projects/).
    mkdir -p /home/agent/logs/session
    cp -a ~/.claude/projects/. /home/agent/logs/session/ 2>/dev/null || true

    # 5. Redact secret values before the workflow reads the bind-mount.
    #    Skip redaction for any variable that is empty — an empty sed pattern
    #    matches every character boundary and corrupts files.
    #    Two-pass BRE escaping: first escape . ^ $ * \ /, then [ separately
    #    ([ cannot appear inside its own bracket expression in a single pass).
    if [ -n "${GH_TOKEN:-}" ]; then
        _escaped_token=$(printf '%s\n' "${GH_TOKEN}" | sed 's/[.^$*\\/]/\\&/g; s/\[/\\[/g')
        find /home/agent/logs -type f \
            -exec sed -i "s/${_escaped_token}/***REDACTED-GH_TOKEN***/g" {} +
    fi
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        _escaped_key=$(printf '%s\n' "${ANTHROPIC_API_KEY}" | sed 's/[.^$*\\/]/\\&/g; s/\[/\\[/g')
        find /home/agent/logs -type f \
            -exec sed -i "s/${_escaped_key}/***REDACTED-ANTHROPIC_API_KEY***/g" {} +
    fi
    if [ -n "${OPENAI_API_KEY:-}" ]; then
        _escaped_openai=$(printf '%s\n' "${OPENAI_API_KEY}" | sed 's/[.^$*\\/]/\\&/g; s/\[/\\[/g')
        find /home/agent/logs -type f \
            -exec sed -i "s/${_escaped_openai}/***REDACTED-OPENAI_API_KEY***/g" {} +
    fi
    if [ -n "${XAI_API_KEY:-}" ]; then
        _escaped_xai=$(printf '%s\n' "${XAI_API_KEY}" | sed 's/[.^$*\\/]/\\&/g; s/\[/\\[/g')
        find /home/agent/logs -type f \
            -exec sed -i "s/${_escaped_xai}/***REDACTED-XAI_API_KEY***/g" {} +
    fi
}
# Save the exit code before the trap runs so the container exits with the
# original code even after the trap body executes additional commands.
trap '_exit_code=$?; _log_capture_exit || true; exit $_exit_code' EXIT

# -----------------------------------------------------------------------------
# Preamble: resolve provider and validate credentials/required vars
# (before any gh call, clone, or agent invocation)
# -----------------------------------------------------------------------------

# 1. Resolve the provider from AGENT_MODEL; unknown model → fail loud
AGENT_PROVIDER="$(resolve_provider "$AGENT_MODEL")"
export -n AGENT_PROVIDER  # keep script-local; unexport in case it was inherited from the environment

# 2. Validate the selected provider's API key
case "$AGENT_PROVIDER" in
    anthropic)
        : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
        ;;
    openai)
        : "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
        # Codex CLI does not read OPENAI_API_KEY from the environment; it
        # authenticates from ~/.codex/auth.json, which this login writes
        # (issue #227 — without it every request goes out with no
        # Authorization header and fails 401).
        printenv OPENAI_API_KEY | codex login --with-api-key
        ;;
    xai)
        : "${XAI_API_KEY:?XAI_API_KEY is required}"
        # No codex login step needed — the [model_providers.xai] block in
        # ~/.codex/config.toml binds XAI_API_KEY via env_key, so Codex reads
        # the key directly from the process environment (see
        # docs/design/grok-models.md decision 2).
        ;;
esac

# 3. Validate remaining required vars
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPO:?GITHUB_REPO is required (owner/repo)}"
: "${GITHUB_PR_NUMBER:?GITHUB_PR_NUMBER is required}"

export GH_TOKEN

# 4. Log the resolved configuration (model names are not secrets; this makes
#    every run self-documenting and enables cost attribution and validation)
log "Model: ${AGENT_MODEL} (provider: ${AGENT_PROVIDER}, max turns: ${AGENT_MAX_TURNS})"

# File where the agent records the GraphQL IDs (one per line) of review threads
# whose findings are addressed. The reviewer token deliberately lacks the
# Contents: write permission that the resolveReviewThread mutation requires
# (see docs/design/reviewer-container.md decision 3), so the container never
# resolves threads itself — the workflow mounts this path and resolves the
# recorded IDs with its own token after the container exits. Truncate/create
# it up front so an empty file always exists, distinguishing "nothing to
# resolve" from "container died before recording".
RESOLVE_THREADS_FILE="${RESOLVE_THREADS_FILE:-/tmp/resolve-threads.txt}"
export RESOLVE_THREADS_FILE
mkdir -p "$(dirname "$RESOLVE_THREADS_FILE")"
: > "$RESOLVE_THREADS_FILE"

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
PR_BODY="$(echo "$PR_JSON"   | jq -r '.body // ""')"
PR_AUTHOR="$(echo "$PR_JSON" | jq -r '.author.login // ""')"
PR_URL="$(echo "$PR_JSON"    | jq -r '.url')"
PR_STATE="$(echo "$PR_JSON"  | jq -r '.state')"
PR_IS_DRAFT="$(echo "$PR_JSON" | jq -r '.isDraft')"

log "Checking out PR #${GITHUB_PR_NUMBER}"
gh pr checkout "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO"
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"
# Re-derive HEAD_SHA from the checked-out git state so that any commits that
# landed between `gh pr view` and `gh pr checkout` are reflected accurately.
HEAD_SHA="$(git rev-parse HEAD)"
log "Head SHA (from git): ${HEAD_SHA}"

# --- Resolve merge-base against the PR's base branch. `origin/${BASE_REF}` is
#     populated by the full clone above; we do one explicit fetch to ensure the
#     merge-base reflects any commits that landed on the base branch between
#     clone start and now. Fail loudly if the fetch cannot update the ref —
#     a stale base would silently produce an incorrect diff.
log "Refreshing origin/${BASE_REF} and resolving merge-base"
# Disable interactive prompting so the command fails fast in non-interactive
# runs rather than hanging. Use an ephemeral HTTP Authorization header derived
# from GH_TOKEN rather than relying on any persistent credential helper that
# may or may not survive across environments (private repos in particular).
# Use HTTP Basic auth (x-access-token:<token>) rather than Bearer — git's
# smart-HTTP transport expects Basic auth for GitHub HTTPS remotes, matching
# the existing git-askpass.sh convention in the developer image.
GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0="http.extraHeader" \
GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "${GH_TOKEN}" | base64 -w 0)" \
git fetch origin "$BASE_REF"
BASE_SHA="$(git merge-base "origin/${BASE_REF}" HEAD)"

# --- Gather the diff, changed files, and the commit series on the PR.
#     Stream outputs directly to a temp file rather than capturing into bash
#     variables; this avoids duplicating potentially large blobs in memory.
log "Computing diff ${BASE_SHA}..HEAD"
CONTEXT_FILE="$(mktemp)"
# The log-capture EXIT trap installed above (see _log_capture_exit) removes
# ${CONTEXT_FILE:-} on all exit paths, superseding a standalone
# `trap 'rm -f "$CONTEXT_FILE"' EXIT` here.

# --- Gather existing review threads WITH IDs. GraphQL is the only place the
#     thread IDs (used by #41's resolve-thread flow) surface; the REST
#     /pulls/{n}/comments endpoint returns comment IDs but not thread IDs.
#     Only unresolved (open) threads are fetched — resolved threads are not
#     actionable and including all threads can cause context-limit failures on
#     PRs with many comments. Per updated design decision 4 (superseded by
#     re-review-loop.md / issue #116, amended by issue #203), the prompt
#     evaluates each open thread and records addressed ones to
#     RESOLVE_THREADS_FILE before posting the new review; the workflow
#     resolves the recorded threads afterwards.
OWNER="${GITHUB_REPO%%/*}"
REPO_NAME="${GITHUB_REPO#*/}"

log "Fetching open (unresolved) review threads (with IDs)"
# Paginate through all review threads (100 per page) using cursor-based
# pagination so PRs with >100 threads are fully covered. CURSOR starts as
# the JSON literal `null` so `after: null` on the first page is equivalent
# to omitting the argument.
REVIEW_THREADS_JSON="[]"
CURSOR=null
while true; do
    PAGE_JSON="$(gh api graphql \
        -F owner="$OWNER" -F name="$REPO_NAME" -F number="$GITHUB_PR_NUMBER" \
        -F cursor="$CURSOR" \
        -f query='
          query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $cursor) {
                  pageInfo { endCursor hasNextPage }
                  nodes {
                    id
                    isResolved
                    isOutdated
                    path
                    line
                    startLine
                    diffSide
                    comments(last: 100) {
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
          }')"
    PAGE_NODES="$(printf '%s' "$PAGE_JSON" | \
        jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)]')"
    REVIEW_THREADS_JSON="$(jq -n \
        --argjson acc "$REVIEW_THREADS_JSON" \
        --argjson page "$PAGE_NODES" \
        '$acc + $page')"
    HAS_NEXT="$(printf '%s' "$PAGE_JSON" | \
        jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')"
    [ "$HAS_NEXT" = "true" ] || break
    CURSOR="$(printf '%s' "$PAGE_JSON" | \
        jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')"
done

# --- Gather CI check status. `gh pr checks` exits non-zero when checks are
#     failing/pending, but still emits JSON on stdout. Capture stdout regardless
#     of exit status (|| true), then default to '[]' only if the output is
#     actually empty — preserving the CI context the agent needs when checks fail.
log "Fetching CI check status"
CHECKS_JSON="$(gh pr checks "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" \
    --json name,state,link,workflow,startedAt,completedAt 2>/dev/null)" || true
CHECKS_JSON="${CHECKS_JSON:-[]}"

# --- Identify this bot so we can verify our own review afterwards. GraphQL's
#     `viewer` works with GitHub App installation tokens and returns the bot
#     login (e.g. `mfrancza-reviewer-agent[bot]`); REST's `/user` does not.
REVIEWER_LOGIN="$(gh api graphql -f query='{ viewer { login } }' --jq '.data.viewer.login')"
log "Reviewer identity: ${REVIEWER_LOGIN}"

# --- Build the user prompt in a temp file, streaming git output directly to
#     avoid duplicating potentially large blobs as bash variables.
log "Building review prompt context in ${CONTEXT_FILE}"
{
    printf 'Review PR #%s in %s.\n\n' "${GITHUB_PR_NUMBER}" "${GITHUB_REPO}"
    printf 'PR URL: %s\n' "${PR_URL}"
    printf 'PR title: %s\n' "${PR_TITLE}"
    printf 'PR author: %s\n' "${PR_AUTHOR}"
    printf 'PR state: %s (draft: %s)\n' "${PR_STATE}" "${PR_IS_DRAFT}"
    printf 'Base ref: %s\n' "${BASE_REF}"
    printf 'Head ref: %s\n' "${HEAD_REF}"
    printf 'Local branch (checked out): %s\n' "${BRANCH_NAME}"
    printf 'Base SHA (merge-base with origin/%s): %s\n' "${BASE_REF}" "${BASE_SHA}"
    printf 'Head SHA: %s\n' "${HEAD_SHA}"
    printf 'Reviewer identity (this bot): %s\n\n' "${REVIEWER_LOGIN}"
    printf 'Post the review against Head SHA %s. Submit it as a single\n' "${HEAD_SHA}"
    printf 'POST /repos/%s/pulls/%s/reviews call so the\n' "${GITHUB_REPO}" "${GITHUB_PR_NUMBER}"
    printf 'verdict and its inline comments land atomically.\n\n'
    printf 'PR body:\n%s\n\n' "${PR_BODY}"
    printf 'Commits on this PR since base:\n'
} > "$CONTEXT_FILE"
git log --pretty='format:%h %s' "${BASE_SHA}..HEAD" >> "$CONTEXT_FILE"
printf '\n\nDiff stat:\n' >> "$CONTEXT_FILE"
git diff --stat "${BASE_SHA}..HEAD" >> "$CONTEXT_FILE"
printf '\nChanged files:\n' >> "$CONTEXT_FILE"
git diff --name-only "${BASE_SHA}..HEAD" >> "$CONTEXT_FILE"
# Stream the full diff directly to avoid holding it in a bash variable
printf '\nFull diff (base..head):\n' >> "$CONTEXT_FILE"
git diff "${BASE_SHA}..HEAD" >> "$CONTEXT_FILE"
{
    printf '\nExisting open (unresolved) review threads (evaluate each against the current\n'
    printf 'diff; append the GraphQL id of each addressed thread to %s,\n' "${RESOLVE_THREADS_FILE}"
    printf 'one id per line, before posting the review; skip new findings already\n'
    printf 'covered by still-open threads):\n'
    printf '%s\n' "${REVIEW_THREADS_JSON}"
    printf '\nCI check status:\n'
    printf '%s\n' "${CHECKS_JSON}"
} >> "$CONTEXT_FILE"

# -----------------------------------------------------------------------------
# Invoke agent
# -----------------------------------------------------------------------------

log "Running agent to review PR (provider: ${AGENT_PROVIDER})"
run_agent "review.md" "$CONTEXT_FILE"
rm -f "$CONTEXT_FILE"

RESOLVE_COUNT="$(grep -c . "$RESOLVE_THREADS_FILE")" || true
log "Threads recorded for resolution: ${RESOLVE_COUNT:-0}"

# -----------------------------------------------------------------------------
# Verify the review was posted (design decision 1)
# -----------------------------------------------------------------------------
#
# Look for at least one review authored by this bot against the PR head SHA.
# Filtering on commit_id (rather than just \"any review by us\") means a stale
# review from an earlier head — e.g. if the workflow re-runs after new commits
# but before the agent posts — does not falsely satisfy the check.

log "Verifying a review by ${REVIEWER_LOGIN} exists on ${HEAD_SHA}"
# Use `jq -s` to aggregate across all pages rather than applying `--jq` once
# per page: `--jq` + `--paginate` emits one number per page, which breaks the
# `-eq 0` numeric comparison when there are multiple pages of reviews.
# `jq -s` slurps all pages into a single outer array and counts matches once.
REVIEW_MATCHES="$(gh api --paginate "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/reviews" \
    | jq -s "[.[][] | select(.user.login == \"${REVIEWER_LOGIN}\" and .commit_id == \"${HEAD_SHA}\")] | length")"

if [ "${REVIEW_MATCHES:-0}" -eq 0 ]; then
    log "ERROR: no review by ${REVIEWER_LOGIN} found on ${HEAD_SHA} for PR #${GITHUB_PR_NUMBER} — agent did not complete the review"
    exit 1
fi

log "Verified: ${REVIEW_MATCHES} review(s) by ${REVIEWER_LOGIN} on ${HEAD_SHA}"
log "Reviewer agent finished successfully"
exit 0
