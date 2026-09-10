#!/bin/bash
# Original script forked from Vencord; Equicord/Protonn Cord adaptation by PhoenixAceVFX.
# Standalone Linux installer. Keep these pins in sync with scripts/runInstaller.mjs.
set -euo pipefail

INSTALLER_RELEASE='v2.2.6'
INSTALLER_ASSET_ID='444851621'
INSTALLER_SIZE='8499465'
INSTALLER_SHA256='5179bff47736c9d0e2df8367798d7c743d221c403f6c9262f8571f34d3383ed1'
INSTALLER_NAME='EquilotlCli-linux'
DEBUG=false

fail() {
    printf 'Error: %s\n' "$1" >&2
    exit 1
}

if [[ "$EUID" -eq 0 ]]; then
    fail 'Run this script as your normal user, not root.'
fi
if [[ "${1:-}" == '-debug' ]]; then
    DEBUG=true
    shift
fi

for required in curl sha256sum wc mktemp cp mv chmod mkdir rm rmdir; do
    command -v "$required" >/dev/null 2>&1 || fail "Required command is missing: $required"
done

privilege_cmd=''
for candidate in sudo doas; do
    if command -v "$candidate" >/dev/null 2>&1; then
        privilege_cmd=$candidate
        break
    fi
done
[[ -n "$privilege_cmd" ]] || fail 'Neither sudo nor doas was found.'

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/protonncord/installer/$INSTALLER_RELEASE"
mkdir -p -- "$cache_dir"
installer_tmp_dir=$(mktemp -d -- "$cache_dir/.install.XXXXXXXX")
installer_file="$installer_tmp_dir/$INSTALLER_NAME"
cache_stage="$installer_tmp_dir/cache.tmp"
cache_file="$cache_dir/$INSTALLER_NAME"

cleanup() {
    # Only remove files created by this invocation; never recursively delete a cache.
    rm -f -- "$installer_file" "$cache_stage" || true
    rmdir -- "$installer_tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_installer() {
    local candidate_path=$1 actual_size actual_digest
    [[ -f "$candidate_path" && ! -L "$candidate_path" ]] || return 1
    actual_size=$(wc -c < "$candidate_path") || return 1
    [[ "$actual_size" -eq "$INSTALLER_SIZE" ]] || return 1
    actual_digest=$(sha256sum -- "$candidate_path") || return 1
    [[ "${actual_digest%% *}" == "$INSTALLER_SHA256" ]]
}

if verify_installer "$cache_file"; then
    printf 'Using cached Equilotl %s.\n' "$INSTALLER_RELEASE"
    cp -- "$cache_file" "$installer_file"
elif verify_installer "$HOME/.equilotl"; then
    # Reuse the old shell installer's cache only if it matches the reviewed artifact.
    cp -- "$HOME/.equilotl" "$installer_file"
else
    printf 'Downloading reviewed Equilotl %s.\n' "$INSTALLER_RELEASE"
    curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 60 --max-filesize "$INSTALLER_SIZE" \
        --header 'Accept: application/octet-stream' \
        --user-agent "ProtonnCord-Installer/$INSTALLER_RELEASE" \
        --output "$installer_file" \
        "https://api.github.com/repos/Equicord/Equilotl/releases/assets/$INSTALLER_ASSET_ID"
fi

verify_installer "$installer_file" || fail 'The installer failed its exact size or SHA-256 check. Nothing was executed.'
chmod 700 -- "$installer_file"

# Atomic cache replacement follows verification; a failed refresh preserves the old cache.
if ! cp -- "$installer_file" "$cache_stage" || ! mv -fT -- "$cache_stage" "$cache_file"; then
    printf 'Warning: Could not refresh the installer cache.\n' >&2
fi

if "$DEBUG"; then
    printf 'Verified asset %s (%s bytes, SHA-256 %s).\n' "$INSTALLER_ASSET_ID" "$INSTALLER_SIZE" "$INSTALLER_SHA256"
fi
printf 'Running the verified installer through %s.\n' "$privilege_cmd"
"$privilege_cmd" "$installer_file" "$@"
