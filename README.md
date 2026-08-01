# [<img src="./browser/icon.png" width="40" align="left" alt="Protonn Cord">](https://github.com/ProtonDev-sys/ProtonnCord) Protonn Cord

[![Tests](https://github.com/ProtonDev-sys/ProtonnCord/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/ProtonDev-sys/ProtonnCord/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/release/ProtonDev-sys/ProtonnCord.svg?label=latest)](https://github.com/ProtonDev-sys/ProtonnCord/releases/tag/latest)

Protonn Cord is a desktop-focused fork of [Equicord](https://github.com/Equicord/Equicord), which is itself a fork of [Vencord](https://github.com/Vendicated/Vencord). It keeps the wider plugin ecosystem while adding Protonn Cord-specific desktop features and release infrastructure.

## Highlights

- More than 300 bundled Equicord and Vencord plugins.
- Opt-in Secure Messaging for DMs and group DMs, including authenticated encrypted text, replies, edits, stickers, GIF links, and ordinary attachments.
- A Protonn Cord updater that checks this repository instead of the upstream Equicord remote.
- Desktop, browser-extension, and userscript build targets.

## Secure Messaging

Secure Messaging is non-ratcheting end-to-end encryption for explicitly selected and verified participants. Each message body and attachment is encrypted once with fresh symmetric key material; only the small content key is wrapped separately for each selected recipient and the sender. Adding somebody to a group does not grant access to earlier encrypted history, so any earlier content they need must be sent again as a new encrypted message.

Encrypted attachments are authenticated completely before display. Their normal download actions are intercepted by Protonn Cord, decrypted in the trusted desktop process, and saved directly to the operating system's Downloads directory without overwriting an existing file.

Authentication proves which verified sender supplied the bytes; it does not prove a file is harmless. Discord can scan only the opaque ciphertext, not the decrypted attachment, so open files only when you trust the sender and continue to rely on your operating system and antivirus protections.

Read the [Secure Messaging protocol, operational rules, limits, and threat model](./src/equicordplugins/secureMessaging.desktop/README.md) before relying on it. It is implementation evidence, not a formal proof or independent security audit, and it does not provide forward secrecy or post-compromise security.

## Install from source

[Git](https://git-scm.com/downloads), Node.js 22 or newer, and the repository-pinned `pnpm` version are required. Do not build or inject from an Administrator/root terminal; doing so can leave Discord files owned by the wrong account.

```shell
git clone https://github.com/ProtonDev-sys/ProtonnCord.git
cd ProtonnCord
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

Useful maintenance commands:

```shell
pnpm uninject
pnpm repair
```

Prebuilt release artifacts are published on the [latest Protonn Cord release](https://github.com/ProtonDev-sys/ProtonnCord/releases/tag/latest). The local injector uses Equicord's Equilotl installer engine, but the code and updater repository remain Protonn Cord.

## Updating

Open **Settings → Protonn Cord → Updater**. A local source build compares its current branch with the same branch in `ProtonDev-sys/ProtonnCord`, updates only by fast-forward, rebuilds, and then offers to restart Discord. Detached, unpublished, diverged, or dirty-behind checkouts stop with an explicit error instead of being reset. A standalone build downloads the current Protonn Cord release artifact from this repository.

## Development and testing

Install dependencies once, then run the complete non-live gate:

```shell
pnpm test
```

That gate builds the standalone desktop artifact, type-checks, verifies the updater against a disposable Git remote, checks updater repository/release selection, exercises Secure Messaging protocol and native fault cases, checks message-event ordering, runs linters, and regenerates plugin metadata. Restore a normal local desktop build afterwards with `pnpm build` when required.

Two additional scripts exercise a running Discord client through its remote-debugging endpoint:

- `pnpm testSecureMessagingLive` sends, edits, forwards, downloads, retries, renders, and deletes real proof messages in its explicitly authorized DM. It refuses to run without `PROTONN_CORD_SECURE_MESSAGING_LIVE_TEST=I_UNDERSTAND_THIS_IS_DISPOSABLE` and matching absolute `PROTONN_CORD_SECURE_MESSAGING_LIVE_DATA_DIR` / `PROTONN_CORD_USER_DATA_DIR` values whose directory name contains `secure-messaging-live`. The Discord process must use that directory, have Secure Messaging enabled before startup when attachment patch coverage is required, and expose its debugging endpoint.
- `pnpm testUpdaterLive` first proves that the connected Discord process uses this checkout's Git backend, `main` branch, and built HEAD; it refuses to update if remote `main` has advanced, then exercises the real no-op pull and desktop rebuild.

The live scripts are deliberately excluded from `pnpm test` because they require a signed-in Discord session and mutate external state. Secure Messaging creates and then removes proof messages, temporary trust/configuration, and one Downloads file; if a run is interrupted, inspect those locations before retrying. Both scripts default to `http://127.0.0.1:9222`; set `DISCORD_DEBUG_URL` to use another explicitly authorized debugging endpoint.

Build the browser extension and userscript with:

```shell
pnpm buildWeb
```

The resulting archives and userscript are written to `dist`.

## Credits and license

Protonn Cord builds on work by the contributors to [Equicord](https://github.com/Equicord/Equicord), [Vencord](https://github.com/Vendicated/Vencord), [Equilotl](https://github.com/Equicord/Equilotl), and Suncord. It is licensed under GPL-3.0-or-later.

## Disclaimer

Discord is a trademark of Discord Inc. Protonn Cord is not affiliated with or endorsed by Discord Inc., Equicord, or Vencord. Client modifications violate Discord's Terms of Service; use Protonn Cord at your own risk, especially on accounts whose loss would be consequential.
