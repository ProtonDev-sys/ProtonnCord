# Protonn Cord

Discord client mod forked from Equicord and Vencord. Preserve upstream attribution and existing license headers.

## Runtime map

- Read `docs/rewrite-acceptance.md` for feature/data compatibility. Layouts and internal formats can change; preserve preferences through tested migrations. The catalog baseline protects existing identifiers; never regenerate it to hide a regression.
- `src/Vencord.ts` is the public renderer entry. Keep its first `~plugins` import ordering; runtime startup/services live in `src/runtime`.
- `src/api/PluginManager.ts` coordinates plugins. `src/api/pluginManager` pairs declarative registrations with cleanup; add both sides there and test partial failure/repeated start-stop.
- `scripts/build/pluginManifest.mjs` generates metadata for the lazy renderer catalog. `src/shared/pluginDefinition.ts` preserves definition identity; uncertain metadata, change callbacks, and startup side effects require eager loading. Never evaluate visibility getters during catalog construction.
- `src/shared/SettingsStore.ts` owns synchronous settings notifications and stable proxies. Persistence is separate in `settingsPersistence.ts`; restart/reload must await pending saves.
- `src/webpack/subscriptions.ts` dispatches pending module lookups. Keep caches local to one dispatch so circular imports can become available later.
- Native plugin methods are discovered at build time. Only reviewed modules in `scripts/build/pluginNatives.mjs` may load on demand; recheck startup effects when editing them. Keep IPC names and main-process singleton identity.

## Project conventions

- Follow nearby code and the repository's lint/type configuration. Keep changes focused on the requested behavior.
- Plugins live in `src/plugins`, `src/equicordplugins`, and `src/userplugins`. Use `definePlugin` and the existing declarative plugin APIs; register required API dependencies.
- Reuse `@api`, `@utils`, `@components`, and `@webpack/common`. Read their implementations and types when needed instead of relying on a fixed API list.
- Discord stores are the source of truth. Use `useStateFromStores` for reactive UI and clean up subscriptions, timers, and other resources on stop or unmount.
- Use lazy webpack lookups where modules may not yet be available. Anchor patches to stable identifiers; use `\i` for minified identifiers and avoid hardcoded mangled CSS classes.
- Persist plugin settings through the settings API and other persistent data through `DataStore`.
- Keep filesystem, subprocess, and privileged network work in the main process or plugin `native.ts`. Validate renderer-supplied arguments at that boundary.
- For Secure Messaging changes, read `src/equicordplugins/secureMessaging.desktop/README.md` and run the relevant protocol/native tests. Never log secrets or plaintext messages.

## Build and validation

- Use the Node requirement and pinned pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile` when needed.
- Choose relevant tests from `package.json` and `scripts/`. Run type checks or builds when the change affects them; documentation-only edits need no build.
- Runtime changes must pass the catalog, lifecycle, settings persistence, native loader, and webpack subscription tests. Record measured workload and limits for performance claims.
- `pnpm test` is the broad gate and includes commands that modify files. Review the resulting diff.
- `pnpm build` produces the normal local installation. `pnpm build --dev` disables the updater and uses separate development data.
- Use `pnpm build --outdir=<directory>` for isolated desktop build checks. An unpublished preview can use `--disable-updater` while retaining the normal profile.
- Standalone builds share the local output paths. After standalone validation, restore `pnpm build` if this checkout supplies the running Discord installation.
- Live tests may send or delete real Discord messages. Read their documented requirements and use only a user-authorized test destination.

## Local checkout

- Check the current branch and worktree before editing; the directory name does not necessarily match the branch. Preserve unrelated changes and leave other worktrees alone unless the task includes them.
- The source updater requires a clean worktree. Do not discard edits to make updates pass; preserve them in a commit or an explicitly requested stash.
