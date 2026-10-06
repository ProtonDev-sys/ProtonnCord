# Protonn Cord

A Discord client mod based on [Equicord](https://github.com/Equicord/Equicord) and [Vencord](https://github.com/Vendicated/Vencord), with plugins and Secure Messaging.

[Download the desktop release](https://github.com/ProtonDev-sys/ProtonnCord/releases/latest).

## Install

On Windows, download `ProtonnCord-<version>-Windows.zip`, extract it, fully quit Discord and double-click `Install.cmd`. Start Discord again. Node.js and a source checkout are not required. Run `Uninstall.cmd` to remove the mod; your settings are retained. PTB and Canary users can run `Install.cmd -DiscordBranch ptb` or `canary`.

On Linux x86-64, download the Linux ZIP, extract it, quit Discord and run `bash install.sh`. Run `bash install.sh uninstall` to remove it. Snap installations are unsupported. See the included `README.txt` for installation paths that require administrator access.

Windows downloads are unsigned and can trigger SmartScreen. Compare the download's SHA-256 with `SHA256SUMS` before running it. Discord must already be installed. Discord updates may require reinstalling the mod.

## Browser and Android

`extension-chrome.zip` can be extracted and loaded as an unpacked extension through Chromium's developer mode. Firefox ZIPs are unsigned and can only be loaded temporarily for development. `ProtonnCord.user.js` is available for userscript managers. Browser extensions are not published to extension stores by this download release.

The Android Secure Messaging companion is distributed separately through [Mobile nightly](https://github.com/ProtonDev-sys/ProtonnCord/releases?q=Mobile+nightly). The desktop download does not include an Android APK.

## Build from source

Use Node.js 24 and the pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm buildStandalone
pnpm buildWebStandalone
pnpm packageRelease
```

Packaging uses an explicit file list and verifies pinned installer binaries. It does not copy local settings, user plugins, account exports, credentials or Git configuration. `ProtonnCord-source.zip` contains the tracked source for the release; `Equilotl-source.zip` supplies the installer source. `release.json` records the exact commit and checksums.

Live Secure Messaging tests require an explicitly authorized disposable profile, `PROTONN_CORD_SECURE_MESSAGING_LIVE_CHANNEL_ID` and `PROTONN_CORD_SECURE_MESSAGING_LIVE_RECIPIENT_ID`. Offline tests use synthetic identifiers. Never commit account data or local `.env` files.

Licensed under GPL-3.0-or-later. Upstream notices and third-party license files are retained.
