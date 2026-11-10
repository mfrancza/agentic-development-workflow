#!/bin/bash
# Optional reply-only re-review. All API data stays in files, never shell arguments.
reply_review_snapshot() {
    local file="$1"
    if [[ -z "${REVIEWER_BOT_LOGIN:-}" ]]; then
        log "reply-only re-review disabled: REVIEWER_BOT_LOGIN is empty"
        return 1
    fi
    if ! gh api --paginate --slurp "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/comments?per_page=100" > "$file" ||
       [[ ! -s "$file" ]] ||
       ! jq -e 'type == "array" and length > 0 and all(.[]; type == "array" and all(.[]; (.id | type == "number")))' "$file" >/dev/null; then
        log "WARNING: reply-only re-review disabled: inline comment snapshot failed"
        return 1
    fi
}

reply_review_request() {
    local snapshot="$1" checkout_sha="$2" dir owner repo
    dir="$(dirname "$snapshot")"
    owner="${GITHUB_REPO%%/*}"; repo="${GITHUB_REPO#*/}"
    if ! gh api --paginate --slurp "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}/comments?per_page=100" > "$dir/comments" ||
       [[ ! -s "$dir/comments" ]] ||
       ! jq -e 'type == "array" and length > 0 and all(.[]; type == "array" and all(.[]; (.id | type == "number")))' "$dir/comments" >/dev/null; then
        log "WARNING: reply-only re-review: could not fetch complete comments"; return 0
    fi
    if ! gh api "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}" > "$dir/pr" ||
       [[ ! -s "$dir/pr" ]] ||
       ! jq -e '(.user.login | type == "string" and length > 0) and .user.type == "Bot"' "$dir/pr" >/dev/null; then
        log "WARNING: reply-only re-review: could not authenticate bot PR author"; return 0
    fi
    if ! gh api graphql --paginate --slurp -f query='query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100, after:$endCursor) { nodes { isResolved comments(first:1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } } }' -f owner="$owner" -f repo="$repo" -F number="$GITHUB_PR_NUMBER" > "$dir/threads" ||
       [[ ! -s "$dir/threads" ]] ||
       ! jq -e 'type == "array" and length > 0 and all(.[]; (.errors // [] | length == 0) and (.data.repository.pullRequest.reviewThreads.nodes | type == "array") and (.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage | type == "boolean")) and (.[-1].data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage == false)' "$dir/threads" >/dev/null; then
        log "WARNING: reply-only re-review: could not fetch complete review threads"; return 0
    fi
    local match_status=0
    jq -en --slurpfile before "$snapshot" --slurpfile after "$dir/comments" --slurpfile pages "$dir/threads" --slurpfile pr "$dir/pr" --arg reviewer "$REVIEWER_BOT_LOGIN" '
      ($before[0] | add // [] | map(.id)) as $old |
      ($after[0] | add // []) as $comments |
      ([$pages[0][] | .data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | .comments.nodes[0].databaseId | select(type == "number")]) as $open |
      ($pr[0].user.login | ascii_downcase) as $author |
      def root($id; $seen):
        if ($seen | index($id)) != null then null else
          ([$comments[] | select(.id == $id)] | if length == 1 then .[0] else null end) as $c |
          if $c == null then null elif $c.in_reply_to_id == null then $c else root($c.in_reply_to_id; $seen + [$id]) end
        end;
      any($comments[]; . as $c | ($old | index($c.id)) == null and ($c.in_reply_to_id | type == "number") and ($c.user.type == "Bot") and (($c.user.login // "" | ascii_downcase) == $author) and
        (root($c.id; []) as $r | $r != null and ($open | index($r.id)) != null and (($r.user.login // "" | ascii_downcase) == ($reviewer | ascii_downcase))))
    ' >/dev/null || match_status=$?
    if (( match_status != 0 )); then
        if (( match_status == 1 )); then
            log "reply-only re-review: no qualifying new replies"
        else
            log "WARNING: reply-only re-review: failed to evaluate reply evidence"
        fi
        return 0
    fi
    # Fetch state again immediately before label mutation, including author identity.
    if ! gh api "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}" > "$dir/live" ||
       [[ ! -s "$dir/live" ]] ||
       ! jq -e --arg sha "$checkout_sha" --arg repo "$GITHUB_REPO" --slurpfile initial "$dir/pr" '
         .state == "open" and .draft == false and (.head.sha == $sha) and
         ((.head.repo.full_name // "" | ascii_downcase) == ($repo | ascii_downcase)) and
         (.user.type == "Bot") and ((.user.login // "" | ascii_downcase) == ($initial[0].user.login | ascii_downcase)) and
         any(.labels[]?; .name == "agent:review") and (any(.labels[]?; .name == "human-required") | not)
       ' "$dir/live" >/dev/null; then
        log "WARNING: reply-only re-review skipped: live PR state, head, author, enrollment or pause guard failed (or API unavailable)"; return 0
    fi
    if ! gh pr edit "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --remove-label 'agent:review'; then
        log "WARNING: reply-only re-review: failed to remove agent:review"; return 0
    fi
    if ! gh pr edit "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --add-label 'agent:review'; then
        log "WARNING: reply-only re-review: agent:review re-add failed; enrollment may be lost; re-apply agent:review manually if restoration fails"
        if gh pr edit "$GITHUB_PR_NUMBER" --repo "$GITHUB_REPO" --add-label 'agent:review'; then
            log "reply-only re-review: best-effort enrollment restoration succeeded"
        else
            log "WARNING: reply-only re-review: restoration failed; enrollment lost; re-apply agent:review manually"
        fi
    fi
}
