#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Run from a dedicated repository checkout: bash scripts/ci/mobile.sh build|publish.
# The controller owns the exact-SHA full-test gate and serializes publication.
set -euo pipefail
set +x

die() { echo "Mobile CI: $*" >&2; exit 1; }
mode=${1:-}
[[ $# == 1 && "$mode" =~ ^(build|publish)$ ]] || die 'Expected build or publish.'
[[ -f mobile/toolchain.json && -f scripts/ci/mobile.sh ]] || die 'Run from the repository root.'
[[ ${PROTONN_CORD_BUILD_CHANNEL:-} =~ ^[A-Za-z0-9._/-]+$ ]] || die 'Set PROTONN_CORD_BUILD_CHANNEL.'
export GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-ProtonDev-sys/ProtonnCord}
[[ "$GITHUB_REPOSITORY" == ProtonDev-sys/ProtonnCord ]] || die 'Unexpected release repository.'
[[ ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ && "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || die 'GITHUB_SHA must identify this exact checkout.'
[[ ${GITHUB_RUN_ID:-} =~ ^[1-9][0-9]{0,18}$ && ${GITHUB_RUN_ATTEMPT:-} == 1 ]] || die 'Set a stable positive numeric GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT=1.'
# These names supply existing artifact formats; they do not identify Actions runs.
export GITHUB_RUN_NUMBER=${GITHUB_RUN_NUMBER:-$GITHUB_RUN_ID}
export GITHUB_REF_NAME=$PROTONN_CORD_BUILD_CHANNEL
[[ "$GITHUB_RUN_NUMBER" =~ ^[1-9][0-9]{0,18}$ ]] || die 'Invalid GITHUB_RUN_NUMBER.'

if [[ "$mode" == publish ]]; then
    [[ "$GITHUB_REF_NAME" == nightly ]] || die 'Only nightly publishes mobile releases.'
    export GITHUB_TOKEN=${GH_TOKEN:-${GITHUB_TOKEN:-}}
    [[ -n "$GITHUB_TOKEN" ]] || die 'The controller must provide GH_TOKEN or GITHUB_TOKEN for publication.'
    export GH_TOKEN=$GITHUB_TOKEN
    # Validate both deliverables before the first GitHub write. No Actions API gate.
    python3 -B mobile/tools/validate_release.py mobile/build/dist
    node --input-type=module -e 'import { validateAndroidInstaller } from "./scripts/publishAndroidInstaller.mjs"; await validateAndroidInstaller();'
    bash scripts/ci/publish-mobile.sh
    node scripts/publishAndroidInstaller.mjs
    exit
fi

[[ -z ${GH_TOKEN:-} && -z ${GITHUB_TOKEN:-} ]] || die 'Build must run without GH_TOKEN and GITHUB_TOKEN.'
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die 'Build requires clean tracked source before versioning.'
[[ ! -e mobile/build/dist && ! -e mobile/build/standalone ]] || die 'Existing Mobile artifacts: use a fresh job checkout; publish retries do not rebuild.'
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}
export ANDROID_SDK_ROOT=$ANDROID_HOME
export JAVA_HOME=${JAVA_HOME:-${JAVA_HOME_21_X64:-/usr/lib/jvm/java-21-openjdk-amd64}}
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.local/share/pnpm/bin:$HOME/.bun/bin:$HOME/.deno/bin:$PATH"
for tool in node pnpm bun deno python3 git java avdmanager adb emulator; do
    command -v "$tool" >/dev/null || die "Missing $tool on PATH. Install the documented toolchain on the CI host."
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || die 'Node 24 is required.'
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Python 3.10 or newer is required.")'
[[ "pnpm@$(pnpm --version)" == "$(node -p 'require("./package.json").packageManager')" ]] || die 'pnpm must match package.json.'
[[ "$(bun --version)" == "$(node -p 'require("./mobile/toolchain.json").bunVersion')" ]] || die 'Bun must match mobile/toolchain.json.'
[[ "$(deno --version | awk 'NR == 1 {print $2}')" == "$(node -p 'require("./mobile/toolchain.json").denoVersion')" ]] || die 'Deno must match mobile/toolchain.json.'
[[ -x "$JAVA_HOME/bin/javac" && -f "$JAVA_HOME/release" ]] || die "Missing JDK 21 at JAVA_HOME=$JAVA_HOME."
grep -q '^JAVA_VERSION="21\.' "$JAVA_HOME/release" || die 'Select JDK 21 with JAVA_HOME.'
java25_home=${JAVA_HOME_25_X64:-}
if [[ -z "$java25_home" ]]; then
    for candidate in /usr/lib/jvm/*; do
        if [[ -f "$candidate/release" ]] && grep -q '^JAVA_VERSION="25\([."]\)' "$candidate/release"; then java25_home=$candidate; break; fi
    done
fi
[[ -x "$java25_home/bin/javac" && -f "$java25_home/release" ]] && grep -q '^JAVA_VERSION="25\([."]\)' "$java25_home/release" || die 'Install JDK 25 for the pinned Revenge API; set JAVA_HOME_25_X64 if needed.'
for sdk_file in platforms/android-36/android.jar platforms/android-37.0/android.jar build-tools/36.0.0/apksigner build-tools/36.0.0/zipalign build-tools/36.0.0/aapt2 system-images/android-35/google_apis/x86_64/package.xml; do
    [[ -f "$ANDROID_HOME/$sdk_file" ]] || die "Missing Android SDK component: $ANDROID_HOME/$sdk_file."
done
[[ -r /dev/kvm && -w /dev/kvm ]] || die 'The Android smoke gate requires readable/writable /dev/kvm.'
emulator_version=$(emulator -version 2>&1)
[[ "$emulator_version" == *'Android emulator version 37.2.12.0 (build_id 16428233)'* ]] || die 'Use Android Emulator 37.2.12 (build 16428233), matching the reviewed smoke gate.'

mkdir -p mobile/build/reports mobile/.toolchain
printf '%s\n' "$emulator_version" > mobile/build/reports/emulator-version.txt
scratch=$(mktemp -d "$PWD/mobile/build/ci.XXXXXX")
emulator_pid=
adb_started=false
cleanup() {
    local status=$?
    trap - EXIT
    unset PROTONNCORD_STORE_PASS PROTONNCORD_KEY_PASS
    if [[ -n "$emulator_pid" ]]; then kill "$emulator_pid" 2>/dev/null || true; wait "$emulator_pid" 2>/dev/null || true; fi
    if [[ "$adb_started" == true ]]; then adb kill-server >/dev/null 2>&1 || true; fi
    cp "$scratch/manifest.json" mobile/plugins/secure-messaging/manifest.json
    cp "$scratch/repo.config.json" mobile/repo.config.json
    rm -rf -- "$scratch"
    exit "$status"
}
cp mobile/plugins/secure-messaging/manifest.json "$scratch/manifest.json"
cp mobile/repo.config.json "$scratch/repo.config.json"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep passwords out of dependency/test subprocess environments.
store_pass=${PROTONNCORD_STORE_PASS:-}
key_pass=${PROTONNCORD_KEY_PASS:-}
unset PROTONNCORD_STORE_PASS PROTONNCORD_KEY_PASS
export PROTONNCORD_KEY_ALIAS=${PROTONNCORD_KEY_ALIAS:-protonncord}
if [[ "$GITHUB_REF_NAME" == nightly && ${PROTONN_CI_RELEASE:-0} == 1 ]]; then
    signing_dir=${PROTONN_CORD_ANDROID_SIGNING_DIR:-$HOME/protonncord-apk/signing}
    export PROTONNCORD_KEYSTORE=${PROTONNCORD_KEYSTORE:-$signing_dir/protonncord-release.p12}
    password_file=${PROTONNCORD_STORE_PASS_FILE:-$signing_dir/password}
    [[ -n "$store_pass" || -r "$password_file" ]] || die "Missing signing password: set PROTONNCORD_STORE_PASS_FILE (default $password_file)."
    [[ -n "$store_pass" ]] || store_pass=$(< "$password_file")
    [[ ${ANDROID_SIGNER_SHA256:-} =~ ^[a-f0-9]{64}$ ]] || die 'Configure the retained production ANDROID_SIGNER_SHA256 independently of the keystore.'
    [[ -f "$PROTONNCORD_KEYSTORE" ]] || die "Missing retained production PKCS12: $PROTONNCORD_KEYSTORE."
else
    # Non-release checks use an isolated disposable identity, never the production key.
    export PROTONNCORD_KEYSTORE=$scratch/test.p12
    key_pass=
    store_pass=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
    PROTONNCORD_STORE_PASS=$store_pass "$JAVA_HOME/bin/keytool" -genkeypair -noprompt -storetype PKCS12 \
        -keystore "$PROTONNCORD_KEYSTORE" -alias "$PROTONNCORD_KEY_ALIAS" -keyalg RSA -keysize 3072 \
        -validity 2 -dname CN=ProtonnCord-CI -storepass:env PROTONNCORD_STORE_PASS >/dev/null 2>&1
fi
certificate=$(PROTONNCORD_STORE_PASS=$store_pass python3 - <<'PY'
import hashlib, os, subprocess
result = subprocess.run([os.environ['JAVA_HOME'] + '/bin/keytool', '-exportcert', '-storetype', 'PKCS12',
    '-keystore', os.environ['PROTONNCORD_KEYSTORE'], '-alias', os.environ['PROTONNCORD_KEY_ALIAS'],
    '-storepass:env', 'PROTONNCORD_STORE_PASS'], capture_output=True, timeout=30)
if result.returncode:
    raise SystemExit('The PKCS12 key/alias/password could not be verified.')
print(hashlib.sha256(result.stdout).hexdigest())
PY
)
if [[ "$GITHUB_REF_NAME" == nightly && ${PROTONN_CI_RELEASE:-0} == 1 ]]; then
    [[ "$certificate" == "$ANDROID_SIGNER_SHA256" ]] || die 'The retained signing certificate does not match ANDROID_SIGNER_SHA256.'
else
    export ANDROID_SIGNER_SHA256=$certificate
fi

pnpm install --frozen-lockfile
python3 -B -m unittest discover -s mobile/tools -p 'test_*.py' -v
gradle_args=(--no-daemon --console=plain "-Porg.gradle.java.installations.paths=$JAVA_HOME,$java25_home")
clone_pin() {
    local repository=$1 directory=$2 revision=$3
    [[ ! -e "$directory" ]] || die "Pinned source directory already exists: $directory; use a fresh job checkout."
    git clone --filter=blob:none "$repository" "$directory"
    git -C "$directory" checkout --detach "$revision"
    [[ "$(git -C "$directory" rev-parse HEAD)" == "$revision" ]] || die 'Pinned source checkout mismatch.'
}
native_revision=$(node -p 'require("./mobile/toolchain.json").revengeNativeRevision')
runtime_revision=$(node -p 'require("./mobile/toolchain.json").revengeRuntimeRevision')
clone_pin https://github.com/revenge-mod/revenge-xposed.git mobile/.toolchain/revenge-xposed "$native_revision"
(cd mobile/.toolchain/revenge-xposed && bash gradlew :api:publishToMavenLocal "${gradle_args[@]}")
(
    cd mobile
    bun install --frozen-lockfile
    bun run test
    bun run lint:types
    bun run lint
    node tools/prepare-release.mjs "0.2.$GITHUB_RUN_NUMBER.$GITHUB_RUN_ATTEMPT-nightly"
    bash gradlew :plugins:secure-messaging:testDebugUnitTest packageSecureMessaging "${gradle_args[@]}"
    bun run test:bundle
    bun run generate-index --dist build/dist --base-url "https://github.com/$GITHUB_REPOSITORY/releases/download/mobile-build-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --out build/dist/index.json
)
clone_pin https://github.com/revenge-mod/revenge-bundle-next.git mobile/.toolchain/revenge-bundle-next "$runtime_revision"
(
    cd mobile/.toolchain/revenge-bundle-next
    export REVENGE_DISCORD_SERVER_URL=https://discord.com/invite/ddcQf3s2Uq
    export REVENGE_DEFAULT_PLUGIN_REPOSITORY_URL=https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-nightly
    export REVENGE_SOURCE_REPOSITORY_URL="https://github.com/revenge-mod/revenge-bundle-next/tree/$runtime_revision"
    export REVENGE_LICENSE_URL="https://raw.githubusercontent.com/revenge-mod/revenge-bundle-next/$runtime_revision/LICENSE"
    deno install --frozen
    node ../../tools/link-runtime-workspaces.mjs "$PWD"
    deno run --unstable-bare-node-builtins --permission-set=build scripts/build.ts 2>&1 | tee ../../build/reports/runtime-build.log
    ! grep -Eq 'UNRESOLVED_IMPORT|MISSING_GLOBAL_NAME' ../../build/reports/runtime-build.log || die 'Runtime dependencies were not bundled correctly.'
    cp dist/revenge.bundle ../../build/dist/revenge.bundle
    git archive --format=zip --output=../../build/dist/revenge-runtime-source.zip HEAD
    cp LICENSE ../../build/dist/REVENGE-LICENSE
)
cp mobile/toolchain.json mobile/build/dist/toolchain.json
printf '%s\n' "$GITHUB_SHA" > mobile/build/dist/desktop-commit.txt
(cd mobile/build/dist && sha256sum *.zip revenge.bundle > SHA256SUMS)
python3 -B mobile/tools/validate_release.py mobile/build/dist
export PROTONNCORD_STORE_PASS=$store_pass PROTONNCORD_KEY_PASS=${key_pass:-$store_pass}
python3 -B mobile/tools/patch_android.py --universal \
    --plugin mobile/build/dist/uk.co.protonn.secure-messaging.zip --runtime mobile/build/dist/revenge.bundle \
    --build-tools "$ANDROID_HOME/build-tools/36.0.0" --output mobile/build/standalone
unset PROTONNCORD_STORE_PASS PROTONNCORD_KEY_PASS store_pass key_pass
python3 - <<'PY'
import json, os
from pathlib import Path
path = Path('mobile/build/standalone/build-receipt.json')
receipt = json.loads(path.read_text())
if receipt['signerSha256'] != os.environ['ANDROID_SIGNER_SHA256']:
    raise SystemExit('The finished APK has an unexpected signer.')
receipt['release'] = {key: os.environ[name] for key, name in (
    ('repository', 'GITHUB_REPOSITORY'), ('runId', 'GITHUB_RUN_ID'),
    ('runNumber', 'GITHUB_RUN_NUMBER'), ('attempt', 'GITHUB_RUN_ATTEMPT'))}
path.write_text(json.dumps(receipt, indent=2) + '\n')
PY

# A private ADB server and AVD keep the gate away from user devices and saved state.
export ANDROID_AVD_HOME=$scratch/avd
mkdir -p "$ANDROID_AVD_HOME"
export ANDROID_ADB_SERVER_PORT
ANDROID_ADB_SERVER_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export ADB_SERVER_SOCKET=tcp:localhost:$ANDROID_ADB_SERVER_PORT
emulator_port=${PROTONN_CORD_EMULATOR_PORT:-5580}
[[ "$emulator_port" =~ ^[1-9][0-9]{3}$ ]] && (( emulator_port >= 5554 && emulator_port <= 5682 && emulator_port % 2 == 0 )) || die 'PROTONN_CORD_EMULATOR_PORT must be even, between 5554 and 5682.'
python3 - "$emulator_port" <<'PY'
import socket, sys
sockets = []
try:
    for port in (int(sys.argv[1]), int(sys.argv[1]) + 1):
        connection = socket.socket()
        connection.bind(('127.0.0.1', port))
        sockets.append(connection)
except OSError:
    raise SystemExit('The dedicated emulator ports are already in use; choose PROTONN_CORD_EMULATOR_PORT.')
finally:
    for connection in sockets:
        connection.close()
PY
export ANDROID_SERIAL=emulator-$emulator_port
avd_name=protonn-ci-$GITHUB_RUN_ID
echo no | avdmanager create avd --name "$avd_name" --package 'system-images;android-35;google_apis;x86_64' --device pixel_7_pro
adb start-server
adb_started=true
emulator -avd "$avd_name" -port "$emulator_port" -no-window -gpu software -accel on -wipe-data -no-snapshot \
    -noaudio -no-boot-anim -camera-back none -memory 4096 >mobile/build/reports/emulator.log 2>&1 &
emulator_pid=$!
booted=false
for ((attempt=0; attempt<150; attempt++)); do
    kill -0 "$emulator_pid" 2>/dev/null || die 'The fresh emulator exited; inspect mobile/build/reports/emulator.log.'
    if [[ "$(adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then booted=true; break; fi
    sleep 2
done
[[ "$booted" == true ]] || die 'The fresh emulator did not boot within five minutes.'
for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
    adb -s "$ANDROID_SERIAL" shell settings put global "$setting" 0
done
bash mobile/tools/run-android-smoke.sh
if [[ "$GITHUB_REF_NAME" == nightly ]]; then
    node --input-type=module -e 'import { validateAndroidInstaller } from "./scripts/publishAndroidInstaller.mjs"; await validateAndroidInstaller();'
fi
echo 'Mobile plugin, runtime, native storage and final-APK validation passed.'
