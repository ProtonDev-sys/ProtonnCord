# Independent CI and releases

GitHub hosts the source, commit statuses, and release downloads. GitHub Actions is disabled. A Windows Scheduled Task wakes WSL and runs `worker.mjs` under `flock`; `windows-agent.ps1` handles native installer requests while the Linux job runs. Set the dispatcher task to repeat every two minutes, start at boot and controller logon, hide its window, and ignore overlapping starts.

The worker watches main, staging, nightly, and same-repository pull requests authored by the repository owner. Public forks and other authors are not executed on the private build PC. Each job has an exact source SHA, its own checkout, durable run ID, log, and result. A failure stays failed until an explicit `--retry`; successful jobs are not repeated. Commit statuses use `other-pc/ci/<branch-or-pr>` and `other-pc/release/<branch>`.

`desktop.sh validate` installs the frozen dependencies, checks repository privacy, builds standalone desktop and browser artifacts, checks actual Electron IPC against the configured pinned runtimes, runs `pnpm test`, checks generated API types, and prepares the release files. Set `PROTONN_CI_ELECTRON_BINS` to their executable paths separated by colons. Nightly also runs `mobile.sh build` and packages Windows setup under a separate native build account. All required builds finish before publication begins. The controller publishes only after these steps pass and the branch still points to the tested SHA.

Publishing credentials never enter the test process. Linux builds run as a separate unprivileged account inside Bubblewrap, with Windows mounts, WSL control sockets and controller home directories hidden. The build home is writable; the SDK and system tools are read-only. After validation, the controller fetches clean publication source independently into a private directory and copies only inert build artifacts through checked file handles, recording their hashes. Build-writable scripts and dependencies never run with publishing credentials. Retries verify that protected artifact evidence; failed or interrupted validation uses a fresh attempt directory.

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
  "buildEnv": {
    "JAVA_HOME": "/path/to/jdk-21",
    "ANDROID_HOME": "/path/to/android-sdk",
    "CHROMIUM_BIN": "/path/to/pinned/chrome",
    "PROTONN_CI_ELECTRON_BINS": "/path/to/electron-41:/path/to/electron-42",
    "PROTONN_CORD_ANDROID_SIGNING_DIR": "/path/to/private/signing",
    "ANDROID_SIGNER_SHA256": "configured-certificate-sha256"
  },
  "windowsInbox": "/mnt/c/path/to/requests",
  "windowsOutput": "/mnt/c/path/to/windows-artifacts",
  "publish": true,
  "promote": true
}
```

Use the machine's existing `gh` authentication for controller requests. Keep Android signing files and browser-store credentials in private host configuration, outside all checkouts. Never put a GitHub publishing token in `buildEnv`. Pin pnpm from `package.json` and mobile tools from `mobile/toolchain.json`.

Windows dispatcher configuration has `Inbox`, `WorkRoot`, `OutputRoot`, `WindowsScript`, `ToolsPath`, `BuildTask`, `BuildSid`, `Distribution`, `LinuxUser`, `LinuxConfig`, `LinuxController`, and `LinuxLock` absolute paths/names. `ToolsPath` is the semicolon-separated pinned Node/Corepack tool directories. The inbox and output directories refer to the same NTFS locations used by the Linux configuration. The scheduled action is `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File <installed-windows-agent.ps1> -Config <private-config.json>`.

Create a separate native Windows local build account with only standard Users membership, its own profile and caches, and no registered WSL distributions. Grant it the local "Log on as a batch job" right, preserving existing entries. Never run source checkout, dependency installation, or packaging under the dispatcher identity. Register an additional hidden, on-demand task named by `BuildTask`, using password/batch logon for this build account with limited privileges and `IgnoreNew`. Its action is `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File <installed-windows-job.ps1> -DispatchFile <Inbox>/native-job.json`, with no recurring trigger. Generate its random password locally; retain it only as a LocalMachine DPAPI-protected file in controller-only storage if needed for task reinstallation. Do not put passwords in task arguments, environment variables, logs, or this repository. The dispatcher uses Task Scheduler to start this task; it does not decrypt a password or inherit its environment into the native build.

Protect the installed scripts and pinned tools against writes by the build account. Grant the builder read/execute access to those files and the inbox, modify access to the native work/output directories, and no access to private controller configuration, credentials, logs, or the controller's Windows profile. Only the controller writes inbox requests, the active native dispatch file, and `result.json`. Verify these ACLs from an actual batch logon as the builder. Its Windows identity must differ from the account owning the controller's WSL registration. The wrapper checks its SID and rejects Administrators membership before cloning or executing source. Linux workloads also need an isolation boundary that prevents access through WSL interop or mounted Windows files to the Windows controller's identity and private storage; a separate Linux UID alone does not provide that boundary.

Register the repeating dispatcher under the Windows identity owning the controller's WSL distribution, using a background S4U logon, limited privileges, `Hidden`, `IgnoreNew`, startup/logon triggers, and indefinite two-minute repetition. Allow runs on battery and remove the dispatcher execution time limit so long Linux validations can finish. The dispatcher stops native work after 25 minutes, before the controller's 30-minute receipt timeout, and writes a failure receipt; optional `NativeTimeoutSeconds` can shorten this deadline (1–1500 seconds). Verify that this identity can start the on-demand build task. `flock -E 75` identifies lock contention as a successful no-op while other WSL failures retain their exit code. Native transcripts are retained beside their per-run checkout as `<WorkRoot>/<runId>.log`. The dispatcher waits for that task's new invocation and exit status before writing the receipt; the Linux controller independently verifies its output files before publication. Optional `LogRoot` keeps private dispatcher and WSL startup logs.

Run one pass or retry a failed revision:

```sh
PROTONN_CI_CONFIG=/path/to/config.json flock -n /path/to/worker.lock node /installed/scripts/ci/worker.mjs
PROTONN_CI_CONFIG=/path/to/config.json flock -n /path/to/worker.lock node /installed/scripts/ci/worker.mjs --only=nightly --retry
```

Read `state.json` and the `<branch>-<sha>.log` files in the controller state directory to diagnose failures. Retry failed Windows builds with a fresh run ID and new work/output paths; the native wrapper rejects existing attempt directories and retains failures for diagnosis. To validate without publishing, set `publish` and `promote` to false. Dependency audits, account-dependent live tests, interactive installer checks, and timing-only benchmarks are maintenance commands rather than repeated commit gates.
