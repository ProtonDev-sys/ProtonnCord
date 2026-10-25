#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Called by mobile.sh only after the controller's exact-SHA validation gate.
set -euo pipefail
set +x
[[ ${GITHUB_REPOSITORY:-} == ProtonDev-sys/ProtonnCord && ${PROTONN_CORD_BUILD_CHANNEL:-} == nightly ]] || { echo 'Mobile publication requires the canonical nightly channel.' >&2; exit 1; }
dist=mobile/build/dist
tag=$(python3 -B mobile/tools/validate_release.py "$dist")
# An existing immutable build aborts. A rebuilt job needs a new stable local job ID.
gh release create "$tag" "$dist"/* --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --prerelease \
    --title "Mobile nightly $GITHUB_SHA" --notes "Android Secure Messaging built and tested against desktop revision $GITHUB_SHA."
runtime=$(node -p 'require("./mobile/toolchain.json").runtimeRelease')
if ! gh release view "$runtime" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    gh release create "$runtime" "$dist/revenge.bundle" "$dist/revenge-runtime-source.zip" "$dist/REVENGE-LICENSE" "$dist/toolchain.json" \
        --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --prerelease --title 'Pinned Revenge Next runtime for ProtonnCord Mobile' \
        --notes 'Revenge runtime, corresponding upstream source, and license. Runtime updates are pinned separately from plugin updates.'
fi
head=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/nightly" --jq '.object.type + " " + .object.sha')
if [[ "$head" != "commit $GITHUB_SHA" ]]; then
    echo 'A newer nightly commit exists; leaving its channel pointer intact.'
    exit 0
fi
if ! gh release view mobile-nightly --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    gh release create mobile-nightly --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --prerelease --title 'ProtonnCord Mobile nightly' \
        --notes 'Add this release download root as a Revenge plugin repository. Each index points to immutable, checksummed build assets.'
fi
gh release upload mobile-nightly "$dist/index.json" --repo "$GITHUB_REPOSITORY" --clobber
gh api --method PATCH "repos/$GITHUB_REPOSITORY/git/refs/tags/mobile-nightly" --field "sha=$GITHUB_SHA" --field force=true
[[ "$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/mobile-nightly" --jq '.object.type + " " + .object.sha')" == "commit $GITHUB_SHA" ]] || { echo 'The mobile-nightly tag did not advance to the published build.' >&2; exit 1; }
