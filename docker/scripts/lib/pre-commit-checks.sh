#!/bin/bash
set -euo pipefail

# Pre-commit checks backstop for the developer agent.
# Runs npm ci && npm run typecheck && npm test in .github/scripts/ when the
# diff HEAD_BEFORE..HEAD touches .github/. Posts a PR comment on failure.
# Returns 0 whether checks pass, fail, or the diff gate skipped;
# non-zero only on bad arguments. Fail-open on backstop errors.
#
# Callers must source this file inside entrypoint.sh where log() is defined.
#
# Required env: WORK_DIR, GITHUB_REPO, GH_TOKEN
# Required args: 1=head-before-sha  2=pr-number

# pre_commit_checks_run <head-before-sha> <pr-number>
#
# Returns 0 whether checks pass, fail, or the diff gate skipped;
# non-zero only on bad arguments.
pre_commit_checks_run() {
    local head_before="${1:?pre_commit_checks_run: head-before-sha is required}"
    local pr_number="${2:?pre_commit_checks_run: pr-number is required}"

    # Required env
    : "${WORK_DIR:?pre_commit_checks_run: WORK_DIR is required}"
    : "${GITHUB_REPO:?pre_commit_checks_run: GITHUB_REPO is required}"
    : "${GH_TOKEN:?pre_commit_checks_run: GH_TOKEN is required}"

    local scripts_dir="${WORK_DIR}/.github/scripts"

    # Compute diff and check if any path touches .github/
    # (follows the same CWD=WORK_DIR convention as fix-checks-guard.sh)
    local changed_paths
    changed_paths="$(git diff --name-only "${head_before}..HEAD")"

    if ! printf '%s\n' "$changed_paths" | grep -q '^\.github/'; then
        log "pre-commit-checks: diff does not touch .github/, skipping"
        return 0
    fi

    log "pre-commit-checks: running npm ci && npm run typecheck && npm test in .github/scripts"

    # Step 1: npm ci — fail-open on setup error (network failure, lockfile mismatch, etc.)
    local npm_ci_err npm_ci_exit=0
    npm_ci_err="$(cd "${scripts_dir}" && npm ci 2>&1)" || npm_ci_exit=$?
    if [[ $npm_ci_exit -ne 0 ]]; then
        log "pre-commit-checks: encountered error running checks (npm ci failed); skipping PR comment"
        return 0
    fi

    # Step 2: npm run typecheck && npm test, capturing combined stdout+stderr
    local check_output_file check_exit=0
    check_output_file="$(mktemp)"
    (cd "${scripts_dir}" && npm run typecheck && npm test) > "${check_output_file}" 2>&1 || check_exit=$?

    if [[ $check_exit -eq 0 ]]; then
        log "pre-commit-checks: passed"
        rm -f "${check_output_file}"
        return 0
    fi

    # Checks failed — prepare and post PR comment
    local head_sha
    head_sha="$(git rev-parse HEAD)"

    log "pre-commit-checks: failed — posting PR comment to PR #${pr_number}"

    # Build truncated output block (last ~200 lines when output is larger)
    local line_count truncation_prefix="" output_block
    line_count="$(wc -l < "${check_output_file}")"
    if [[ $line_count -gt 200 ]]; then
        truncation_prefix="(…truncated — full output in container logs…)
"
        output_block="$(tail -n 200 "${check_output_file}")"
    else
        output_block="$(cat "${check_output_file}")"
    fi
    rm -f "${check_output_file}"

    # Build the comment body.  Store triple-backtick in a variable so the
    # heredoc template itself does not contain bare backticks that bash would
    # treat as command substitution.
    local fence
    fence='```'
    local comment_body
    comment_body="$(cat <<EOF
### Developer agent pre-commit checks failed

\`npm run typecheck && npm test\` in \`.github/scripts/\` failed on commit \`${head_sha}\`.
The branch was pushed anyway; CI will re-check. See the agent run logs for the full output.

${fence}
${truncation_prefix}${output_block}
${fence}
EOF
)"

    # Post the PR comment — fail-open if posting fails (Decision 3)
    local gh_err gh_exit=0
    gh_err="$(gh pr comment "${pr_number}" --repo "${GITHUB_REPO}" --body "${comment_body}" 2>&1)" || gh_exit=$?
    if [[ $gh_exit -ne 0 ]]; then
        log "pre-commit-checks: failed to post PR comment (${gh_err}); push proceeding"
        return 0
    fi

    return 0
}
