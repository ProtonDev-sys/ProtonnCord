#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
action="${1:-install}"
if (( $# )); then shift; fi
case "$action" in install|uninstall) ;; *) echo 'Usage: bash install.sh [install|uninstall] [--branch stable|ptb|canary | --location PATH]' >&2; exit 1 ;; esac
sha256sum --check --strict payload.sha256
data_dir="${PROTONN_CORD_INSTALL_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ProtonnCord}"
mkdir -p -- "$data_dir"
target="$data_dir/desktop.asar"
[[ ! -L "$data_dir" && ! -L "$target" ]] || { echo 'Refusing linked installation paths.' >&2; exit 1; }
backup=''
if [[ "$action" == install ]]; then
    if [[ -f "$target" ]]; then
        backup=$(mktemp -- "$data_dir/.desktop.backup.XXXXXXXX")
        cp -- "$target" "$backup"
    fi
    cp -- desktop.asar "$target"
fi
export EQUICORD_USER_DATA_DIR="$data_dir" EQUICORD_DIRECTORY="$target" EQUICORD_DEV_INSTALL=1
chmod +x -- EquilotlCli-linux
if (( $# == 0 )); then set -- --branch stable; fi
echo 'Fully quit Discord before continuing.'
if ./EquilotlCli-linux "--$action" "$@"; then
    if [[ -n "$backup" ]]; then rm -- "$backup"; fi
    echo 'Complete. You can now start Discord.'
else
    result=$?
    if [[ -n "$backup" ]]; then mv -f -- "$backup" "$target"; fi
    exit "$result"
fi
