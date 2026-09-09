# Privacy and data handling

Protonn Cord processes Discord account, channel, message and media data for the features you enable. Plugins and connected services determine what is stored and sent.

## Local data

Settings, themes and QuickCSS are stored in the configured data directory or browser profile. Plugins may also keep IndexedDB records, message/notification history, downloads, recordings or transcripts. Some integrations store credentials locally. Treat settings files and exports as sensitive; ordinary settings are not encrypted by default.

Use the plugin's own controls to clear stored data; disabling it usually retains that data. Removing a build or disabling sync does not erase every local record. See the [backup implementation](src/api/SettingsSync/offline.ts) and [data-directory configuration](src/main/utils/constants.ts).

## External services

Updates and installer downloads contact GitHub. Themes, fonts, badges, images and media libraries can load from other hosts. Enabled integrations may send text, audio, media or account identifiers to translation, transcription, music, upload or other configured services. Requests also expose your IP address and requested resource to the receiving service.

Review the feature and provider before enabling it or entering credentials. Themes and QuickCSS can reference remote resources. Ordinary Discord activity remains subject to [Discord's privacy policy](https://discord.com/privacy).

## Cloud sync

Cloud authentication is opt-in. Compatible Equicord, Vencord or self-hosted backends receive allowlisted preferences and QuickCSS, which they can read. Review QuickCSS for private URLs or secrets before syncing. The current [cloud policy](src/api/SettingsSync/cloudPolicy.ts) excludes credential fields, private plugin configuration and plugin DataStore records.

Older clients may have uploaded excluded fields. The sync page can request deletion from the selected backend; it cannot verify retained backups or erase every former backend. Update other clients and rotate credentials that were previously synced.

## Encrypted messages and bridges

Secure Messaging applies only to selected, verified conversations. Discord still sees routing, timing, sizes and ciphertext. Its installation-local vault has different backup/recovery requirements from ordinary settings. Read the [protocol and recovery guide](src/equicordplugins/secureMessaging.desktop/README.md).

Enabling [DiscordMCP](tools/discord-mcp/README.md) gives connected software access to supported account operations and returned data. That software's handling and retention policies apply too. Custom plugins and development tools can add further access.

Before sharing logs, screenshots or exports, remove private messages and credentials. Never attach the Secure Messaging vault to a public issue.
