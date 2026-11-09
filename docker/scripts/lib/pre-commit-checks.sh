#!/bin/bash
set -euo pipefail

# Pre-commit checks backstop for the developer agent.
# Runs the configured check command in the configured directory when the
# diff HEAD_BEFORE..HEAD touches .github/.
# Posts a PR comment on failure.
# Returns 0 whether checks pass, fail, or the diff gate skipped;
# non-zero only on bad arguments. Fail-open on backstop errors.
#
# Callers must source this file inside entrypoint.sh where log() is defined.
#
# Required env: WORK_DIR, GITHUB_REPO, GH_TOKEN
# Optional env:
#   PRE_COMMIT_SCRIPTS_DIR  Path (relative to WORK_DIR) of the directory
#                           where the check command is run.
#                           Defaults to ".github/scripts".  Set to an empty
#                           string to disable checks entirely.
#   PRE_COMMIT_CHECK_CMD    Shell command executed inside the scripts directory.
#                           When unset or empty, checks are skipped — configure
#                           this per-deployment to avoid baking repo-specific
#                           commands into the Docker image.  The command is
#                           responsible for all setup (e.g. dependency
#                           installation) as well as the actual checks.
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

    # Optional env: scripts directory and check command.
    # Use single-dash expansion so an explicitly empty value is preserved and
    # treated as "disable" for both variables.  PRE_COMMIT_CHECK_CMD has no
    # built-in default to avoid baking repo-specific commands into the image.
    local scripts_rel="${PRE_COMMIT_SCRIPTS_DIR-.github/scripts}"
    local check_cmd="${PRE_COMMIT_CHECK_CMD-}"

    # An empty scripts dir or an unset/empty check command disables checks.
    if [[ -z "${scripts_rel}" ]]; then
        log "pre-commit-checks: PRE_COMMIT_SCRIPTS_DIR is empty; skipping checks"
        return 0
    fi
    if [[ -z "${check_cmd}" ]]; then
        log "pre-commit-checks: PRE_COMMIT_CHECK_CMD is not set; skipping checks"
        return 0
    fi

    local scripts_dir="${WORK_DIR}/${scripts_rel}"

    # Compute diff and check if any path touches .github/
    # (follows the same CWD=WORK_DIR convention as fix-checks-guard.sh)
    # Fail-open: a malformed/unavailable SHA or any git error must not abort
    # the caller — capture the exit status and return 0 instead.
    local changed_paths git_diff_exit=0
    changed_paths="$(git diff --name-only "${head_before}..HEAD")" || git_diff_exit=$?
    if [[ $git_diff_exit -ne 0 ]]; then
        log "pre-commit-checks: git diff failed (exit ${git_diff_exit}); skipping checks (fail-open)"
        return 0
    fi

    # Use a here-string instead of printf | grep -q to avoid SIGPIPE.
    # grep -q exits on the first match, which would cause printf to receive
    # SIGPIPE for large path lists; with pipefail that makes the pipeline
    # non-zero, so the negated `if !` would incorrectly skip the checks.
    if ! grep -q '^\.github/' <<< "$changed_paths"; then
        log "pre-commit-checks: diff does not touch .github/, skipping"
        return 0
    fi

    log "pre-commit-checks: running ${check_cmd} in ${scripts_rel}"

    # Run the configured check command, capturing combined stdout+stderr
    # Fail-open: a full or unavailable temp filesystem must not abort the caller
    # before its git push — capture mktemp's exit status and return 0 instead.
    local check_output_file mktemp_exit=0 check_exit=0
    check_output_file="$(mktemp)" || mktemp_exit=$?
    if [[ $mktemp_exit -ne 0 ]]; then
        log "pre-commit-checks: mktemp failed (exit ${mktemp_exit}); skipping checks (fail-open)"
        return 0
    fi
    (cd "${scripts_dir}" && bash -c "${check_cmd}") > "${check_output_file}" 2>&1 || check_exit=$?

    if [[ $check_exit -eq 0 ]]; then
        log "pre-commit-checks: passed"
        rm -f "${check_output_file}"
        return 0
    fi

    # Checks failed — prepare and post PR comment
    # Fail-open: a transient repository/worktree error on rev-parse must not
    # abort the caller before its git push — capture the exit status and return
    # 0 instead, following the same pattern as git diff and mktemp.
    local head_sha git_rev_parse_exit=0
    head_sha="$(git rev-parse HEAD)" || git_rev_parse_exit=$?
    if [[ $git_rev_parse_exit -ne 0 ]]; then
        log "pre-commit-checks: git rev-parse HEAD failed (exit ${git_rev_parse_exit}); skipping PR comment (fail-open)"
        return 0
    fi

    log "pre-commit-checks: failed — posting PR comment to PR #${pr_number}"

    # Build truncated output block (last ~200 lines when output is larger)
    local line_count truncation_prefix="" output_block
    line_count="$(wc -l < "${check_output_file}")"
    if [[ $line_count -gt 200 ]]; then
        truncation_prefix="(…truncated — full output in container logs…)
"
        output_block="$(tail -n 200 "${check_output_file}")"
        # Emit the complete output to the container log before discarding the
        # file, so that the truncation marker's promise ("full output in
        # container logs") is not false.
        log "pre-commit-checks: full check output (${line_count} lines):"
        cat "${check_output_file}"
    else
        output_block="$(cat "${check_output_file}")"
    fi
    rm -f "${check_output_file}"

    # Build the comment body.  Store triple-backtick in a variable so the
    # heredoc template itself does not contain bare backticks that bash would
    # treat as command substitution.
    local fence
    fence='```'
    # Conditionally include the GITHUB_RUN_ID so concurrent/repeated failures
    # can be correlated to their specific agent run (Decision 7).
    local run_id_line=""
    if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
        run_id_line="
Agent run: \`${GITHUB_RUN_ID}\`"
    fi
    local comment_body
    comment_body="$(cat <<EOF
### Developer agent pre-commit checks failed

\`${check_cmd}\` in \`${scripts_rel}/\` failed on commit \`${head_sha}\`.${run_id_line}
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
