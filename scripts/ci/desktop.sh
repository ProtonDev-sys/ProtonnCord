#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

mode=${1:-validate}
[[ "$mode" == validate || "$mode" == release ]] || { echo 'Expected validate or release' >&2; exit 1; }
[[ ${PROTONN_CORD_BUILD_CHANNEL:-} =~ ^(main|staging|nightly)$ ]]
[[ $(git rev-parse HEAD) == "${GITHUB_SHA:?Exact source revision required}" ]]
export CI=true
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)

if [[ "$mode" == validate ]]; then
    # The controller runs this stage as a separate user without publishing credentials.
    [[ -z ${GH_TOKEN:-}${GITHUB_TOKEN:-} ]] || { echo 'Builds must not receive publishing credentials' >&2; exit 1; }
    pnpm install --frozen-lockfile
    pnpm checkPrivacy
    pnpm buildStandalone
    IFS=: read -r -a electron_binaries <<< "${PROTONN_CI_ELECTRON_BINS:?Configure pinned Electron runtimes on the build host}"
    for electron in "${electron_binaries[@]}"; do
        [[ -x "$electron" ]]
        ELECTRON_BIN="$electron" xvfb-run -a node scripts/testElectronIpc.mjs
    done
    PROTONN_CI_NATIVE_NETNS=1 pnpm test
    pnpm buildWebStandalone
    pnpm generateTypes
    pnpm --dir packages/vencord-types test
    pnpm generatePluginJson dist/plugins.json
    pnpm generateEquicordPluginJson dist/equicordplugins.json
    pnpm generateVencordPluginJson dist/vencordplugins.json
    pnpm generateDevsList dist/devs.json
    git archive --format=zip --output=dist/extension-sources.zip HEAD
    printf '%s\n' "$GITHUB_SHA" > dist/release-sha.txt
    (cd dist && sha256sum extension-chrome.zip extension-firefox.zip extension-sources.zip > archives.sha256)
    if [[ "$PROTONN_CORD_BUILD_CHANNEL" == main ]]; then
        pnpm packageRelease
        pnpm testPublicRelease
    fi
    node --input-type=module <<'JS'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
const output = 'dist/release';
await mkdir(output, { recursive: true });
async function collect(directory, rename = name => name, filter = () => true) {
    for (const name of await readdir(directory)) {
        const path = `${directory}/${name}`;
        if (!filter(name) || name.endsWith('.map') || name === 'package.json') continue;
        const entry = await stat(path);
        if (entry.isFile() && entry.size) await copyFile(path, `${output}/${rename(name)}`);
    }
}
await collect('dist', n => n, n => /\.(json|zip|asar)$/.test(n) || /^ProtonnCord\.user\.(js|js\.LEGAL\.txt)$/.test(n));
await collect('dist/browser', n => n, n => n.startsWith('browser.'));
await collect('dist/desktop');
await collect('dist/equibop', n => `equibop${n[0].toUpperCase()}${n.slice(1)}`);
if (process.env.PROTONN_CORD_BUILD_CHANNEL === 'main') await collect('dist/public-release');
JS
elif [[ "$mode" == release ]]; then
    [[ -n ${GITHUB_TOKEN:-} ]] || { echo 'Publishing credential required' >&2; exit 1; }
    node scripts/releaseUpdateChannel.mjs
    if [[ "$PROTONN_CORD_BUILD_CHANNEL" == main ]]; then
        retry_flags=()
        [[ ${PROTONN_CI_RETRY:-0} != 1 ]] || retry_flags+=(--recover-if-matching)
        node scripts/ci/publish-browser.mjs --sha "$GITHUB_SHA" --store "${PROTONN_CI_BROWSER_STORES:-all}" "${retry_flags[@]}"
    fi
fi
