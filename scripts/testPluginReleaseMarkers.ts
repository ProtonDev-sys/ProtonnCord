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
assert.deepEqual(
    [...getReleaseNewPlugins(packageJson.version, ["AutoJumpToMessage", "WebPWA", "SecureMessaging"])!].sort(),
    ["AutoJumpToMessage", "WebPWA"],
);
assert.equal(getReleaseNewPlugins("1.15.1.2", ["AutoJumpToMessage", "WebPWA"]), null,
    "New markers must disappear as soon as the release version is bumped");
assert.deepEqual([...getReleaseNewPlugins(packageJson.version, ["AutoJumpToMessage"])!], ["AutoJumpToMessage"],
    "plugins excluded from the current client target must not create phantom cards");

const pluginSettings = readFileSync(new URL(
    "../src/components/settings/tabs/plugins/index.tsx",
    import.meta.url,
), "utf8");
assert.doesNotMatch(pluginSettings, /Vencord_existingPlugins|60\s*\*\s*60\s*\*\s*24\s*\*\s*2/u,
    "the old time-based New marker cache must not return");
assert.match(pluginSettings, /getReleaseNewPlugins\(VERSION/u);
assert.match(readFileSync(new URL(
    "../src/equicordplugins/autoJumpToMessage/index.ts",
    import.meta.url,
), "utf8"), /name:\s*"AutoJumpToMessage"/u);
assert.match(readFileSync(new URL(
    "../src/plugins/webPWA.browser/index.tsx",
    import.meta.url,
), "utf8"), /name:\s*"WebPWA"/u);

console.log("release-scoped plugin New marker checks passed");
