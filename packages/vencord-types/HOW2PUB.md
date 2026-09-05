# How to publish

Run these commands from the repository root.

1. If the Discord declarations changed, bump `packages/discord-types/package.json` and publish that matching revision first.
2. Bump `packages/vencord-types/package.json`.
3. Run `pnpm generateTypes` and `pnpm --dir packages/vencord-types test`.
4. Inspect `pnpm --dir packages/vencord-types pack`. The archive must include the generated API declarations, their dependencies and the license.
5. Run `pnpm --dir packages/vencord-types publish`. Its prepublish hook regenerates and checks the package.

Use pnpm to pack and publish so the workspace dependency becomes an npm alias for the matching `@equicord/discord-types` version. Generation follows the public API entry points and prepares their declarations; do not run `prepare.ts` separately.
