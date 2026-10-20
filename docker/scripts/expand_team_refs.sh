#!/bin/bash

# Expand ADMIN_ASSIGNEES team references to login names for the grooming
# prompt. This file is sourced by entrypoint.sh after `log()` is available.
#
# The resolver credential is deliberately scoped to the one membership API
# request below. GH_TOKEN remains the developer-agent credential for the rest
# of the grooming run.
expand_admin_assignees() {
    local supported_org entries_file members_file entry team_org team_slug member
    local -a expanded=()
    local -A seen=()

    supported_org="${GITHUB_REPO%%/*}"
    entries_file="$(mktemp)"

    # The variable is optional for callers that do not configure assignees.
    # Normalize that case to the flat JSON shape the prompt expects.
    if [[ -z "${ADMIN_ASSIGNEES}" ]]; then
        rm -f "${entries_file}"
        ADMIN_ASSIGNEES='[]'
        export ADMIN_ASSIGNEES
        return 0
    fi

    if ! jq -e 'type == "array" and all(.[]; type == "string")' \
        <<<"${ADMIN_ASSIGNEES}" > /dev/null; then
        log "WARNING: ADMIN_ASSIGNEES must be a JSON array of strings; using an empty list"
        rm -f "${entries_file}"
        ADMIN_ASSIGNEES='[]'
        export ADMIN_ASSIGNEES
        return 0
    fi

    jq -r '.[]' <<<"${ADMIN_ASSIGNEES}" > "${entries_file}"
    while IFS= read -r entry || [ -n "${entry}" ]; do
        if [[ "${entry}" != */* ]]; then
            # Individual logins are intentionally passed through unchanged.
            if [[ -n "${entry}" ]]; then
                local login_key="${entry,,}"
                if [[ -z "${seen[${login_key}]:-}" ]]; then
                    seen["${login_key}"]=1
                    expanded+=("${entry}")
                fi
            fi
            continue
        fi

        team_org="${entry%%/*}"
        team_slug="${entry#*/}"
        if [[ -z "${team_org}" || -z "${team_slug}" || "${team_slug}" == */* ]]; then
            log "WARNING: empty or invalid team reference '${entry}' — skipping"
            continue
        fi
        if [[ "${team_org}" != "${supported_org}" ]]; then
            log "WARNING: cross-org team reference '${entry}' rejected: supported org is '${supported_org}', got '${team_org}' — skipping"
            continue
        fi
        if [[ -z "${ALLOWLIST_RESOLVER_TOKEN:-}" ]]; then
            log "WARNING: resolver credential unavailable — skipping team entry '${entry}'"
            continue
        fi

        members_file="$(mktemp)"
        if ! GH_TOKEN="${ALLOWLIST_RESOLVER_TOKEN}" gh api \
            "orgs/${team_org}/teams/${team_slug}/members" --paginate --jq '.[].login' \
            > "${members_file}"; then
            log "WARNING: failed to resolve team entry '${entry}' — skipping"
            rm -f "${members_file}"
            members_file=''
            continue
        fi
        while IFS= read -r member || [ -n "${member}" ]; do
            [[ -z "${member}" ]] && continue
            local member_key="${member,,}"
            if [[ -z "${seen[${member_key}]:-}" ]]; then
                seen["${member_key}"]=1
                expanded+=("${member}")
            fi
        done < "${members_file}"
        rm -f "${members_file}"
        members_file=''
    done < "${entries_file}"

    rm -f "${entries_file}"
    ADMIN_ASSIGNEES="$(jq -cn '$ARGS.positional' --args "${expanded[@]}")"
    export ADMIN_ASSIGNEES
    log "Expanded ADMIN_ASSIGNEES: ${ADMIN_ASSIGNEES}"
}
