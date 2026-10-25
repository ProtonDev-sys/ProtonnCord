/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    getReleaseNewPlugins,
    NEW_PLUGIN_RELEASE,
} from "../src/components/settings/tabs/plugins/newPluginRelease";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(NEW_PLUGIN_RELEASE.version, packageJson.version, "the New marker manifest must be updated with every version bump");
assert.equal(
    getReleaseNewPlugins(packageJson.version, ["AutoJumpToMessage", "WebPWA", "SecureMessaging"]),
    null,
    "a patch release must not keep the previous release's New markers",
);
assert.equal(
    getReleaseNewPlugins("1.15.1.1", ["AutoJumpToMessage", "WebPWA"]),
    null,
    "New markers must disappear as soon as the release version is bumped",
);
assert.equal(
    getReleaseNewPlugins("1.15.1.9", ["AutoJumpToMessage"]),
    null,
    "versions without an explicit release manifest must not create phantom cards",
);

console.log("release-scoped plugin New marker checks passed");
