# ProtonnCord Mobile

Android Secure Messaging for [Revenge Next](https://github.com/revenge-mod/revenge-bundle-next), with desktop-compatible encryption, attachments, and OneKey Classic 1S support. Desktop UI and other plugins are not included.

## Install and update

In Revenge, open **Settings â†’ Plugins â†’ plugin settings** for Protonn Cord Secure Messaging, choose **Update from nightly**, then reload Discord. This sets the pinned HTTPS Revenge runtime and mobile repository. Subsequent plugin updates can use Revenge's standard or automatic update controls.

Repository URL (Revenge appends `index.json`):

```text
https://github.com/ProtonDev-sys/ProtonnCord/releases/download/mobile-nightly
```

The `Mobile nightly` workflow tests desktop/mobile cryptography and attachments, checks mobile types, runs native OneKey wire tests, and packages Android on each `nightly` push. Its index points to immutable downloads with SHA-256 checksums; failed builds leave the previous channel intact. Runtime/native API revisions are pinned in `toolchain.json`, and runtime updates are separate from plugin updates. Releases include upstream runtime source and license. Discord APKs are not packaged or downloaded.

## OneKey Classic 1S

1. Connect the same physical Classic 1S used on your PC, with its PIN configured, using a USB data cable.
2. Choose **Set up OneKey** in the plugin settings. Allow Android USB access, enter the PIN on the device, and approve **ProtonnCord Secure Messaging** on its screen.
3. Compare the full mobile and PC fingerprints for the same Discord account.
4. After restarting Discord, use **Unlock with OneKey**. You can unplug the device after approval. **Lock Secure Messaging** clears the active root and decrypted caches.

The same OneKey/account derives the same identity on desktop and mobile. Setup retains a replaced mobile identity for bounded history and requires review of affected conversations. OneKey encrypts the vault beneath its Android Keystore layer; derived keys remain in app memory while unlocked. The wallet recovery phrase cannot recreate the device-bound secret. Bluetooth is unsupported.

### Bring your PC chats

On the unlocked PC, choose **Copy phone pairing**. On the phone, use the same OneKey, paste the token into **Bring your PC chats**, choose **Import PC chats**, and clear the clipboard.

Pairing transfers verified contacts, enabled conversation choices, and up to four historical identities per account/contact. Desktop encrypts private history keys before the token reaches its renderer. The token is bound to the OneKey and Discord account and needs no password. It is an explicit snapshot, not continuous sync or a complete vault backup; copy a new one after PC contact changes. Without pairing, verify announcements on the phone before enabling conversations.

Imports preserve phone-only contacts and existing review requirements. If an imported key changes a current phone contact, affected conversations require review and the displaced key is retained for earlier history. Retired keys merge within the four-key limit: the earlier recorded cutoff wins, and a newly displaced key retires at import time. Imports exceeding contact or conversation limits are rejected without replacing phone state.

Mobile counters and replay records stay local. Changed membership or pending peer keys still block sends for review. Messages originally sent from the phone cannot be edited on desktop; send a new encrypted copy instead.

## Encrypted chats

In a DM or group DM:

```text
/pc announce
/pc trust USER_ID FULL_FINGERPRINT
/pc on [USER_ID ...]
/pc status
/pc off
```

Each person publishes a public key with `/pc announce`, compares the full fingerprint over another trusted channel, and trusts that exact key with `/pc trust`. Enable encryption with `/pc on`; supply recipient IDs explicitly for group DMs. All other commands are handled locally. Membership or observed key changes block protected sends pending review.

Mobile sends PCEM3 text, participant mentions, and encrypted file bundles. It reads PCEM1/2/3, PCEA3/PCER3 attachment manifests, and PCET2 detached text. Before display it verifies the signature, channel/author binding, trusted key, AEAD, bundle integrity, and persistent replay state (bounded to 4,096 records). Retired keys accept only messages posted, signed, and last edited before their cutoff. Text stays out of Discord's message store; decrypted attachment files use app cache cleared on lock. Encryption or persistence failures block protected sends.

## Current limits

Mobile is an alpha:

- Mobile cannot send detached long text, edit encrypted messages, or render native encrypted stickers. Protected edits, stickers, and forwards are blocked on the hooked message-actions path.
- Incoming media requires the complete authenticated bundle. Uploads are limited to 64 MiB per file and 128 MiB total; Discord's account allowance may be lower.
- Duplicate optimistic own-message IDs may remain blocked until the canonical message reloads.
- Other plugins and unhooked programmatic network paths remain trusted; mobile has no desktop-style REST backstop.
- Calls, reactions, notifications, metadata, screenshots, and compromised clients are outside encryption. The protocol is non-ratcheting E2EE without forward secrecy.

Legacy password-encrypted PCIB1/2 import supports existing unprotected desktop identity backups. The Windows-only `tools/Export-DesktopIdentity.ps1` cannot export a OneKey-protected vault. Never send private backups or passwords through Discord.

## Build and verify

Use the Bun version pinned in `toolchain.json`, Node 24, JDK 21 and 25, Android SDK 36 and 37.0, and build-tools 36.0.0. The [workflow](../.github/workflows/mobile.yml) contains the full recipe. First run `pnpm install --frozen-lockfile` at the repository root: mobile interoperability tests import that desktop checkout and its dependencies.

From `mobile/`:

```powershell
bun install --frozen-lockfile
bun run test
bun run lint:types
.\gradlew.bat :plugins:secure-messaging:testDebugUnitTest packageSecureMessaging
```

Before the Android build, publish `:api:publishToMavenLocal` from the exact `revengeNativeRevision` in `toolchain.json`. Packaging produces `build/dist/uk.co.protonn.secure-messaging.zip`. `bun run serve` hosts a development repository locally; hosted nightly updates do not need it.
