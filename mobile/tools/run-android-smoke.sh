#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ "${ANDROID_SERIAL:-}" != "emulator-5554" ]]; then
    echo 'The smoke suite requires its fresh emulator on port 5554.' >&2
    exit 1
fi

reports=mobile/build/reports/android-smoke
mkdir -p "$reports"
adb -s "$ANDROID_SERIAL" shell getprop > "$reports/device-properties.txt"
git rev-parse HEAD > "$reports/source-commit.txt"
sha256sum mobile/build/dist/revenge.bundle mobile/build/dist/uk.co.protonn.secure-messaging.zip > "$reports/inputs.sha256"

native_result=0
bash mobile/gradlew -p mobile :plugins:secure-messaging:connectedDebugAndroidTest \
    -Pandroid.testInstrumentationRunnerArguments.class=uk.co.protonn.securemessaging.NativeStorageTest \
    --console=plain --stacktrace 2>&1 | tee "$reports/native-tests.txt" || native_result=$?
adb -s "$ANDROID_SERIAL" logcat -d -v threadtime > "$reports/native-logcat.txt" 2>&1 || true

# Run both checks so a storage failure does not hide useful client diagnostics.
client_result=0
python3 -B mobile/tools/test_android_client.py \
    --serial "$ANDROID_SERIAL" --apk-dir mobile/build/nonroot-x86_64 \
    --runtime mobile/build/dist/revenge.bundle \
    --plugin mobile/build/dist/uk.co.protonn.secure-messaging.zip \
    --output mobile/build/reports/android-client \
    2>&1 | tee "$reports/client-tests.txt" || client_result=$?
adb -s "$ANDROID_SERIAL" logcat -d -v threadtime > "$reports/client-logcat.txt" 2>&1 || true

if (( native_result != 0 || client_result != 0 )); then
    echo "Android smoke failed: native=$native_result client=$client_result" >&2
    exit 1
fi
