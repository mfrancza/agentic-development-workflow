#!/bin/bash
set -euo pipefail

# =============================================================================
# scripts/generate-docs.sh
#
# Regenerates the three <!-- generated:* --> sections in AGENTS.md by reading
# their authoritative sources:
#
#   generated:labels            ← terraform/modules/labels/main.tf
#   generated:agent-actions     ← docker/scripts/entrypoint.sh
#   generated:workflow-triggers ← .github/workflows/agent-*.yml
#
# Usage: run from any directory within the repo:
#   bash scripts/generate-docs.sh
#
# Requirements: bash ≥ 4, awk (POSIX), python3 (stdlib only — no PyYAML needed).
# Output is deterministic (labels sorted A-Z, workflows sorted by filename,
# column widths computed from data) so two independent runs produce identical
# output and do not conflict.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

AGENTS_MD="${REPO_ROOT}/AGENTS.md"
LABELS_TF="${REPO_ROOT}/terraform/modules/labels/main.tf"
ENTRYPOINT="${REPO_ROOT}/docker/scripts/entrypoint.sh"
WORKFLOWS_DIR="${REPO_ROOT}/.github/workflows"

# -----------------------------------------------------------------------------
# Validate prerequisites
# -----------------------------------------------------------------------------

_die() { echo "ERROR: $*" >&2; exit 1; }

[ -f "$AGENTS_MD"     ] || _die "required file not found: $AGENTS_MD"
[ -f "$LABELS_TF"     ] || _die "required file not found: $LABELS_TF"
[ -f "$ENTRYPOINT"    ] || _die "required file not found: $ENTRYPOINT"
[ -d "$WORKFLOWS_DIR" ] || _die "workflows directory not found: $WORKFLOWS_DIR"
command -v python3 >/dev/null 2>&1 || _die "python3 is required but not found in PATH"

# -----------------------------------------------------------------------------
# Helper: replace a generated section in AGENTS.md in-place
#
#   replace_section FILE SECTION CONTENT
#
#   FILE    — path to the Markdown file
#   SECTION — section identifier (labels | agent-actions | workflow-triggers)
#   CONTENT — new text to place between the markers; must end with a newline
#
# Exits non-zero with a clear error message if either marker is missing.
# -----------------------------------------------------------------------------

replace_section() {
    local file="$1"
    local section="$2"
    local content="$3"

    local sp="<!-- generated:${section}:start"
    local ep="<!-- generated:${section}:end -->"

    # Write content to a temp file so awk can read it back with getline
    # (avoids multi-line variable quoting issues inside awk -v).
    local cf tf
    cf=$(mktemp)
    tf=$(mktemp)
    printf '%s' "$content" > "$cf"

    awk \
        -v sp="$sp" \
        -v ep="$ep" \
        -v cf="$cf" \
        -v sec="$section" \
        -v src="$file" \
    '
    BEGIN { skip=0; saw_start=0; saw_end=0 }

    !skip && index($0, sp) {
        print                           # emit the start-marker line unchanged
        skip=1; saw_start=1
        while ((getline ln < cf) > 0) print ln
        close(cf)
        next
    }
    skip && index($0, ep) {
        skip=0; saw_end=1
        print                           # emit the end-marker line unchanged
        next
    }
    skip  { next }                      # discard old generated content
    { print }

    END {
        if (!saw_start) {
            print "ERROR: start marker \"<!-- generated:" sec ":start\" not found in " src \
                  > "/dev/stderr"
            exit 1
        }
        if (!saw_end) {
            print "ERROR: end marker \"<!-- generated:" sec ":end -->\" not found in " src \
                  > "/dev/stderr"
            exit 1
        }
    }
    ' "$file" > "$tf"

    mv "$tf" "$file"
    rm -f "$cf"
}

# =============================================================================
# Section 1: generated:labels
# Source: terraform/modules/labels/main.tf  →  automation_labels local block
#
# AWK state machine targets the specific HCL block format:
#   automation_labels = {
#     "name" = {
#       color       = "rrggbb"
#       description = "Human-readable description."
#     }
#   }
# Labels are sorted A-Z for determinism.
# =============================================================================

_gen_labels() {
    # Pass 1: extract "name|description" pairs from the HCL block and sort A-Z.
    local raw
    raw="$(awk '
    BEGIN { in_block=0; in_item=0; name=""; desc="" }

    # Detect the opening of the automation_labels block.
    /automation_labels[[:space:]]*=[[:space:]]*\{/ {
        in_block=1; next
    }
    !in_block { next }

    # Label entry start:  "label-name" = {
    in_block && !in_item && /^[[:space:]]*"[^"]+"[[:space:]]*=[[:space:]]*\{/ {
        line=$0
        sub(/^[[:space:]]*"/, "", line)      # strip leading whitespace + opening "
        sub(/"[[:space:]]*=.*$/, "", line)   # strip  " = {  and anything after
        name=line; desc=""; in_item=1; next
    }

    # description line inside a label entry
    in_item && /description[[:space:]]*=[[:space:]]*"/ {
        line=$0
        sub(/.*description[[:space:]]*=[[:space:]]*"/, "", line)  # strip prefix
        sub(/"[[:space:]]*$/, "", line)                           # strip trailing "
        desc=line; next
    }

    # Closing brace of a label entry — emit the collected pair.
    in_item && /^[[:space:]]*\}[[:space:]]*$/ {
        print name "|" desc
        name=""; desc=""; in_item=0; next
    }

    # Closing brace of the automation_labels block itself — done.
    !in_item && /^[[:space:]]*\}[[:space:]]*$/ {
        in_block=0; exit
    }
    ' "$LABELS_TF" | sort)"

    # Pass 2: compute column widths and render the Markdown table.
    printf '%s\n' "$raw" | awk -F'|' '
    BEGIN { wn=5; wd=11 }   # minimums: len("Label")=5, len("Description")=11
    {
        names[NR]=$1; descs[NR]=$2
        n=length($1)+2       # +2 for surrounding backticks  `name`
        if (n  > wn) wn=n
        if (length($2) > wd) wd=length($2)
    }
    END {
        fmt = "| %-" wn "s | %-" wd "s |\n"
        printf fmt, "Label", "Description"
        # Separator row
        printf "|"
        for (i=0; i<wn+2; i++) printf "-"
        printf "|"
        for (i=0; i<wd+2; i++) printf "-"
        printf "|\n"
        for (i=1; i<=NR; i++) {
            printf fmt, "`" names[i] "`", descs[i]
        }
    }
    '
}

LABELS_CONTENT="$(_gen_labels)
"
replace_section "$AGENTS_MD" "labels" "$LABELS_CONTENT"
echo "Updated generated:labels in AGENTS.md"

# =============================================================================
# Section 2: generated:agent-actions
# Source: docker/scripts/entrypoint.sh
#   Action names  ← case "$AGENT_ACTION" in  dispatcher (preserved in order)
#   Required vars ← : "${VAR:?...}"  patterns in each  action_*()  function
# =============================================================================

_gen_agent_actions() {
    # Step 1: extract action names in dispatcher order (stop before the *) arm).
    mapfile -t _actions < <(awk '
        /^case "\$AGENT_ACTION" in/ { found=1; next }
        found && /^[[:space:]]+\*\)/ { exit }
        found && /^[[:space:]]+[a-z][a-z-]*\)/ {
            line=$0
            sub(/^[[:space:]]+/, "", line)
            sub(/\).*$/, "", line)
            print line
        }
    ' "$ENTRYPOINT")

    # Step 2: for each action, extract required vars from its function body.
    # The bash function name is  action_<name>  with hyphens replaced by underscores.
    declare -A _vars_map
    local _action _func _vars
    for _action in "${_actions[@]}"; do
        _func="action_${_action//-/_}"
        # Match lines of the form:   : "${VAR:?error message}"
        # inside the function body.  Function ends at a lone } at column 0.
        _vars="$(awk -v fn="$_func" '
            $0 ~ ("^" fn "\\(\\)") { in_fn=1; next }
            in_fn && /^\}[[:space:]]*$/ { in_fn=0; next }
            in_fn && index($0, ": \"${") > 0 {
                line=$0
                sub(/.*: "\$\{/, "", line)   # strip everything up to  : "${
                sub(/:\?.*/, "", line)        # strip  :?message  to end
                print line
            }
        ' "$ENTRYPOINT" | sort | awk 'NR>1{printf ", "}{printf $0} END{print ""}')"
        _vars_map[$_action]="${_vars:-}"
    done

    # Step 3: compute column widths.
    local _header="Required vars (in addition to the provider API key, \`GH_TOKEN\`, \`GITHUB_REPO\`)"
    local _wa=6             # minimum width: len("Action")
    local _wv="${#_header}" # header text is the minimum for column 2
    local _al _fv _vl
    for _action in "${_actions[@]}"; do
        _al=$(( ${#_action} + 2 ))     # +2 for backtick wrapping
        (( _al > _wa )) && _wa=$_al
        _vars="${_vars_map[$_action]}"
        if [ -n "$_vars" ]; then
            _fv="$(printf '%s' "$_vars" | sed 's/\([A-Z_][A-Z_]*\)/`\1`/g')"
            _vl="${#_fv}"
            (( _vl > _wv )) && _wv=$_vl
        fi
    done

    # Step 4: render the table.
    local _sep1 _sep2
    _sep1="$(printf '%*s' "$_wa" '' | tr ' ' '-')"
    _sep2="$(printf '%*s' "$_wv" '' | tr ' ' '-')"

    printf "| %-${_wa}s | %-${_wv}s |\n" "Action" "$_header"
    printf "|-%s-|-%s-|\n" "$_sep1" "$_sep2"

    local _fvars
    for _action in "${_actions[@]}"; do
        _vars="${_vars_map[$_action]}"
        _fvars=""
        if [ -n "$_vars" ]; then
            _fvars="$(printf '%s' "$_vars" | sed 's/\([A-Z_][A-Z_]*\)/`\1`/g')"
        fi
        printf "| %-${_wa}s | %-${_wv}s |\n" "\`${_action}\`" "$_fvars"
    done
}

ACTIONS_CONTENT="$(_gen_agent_actions)
"
replace_section "$AGENTS_MD" "agent-actions" "$ACTIONS_CONTENT"
echo "Updated generated:agent-actions in AGENTS.md"

# =============================================================================
# Section 3: generated:workflow-triggers
# Source: .github/workflows/agent-*.yml  (non-reusable caller stubs only)
#
# Parses YAML using stdlib-only Python — no PyYAML required.  The parser
# handles the specific structures found in these files:
#   on: block        — 2-space-indented event names with inline types/branches
#   job if: clause   — single-line or YAML block-scalar (>) multi-line
#
# Columns: Workflow file | Trigger events | Key gate (first job if:)
# Files and events are sorted for determinism.
# =============================================================================

TRIGGERS_CONTENT="$(python3 - "$WORKFLOWS_DIR" <<'PYEOF'
import sys, os, glob, re

# ---------------------------------------------------------------------------
# Minimal YAML parser for GitHub Actions workflow files (stdlib only).
# Handles the specific structures used in agent-*.yml files without PyYAML.
# ---------------------------------------------------------------------------

def parse_on_block(lines):
    """
    Parse the top-level 'on:' block and return a dict of
    {event_name: {types: [...], branches: [...]}} (values may be empty dicts).
    """
    events = {}
    i = 0
    n = len(lines)
    # Find top-level 'on:' line (column 0)
    while i < n:
        if lines[i].rstrip() == 'on:':
            i += 1
            break
        i += 1
    else:
        return events  # no on: block found

    # Collect until we hit another top-level key (indent 0)
    current_event = None
    while i < n:
        line = lines[i]
        stripped = line.rstrip()
        if not stripped:                        # blank line — continue
            i += 1; continue
        content = stripped.lstrip()             # stripped of all whitespace
        if content.startswith('#'):             # comment line — skip
            i += 1; continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:           # back to top level
            break
        if indent == 2:           # event name
            current_event = content.rstrip(':')
            events[current_event] = {}
        elif indent >= 4 and current_event is not None:
            m = re.match(r'\s+types:\s*\[([^\]]+)\]', line)
            if m:
                events[current_event]['types'] = [
                    t.strip().strip("'\"") for t in m.group(1).split(',')
                ]
            m = re.match(r'\s+branches:\s*\[([^\]]+)\]', line)
            if m:
                events[current_event]['branches'] = [
                    b.strip().strip("'\"") for b in m.group(1).split(',')
                ]
        i += 1
    return events


def fmt_events(events):
    """Format parsed on: events as a human-readable string."""
    if not events:
        return ''
    parts = []
    for event in sorted(events.keys()):
        cfg = events[event]
        sub = []
        if 'types' in cfg:
            sub.append(f"[{', '.join(cfg['types'])}]")
        if 'branches' in cfg:
            sub.append(f"branches: [{', '.join(cfg['branches'])}]")
        parts.append(f"{event}: {' '.join(sub)}" if sub else event)
    return '; '.join(parts)


def parse_first_job_if(lines):
    """
    Return the if: condition of the first job that has one, with whitespace
    normalized to a single space (handles both single-line and block-scalar >).
    """
    n = len(lines)
    i = 0
    # Find top-level 'jobs:' line
    while i < n:
        if lines[i].rstrip() == 'jobs:':
            i += 1
            break
        i += 1
    else:
        return ''

    while i < n:
        line = lines[i]
        stripped = line.rstrip()
        if not stripped:
            i += 1; continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            break   # out of jobs block
        if indent == 2 and stripped.endswith(':'):
            # Start of a job definition — scan its body for if:
            i += 1
            while i < n:
                jline = lines[i]
                jstripped = jline.rstrip()
                if not jstripped:
                    i += 1; continue
                ji = len(jline) - len(jline.lstrip())
                if ji <= 2:
                    break   # moved past this job
                # if: at indent 4
                m = re.match(r'    if:\s*(.*)', jline)
                if m:
                    val = m.group(1).strip()
                    if val in ('>', '|', '|-', '>-'):
                        # Block scalar — collect continuation lines (indent >= 6)
                        parts = []
                        i += 1
                        while i < n:
                            cl = lines[i]
                            ci = len(cl) - len(cl.lstrip()) if cl.strip() else 0
                            if cl.strip() and ci < 6:
                                break
                            if cl.strip():
                                parts.append(cl.strip())
                            i += 1
                        return ' '.join(parts)
                    else:
                        return val
                i += 1
        else:
            i += 1

    return ''


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

wdir = sys.argv[1]
files = sorted(
    fp for fp in glob.glob(os.path.join(wdir, 'agent-*.yml'))
    if 'reusable' not in os.path.basename(fp)
)

rows = []
for fp in files:
    name = os.path.basename(fp)
    with open(fp) as fh:
        content = fh.read()
    lines = content.splitlines()

    events = parse_on_block(lines)
    trigger = fmt_events(events)
    gate = parse_first_job_if(lines)
    # Normalize all internal whitespace in gate to single spaces
    gate = re.sub(r'\s+', ' ', gate).strip()
    rows.append((name, trigger, gate))

# Compute column widths from data; enforce header minimums.
w1 = max(len('Workflow'),  max(len(r[0]) + 2 for r in rows) if rows else 0)
w2 = max(len('Trigger'),   max(len(r[1]) for r in rows) if rows else 0)
w3 = max(len('Key gate'),  max(len(r[2]) for r in rows) if any(r[2] for r in rows) else 0)

fmt = '| {:<' + str(w1) + '} | {:<' + str(w2) + '} | {:<' + str(w3) + '} |'
print(fmt.format('Workflow', 'Trigger', 'Key gate'))
print(f'|-{"-" * w1}-|-{"-" * w2}-|-{"-" * w3}-|')
for (name, trigger, gate) in rows:
    print(fmt.format(f'`{name}`', trigger, gate))
PYEOF
)
"

replace_section "$AGENTS_MD" "workflow-triggers" "$TRIGGERS_CONTENT"
echo "Updated generated:workflow-triggers in AGENTS.md"

echo ""
echo "Done. Review changes with: git diff '${AGENTS_MD}'"
