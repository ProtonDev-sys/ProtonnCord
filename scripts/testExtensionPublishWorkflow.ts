/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

assert.equal(existsSync(".github/workflows/publish.yml"), false, "extension-store publishing remains removed");
for (const name of readdirSync(".github/workflows")) {
    const workflow = readFileSync(`.github/workflows/${name}`, "utf8");
    assert.doesNotMatch(workflow, /publish-extension|secrets\.(?:CHROME|FIREFOX|EDGE)_/u, `${name} must not publish to extension stores`);
}
assert.doesNotMatch(readFileSync("scripts/promoteChannels.mjs", "utf8"), /publish\.yml/u, "promotion must not dispatch or wait for store publishing");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(packageJson.devDependencies["@equicord/publish-browser-extension"], undefined, "the unused store publisher is removed");
assert.doesNotMatch(readFileSync("pnpm-lock.yaml", "utf8"), /@equicord\/publish-browser-extension/u);
assert.ok(packageJson.scripts.buildWeb && packageJson.scripts.buildWebStandalone, "browser builds remain available");

console.log("extension-store publishing removal checks passed");
