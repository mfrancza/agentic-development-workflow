#!/bin/bash
# =============================================================================
# Validation script: resolve-conflicts zero-diff guard — acceptance and rejection paths
# Issue #324: end-to-end validation of justified ours-equal guard
#
# Tests the zero-diff guard logic extracted from docker/scripts/entrypoint.sh
# (action_resolve_conflicts, zero-diff check block):
#   - Acceptance path: marker present in correct section → guard accepts
#   - Rejection path: marker absent → guard escalates
#   - Boundary cases: marker in wrong section, multiple files, edge whitespace
#
# Also validates the full guard behavior using a live git repo with staged
# content identical to HEAD (simulating what happens after Claude keeps the
# PR side and runs git add).
# =============================================================================
set -euo pipefail

PASS=0
FAIL=0

# Color codes (disabled if not a tty)
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    RESET='\033[0m'
else
    GREEN=''
    RED=''
    RESET=''
fi

pass() {
    PASS=$((PASS + 1))
    echo -e "${GREEN}PASS${RESET}: $1"
}

fail() {
    FAIL=$((FAIL + 1))
    echo -e "${RED}FAIL${RESET}: $1"
}

# =============================================================================
# Helper: the awk justification check (copied verbatim from entrypoint.sh)
# =============================================================================

# Returns 0 (success) if the justification marker is found within the
# "### <file-path>" section of CLAUDE_OUTPUT; returns 1 otherwise.
check_justification() {
    local zdfile="$1"
    local claude_output="$2"
    echo "$claude_output" | awk -v hdr="### ${zdfile}" '
        $0 == hdr { in_section=1; next }
        in_section && /^### / { in_section=0 }
        in_section && index($0, "**Kept PR side (ours):**") { found=1; exit }
        END { exit !found }
    '
}

# =============================================================================
# Part 1: Unit tests of the awk justification check
# =============================================================================

echo ""
echo "=== Part 1: awk justification check unit tests ==="
echo ""

ZDFILE="config/version.txt"

# ---
# Test 1a: Acceptance — marker present in correct section
# ---
CLAUDE_OUTPUT_ACCEPT=$(cat <<'EOF'
### config/version.txt
**Conflict type:** Both sides bumped the package version number
**Resolution:** Kept the PR branch version (2.0.0) because it supersedes the base branch's patch bump (1.1.1 → 1.1.2). The PR intentionally introduced a major-version bump that makes the base-side patch irrelevant.
**Kept PR side (ours):** The incoming hunk changed version from 1.1.1 to 1.1.2; the PR branch already superseded this with a deliberate major-version bump to 2.0.0, so the incoming patch needs no preservation.

### Unresolvable files
None.
EOF
)

if check_justification "$ZDFILE" "$CLAUDE_OUTPUT_ACCEPT"; then
    pass "1a: marker present in correct section → accepted"
else
    fail "1a: marker present in correct section → expected acceptance but guard rejected"
fi

# ---
# Test 1b: Rejection — marker completely absent
# ---
CLAUDE_OUTPUT_ABSENT=$(cat <<'EOF'
### config/version.txt
**Conflict type:** Both sides bumped the package version number
**Resolution:** Kept the PR branch version (2.0.0) because it is higher.

### Unresolvable files
None.
EOF
)

if check_justification "$ZDFILE" "$CLAUDE_OUTPUT_ABSENT"; then
    fail "1b: marker absent → expected rejection but guard accepted"
else
    pass "1b: marker absent → correctly rejected"
fi

# ---
# Test 1c: Rejection — marker in a different file's section (wrong section)
# ---
CLAUDE_OUTPUT_WRONG_SECTION=$(cat <<'EOF'
### other/file.txt
**Conflict type:** unrelated
**Resolution:** merged both sides
**Kept PR side (ours):** The incoming hunk added a comment that the PR branch already removed in a broader refactor.

### config/version.txt
**Conflict type:** Both sides bumped version
**Resolution:** Kept PR side

### Unresolvable files
None.
EOF
)

if check_justification "$ZDFILE" "$CLAUDE_OUTPUT_WRONG_SECTION"; then
    fail "1c: marker in wrong section → expected rejection but guard accepted"
else
    pass "1c: marker in wrong section → correctly rejected (marker not in config/version.txt section)"
fi

# ---
# Test 1d: Acceptance — marker present; file section is the last section (no closing ### heading)
# ---
CLAUDE_OUTPUT_LAST_SECTION=$(cat <<'EOF'
### other/file.txt
**Conflict type:** unrelated
**Resolution:** merged both sides

### config/version.txt
**Conflict type:** Both sides bumped version
**Resolution:** Kept PR side
**Kept PR side (ours):** The incoming change bumped patch from 1.0 to 1.1; the PR already moved to 2.0.
EOF
)

if check_justification "$ZDFILE" "$CLAUDE_OUTPUT_LAST_SECTION"; then
    pass "1d: marker present in last section (no trailing ### heading) → accepted"
else
    fail "1d: marker present in last section → expected acceptance but guard rejected"
fi

# ---
# Test 1e: Acceptance — marker present but as part of a word boundary (index check is substring, so this should accept)
#           Confirm the awk index() function matches as a substring correctly.
# ---
CLAUDE_OUTPUT_INLINE=$(cat <<'EOF'
### config/version.txt
**Kept PR side (ours):** The incoming patch bump was superseded.
EOF
)

if check_justification "$ZDFILE" "$CLAUDE_OUTPUT_INLINE"; then
    pass "1e: marker as first field in section → accepted (inline with no preamble)"
else
    fail "1e: marker as first field in section → expected acceptance but guard rejected"
fi

# ---
# Test 1f: Rejection — empty output (Claude produced nothing)
# ---
CLAUDE_OUTPUT_EMPTY=""

if check_justification "$ZDFILE" "$CLAUDE_OUTPUT_EMPTY"; then
    fail "1f: empty Claude output → expected rejection but guard accepted"
else
    pass "1f: empty Claude output → correctly rejected"
fi

# ---
# Test 1g: Acceptance — multiple files, all justified
# ---
CLAUDE_OUTPUT_MULTI=$(cat <<'EOF'
### config/version.txt
**Conflict type:** version bump conflict
**Resolution:** kept PR branch version
**Kept PR side (ours):** Base branch bumped patch; PR branch bumped major. Major wins.

### src/index.ts
**Conflict type:** import path conflict
**Resolution:** PR branch restructured imports; base branch added a new import into the old structure
**Kept PR side (ours):** The base branch's new import is for a module the PR branch deleted in its restructuring; no preservation needed.

### Unresolvable files
None.
EOF
)

ZDFILES_MULTI="config/version.txt
src/index.ts"

UNJUSTIFIED_MULTI=""
while IFS= read -r ZDFILE_ITER; do
    [ -z "$ZDFILE_ITER" ] && continue
    if ! check_justification "$ZDFILE_ITER" "$CLAUDE_OUTPUT_MULTI"; then
        UNJUSTIFIED_MULTI="${UNJUSTIFIED_MULTI}${ZDFILE_ITER}"$'\n'
    fi
done <<< "$ZDFILES_MULTI"
UNJUSTIFIED_MULTI="$(printf '%s' "$UNJUSTIFIED_MULTI" | sed '/^$/d')"

if [ -z "$UNJUSTIFIED_MULTI" ]; then
    pass "1g: multiple files — both justified → all accepted, none escalated"
else
    fail "1g: multiple files — both justified → expected none escalated but got: ${UNJUSTIFIED_MULTI}"
fi

# ---
# Test 1h: Rejection — multiple files, one missing justification
# ---
CLAUDE_OUTPUT_ONE_MISSING=$(cat <<'EOF'
### config/version.txt
**Conflict type:** version bump conflict
**Resolution:** kept PR branch version
**Kept PR side (ours):** Base branch bumped patch; PR branch bumped major. Major wins.

### src/index.ts
**Conflict type:** import path conflict
**Resolution:** PR branch restructured imports; kept PR side

### Unresolvable files
None.
EOF
)

UNJUSTIFIED_ONE=""
while IFS= read -r ZDFILE_ITER; do
    [ -z "$ZDFILE_ITER" ] && continue
    if ! check_justification "$ZDFILE_ITER" "$CLAUDE_OUTPUT_ONE_MISSING"; then
        UNJUSTIFIED_ONE="${UNJUSTIFIED_ONE}${ZDFILE_ITER}"$'\n'
    fi
done <<< "$ZDFILES_MULTI"
UNJUSTIFIED_ONE="$(printf '%s' "$UNJUSTIFIED_ONE" | sed '/^$/d')"

if [ "$UNJUSTIFIED_ONE" = "src/index.ts" ]; then
    pass "1h: multiple files — one missing justification → only that file escalated"
else
    fail "1h: multiple files — one missing justification → expected 'src/index.ts' in escalation list, got: '${UNJUSTIFIED_ONE}'"
fi

# =============================================================================
# Part 2: Full git-repo simulation of the zero-diff check
# Verifies that the git diff --cached --quiet HEAD -- <file> command correctly
# identifies a staged-but-unchanged file.
# =============================================================================

echo ""
echo "=== Part 2: git-repo zero-diff detection simulation ==="
echo ""

TMPDIR_GUARD="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_GUARD"; }
trap cleanup EXIT

# Set up a minimal git repo
cd "$TMPDIR_GUARD"
git init -q -b base
git config user.email "test@test.invalid"
git config user.name "Test"

# Create an initial commit (simulates "main" base state)
mkdir -p config src
echo "version=1.0.0" > config/version.txt
echo "export const greeting = 'hello';" > src/index.ts
git add config/version.txt src/index.ts
git commit -q -m "initial"

# Branch from HEAD (simulates a PR branch)
git checkout -q -b pr-branch

# The PR branch modifies both files (simulates what the PR introduced)
echo "version=2.0.0" > config/version.txt
echo "export const greeting = 'hello, world';" > src/index.ts
git add config/version.txt src/index.ts
git commit -q -m "PR changes: bump major version, update greeting"

# Go back to base and add a conflicting change (simulates the base branch advance)
git checkout -q base
echo "version=1.0.1" > config/version.txt
echo "export const greeting = 'hi';" > src/index.ts
git add config/version.txt src/index.ts
git commit -q -m "base: patch bump and greeting tweak"

# Return to the PR branch and start the merge (this will conflict)
git checkout -q pr-branch
set +e
git merge base 2>/dev/null
MERGE_EXIT="$?"
set -e

if [ "$MERGE_EXIT" -ne 1 ]; then
    fail "2a: expected conflict (exit 1) from git merge, got ${MERGE_EXIT}"
else
    pass "2a: git merge produces conflict as expected (exit 1)"
fi

# Simulate Claude resolving by keeping the PR side for config/version.txt
# (staged result will equal HEAD — zero-diff)
echo "version=2.0.0" > config/version.txt
git add config/version.txt

# Simulate Claude resolving by merging both sides for src/index.ts
# (staged result is different from HEAD — non-zero-diff)
echo "export const greeting = 'hello, world'; // updated" > src/index.ts
git add src/index.ts

CONFLICTED_FILES="config/version.txt src/index.ts"

# Collect zero-diff files using the same logic as entrypoint.sh
ZERO_DIFF_FILES_REPO=""
for CFILE in $CONFLICTED_FILES; do
    if git diff --cached --quiet HEAD -- "$CFILE" 2>/dev/null; then
        ZERO_DIFF_FILES_REPO="${ZERO_DIFF_FILES_REPO}${CFILE}"$'\n'
    fi
done
ZERO_DIFF_FILES_REPO="$(printf '%s' "$ZERO_DIFF_FILES_REPO" | sed '/^$/d')"

if [ "$ZERO_DIFF_FILES_REPO" = "config/version.txt" ]; then
    pass "2b: zero-diff check correctly identifies config/version.txt (kept PR side) as zero-diff"
else
    fail "2b: expected 'config/version.txt' in zero-diff list, got: '${ZERO_DIFF_FILES_REPO}'"
fi

if ! echo "$ZERO_DIFF_FILES_REPO" | grep -q "src/index.ts"; then
    pass "2c: zero-diff check correctly excludes src/index.ts (content changed) from zero-diff list"
else
    fail "2c: src/index.ts should NOT appear in zero-diff list (it was changed)"
fi

# Test acceptance path: zero-diff file has justification marker
CLAUDE_OUTPUT_GIT_ACCEPT=$(cat <<'EOF'
### config/version.txt
**Conflict type:** Both sides modified the version number
**Resolution:** Kept the PR branch version (2.0.0) because the PR intentionally introduced a major-version bump; the base branch's patch bump (1.0.1) is a subset of and superseded by the PR's change.
**Kept PR side (ours):** The incoming hunk changed version from 1.0.0 to 1.0.1; the PR already advanced to 2.0.0 with a breaking-change major bump, making the patch irrelevant.

### src/index.ts
**Conflict type:** Both sides modified the greeting constant
**Resolution:** Combined the PR's longer message ('hello, world') with a trailing comment from the base branch merge.

### Unresolvable files
None.
EOF
)

UNJUSTIFIED_GIT_ACCEPT=""
while IFS= read -r ZDFILE_GIT; do
    [ -z "$ZDFILE_GIT" ] && continue
    if ! check_justification "$ZDFILE_GIT" "$CLAUDE_OUTPUT_GIT_ACCEPT"; then
        UNJUSTIFIED_GIT_ACCEPT="${UNJUSTIFIED_GIT_ACCEPT}${ZDFILE_GIT}"$'\n'
    fi
done <<< "$ZERO_DIFF_FILES_REPO"
UNJUSTIFIED_GIT_ACCEPT="$(printf '%s' "$UNJUSTIFIED_GIT_ACCEPT" | sed '/^$/d')"

if [ -z "$UNJUSTIFIED_GIT_ACCEPT" ]; then
    pass "2d: acceptance path end-to-end — zero-diff file with justification marker → no escalation"
else
    fail "2d: acceptance path end-to-end — expected no escalation but got: ${UNJUSTIFIED_GIT_ACCEPT}"
fi

# Test rejection path: zero-diff file missing justification marker
CLAUDE_OUTPUT_GIT_REJECT=$(cat <<'EOF'
### config/version.txt
**Conflict type:** Both sides modified the version number
**Resolution:** Kept the PR branch version (2.0.0).

### src/index.ts
**Conflict type:** Both sides modified the greeting constant
**Resolution:** Combined both sides.

### Unresolvable files
None.
EOF
)

UNJUSTIFIED_GIT_REJECT=""
while IFS= read -r ZDFILE_GIT; do
    [ -z "$ZDFILE_GIT" ] && continue
    if ! check_justification "$ZDFILE_GIT" "$CLAUDE_OUTPUT_GIT_REJECT"; then
        UNJUSTIFIED_GIT_REJECT="${UNJUSTIFIED_GIT_REJECT}${ZDFILE_GIT}"$'\n'
    fi
done <<< "$ZERO_DIFF_FILES_REPO"
UNJUSTIFIED_GIT_REJECT="$(printf '%s' "$UNJUSTIFIED_GIT_REJECT" | sed '/^$/d')"

if [ "$UNJUSTIFIED_GIT_REJECT" = "config/version.txt" ]; then
    pass "2e: rejection path end-to-end — zero-diff file without justification → escalation with correct file"
else
    fail "2e: rejection path end-to-end — expected 'config/version.txt' in escalation list, got: '${UNJUSTIFIED_GIT_REJECT}'"
fi

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "=== Summary ==="
echo "Passed: ${PASS}"
echo "Failed: ${FAIL}"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo "All tests passed. The zero-diff guard behaves correctly on both paths."
    exit 0
else
    echo "Some tests FAILED. See output above for details."
    exit 1
fi
