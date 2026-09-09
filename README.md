# [<img src="./browser/icon.png" width="40" align="left" alt="Protonn Cord">](https://github.com/ProtonDev-sys/ProtonnCord) Protonn Cord

[![Tests](https://github.com/ProtonDev-sys/ProtonnCord/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/ProtonDev-sys/ProtonnCord/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/release/ProtonDev-sys/ProtonnCord.svg?label=latest)](https://github.com/ProtonDev-sys/ProtonnCord/releases/tag/latest)

Protonn Cord is a Discord client mod based on [Equicord](https://github.com/Equicord/Equicord) and [Vencord](https://github.com/Vendicated/Vencord). It includes their plugins, optional Secure Messaging, and its own updater. Desktop, browser-extension and userscript builds are supported; [Android Secure Messaging](mobile/README.md) is a separate companion plugin.

## Secure Messaging

Secure Messaging encrypts DM/group-DM text and attachments for explicitly selected, verified participants. Adding someone does not give them access to earlier encrypted history. The protocol is non-ratcheting and provides neither forward secrecy nor post-compromise security.

Attachments authenticate before display and decrypt locally. Authentication identifies the sender; it is not a malware scan, and Discord sees only ciphertext. Open files only from senders you trust.

Read the [setup, protocol and recovery guide](src/equicordplugins/secureMessaging.desktop/README.md) before use. [Privacy and data handling](PRIVACY_POLICY.md) covers local storage, cloud sync and external integrations.

## Install from source

Use [Git](https://git-scm.com/downloads), Node.js 24 (as CI does), and the `pnpm` version pinned in `package.json`. Other supported Node versions are listed there. Build and inject as your normal user to avoid incorrect file ownership.

```shell
git clone https://github.com/ProtonDev-sys/ProtonnCord.git
cd ProtonnCord
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

Use `pnpm uninject` to remove the injection or `pnpm repair` to repair it.

Prebuilt artifacts are on the [latest release](https://github.com/ProtonDev-sys/ProtonnCord/releases/tag/latest). The injector uses Equicord's Equilotl installer engine.

## Updating

Choose `main`, `staging`, or `nightly` in **Settings → Protonn Cord → Updater**. Source builds fast-forward the selected branch from this repository and rebuild. Detached, unpublished, diverged or conflicting dirty checkouts stop with an error. Standalone builds download that channel's release. A restart is offered after a successful update.

## Development and testing

After installing dependencies, run the desktop gate:

```shell
pnpm build
pnpm test
```

The gate uses built desktop inputs, runs regressions and type/lint checks, and can modify formatting and `dist`. Review the diff. Restore `pnpm build` afterwards if this checkout supplies your running client. Additional checks are listed in `package.json`; Android has its [own build recipe](mobile/README.md).

`pnpm build --dev` and `pnpm dev` use separate development data and disable updates. `--disable-updater` keeps the normal data profile with updates disabled. Use an isolated checkout or `--outdir=<directory>` for preview builds.

Live runners are excluded from `pnpm test`. They can change real messages, settings, downloads or installed builds. Read each runner's preflight requirements and use its required profile, branch and authorized destination. `testSecureMessagingLive` requires explicit disposable-profile opt-in; `testUpdaterLive` requires an exact installed `main` checkout. Inspect proof messages, temporary configuration and downloads after an interrupted run.

Build the browser extension and userscript with:

```shell
pnpm buildWeb
```

The resulting archives and userscript are written to `dist`.

## Credits and license

Protonn Cord builds on work by the contributors to [Equicord](https://github.com/Equicord/Equicord), [Vencord](https://github.com/Vendicated/Vencord), [Equilotl](https://github.com/Equicord/Equilotl), and Suncord. It is licensed under GPL-3.0-or-later.

## Disclaimer

Discord is a trademark of Discord Inc. Protonn Cord is not affiliated with or endorsed by Discord Inc., Equicord, or Vencord. Client modifications violate Discord's Terms of Service; use Protonn Cord at your own risk, especially on accounts whose loss would be consequential.
