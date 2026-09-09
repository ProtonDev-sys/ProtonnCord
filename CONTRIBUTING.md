# Contributing

Submit Protonn Cord issues and pull requests to [ProtonDev-sys/ProtonnCord](https://github.com/ProtonDev-sys/ProtonnCord). Use the branch intended for the change and keep each PR focused on one problem.

Preserve useful features, saved preferences and upstream attribution. Explain migrations, new dependencies and any data sent to external services. Follow the [Code of Conduct](CODE_OF_CONDUCT.md); the code map and implementation rules are in [AGENTS.md](AGENTS.md).

Follow the [setup instructions](README.md), then run the relevant tests. For a broad desktop change:

```sh
pnpm build
pnpm test
```

Browser, public API and Android changes also need their own builds/type checks. Test and build commands live in the package files and [mobile guide](mobile/README.md). `pnpm test` can change formatting; review its diff.

Describe the final behavior and checks in the PR. Add screenshots when they help review UI changes. Distinguish mocked tests from live client/device testing. Live tests must use their documented disposable data and authorized destinations.
