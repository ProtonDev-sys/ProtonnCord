# Contributing to Protonn Cord

Protonn Cord is a fork of Equicord and Vencord. Report issues and submit changes to [ProtonDev-sys/ProtonnCord](https://github.com/ProtonDev-sys/ProtonnCord). Their communities and contribution policies are separate; do not send Protonn Cord-specific support requests upstream.

Follow the [Code of Conduct](./CODE_OF_CONDUCT.md), preserve upstream attribution and license headers, and read [AGENTS.md](./AGENTS.md) for the runtime map and local development conventions. The upstream [Equicord documentation](https://docs.equicord.org) provides background on plugin development; check the implementations in this repository for the APIs available here.

Before a major change, describe the problem, intended behavior, and compatibility impact in an issue or pull request. Target the branch the change is intended to update (`main`, `staging`, or `nightly`) and state that choice in the pull request. Avoid mixing unrelated fixes.

## Plugins and runtime changes

- Use `definePlugin`, the declarative plugin APIs, and the required API dependencies.
- Keep settings and useful features compatible. If a stored format changes, provide a tested migration. The [rewrite acceptance contract](./docs/rewrite-acceptance.md) describes the catalog and data guarantees.
- Clean up timers, subscriptions, listeners, and pending work when a plugin stops or a component unmounts.
- Keep filesystem, subprocess, and privileged network operations in native modules, with validation at the renderer boundary.
- Explain new dependencies and external services, including what data the feature sends to them.
- Do not introduce API abuse or features that automate abusive behavior.

## Validation and review

Use the Node requirement and pinned pnpm version in `package.json`. Start with the checks relevant to the changed behavior. For the complete non-live gate, run:

```shell
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The broad gate can modify source formatting, plugin metadata, and build outputs; inspect the resulting diff. Browser and public API changes also need the relevant browser build or generated type checks described in [AGENTS.md](./AGENTS.md).

Describe the final behavior, validation results, and unresolved limitations in the pull request. Include screenshots for visible UI changes when useful. Review all submitted code and documentation, including tool-generated changes. Live checks are separate from the broad gate and require an explicitly authorized test destination.
