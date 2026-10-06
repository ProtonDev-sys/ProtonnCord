PROTONN CORD

Windows: extract the entire ZIP, fully quit Discord (including its tray icon),
then double-click Install.cmd. Restart Discord and open Settings > Protonn Cord.
Node.js, pnpm, Git and a source checkout are not needed.
To remove the mod, quit Discord and double-click Uninstall.cmd.
For Discord PTB or Canary, run Install.cmd -DiscordBranch ptb (or canary).
The unsigned installer may trigger Windows SmartScreen. Verify SHA256SUMS
against the release download before deciding to run it.

Linux x86-64: extract the entire ZIP, quit Discord, then run:
  bash install.sh
If your Discord installation needs administrator access, run the same command
with sudo while setting PROTONN_CORD_INSTALL_DIR to a directory your normal
Discord user can read and write. Snap installations are not supported.
To remove the mod: bash install.sh uninstall
For PTB or Canary: bash install.sh install --branch ptb (or canary).

Keep the extracted files together. After installation the application payload is
copied into your ProtonnCord configuration directory, so the extracted download
can be removed. Uninstall preserves your settings. Discord updates may require
running the installer again. Protonn Cord's built-in updater remains enabled.

This is a modification of an existing Discord desktop installation. Discord must
already be installed. No Discord account, settings, tokens or identity backups
are included in this archive. The installer does not need your Discord password.

This release includes unmodified Equilotl binaries, verified by exact size and
SHA-256 during packaging. The launchers install the bundled Protonn Cord build.
See THIRD-PARTY.txt, LICENSE and the source archives attached to this release.
