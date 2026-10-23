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

uninstall=false
show_help=false
show_version=false
skip_argument=false
for argument in "$@"; do
    if "$skip_argument"; then skip_argument=false; continue; fi
    case "$argument" in
        --location|-location|--branch|-branch) skip_argument=true ;;
        --h|-h|--h=*|-h=*) show_help=true; break ;;
        --help|-help|--help=*|-help=*|--version|-version|--version=*|-version=*|--uninstall|-uninstall|--uninstall=*|-uninstall=*)
            enabled=false
            if [[ "$argument" != *=* ]]; then
                enabled=true
            else
                case "${argument#*=}" in 1|t|T|TRUE|true|True) enabled=true ;; esac
            fi
            case "${argument%%=*}" in
                --help|-help) show_help=$enabled ;;
                --version|-version) show_version=$enabled ;;
                --uninstall|-uninstall) uninstall=$enabled ;;
            esac
            ;;
        --) break ;;
        -*) ;;
        *) break ;;
    esac
done

for required in curl sha256sum wc mktemp cp mv chmod mkdir rm rmdir; do
    command -v "$required" >/dev/null 2>&1 || fail "Required command is missing: $required"
done
if ! "$uninstall" && ! "$show_help" && ! "$show_version"; then
    command -v jq >/dev/null 2>&1 || fail 'Required command is missing: jq'
fi

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/protonncord/installer/$INSTALLER_RELEASE"
mkdir -p -- "$cache_dir"
installer_tmp_dir=$(mktemp -d -- "$cache_dir/.install.XXXXXXXX")
installer_file="$installer_tmp_dir/$INSTALLER_NAME"
cache_stage="$installer_tmp_dir/cache.tmp"
cache_file="$cache_dir/$INSTALLER_NAME"
release_metadata="$installer_tmp_dir/release.json"
payload_identity="$installer_tmp_dir/payload.tsv"
payload_tmp_dir=''
rollback_archive=false

cleanup() {
    local exit_status=$?
    trap - EXIT
    trap '' HUP INT TERM
    if "$rollback_archive"; then
        if mv -fT -- "$payload_tmp_dir/previous.asar" "$archive_file"; then
            rollback_archive=false
        else
            printf 'Warning: Could not restore the previous archive. Recovery copy retained at %s\n' "$payload_tmp_dir/previous.asar" >&2
        fi
    fi
    # Only remove files created by this invocation; never recursively delete a cache.
    rm -f -- "$installer_file" "$cache_stage" "$release_metadata" "$payload_identity" || true
    if [[ -n "$payload_tmp_dir" ]]; then
        rm -f -- "$payload_tmp_dir/desktop.asar" || true
        if ! "$rollback_archive"; then
            rm -f -- "$payload_tmp_dir/previous.asar" || true
        fi
        rmdir -- "$payload_tmp_dir" 2>/dev/null || true
    fi
    rmdir -- "$installer_tmp_dir" 2>/dev/null || true
    return "$exit_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
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

# Informational flags need neither elevation nor access to the installed data.
if "$show_help" || "$show_version"; then
    EQUICORD_DEV_INSTALL=1 EQUICORD_DIRECTORY="$installer_tmp_dir/desktop.asar" \
        EQUICORD_USER_DATA_DIR="$installer_tmp_dir" "$installer_file" "$@"
    exit 0
fi

privilege_cmd=''
for candidate in sudo doas; do
    if command -v "$candidate" >/dev/null 2>&1; then
        privilege_cmd=$candidate
        break
    fi
done
[[ -n "$privilege_cmd" ]] || fail 'Neither sudo nor doas was found.'

# Match the client's data location. Replace only its archive; settings, plugins,
# themes and all other user files are left in place.
data_dir="${PROTONN_CORD_USER_DATA_DIR:-${EQUICORD_USER_DATA_DIR:-}}"
if [[ -z "$data_dir" ]]; then
    if [[ -n "${DISCORD_USER_DATA_DIR:-}" ]]; then
        data_dir="$DISCORD_USER_DATA_DIR/../ProtonnCordData"
    else
        data_dir="${XDG_CONFIG_HOME:-$HOME/.config}/ProtonnCord"
    fi
fi
[[ "$data_dir" == /* ]] || fail 'The Protonn Cord data directory must be an absolute path.'
mkdir -p -- "$data_dir"
data_dir=$(cd -- "$data_dir" && pwd -P)
archive_file="$data_dir/desktop.asar"

if ! "$uninstall"; then
    # Keep the saved channel without changing settings; new installs use stable.
    payload_tag=latest
    settings_file="$data_dir/settings/settings.json"
    if [[ -e "$settings_file" || -L "$settings_file" ]]; then
        update_branch=$(jq -er 'select(type == "object")
            | if has("updateBranch") then .updateBranch else "main" end
            | select(. == "main" or . == "nightly" or . == "staging")' "$settings_file") \
            || fail 'Could not read a supported update branch from existing settings. Nothing was installed.'
        [[ "$update_branch" == main ]] || payload_tag=$update_branch
    fi

    # Equilotl's own downloader targets Equicord. Pin the Protonn asset ID and
    # verify its advertised size and SHA-256 before replacing any archive.
    curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 60 --max-filesize 2097152 \
        --header 'Accept: application/vnd.github+json' \
        --user-agent "ProtonnCord-Installer/$INSTALLER_RELEASE" \
        --output "$release_metadata" \
        "https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/tags/$payload_tag"
    jq -er --arg tag "$payload_tag" '
        select(.tag_name == $tag and .draft == false
            and (.prerelease == false or ($tag != "latest" and .prerelease == true)))
        | [.assets[] | select(.name == "desktop.asar")]
        | select(length == 1) | .[0]
        | select(.state == "uploaded"
            and .browser_download_url == ("https://github.com/ProtonDev-sys/ProtonnCord/releases/download/" + $tag + "/desktop.asar"))
        | select((.id | type) == "number" and .id > 0 and .id <= 9007199254740991 and .id == (.id | floor))
        | select((.size | type) == "number" and .size > 0 and .size <= 67108864 and .size == (.size | floor))
        | select((.digest | type) == "string")
        | select(.digest | test("^sha256:[a-f0-9]{64}$"))
        | [.id, .size, (.digest | ltrimstr("sha256:"))] | @tsv
    ' "$release_metadata" > "$payload_identity" || fail 'Invalid Protonn Cord release metadata. Nothing was installed.'
    read -r payload_asset_id payload_size payload_sha256 < "$payload_identity"
    [[ "$payload_asset_id" =~ ^[1-9][0-9]*$ && "$payload_size" =~ ^[1-9][0-9]*$ && "$payload_sha256" =~ ^[a-f0-9]{64}$ ]] \
        || fail 'Invalid Protonn Cord archive identity. Nothing was installed.'

    payload_tmp_dir=$(mktemp -d -- "$data_dir/.install.XXXXXXXX")
    payload_file="$payload_tmp_dir/desktop.asar"
    curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 60 --max-filesize "$payload_size" \
        --header 'Accept: application/octet-stream' \
        --user-agent "ProtonnCord-Installer/$INSTALLER_RELEASE" \
        --output "$payload_file" \
        "https://api.github.com/repos/ProtonDev-sys/ProtonnCord/releases/assets/$payload_asset_id"
    [[ -f "$payload_file" && ! -L "$payload_file" && "$(wc -c < "$payload_file")" -eq "$payload_size" ]] \
        || fail 'The Protonn Cord archive failed its exact size check. Nothing was installed.'
    payload_digest=$(sha256sum -- "$payload_file")
    [[ "${payload_digest%% *}" == "$payload_sha256" ]] \
        || fail 'The Protonn Cord archive failed its SHA-256 check. Nothing was installed.'
    chmod 600 -- "$payload_file"
    if [[ -e "$archive_file" || -L "$archive_file" ]]; then
        [[ -f "$archive_file" && ! -L "$archive_file" ]] || fail 'The existing archive is not a regular file. Nothing was installed.'
        # Keep a private copy on this filesystem until the privileged CLI succeeds.
        cp -p -- "$archive_file" "$payload_tmp_dir/previous.asar"
        rollback_archive=true
    fi
    mv -fT -- "$payload_file" "$archive_file"
fi

printf 'Running the verified installer through %s.\n' "$privilege_cmd"
# Set only these explicit values after sudo/doas sanitizes the environment.
# Never interpolate paths or user arguments into a privileged shell command.
"$privilege_cmd" -- /usr/bin/env EQUICORD_DEV_INSTALL=1 \
    "EQUICORD_DIRECTORY=$archive_file" "EQUICORD_USER_DATA_DIR=$data_dir" \
    "$installer_file" "$@"
rollback_archive=false
