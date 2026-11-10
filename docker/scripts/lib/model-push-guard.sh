#!/bin/bash
set -euo pipefail

run_agent_without_push() (
    local checkout hooks_dir effective_path temporary_dir overlay snapshot_status hook name original_umask
    local config_touched=0
    local -a original_paths=()

    checkout="$(git rev-parse --show-toplevel)" || {
        echo 'ERROR: Cannot locate checkout for model push guard' >&2
        return 1
    }
    checkout="$(cd "$checkout" && pwd -P)" || return 1

    original_umask="$(umask)"
    umask 077
    temporary_dir="$(mktemp -d /tmp/model-push-guard.XXXXXXXXXX)" || {
        echo 'ERROR: Cannot create model push guard overlay' >&2
        return 1
    }
    overlay="$temporary_dir/hooks"

    model_push_guard_cleanup() {
        local status="$1" restore_status=0 unset_status path
        trap - EXIT
        if (( config_touched )); then
            git -C "$checkout" config --local --unset-all core.hooksPath || {
                unset_status=$?
                if (( unset_status != 5 )); then
                    restore_status=1
                fi
            }
            if (( restore_status == 0 )); then
                for path in "${original_paths[@]}"; do
                    if ! git -C "$checkout" config --local --add core.hooksPath "$path"; then
                        restore_status=1
                        break
                    fi
                done
            fi
            if (( restore_status )); then
                echo "ERROR: Cannot restore local core.hooksPath in '$checkout'; overlay retained at '$temporary_dir'" >&2
                exit 1
            fi
        fi
        if ! rm -rf -- "$temporary_dir"; then
            echo "ERROR: Cannot remove model push guard overlay '$temporary_dir'" >&2
            exit 1
        fi
        exit "$status"
    }
    trap 'model_push_guard_cleanup "$?"' EXIT

    if git -C "$checkout" config --local --null --get-all core.hooksPath > "$temporary_dir/original-config"; then
        mapfile -d '' -t original_paths < "$temporary_dir/original-config"
    else
        snapshot_status=$?
        if (( snapshot_status != 1 )); then
            echo 'ERROR: Cannot snapshot local core.hooksPath' >&2
            return 1
        fi
    fi
    if effective_path="$(git -C "$checkout" config --get core.hooksPath)"; then
        if [[ -n "$effective_path" ]]; then
            hooks_dir="$(git -C "$checkout" rev-parse --path-format=absolute --git-path hooks)" || {
                echo 'ERROR: Cannot resolve effective hooks directory' >&2
                return 1
            }
        else
            hooks_dir=''
        fi
    else
        snapshot_status=$?
        if (( snapshot_status != 1 )); then
            echo 'ERROR: Cannot read effective core.hooksPath' >&2
            return 1
        fi
        hooks_dir="$(git -C "$checkout" rev-parse --path-format=absolute --git-path hooks)" || {
            echo 'ERROR: Cannot resolve default hooks directory' >&2
            return 1
        }
    fi

    if ! mkdir -- "$overlay"; then
        echo 'ERROR: Cannot create model hooks directory' >&2
        return 1
    fi
    if [[ -n "$hooks_dir" && -d "$hooks_dir" ]]; then
        shopt -s nullglob dotglob
        for hook in "$hooks_dir"/*; do
            name="${hook##*/}"
            [[ "$name" == pre-push ]] && continue
            if ! ln -s -- "$hook" "$overlay/$name"; then
                echo "ERROR: Cannot forward hook '$hook'" >&2
                return 1
            fi
        done
        shopt -u nullglob dotglob
    fi
    if ! printf '%s\n' '#!/bin/bash' \
        'echo "Do not git push in this model session. Commit locally; the entrypoint will push after the session exits." >&2' \
        'exit 1' > "$overlay/pre-push" || ! chmod 700 "$overlay/pre-push"; then
        echo 'ERROR: Cannot create model pre-push hook' >&2
        return 1
    fi

    config_touched=1
    if ! git -C "$checkout" config --local --replace-all core.hooksPath "$overlay"; then
        echo 'ERROR: Cannot activate model push guard' >&2
        return 1
    fi
    if ! effective_path="$(git -C "$checkout" rev-parse --path-format=absolute --git-path hooks)" || [[ "$effective_path" != "$overlay" ]]; then
        echo 'ERROR: Model push guard is overridden by higher-precedence Git configuration' >&2
        return 1
    fi
    umask "$original_umask"
    run_agent "$@"
)
