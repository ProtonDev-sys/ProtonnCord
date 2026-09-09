# ProtonnCord Mobile

Android Secure Messaging for ProtonnCord, built as a native and JavaScript plugin for [Revenge Next](https://github.com/revenge-mod/revenge-bundle-next). Mobile lives in this repository so every desktop nightly revision is tested against the Android protocol implementation.

## Install and update

In Revenge, open **Settings → Plugins → plugin settings** for Protonn Cord Secure Messaging and choose **Update from nightly**, then reload Discord. This configures a pinned HTTPS Revenge runtime and the mobile nightly repository. Future plugin updates can also use Revenge's standard update controls and automatic-update setting.

Repository URL (Revenge appends `index.json`):

```text
https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-nightly
```

The `Mobile nightly` workflow builds on every push to `nightly`. It runs mobile/desktop cryptography and attachment compatibility tests, mobile TypeScript checks, native OneKey wire tests, and Android packaging. The repository index points to immutable build downloads with SHA-256 checksums. A failed mobile build leaves the previous mobile channel intact. Desktop-only UI and plugins do not automatically become Android plugins.

The Revenge runtime and native API source revisions are pinned in `toolchain.json`. Runtime updates are separate from normal plugin updates. Release assets include the runtime's corresponding upstream source and license. This project does not package or download Discord APKs.

## OneKey Classic 1S

1. Use the same physical Classic 1S as on your PC, with its PIN already configured.
2. Connect it directly to the phone using a USB data cable.
3. In the plugin settings choose **Set up OneKey**. Allow Android USB access, enter the PIN on the OneKey, and approve **ProtonnCord Secure Messaging** on its screen.
4. Compare the complete mobile fingerprint with your PC fingerprint for the same Discord account.
5. After restarting Discord, use **Unlock with OneKey**. You can unplug the device after approval; **Lock Secure Messaging** clears the active root and decrypted caches.

The same physical OneKey and Discord account derive the same current identity as desktop. The existing mobile identity is retained for bounded historical decryption when setup replaces it, and affected conversations require review.

To bring existing PC chats across, unlock Secure Messaging on the PC and choose **Copy phone pairing** in its security-key controls. In the phone plugin settings, unlock with the same OneKey, paste that encrypted pairing into **Bring your PC chats**, and choose **Import PC chats**. This transfers verified contacts, enabled conversation choices, and up to four historical identities per account/contact. Private historical keys are encrypted in the main process before the pairing reaches the desktop renderer. The pairing is bound to the OneKey and Discord account; a password is not needed. Clear the clipboard afterward. Existing mobile counters and replay records remain local, and changed membership or pending peer keys still block sends for review.

Pairing is an explicit snapshot, not continuous synchronization or a complete desktop vault backup. Copy a new pairing after changing verified contacts on the PC. Without pairing, verify peer announcements on the phone before enabling conversations.

Importing PC chats preserves phone-only verified contacts and existing review requirements. If a PC contact key differs from the phone's current key, affected conversations require review and the displaced phone key remains available for earlier history. Retired keys merge within the existing four-key limit; an earlier recorded cutoff is preserved, and a newly displaced phone key retires at import time. An import that would exceed the contact or conversation limits is rejected without replacing the phone's state.

OneKey protection encrypts the mobile vault beneath its Android Keystore layer. Derived identity keys exist in the app's memory while unlocked. The wallet recovery phrase does not reproduce this device-bound secret. Bluetooth is not supported by this USB implementation.

## Encrypted chats

Commands entered in a DM are intercepted locally:

```text
/pc announce
/pc trust USER_ID FULL_FINGERPRINT
/pc on [USER_ID ...]
/pc status
/pc off
```

Each person uses `/pc announce`, compares the complete fingerprint over another trusted channel, and trusts that exact key with `/pc trust`. Use `/pc on` to enable encryption; in group DMs, supply the intended recipient IDs explicitly. A membership change or observed peer key change blocks protected sends pending review. `/pc announce` publishes a public key announcement; other commands are handled locally.

Mobile sends desktop-compatible PCEM3 text, participant mentions, and encrypted file bundles. It reads PCEM1/2/3, including the latest PCEA3/PCER3 attachment manifests and PCET2 detached text. Text stays out of Discord's message store; decrypted attachments use temporary app-cache files cleared on lock. Signature, channel/author binding, trusted keys, AEAD, bundle integrity, and a persistent bounded 4,096-record replay history are checked before display. Retired identities accept only history posted, signed, and last edited before their retirement cutoff. Failed encryption or vault persistence cancels a protected send.

## Current limits

This is an alpha, not full desktop feature parity. Mobile does not yet send detached long text, edit encrypted messages, or render native encrypted stickers. Incoming media is fetched as a complete authenticated bundle rather than on demand per file. Uploads are bounded to 64 MiB per file and 128 MiB total; the actual Discord allowance can be lower. Duplicate optimistic own-message IDs can be blocked until the canonical message reloads.

Protected mobile edits, stickers, and forwards are blocked on the hooked message-actions path. Other plugins and unhooked programmatic network paths remain part of the trusted endpoint; mobile does not claim the desktop REST backstop. Calls, reactions, notifications, Discord metadata, screenshots, and a compromised client are outside message encryption. The protocol is non-ratcheting E2EE without forward secrecy.

The legacy password-encrypted PCIB1/2 import remains available for existing unprotected desktop identity backups. `tools/Export-DesktopIdentity.ps1` is a Windows-only legacy exporter; it cannot export a OneKey-protected desktop vault. Do not send private backups or passwords through Discord.

## Build and verify

Use Bun, Node 24, JDK 21 and 25, Android SDK 36 and 37, and the pinned Revenge API built from source. The workflow is the complete reproducible build recipe.

Run `pnpm install --frozen-lockfile` in the repository root first; the interoperability tests import that checkout's desktop implementation and dependencies.

```powershell
bun install --frozen-lockfile
bun run test
bun run lint:types
.\gradlew.bat :plugins:secure-messaging:testDebugUnitTest packageSecureMessaging
```

Publish `:api:publishToMavenLocal` from the `revengeNativeRevision` in `toolchain.json` before the Android build. The plugin archive is `build/dist/uk.co.protonn.secure-messaging.zip`. For development, `bun run serve` exposes a local repository; this is not needed for hosted nightly updates.
