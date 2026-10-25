# Protonn Cord Mobile

The Android companion provides Secure Messaging inside Discord through a Revenge native plugin. It contains a JavaScript bundle and a Kotlin/DEX bridge for Android Keystore, attachment files and OneKey USB. The desktop plugin collection is not ported to React Native.

## Installation and compatibility

The standalone Android APK bundles both halves of Revenge and Secure Messaging. Production APK publication is pending release signing and the standalone Android smoke gate; see the [APK installation guide](ANDROID.md) for release status and normal phone installation. The build pins both halves of Revenge in [toolchain.json](toolchain.json).

| Route | Requirements | Instructions |
| --- | --- | --- |
| Standalone APK | Android 9+ on an ARM64 phone; no root or computer | [Download and install the APK](ANDROID.md) |
| Xposed module | A rooted phone with an Xposed framework and the official Discord Android app | Follow the rooted installation steps below |

Both routes use the following pins:

| Component | Pinned target |
| --- | --- |
| Native loader | [RevengeXposed 1.6.2, release `1602`](https://github.com/revenge-mod/revenge-xposed/releases/tag/1602), source `9a1426d0a3df000beb4174d0071d4d80e8be42fc` |
| JavaScript host | [Revenge Next](https://github.com/revenge-mod/revenge-bundle-next/tree/6f22fe1d5843160320a4a06644e816bb11f0c929), source `6f22fe1d5843160320a4a06644e816bb11f0c929` |
| Plugin | `uk.co.protonn.secure-messaging`, native Revenge API `>=1 <2` |
| Discord | Manifest accepts Discord version `>=341.0`; the nonroot build pins `348.10 - Stable` / `348010` |
| Android | Android 7+ for the plugin; Android 9+ for the standalone APK; Android 8+ and USB host support for OneKey |

Changing only the JavaScript bundle cannot add the native plugin API to an older bootstrap. Newer loader releases also need compatibility review before changing these pins. The standalone APK authenticates and merges the original Discord APKs, includes ARM64 and x86-64 native libraries, and configures Next plus Secure Messaging on a fresh installation. Existing mod settings, disabled or removed plugins and stored data are preserved. Plugin/runtime releases remain separate from installable APK releases.

### Rooted installation

1. Install the pinned module APK from the upstream release and enable it for Discord in your Xposed manager, following [upstream installation instructions](https://github.com/revenge-mod/revenge-xposed/blob/9a1426d0a3df000beb4174d0071d4d80e8be42fc/README.md).
2. Configure the loader to use the pinned Next runtime below. The pinned loader defaults to Revenge Classic, so this step is required. Its configuration is `files/pyoncord/loader.json` inside Discord's private app data directory, normally `/data/user/0/com.discord/files/pyoncord/loader.json`. With Discord stopped, preserve a copy of an existing configuration and update its `customLoadUrl` field using your root file manager. Preserve file ownership and other existing fields.

   ```json
   {
     "customLoadUrl": {
       "enabled": true,
       "url": "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-runtime-6f22fe1/revenge.bundle"
     }
   }
   ```

3. Restart Discord and open Revenge's plugin settings. The hosted runtime supplies **Protonn Cord Mobile** as its default repository. If it is absent, add this repository URL on the plugins **Advanced** screen:

   ```text
   https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-nightly
   ```

4. On **Browse**, install **Protonn Cord Secure Messaging**, enable it and reload when prompted. The repository index resolves to an immutable plugin ZIP with a SHA-256 digest checked by the native loader.
5. Open the plugin's settings to configure an identity or pair your OneKey. **Update from nightly** checks the pinned runtime download before installing the plugin update, then configures the loader through the native bridge. The check times out after 10 seconds. Configuration writes are atomic, preserve other saved fields, and keep the original bytes in `loader.json.protonn-backup` when no backup exists. An invalid configuration or backup must be repaired before updating; it is never replaced with an empty one.

The [independent CI pipeline](../scripts/ci/README.md) publishes the plugin ZIP, runtime, upstream runtime source/license, toolchain pins and checksums. Plugin builds are tagged `mobile-build-RUN_ID-ATTEMPT`; the `mobile-nightly` index follows the current build. Runtime releases are pinned separately. Preserve the plugin's stored data when updating: clearing app/plugin data loses locally held identities and history keys.

Publication validates the build's version, immutable URL, checksums and desktop revision before writing a release. Publish retries retain the original build identity and verify existing immutable assets. The local controller requires successful validation of the exact desktop revision before publishing.

## Use Secure Messaging

Open a DM or group DM. Both peers need a compatible Protonn Cord Secure Messaging implementation. These commands are handled locally, except `/pc announce`, which sends your signed public-key announcement to the conversation.

| Command | Effect |
| --- | --- |
| `/pc announce` | Share your public identity for the other participant to review |
| `/pc trust USER_ID FULL_FINGERPRINT` | Trust a received announcement after comparing the complete fingerprint through a separate trusted channel |
| `/pc on [USER_ID ...]` | Enable encryption for verified participants in this DM; omitted IDs use current DM members |
| `/pc off` | Return this conversation to ordinary Discord messages |
| `/pc status` | Show whether this conversation is protected |
| `/pc help` | Show the local command help |

Trust is explicit. Key replacements and membership changes require review; a missing key, locked vault, failed save or changed account blocks protected sends. Stopping the plugin or changing accounts clears decrypted caches and closes a configured OneKey vault. **Lock Secure Messaging** and **Cancel** invalidate pending hardware approvals, including results that arrive after the action.

To use the same OneKey identity as your PC, connect a Classic 1S with a USB data cable or OTG adapter, choose **Set up OneKey** or **Unlock with OneKey**, and approve on the device. Compare the displayed fingerprint with the PC. On desktop choose **Copy phone pairing**, then paste its `PCMP1:` token into **Bring your PC chats** on the phone. This imports verified contacts, protected conversations and older history keys. The identity-backup importer also accepts desktop `PCIB1:` password-protected exports.

This alpha sends protected text and attachments, and reads compatible desktop encrypted messages and attachment formats. It reads encrypted forwarded text and stickers from desktop; sending stickers/forwards and editing protected messages on mobile remain blocked. Calls, reactions, notifications and Discord metadata are not encrypted by the plugin. Encryption does not protect plaintext from other code already running inside the same Discord process.

For an attachment retry, keep the same files, order, account and conversation. If Secure Messaging reports that the encrypted uploads changed or expired, remove those entries and attach the original files again. Locking/reloading clears retry keys; a cached `.pcaf` file cannot substitute for its original attachment.

## Build and test without a Discord account

Use the package manager recorded in the root `package.json`, Bun from [toolchain.json](toolchain.json), and the committed lockfiles. Root dependencies are needed because the interoperability tests import the desktop implementation. From the repository root:

```sh
pnpm install --frozen-lockfile
cd mobile
bun install --frozen-lockfile
bun audit
bun run test
bun run lint:types
bun run lint
bun run build
bun run test:bundle
```

This directory builds a Rolldown plugin. Discord supplies React and React Native at runtime; their type packages, including Reanimated and Worklets, are explicit development dependencies. [bunfig.toml](bunfig.toml) disables automatic peer installation so these type packages do not pull in the unused Metro application bundler. The separately built pinned Revenge runtime keeps its own Deno dependency graph.

The ordinary tests exercise protocol/crypto interoperability, trust changes, replay rejection, storage failures, attachment validation, vault locking and delayed host callbacks. `test:bundle` loads the actual generated `index.js` IIFE with a synthetic Revenge/native host, starts signed out, renders settings, handles commands and a public announcement with a synthetic account, and checks cleanup. It forbids network access and fails if the build artifact is missing. These checks use no Discord credentials or live messages.

For native compilation, install JDK 21 and 25 and the Android SDK packages used by the local pipeline (`platforms;android-36`, `platforms;android-37.0`, `build-tools;36.0.0`). Publish the pinned Revenge API to local Maven before packaging:

```sh
# Run from mobile/; use a fresh .toolchain/revenge-xposed directory.
mkdir -p .toolchain
git clone https://github.com/revenge-mod/revenge-xposed.git .toolchain/revenge-xposed
git -C .toolchain/revenge-xposed checkout --detach "$(node -p "require('./toolchain.json').revengeNativeRevision")"
(cd .toolchain/revenge-xposed && bash gradlew :api:publishToMavenLocal --console=plain)
bash gradlew :plugins:secure-messaging:testDebugUnitTest packageSecureMessaging --console=plain
bun run test:bundle
```

The plugin package is `build/dist/uk.co.protonn.secure-messaging.zip`. Its `plugin.jar` contains DEX bytecode and is loaded by Revenge; the ZIP is not an installable Android APK. See [mobile.sh](../scripts/ci/mobile.sh) for building the pinned Hermes runtime with Deno and recording release provenance.

Gradle requires the pinned Bun version for the plugin bundle and installs with `--frozen-lockfile`. Set `BUN` or pass `-PjsToolPath=/absolute/path/to/bun` if it is outside the usual locations. Deno is used separately for the upstream Hermes runtime; npm/Deno are not fallback package managers for this plugin.

With an Android emulator or test device connected, run the native storage suite after publishing the pinned Revenge API:

```sh
bash gradlew :plugins:secure-messaging:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=uk.co.protonn.securemessaging.NativeStorageTest \
  --console=plain
```

These instrumented tests run in their own ordinary Android app sandbox and use the actual Android Keystore, AES-GCM and AtomicFile implementations. They exercise key persistence and replacement, tampered vault rejection, interrupted-write rollback, legacy backup recovery, reset, UTF-8 size bounds, and loader configuration failure/retry with unknown fields and original backups preserved. No Discord installation or account is needed. AndroidX runner and JUnit are test dependencies and are excluded from the released plugin JAR. Results and reports are under `plugins/secure-messaging/build/outputs/androidTest-results/connected` and `plugins/secure-messaging/build/reports/androidTests/connected`.

The [local mobile pipeline](../scripts/ci/mobile.sh) builds the current plugin, pinned Next runtime and standalone APK, then runs the storage suite and client check on one fresh Android 15 `google_apis` x86_64 emulator. It proves that the APK supplies its own first-launch defaults before any test modifies private app data, then checks one cache-clear restart with settings/data preserved. It records both phases' input/file hashes, screen, hierarchy and logs. Pull requests use a disposable signing identity; release builds use the retained production key. Diagnostics stay with the local job.

The earlier [2026-10-12 validation run](https://github.com/ProtonDev-sys/ProtonnCord/actions/runs/38210958852) passed on merged revision `113bb1d40fb45b995437fae84ba7e0f9cc6011d3`: all 13 native storage tests passed, and Discord `348010` reached its signed-out welcome screen on Android 15 / API 35 with the native loader and this plugin's JavaScript started. That run used the previous split-APK fixture with test-seeded runtime/plugin files; it is not evidence for the standalone bootstrap. Each standalone APK must pass the local gate before publication.

Unit tests, a compiled-bundle fixture and native compilation cover different failure modes. They do not establish device compatibility. Before claiming a device/Discord version is supported, record its Android and Discord versions, loader/runtime pins, and verify injection, plugin settings, reload/disable cleanup, Android Keystore round trips, attachment selection/rendering and failed-send retry, and OneKey permission denial/cancel/disconnect. A signed-out device can check startup and loader behavior; successful encrypted delivery between live peers needs a separate, explicitly authorized account test.
