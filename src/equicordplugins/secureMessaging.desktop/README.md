# Secure Messaging

Secure Messaging encrypts text, stickers, GIF-picker links, and files in Discord DMs and group DMs. Encryption stays off until you verify at least one participant key and enable it for a selected recipient set.

Compare the full fingerprint over a channel outside the Discord conversation before trusting a key. The fingerprint binds the Discord user ID and both public keys. Selected recipients can be a subset of a group; adding someone does not give them access to earlier messages. Send a new encrypted copy of any history they need.

## Protocol

- Each Discord account has an Ed25519 signing key and an X25519 HPKE key pair.
- Each message uses a fresh AES-256-GCM content key and nonce. RFC 9180 HPKE (`DHKEM(X25519, HKDF-SHA256)`, HKDF-SHA256, AES-128-GCM) wraps that key separately for each selected recipient and the sender. The message body and each attachment are encrypted once, regardless of group size.
- Ed25519 signs the canonical envelope: version, random 128-bit envelope ID, channel, author, timestamp, persistent counter, sender fingerprint, ordered recipients, mentioned users, wrapped keys, nonce, and ciphertext.
- Version 3 uses a positional tuple. Its prefix identifies the type/version; channel and author come from Discord metadata rather than duplicated wire fields. Both remain mandatory inputs to the signed HPKE/AEAD context, so copying ciphertext to another channel or author fails authentication. Versions 1 and 2 remain readable.
- Explicit mentions of selected participants, including the author, become signed, AEAD-bound user IDs using canonical `<@user-id>` syntax. The renderer uses them for highlighting. The REST guard allows notifications only for mentioned recipients, excludes the author, and disables automatic role/everyone parsing.
- The native helper resolves recipients through its persistent verified-key store. Before showing plaintext, it checks channel/author binding, pinned sender fingerprint, signature, AEAD tag, recipient entry, and replay state.

Keys and counters live in an encrypted vault protected by Electron `safeStorage`. Secure Messaging refuses to operate without secure OS storage, including on Linux's `basic_text` backend. The native helper caches the decrypted vault while it is in use; the renderer API does not return plaintext private keys. Code running in the trusted main process can access that memory.

## Trust, sends, and history

A changed participant set or peer key creates a persistent review requirement. Protected sends remain blocked until you review and save or disable the conversation, even if Discord has evicted its channel from the renderer cache. Key announcements are processed from message events and loaded history whether or not their accessory is visible. Quarantine is persisted before sends resume; Discord announcement publication times prevent an older announcement from displacing a newer key.

Encryption, key-review, listener, or storage errors cancel protected sends without plaintext fallback. The REST backstop also covers built-in programmatic sends and blocks unauthorized edits, attachment reservations, and unsupported non-text sends. It admits only exact, short-lived, single-use ciphertext/key payloads and opaque attachment reservations prepared by Secure Messaging. A `PCEM3:`, `PCEM2:`, `PCEM1:`, or `PCEK1:` prefix alone is not authorization.

Forwarding into a ready protected conversation creates a new encrypted copy with its own channel and author binding. Protected-to-ordinary forwards are blocked; ordinary-to-ordinary forwards retain Discord's behavior. Inline encrypted edits preserve attachment/sticker descriptors and use a freshly signed higher-counter envelope. Detached text and attachment-set changes cannot be edited because Discord cannot replace the bundle atomically.

The vault retains the latest 4,096 accepted envelopes per local account. While those records remain, conflicting envelope IDs/counters and recorded-envelope replay are rejected. An own-message optimistic nonce ID can be reconciled once with its confirmed server ID when the canonical message carries that nonce. If loaded history omits the nonce, reconciliation also requires tightly bounded older-canonical/newer-provisional snowflake ordering around the signed envelope time. Unrelated copies, second replacements, and rollback to an older edit remain blocked.

History retains at most four retired local private identities and four retired verified public identities per peer. A historical message's Discord snowflake, signed time, and last edit must all predate the key's retirement cutoff. Peer cutoffs use Discord announcement metadata; local rotation and voluntary forget use the OS clock because they have no server event.

## Attachments and long text

New payloads use `PCEA3:`/`PCER3:` for attachments and `PCET2:` for detached text. Recipients need a version that reads these formats. This version also reads `PCEA1:`/`PCEA2:`, `PCER1:`/`PCER2:`, and `PCET1:`.

Each file uses an independently derived AES-256-GCM key and nonce. Its encrypted descriptor contains an authenticated manifest of ciphertext digests, preview/spoiler flags, original sizes, and filenames when space permits. Full metadata and bytes stay in opaque Discord attachments. The receiver checks the ordered aggregate digest against the manifest before fetching, then checks each selected ciphertext digest and AEAD tag before use. Files are never streamed before authentication.

Short text stays inline. In protected conversations, the pre-send handler bypasses Discord's local length popup and moves oversized UTF-8 text into a reserved bundle attachment. Its exact index is signed; the receiver authenticates the selected text ciphertext before reconstruction, or the whole bundle for older descriptors. This avoids Base64 expansion of large text and keeps the visible envelope below 2,000 characters. Ordinary conversations retain Discord's normal length handling.

Up to 10 attachments and 500 MiB of total ciphertext are supported. Each file must also fit Discord's current account upload allowance, normally 10, 50, or 500 MiB. Before encryption, the sender counts private metadata, framing, and the AES-GCM tag in the final size. Detached text occupies one attachment slot and must fit the remaining capacity of its file.

Opening a message fetches supported image/video/audio previews and any detached text. Other files, including ZIPs and executables, are fetched, authenticated, decrypted, and saved only after a download click; ZipPreview's expander is hidden for these deferred files. Older bundles lack an external authenticated file list, so they show generic file rows and require full-bundle authentication on download. Older detached text also needs the full bundle.

Optional filenames are dropped when the manifest or envelope budget is tight. If the mandatory manifest still exceeds the 2,000-character envelope limit after moving text where possible, the sender falls back to the older bundle format and its manual-download behavior.

Decrypted attachments use bounded renderer/main-process caches and revocable blob URLs for Discord's native media/file renderers. Downloads use the authenticated native cache when available: at most 10 minutes, 128 entries, and 256 MiB, with earlier eviction possible. Otherwise they fetch and authenticate the requested file or legacy bundle. Files go to the OS Downloads directory without overwriting existing files. Message plaintext stays out of Discord's message store and plugin settings; attachment plaintext is written to Downloads only on an explicit download action.

Sticker IDs, names, and formats stay inside the encrypted payload and are reconstructed for Discord's native sticker renderer. GIF-picker links are encrypted as text and reconstructed as native embeds. Attachment authentication proves who sent the bytes, not whether they are safe to open. Discord can scan only ciphertext; use normal file caution and OS/antivirus protections.

## OneKey setup

OneKey Classic 1S is supported through its hardware-vault interface with current firmware, a configured PIN, and USB. OneKey Pro and Touch can use the standard FIDO2 route where the OS supports WebAuthn PRF (`hmac-secret`) or large-blob storage. Bluetooth and U2F-only OneKey models are not supported.

Windows 10 cannot return the required FIDO2 PRF result. Classic 1S uses its separate Microsoft WinUSB interface and `CipherKeyValue` primitive automatically, with no administrator rights, custom shortcut, launch arguments, bridge, or driver replacement. It requires the device PIN when locked and physical confirmation on every derivation. Wallet software can hold the USB interface exclusively.

1. Update the firmware, configure the OneKey PIN, and connect it by USB.
2. Open a DM or group DM and click the lock button beside the message box.
3. Fully quit OneKey Desktop or other wallet software from the system tray.
4. Under **Security key**, click **Set up OneKey**. Enter the PIN on the device if asked, then approve **ProtonnCord Secure Messaging** on its screen.
5. Compare or share the displayed fingerprint. The same physical OneKey and Discord account deterministically restore the same fingerprint on a clean installation.
6. For every account in the shared vault, setup replaces a differing Secure Messaging identity, retains the previous key for bounded history, and disables protected conversations for explicit review. Share the new fingerprint so recipients can verify it. Accounts first opened later also derive their identity from the OneKey root.
7. After restart or manual lock, click **Unlock** and approve on the device again.

Classic 1S derives the root from a secret inside that physical device's secure element. Separate Ed25519/X25519 account identities are derived from it. This is not hardware-only signing: the derived private key material exists in the trusted Electron main-process memory while the vault is unlocked.

Keep an installation-local Secure Messaging state backup for verified contacts, conversation settings, counters, replay records, retired keys, and old history. Deterministic recovery restores only the current fingerprint. The outer `safeStorage` wrapper is OS-account-bound, so copying `vault.bin` alone is not a portable backup or export. The profile-copy control is intentionally hidden: its fixed derivation input cannot restore that state.

A clean OneKey restore seeds its send counter from the current system clock. Keep it accurate and use only one active sending desktop installation per OneKey/account. An installation-local state backup preserves the exact send counters and replay records.

The wallet recovery phrase does not recreate the device's secure-element secret. Before resetting or replacing the OneKey, unlock the vault and choose **Remove protection**; losing the device while protection remains can make the vault permanently unreadable. While OneKey protection is active, deterministic identity rotation is hidden; remove protection first if rotation is required.

### Pair an Android phone

Use the same Classic 1S and Discord account with [ProtonnCord Mobile](../../../mobile/README.md), then compare the full phone and desktop fingerprints.

On the unlocked desktop, choose **Copy phone pairing**. Paste the `PCMP1` token into **Bring your PC chats â†’ Import PC chats** on the phone, then clear the clipboard. This snapshot contains verified contacts, reviewed enabled conversations, and bounded retired-key history. The main process encrypts it with a separate HKDF-derived pairing key and AES-GCM, binding the OneKey root fingerprint and account as authenticated context. Only ciphertext reaches the renderer/clipboard. Wrong-device/account, modified, and older-than-last-import pairings are rejected.

Pairing preserves phone-only verified contacts and existing review requirements. An imported key change requires review of affected conversations and retains the displaced phone key for earlier history. Histories merge within the four-key limit; the earlier recorded cutoff wins, and a newly displaced phone key retires at import time.

Phone counters and replay records stay local. A separate high counter range allows the paired PC and phone to send with the same identity; the single-desktop rule still applies. Pairing is a snapshot, not continuous contact sync or a vault backup. Keep the desktop state backup and copy a new pairing after contact changes. Changed membership or pending key review still blocks mobile sends.

Messages originally sent from the phone cannot be edited on desktop. Send a new encrypted message instead. Messages sent by the same desktop remain editable.

## Limits

This is **non-ratcheting E2EE** without forward secrecy or automatic recovery after compromise. A stolen static recipient key can expose recorded messages addressed to it. A future upgrade for forward secrecy and post-compromise security should use an audited MLS implementation.

Discord retains message and attachment ciphertext and sees channel membership, sender, timing, ciphertext sizes, attachment counts, recipient IDs, explicit mentions, reply relationships, and traffic patterns. Calls, reactions, and notification delivery are not encrypted. Native link/GIF previews disclose their URLs to Discord's unfurl service; sticker rendering requests its asset ID from Discord's CDN.

Optional screenshot mode hides decrypted text/media in current and future Discord windows and pauses protected sends. It must be enabled before capture. Discord's whole-window OS capture block stays disabled, so normal recording and screensharing remain available.

A compromised endpoint, renderer, plugin, keylogger, clipboard monitor, or capture outside screenshot mode can expose visible plaintext. Other installed plugins are part of the trusted endpoint: code with direct network access can bypass client-side guards. These tests provide implementation evidence, not a formal proof or independent security audit.
