# Rewrite acceptance

The rewrite must retain the complete existing plugin catalog and saved settings. Refactoring implementation does not authorize removing features, resetting preferences, rotating encryption identities, or changing the user's enabled plugins.

## Catalog and user-visible behavior

The frozen source inventory contains **399 plugins**: 377 catalog/core entries and 22 supporting API entries. It includes 167 catalog/core entries under `src/plugins` and 210 under `src/equicordplugins`; 388 entries apply to a normal Discord desktop build. Platform exclusions remain explicit. There were no local `src/userplugins` entries in this baseline; user-plugin discovery remains supported separately.

| Feature family | Representative existing behavior |
| --- | --- |
| Chat | Composer actions, commands, replies, edits, search, message logging, translation, timestamps, mention controls, and text transformations. |
| Private communication | Secure Messaging text, replies, edits, large text, attachments, stickers, GIF links, voice messages, key verification, screenshot mode, hardware-vault protection, and protected forwarding. |
| Voice and media | Calls, stream focus/audio, audio playback across navigation, voice transcription, recording/upload controls, attachment previews/downloads, emoji and sticker tools. |
| Navigation and community | Channel tabs, DM ordering/switching, server folders/icons, role/member information, friends, notifications, and activity/RPC. |
| Appearance | Themes, QuickCSS, fonts, colors, collapsible surfaces, local profile customization, accessibility, and window preferences. |
| Product controls | Plugin search/toggles/favorites/settings, new-plugin notices, updater, backup/restore, opt-in cloud sync, repair/injection, browser targets, and the local DiscordMCP bridge. |

The Protonn Cord additions include `SecureMessaging`, `SecureMessagingForwarding`, `PrimaryStreamAudio`, `PersistentAudioPlayback`, `VoiceMessageTranscriber`, `AutoCodeblockLanguage`, `ClientsideGuildIcons`, `DiscordMCP`, context-menu copy utilities, and the Protonn Cord updater. These are covered alongside the upstream ecosystem rather than replacing it.

Acceptance requires:

- Every baseline plugin name, saved-settings namespace, platform target, required/default-enable flag, and statically declared setting identifier survives. Existing optional plugins remain optional; enabled plugins remain enabled.
- Registered commands, menus, buttons, render contributions, and event handlers retain their observable behavior. Enabling, disabling, restarting, changing account/channel, and closing windows do not leave stale listeners, timers, UI, or background work.
- Settings pages, themes/QuickCSS, updater, notifications, and crash recovery work in the running client; representative enabled plugins from each applicable family receive live smoke coverage.
- Normal desktop, standalone, browser-extension, and userscript builds retain their output contracts. A development build cannot update itself or write production settings.

## Saved data and migration

Retain `Settings.plugins[plugin.name]`, including `enabled`, `isFavorite`, private settings, and unknown keys. The catalog check records 1,352 statically inferred setting identifiers, including private settings exposed by `withPrivateSettings`. Dynamic namespaces such as CustomSounds and OpenInApp require opaque preservation and focused feature tests; a source inventory cannot enumerate every runtime-generated value.

Keep the existing `VencordData` / `VencordStore` IndexedDB database and object-store identity (`src/api/DataStore`), its plugin keys, and atomic multi-key/update behavior. Keep renderer/native settings, local themes, QuickCSS, UI preferences, and data-directory overrides from `src/main/utils/constants.ts`. Renaming these needs a versioned, repeatable migration with a recoverable original and an explicit rollback test. Unrelated and unknown user data must round-trip without loss.

Offline backups retain their settings/QuickCSS/DataStore import/export contract. Cloud sync stays opt-in and restricted to the explicitly allowed fields in `src/api/SettingsSync/cloudPolicy.ts`; plugin DataStore records and secrets remain local. Neither a rewrite nor a backup import should silently enable plugins or cloud transfers.

Preserve the complete installation-local Secure Messaging vault and quarantine state under `DATA_DIR/secure-messaging`, not just public keys. Contacts, participant selections, persistent review latches, counters, replay records, retired keys, and hardware protection are necessary to retain trust and history. The vault is bound to OS storage; copying `vault.bin` is not a portable backup. Keeping the established protocol/vault implementation while replacing its surrounding runtime is the preferred compatibility strategy.

## Secure Messaging contract

Read `src/equicordplugins/secureMessaging.desktop/README.md` before touching the secure path. The implementation and focused tests also govern these requirements:

- Encryption remains opt-in for explicitly verified recipients in DMs/group DMs. Ordinary conversations retain ordinary Discord behavior. Participant/key changes persist a review requirement before further protected sends.
- Existing PCEM1/2/3 messages and legacy attachment/text formats remain readable. Preserve signed account/channel binding, recipient selection, replay/edit ordering, and old-key history cutoffs. Identity and protocol changes are separate work.
- Encryption, storage, review, listener, or vault-lock failures cancel protected sends. REST guards admit only the exact authorized encrypted payload/reservation; no failure may become plaintext fallback.
- Plaintext stays out of Discord's message store, settings, and logs. Screenshot mode hides decrypted content and pauses protected sends; it must also cover newly created windows.
- Attachments authenticate fully before display; deferred files load on explicit demand. Preserve upload-limit accounting, bounded caches, revocable URLs, and Downloads writes without overwriting existing files.
- Sender optimistic/confirmed messages, receive events, history, edits, replies, mentions, stickers, GIFs, voice messages, and attachment downloads retain native-looking behavior.
- Forwarding into a ready protected conversation creates a new encrypted copy. Protected-to-ordinary forwards are blocked. Ordinary-to-ordinary forwards retain Discord behavior. This is the current `SecureMessagingForwarding` contract; the older README statement that all protected forwards are blocked is outdated.

The existing protocol is non-ratcheting E2EE. A runtime rewrite must not claim forward secrecy, post-compromise recovery, hardware-only signing, or a new security audit.

## Validation and performance

Run the source-only catalog gate from the repository root:

```sh
pnpm exec tsx scripts/testPluginCatalog.ts
```

It parses TypeScript without executing plugin code, checks all platforms rather than only the active desktop build, and compares names/flags/settings against `docs/plugin-catalog-baseline.json`. New plugins and new settings are allowed; removal or identity changes fail. Local user plugins are intentionally outside the frozen upstream catalog.

The baseline is a compatibility contract, not a generated file to refresh after a failure. `--print-baseline` prints a candidate without writing it. Update the checked-in baseline only after reviewing an intentional feature change, its migration, and preservation tests; never regenerate it to hide a missing plugin or setting.

Run the existing relevant tests during each change, then the broad `pnpm test`, type check, and applicable desktop/browser builds. The broad test command includes formatting/metadata generation; inspect its diff. It does not directly invoke every focused command: also cover PrimaryStreamAudio, NewPluginsManager, ClientsideGuildIcons, PromiseTimeout, VoiceMessageTranscriber, and DiscordMcp when their paths change. Secure Messaging needs its protocol/native/attachment/history/REST/forwarding suites. Live scripts have separate documented prerequisites and may only mutate destinations authorized for the current task.

Compare startup, idle CPU/heap, channel switching, message rendering, and secure receive/history behavior against the same enabled-plugin/settings profile in the same client. Record the build, sample count, workload, and measurement limits. Existing deterministic cache/queue/listener/work-count gates must pass. Treat synthetic benchmark gains as isolated evidence; do not present them as measured Discord FPS or whole-client improvements. Release only after explaining any repeatable regression and obtaining a passing live smoke result with the preserved profile.
