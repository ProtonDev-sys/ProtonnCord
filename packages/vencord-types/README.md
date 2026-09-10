# Protonn Cord types

This directory generates declarations from the current Protonn Cord checkout. It retains the upstream package name `@equicord/types`; an existing registry release may describe a different revision from this fork.

Generate, check and pack the declarations from the repository root:

```shell
pnpm generateTypes
pnpm --dir packages/vencord-types test
pnpm --dir packages/vencord-types pack
```

The archive can be used by local consumers. Check that it contains the generated API declarations, their dependencies and the license. Generation follows the public API entry points and runs `prepare.ts`; do not run that script separately.

If the Discord declarations changed, first bump and publish their version with `pnpm --dir packages/discord-types publish`. Then bump this package's version, rerun the commands above and inspect the archive before publishing:

```sh
pnpm --dir packages/vencord-types publish
```

Use pnpm for packing and publishing: it converts the workspace dependency into an npm alias for the matching `@equicord/discord-types` version. The `prepublishOnly` hook regenerates and tests the declarations.

Licensed under [GPL-3.0-or-later](https://github.com/ProtonDev-sys/ProtonnCord/blob/main/LICENSE).
