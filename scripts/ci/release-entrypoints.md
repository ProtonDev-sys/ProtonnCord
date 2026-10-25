# Local release entrypoints

The controller serializes publication and runs the full validation gate for the
exact job SHA. These entrypoints neither query Actions nor impersonate a hosted
runner. Keep host paths, task definitions and credentials outside the repository.

## Windows packaging

Invoke `windows.ps1` from an unattended native Windows process with:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/ci/windows.ps1 -Checkout $jobCheckout -Sha $validatedSha -PayloadSha256 $wslPayloadHash -OutputDirectory $jobArtifacts
```

`Checkout` is an absolute, dedicated native Windows checkout at `Sha`, with clean
tracked source. Transfer the validated standalone nightly `dist/desktop.asar`
from WSL. Supply its WSL-produced SHA-256 through `PayloadSha256`, or transfer
`dist/desktop.asar.sha256` containing `<hash>  desktop.asar` and a final LF.
Do not reuse WSL `node_modules` on Windows.

Install native Windows Node 24, Git and the x64 .NET Framework C# compiler on the
host beforehand. Job dependencies must already be installed from the frozen
lockfile, or opt into `-InstallDependencies` with the `package.json` pnpm version
available. That switch runs `pnpm install --frozen-lockfile --ignore-scripts` in
the job checkout. All packaging subprocesses run without inherited credentials;
the entrypoint rejects credential environment variables before launching them.

`dist/windows` must not exist before packaging. The entrypoint verifies the
payload, executable, metadata, pinned installer identity, bootstrap, license and
checksums. Optional `OutputDirectory` must be an absolute, nonexistent directory
outside the checkout; complete outputs are copied there atomically. Without it,
outputs remain in `dist/windows`. An existing destination is an error. Preserve
the job's exit status; partial output is never success. The controller owns
retention and cleanup of failed jobs.

No installer is executed, and no Discord process is closed. GUI smoke and the
public-release Windows installer smoke must not run on a live user's PC.
`windows-build.json` explicitly records that installer smoke was not run.
For publication, copy the verified output to the controller's exact-SHA checkout
at `dist/windows`, then invoke the existing `publishWindowsInstaller.mjs` only
after validation with its canonical nightly repository, exact SHA, stable numeric
local job ID/attempt and GitHub token. Those identity fields name local builds.

## Browser publication

After validating a `main` job, from its clean repository root run:

```sh
PROTONN_CORD_BUILD_CHANNEL=main node scripts/ci/publish-browser.mjs --sha "$validated_sha"
```

`desktop.sh` supplies `dist/extension-chrome.zip`, `extension-firefox.zip`,
`extension-sources.zip`, `archives.sha256` and `release-sha.txt`. The checksums
must list the three ZIPs in that order; `release-sha.txt` contains the exact SHA
and a final LF. `--archives` selects another input directory. This helper never
rebuilds archives or installs dependencies. GitHub authentication uses the
controller's `gh` login or a publication-only `GH_TOKEN`/`GITHUB_TOKEN`.

A newer numeric package version persists the five immutable files in the draft
GitHub release `browser-extension-v<version>` and downloads them again for
verification before creating `v<version>`.
Every remote write and store submission checks that `main` still names the job
SHA. Existing version tags must name that same SHA. A superseded build fails
without advancing publication. The controller must hold its release lock across
the entire operation.

Store publication is optional. With `--store all` (default), absent credentials
skip that store; incomplete credentials fail after preserving durable archives.
`--store none` only persists archives and the version tag. Credentials are:

| Store | Required environment variables |
| --- | --- |
| Chrome | `CHROME_EXTENSION_ID`, `CHROME_PUBLISHER_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` |
| Firefox | `FIREFOX_EXTENSION_ID`, `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET` |
| Edge | `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` |

Prepare the exact locked `@equicord/publish-browser-extension` dependency during
the credential-free desktop dependency setup. Each store process receives only
its own store credentials, without GitHub tokens, and runs in a fresh temporary
working directory to avoid loading `.env.submit` from the checkout. Provider
response output is suppressed because errors may contain request headers.

After a failed submission, use `--retry --store firefox` (or `chrome`/`edge`) to
retry only that store. Completed archive sets are always downloaded and verified,
regardless of local build output. If an interrupted upload left an untagged draft
at this exact SHA, retain the original five local files: recovery checks existing
uploaded bytes against them, removes only empty failed-upload placeholders, and
uploads missing files without replacing existing assets. It verifies the complete
remote set before tagging. No archive is rebuilt. Retry refuses mismatched SHA,
older versions and a moved `main`. Keep the same validated SHA and existing
version tag; never delete a tag or replace uploaded release assets to retry.
