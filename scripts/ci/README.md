# Independent CI and releases

GitHub hosts the source, commit statuses, and release downloads. GitHub Actions is disabled. A Windows Scheduled Task wakes WSL and runs `worker.mjs` under `flock`; `windows-agent.ps1` handles native installer requests while the Linux job runs. Set the task to repeat every two minutes, start at boot, hide its window, and ignore overlapping starts.

The worker watches main, staging, nightly, and same-repository pull requests authored by the repository owner. Public forks and other authors are not executed on the private build PC. Each job has an exact source SHA, its own checkout, durable run ID, log, and result. A failure stays failed until an explicit `--retry`; successful jobs are not repeated. Commit statuses use `other-pc/ci/<branch-or-pr>` and `other-pc/release/<branch>`.

`desktop.sh validate` installs the frozen dependencies, checks repository privacy, builds standalone desktop and browser artifacts, runs `pnpm test`, checks generated API types, and prepares the release files. Nightly also runs `mobile.sh build`. The controller publishes only after these steps pass and the branch still points to the tested SHA. Publishing credentials never enter the test process; run builds as a separate unprivileged account with its own home and caches.

The existing atomic desktop release helper and immutable installer publishers remain in use. Browser archives are built once and archived durably; browser-store publication requires its own configured credentials. Android uses the existing production signing identity. No new signing identity is generated. Windows setup is compiled without opening its GUI or modifying a Discord installation. Native installer GUI and signed-out client tests remain available for explicitly requested disposable-environment checks.

Nightly promotion retains its three-hour soak. Arrival time is the first observation of a new nightly SHA in the local journal. Only a successfully published nightly revision advances to staging; staging must then pass and publish its own exact merge SHA before main advances. Missing evidence and failed releases block promotion.

Keep hostnames, local paths, and credentials outside this repository. Install a reviewed copy of the controller scripts into an administrator-owned directory; do not run the controller directly from a build-writable checkout. Reinstall this reviewed controller snapshot when changing its code.

Linux controller configuration (`PROTONN_CI_CONFIG` points to a private JSON file):

```json
{
  "stateRoot": "/path/to/private/controller-state",
  "workRoot": "/path/to/build-workspaces",
  "buildUser": "ci-build-user",
  "buildHome": "/path/to/build-home",
  "buildPath": "/path/to/pinned/tools:/usr/local/bin:/usr/bin:/bin",
  "buildEnv": { "JAVA_HOME": "/path/to/jdk", "ANDROID_HOME": "/path/to/android-sdk" },
  "windowsInbox": "/mnt/c/path/to/requests",
  "windowsOutput": "/mnt/c/path/to/windows-artifacts",
  "publish": true,
  "promote": true
}
```

Use the machine's existing `gh` authentication for controller requests. Keep Android signing files and browser-store credentials in private host configuration, outside all checkouts. Never put a GitHub publishing token in `buildEnv`. Pin pnpm from `package.json` and mobile tools from `mobile/toolchain.json`.

Windows dispatcher configuration has `Inbox`, `WorkRoot`, `OutputRoot`, `WindowsScript`, `Distribution`, `LinuxUser`, `LinuxConfig`, `LinuxController`, and `LinuxLock` absolute paths/names. The inbox and output directories refer to the same NTFS locations used by the Linux configuration. The scheduled action is `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File <installed-windows-agent.ps1> -Config <private-config.json>`.

Run one pass or retry a failed revision:

```sh
PROTONN_CI_CONFIG=/path/to/config.json flock -n /path/to/worker.lock node /installed/scripts/ci/worker.mjs
PROTONN_CI_CONFIG=/path/to/config.json flock -n /path/to/worker.lock node /installed/scripts/ci/worker.mjs --only=nightly --retry
```

Read `state.json` and the `<branch>-<sha>.log` files in the controller state directory to diagnose failures. To retry a failed Windows build, remove only that run's `result.json` before retrying the controller. To validate without publishing, set `publish` and `promote` to false. Dependency audits, account-dependent live tests, interactive installer checks, and timing-only benchmarks are maintenance commands rather than repeated commit gates.
