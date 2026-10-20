# Android APK

The standalone **ProtonnCord.apk** contains Discord, the pinned Revenge native loader, Revenge Next and Secure Messaging. A fresh installation configures the runtime and plugin automatically. Root, a computer and a separate plugin ZIP are unnecessary for installation.

**The production APK is pending release signing and the standalone Android smoke gate.** When published, download `ProtonnCord.apk` from the reviewed `android-RUN_ID-ATTEMPT` entry on [Releases](https://github.com/ProtonDev-sys/ProtonnCord/releases). The plugin assets under `mobile-build-*` are a different deliverable; their ZIP is not an Android installer.

## Install on a phone

1. Use Android 9 or newer on an ARM64 phone. The same APK also includes x86-64 for the tested emulator route.
2. Download `ProtonnCord.apk`, open it and allow installation from that download source when Android asks.
3. Open the installed app. On a fresh installation, the bundled Next runtime and Secure Messaging plugin are already enabled. No identity, trusted contact or protected conversation is created automatically.
4. Open the plugin's settings to create an identity or pair your OneKey, then follow the [Secure Messaging guide](README.md#use-secure-messaging).

The APK keeps the application ID **`com.discord`**. It cannot coexist with an official Discord installation under that ID or update an app signed with another key. Back up the data you need before migrating; uninstalling removes local app data. Another Android user or work profile does not allow a different signing certificate for the same installed package. See [Android's update rules](https://developer.android.com/google/play/app-updates).

Later Protonn Cord APKs must use the same release signing identity and an equal or higher Discord version code. Install them over the existing app to retain data. Existing Revenge settings, plugin flags, removed plugins and stored data are preserved. If Android evicts the runtime cache, the APK restores its bundled runtime only while the loader still selects the exact pinned URL; it preserves a changed runtime selection.

Plugin updates use the existing `mobile-nightly` repository through **Update from nightly**. They do not replace the APK or its signing key. A Discord/native-loader update requires a new APK. Rooted users who want to retain official Discord can instead use the [Xposed installation route](README.md#rooted-installation).

## What is packaged

| Component | Pinned input |
| --- | --- |
| Discord | `com.discord`, `348.10 - Stable`, version code `348010` |
| Resources | Both `arm64-v8a` and `x86_64`; English and `xxhdpi` resources |
| Native loader | [RevengeXposed 1.6.2 / `1602`](https://github.com/revenge-mod/revenge-xposed/releases/tag/1602), native API 1 |
| Patcher | [JingMatrix LSPatch 1.2 / `487`](https://github.com/JingMatrix/LSPatch/releases/tag/v1.2) |
| Split merger | [APKEditor 1.4.9](https://github.com/REAndroid/APKEditor/releases/tag/V1.4.9) |
| JavaScript host | Revenge Next revision in [toolchain.json](toolchain.json) |
| Android minimum | Android 9 / API 28 |

[android-distribution.json](android-distribution.json) records exact input URLs, sizes, SHA-256 digests and upstream revisions. Downloads are bounded by size and a five-minute total deadline, cached and authenticated again before use. A changed or unavailable input stops the build.

The original Discord APKs come from Aptoide's public package pool, with exact files selected from its [348010 package metadata](https://ws2.aptoide.com/api/7/app/get/app_id=76990142/aab=1). Every APK signature must match an application signing-certificate fingerprint published by **Discord itself** at [discord.com/.well-known/assetlinks.json](https://discord.com/.well-known/assetlinks.json). All splits must have the same signer, package and version as the base. Their hashes also freeze the selected release. A Google source-stamp certificate does not substitute for the app signer.

The build merges those authenticated inputs before applying LSPatch. It retains the pinned loader's original DEX and adds a small first-install bootstrap through Xposed's public API. LSPatch uses signature-bypass level zero, with no extra storage permission or private-data document provider. The final checks verify the nested merged APK, derived loader, package/version, absence of split requirements, signature, ZIP alignment and all packaged 64-bit native libraries' ELF alignment.

Two alignment constants in the exact pinned LSPatch source are backported from 4 KiB to 16 KiB before signing. This preserves its nested ZIP aliases instead of duplicating hundreds of megabytes of resources through a later realignment. Input/source hashes and the derived source hash are recorded in the CI build receipt. Alignment checks alone do not establish compatibility with a physical 16 KiB-page device.

## Build an APK locally

This section is for developers; installing a published APK does not require these tools. Use Linux or macOS with Python 3.10+, JDK 21+ selected by `JAVA_HOME`, and official [Android SDK Build Tools 36.0.0](https://developer.android.com/tools/releases/build-tools):

```sh
sdkmanager 'build-tools;36.0.0' 'platform-tools'
```

Supply the compiled plugin and pinned Hermes runtime from the **same reviewed Mobile build**. The eight-file Mobile artifact's `desktop-commit.txt`, manifest, toolchain and checksums establish their source identity. Build those inputs using the [mobile workflow](../.github/workflows/mobile.yml) or the commands in the [development guide](README.md#build-and-test-without-a-discord-account).

Create a private PKCS12 keystore once, keep it outside the repository and retain it for later updates. Skip generation if you already have that key:

```bash
export PROTONNCORD_KEYSTORE=/your/private/path/android.p12
export PROTONNCORD_KEY_ALIAS=protonncord
"$JAVA_HOME/bin/keytool" -genkeypair \
  -keystore "$PROTONNCORD_KEYSTORE" -storetype PKCS12 \
  -alias "$PROTONNCORD_KEY_ALIAS" -keyalg RSA -keysize 3072 -validity 10000

read -r -s -p 'Keystore password: ' PROTONNCORD_STORE_PASS
printf '\n'
export PROTONNCORD_STORE_PASS
export PROTONNCORD_KEY_PASS="$PROTONNCORD_STORE_PASS"
```

The example PKCS12 uses the store password for its key. An existing keystore with a distinct key password needs `PROTONNCORD_KEY_PASS` set separately. Passwords stay out of process arguments and are redacted from tool failure messages. Follow [Android's signing guidance](https://developer.android.com/studio/publish/app-signing) when backing up your key.

From the repository root:

```bash
python3 -B mobile/tools/patch_android.py --universal \
  --plugin mobile/build/dist/uk.co.protonn.secure-messaging.zip \
  --runtime mobile/build/dist/revenge.bundle \
  --build-tools "$ANDROID_HOME/build-tools/36.0.0" \
  --output mobile/build/standalone
unset PROTONNCORD_STORE_PASS PROTONNCORD_KEY_PASS
```

The new output directory contains `ProtonnCord.apk`, a build receipt and the pinned loader configuration. Share the APK; keep the receipt for verification. Existing output is never replaced. The builder never generates a release key or installs/uninstalls an app. Upstream signing metadata means repeated builds are not promised to be byte-identical.

Use `--universal --verify-only` to authenticate the five original APKs without signing. `--input-dir DIR` accepts separately obtained copies with the exact filenames and bytes in the distribution manifest. The advanced `--abi arm64-v8a` or `--abi x86_64` route still produces a split APK set and leaves stock Revenge Classic configuration to the user; it is not the standalone installation path.

## Account-free Android validation

The [Android smoke workflow](../.github/workflows/android-smoke.yml) builds this commit's plugin, the pinned runtime and one standalone APK with a disposable test identity. Its existing fresh Android 15 `google_apis` x86-64 emulator runs the 13 native storage tests and the following client check; there is no second emulator suite. Test APKs and signing material are excluded from diagnostic uploads.

```sh
python3 -B mobile/tools/test_android_client.py \
  --serial emulator-5554 --apk-dir mobile/build/standalone \
  --runtime mobile/build/dist/revenge.bundle \
  --plugin mobile/build/dist/uk.co.protonn.secure-messaging.zip \
  --output mobile/build/reports/android-client
```

The harness rejects physical devices and existing Discord installations. It verifies the APK receipt against the current checkout and supplied plugin/runtime, installs the single APK, verifies an unprivileged ADB shell, and requires the APK bootstrap/native-plugin markers and visible logged-out screen from one unchanged app process. **No app-data fixture is written before that launch.** Only afterward does it inspect the eight APK-owned files and check that no vault exists.

For one subsequent restart, the test adds an observer of the original plugin's asynchronous startup, a native bridge probe, an explicit disabled/removed flag and a storage sentinel. It removes the runtime cache without replacing the loader configuration. The restart must restore the pinned cache, preserve those existing files and flags, complete the original plugin's startup and native checks, and show the logged-out screen again. The direct Python command does not repeat native instrumentation, JavaScript compilation or unit tests.

`result.json` records both phases and their file hashes. `first-launch/` preserves the original screen, hierarchy and log before test modifications; top-level diagnostics record the restart. Cleanup removes only the installation the harness created. A pass establishes the recorded emulator configuration, signed-out startup and native bridge integration. Physical phones, logged-in encrypted delivery and OneKey USB hardware require their own evidence.

## Release signing configuration

Production builds require one retained private signing identity. Configure GitHub Actions secrets `ANDROID_SIGNING_KEYSTORE_B64` (the base64 PKCS12 file) and `ANDROID_SIGNING_PASSWORD`, using alias `protonncord`. Set repository variable `ANDROID_SIGNER_SHA256` to its lowercase, 64-hex certificate SHA-256 fingerprint. The release workflow verifies that certificate before signing and checks it again against the finished APK.

A missing or mismatched identity stops production publication. The disposable emulator key is never a production fallback. The final APK receives the same install/launch/restart check before publication, using the already validated Mobile payload; it does not rebuild Bun, Gradle or the native storage test suite. Supporting receipts remain CI artifacts, while each immutable `android-RUN_ID-ATTEMPT` release contains only `ProtonnCord.apk`.
