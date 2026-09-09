# Privacy and data handling

Protonn Cord processes Discord account, channel, message and media data to provide its enabled features. Data handling depends on your plugins, settings, build target and connected services. This document describes the client implementation; it does not describe the retention practices of every external provider.

## Data on your device

Preferences, plugin configuration, themes and QuickCSS are stored locally. Plugins can also store records in IndexedDB, keep message or notification history, create downloads, and process recordings or transcripts. Some integrations save credentials or API keys in local configuration. Ordinary settings and exports should be treated as sensitive files, not assumed to be encrypted.

Desktop storage uses the configured Protonn Cord data directory; development builds use a separate directory unless explicitly overridden. Browser builds use the browser profile's storage. Disabling a plugin generally preserves its saved preferences and records. Removing a build or disabling cloud sync does not itself erase all local data. See the [backup implementation](src/api/SettingsSync/offline.ts) and [data-directory configuration](src/main/utils/constants.ts) for the current storage behavior.

## Network requests and optional integrations

Update checks and installer downloads contact GitHub according to the selected update channel and update settings. Themes, fonts, badges, images and media libraries can load resources from other hosts. Enabled plugins may contact translation, transcription, music, profile, upload or other services, including a server you configure. These requests can disclose your IP address, the requested resource, and information the feature submits, such as selected text, audio, media or account identifiers.

Review a plugin's settings and provider before enabling an integration or entering credentials. Themes and QuickCSS can also reference remote resources. Discord continues to process ordinary account activity under its own [privacy policy](https://discord.com/privacy).

## Cloud settings sync

Cloud authentication is opt-in. The client supports compatible Equicord, Vencord and self-hosted backends. The current sync policy allows a restricted subset of preferences and QuickCSS; the selected backend can read that data. QuickCSS can contain private URLs or other text you enter, so review it before syncing. Plugin DataStore records, private plugin configuration and credential fields are excluded by the current [cloud policy](src/api/SettingsSync/cloudPolicy.ts).

Older clients may have uploaded fields that the current client excludes. The sync page can request deletion of settings or the account on the selected backend, but the client cannot verify provider backups or erase data from every previous backend. Previously shared credentials should be rotated, and all clients using the account should be updated. Provider retention and deletion practices remain the provider's responsibility.

## Secure Messaging

Secure Messaging encrypts content only for explicitly selected, verified conversations. Its installation-local vault uses operating-system storage protection and has different backup and recovery requirements from ordinary settings. Discord still receives routing information and ciphertext, including observable timing and sizes. The implementation does not provide forward secrecy or post-compromise security. Read the [protocol, storage and operational limits](src/equicordplugins/secureMessaging.desktop/README.md) before relying on it.

## Local bridges and custom code

Enabling a local bridge such as DiscordMCP gives connected software access to the bridge's supported operations using the signed-in Discord account. Returned messages and downloaded files become available to that connected software, whose own handling and retention policies then apply. See the [DiscordMCP capabilities](tools/discord-mcp/README.md). Custom plugins and development tools can introduce additional data access beyond the bundled defaults.

When reporting a problem, review logs, screenshots and exported files before sharing them. Do not include credentials, private messages or the Secure Messaging vault in a public issue.
