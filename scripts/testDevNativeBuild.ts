/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BUILD_SCRIPT = "scripts/build/build.mjs";
const OUTPUTS = [
    ["dist/desktop/patcher.js", "dist/desktop/patcher.js.map"],
    ["dist/equibop/main.js", "dist/equibop/main.js.map"],
] as const;
const DEV_NATIVE = "src/equicordplugins/userpluginInstaller.dev/native.ts";

function build(dev = false) {
    execFileSync(process.execPath, [BUILD_SCRIPT, "--standalone", ...dev ? ["--dev"] : []], { stdio: "inherit" });
}

function normalizedSources(sourceMapPath: string): string[] {
    const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8")) as { sources: string[]; };
    return sourceMap.sources.map(source => source.replaceAll("\\", "/"));
}

try {
    build(true);

    for (const [bundlePath, sourceMapPath] of OUTPUTS) {
        const bundle = readFileSync(bundlePath, "utf8");
        const sources = normalizedSources(sourceMapPath);
        assert.ok(sources.some(source => source.endsWith(DEV_NATIVE)), `${bundlePath} must include development natives in a development build`);
        assert.ok(bundle.includes("UserpluginInstaller"), `${bundlePath} must register development natives in a development build`);
    }
} finally {
    build();
}

for (const [bundlePath, sourceMapPath] of OUTPUTS) {
    const bundle = readFileSync(bundlePath, "utf8");
    const sources = normalizedSources(sourceMapPath);
    assert.match(bundle, /\/\/ Development: false/u, `${bundlePath} must be a production build`);
    assert.equal(sources.some(source => /\/[^/]+\.dev\/native(?:\/index)?\.ts$/u.test(source)), false, `${bundlePath} must exclude every development native`);
    assert.equal(bundle.includes("UserpluginInstaller"), false, `${bundlePath} must not register UserpluginInstaller in production`);
}

console.log("development native build filtering checks passed");
