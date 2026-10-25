#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Called by mobile.sh only after the controller's exact-SHA validation gate.
set -euo pipefail
set +x
[[ ${GITHUB_REPOSITORY:-} == ProtonDev-sys/ProtonnCord && ${PROTONN_CORD_BUILD_CHANNEL:-} == nightly ]] || { echo 'Mobile publication requires the canonical nightly channel.' >&2; exit 1; }
tag=$(python3 -B mobile/tools/validate_release.py mobile/build/dist)
# Keep the original build attempt returned by validation on publish-only retries.
exec node scripts/ci/publish-mobile.mjs "$tag"
