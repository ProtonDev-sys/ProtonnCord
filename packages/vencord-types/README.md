# Protonn Cord Types

This directory generates declarations from the current Protonn Cord checkout. It retains the upstream package name `@equicord/types`; an existing registry release may describe a different revision from this fork.

Generate and check the declarations from the repository root:

```shell
pnpm generateTypes
pnpm --dir packages/vencord-types test
```

Use `pnpm --dir packages/vencord-types pack` to create an archive of these declarations for local consumers. See [HOW2PUB.md](./HOW2PUB.md) for the publication workflow.
