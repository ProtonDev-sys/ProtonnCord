# Protonn Cord

Discord client mod based on Equicord/Vencord, with an Android Secure Messaging companion in `mobile/`. Preserve upstream attribution and license headers.

## Code map

- `src/runtime`: renderer startup and services; keep the first `~plugins` import in `src/Vencord.ts`.
- `src/api/PluginManager.ts` and `src/api/pluginManager`: plugin lifecycle and paired registration/cleanup.
- `src/shared/SettingsStore.ts` and `settingsPersistence.ts`: stable settings proxies, notifications and serialized saves.
- `scripts/build/pluginManifest.mjs` and `pluginNatives.mjs`: conservative lazy loading; preserve side effects, IPC names and module identity.
- `src/webpack`: host module lookup and patching. Check current implementations and callers before changing compatibility code.

## Changes

Preserve plugin IDs, enabled states, favorites and unknown saved fields. Storage changes need migration and failure/retry coverage. `scripts/fixtures/plugin-catalog-baseline.json` is a compatibility fixture; do not regenerate it to hide removals.

Prefer the smallest maintainable change. Remove duplicate or dead logic when behavior is preserved; share existing repeated code instead of adding speculative layers. Keep production and test-code growth visible in review.

Use existing APIs and dispose listeners, timers, media tracks and pending work on stop/unmount. Keep privileged work in native modules and validate renderer arguments there. For encryption or pairing changes, read the desktop Secure Messaging and mobile READMEs; preserve trust review, history and fail-closed behavior.

Check the branch/worktree before editing. Keep task notes and review ledgers outside the submitted tree. Put concise validation results in the PR.

## Verification

Use the versions and commands in `package.json`, `mobile/toolchain.json` and the READMEs. Run checks for the changed behavior; documentation edits need reference checks, not a new performance benchmark. Broad desktop validation is `pnpm build` then `pnpm test`; mobile has its own tests, types and native build. Review formatter changes.

Build previews in an isolated checkout or `--outdir`; `--dev` uses separate data and disables updates. Live tests require their documented profile/destination conditions and may change real account state. Report what ran and what remains unverified.

Keep coding-model selection in the client configuration. Use current [Codex model guidance](https://learn.chatgpt.com/docs/models) when selecting a model; this repository does not override the session's choice.
