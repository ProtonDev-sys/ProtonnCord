/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUILD_SCRIPT = "scripts/build/build.mjs";
const OUTPUT_DIRECTORY = mkdtempSync(join(tmpdir(), "protonncord-native-build-"));
const OUTPUTS = [
    [join(OUTPUT_DIRECTORY, "desktop/patcher.js"), join(OUTPUT_DIRECTORY, "desktop/patcher.js.map")],
    [join(OUTPUT_DIRECTORY, "equibop/main.js"), join(OUTPUT_DIRECTORY, "equibop/main.js.map")],
] as const;
const DEV_NATIVE = "src/equicordplugins/userpluginInstaller.dev/native.ts";

function installedBuildHashes() {
    const paths = ["dist/desktop.asar", "dist/equibop.asar"];
    for (const [host, main] of [["desktop", "patcher"], ["equibop", "main"]]) {
        paths.push(join("dist", host, "package.json"));
        for (const name of [main, "preload", "renderer"]) {
            for (const extension of [".js", ".js.map", ".js.LEGAL.txt"])
                paths.push(join("dist", host, name + extension));
        }
        paths.push(join("dist", host, "renderer.css"), join("dist", host, "renderer.css.map"));
    }
    return paths.map(path => {
        try {
            return [path, createHash("sha256").update(readFileSync(path)).digest("hex")];
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            return [path, null];
        }
    });
}

const originalBuildHashes = installedBuildHashes();

function build(...args: string[]) {
    execFileSync(process.execPath, [BUILD_SCRIPT, "--standalone", `--outdir=${OUTPUT_DIRECTORY}`, ...args], { stdio: "inherit" });
}

function normalizedSources(sourceMapPath: string): string[] {
    const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8")) as { sources: string[]; };
    return sourceMap.sources.map(source => source.replaceAll("\\", "/"));
}

try {
    build("--dev");

    for (const [bundlePath, sourceMapPath] of OUTPUTS) {
        const bundle = readFileSync(bundlePath, "utf8");
        const sources = normalizedSources(sourceMapPath);
        assert.ok(sources.some(source => source.endsWith(DEV_NATIVE)), `${bundlePath} must include development natives in a development build`);
        assert.ok(bundle.includes("UserpluginInstaller"), `${bundlePath} must register development natives in a development build`);
    }

    build("--reporter");

    for (const [bundlePath, sourceMapPath] of OUTPUTS) {
        const bundle = readFileSync(bundlePath, "utf8");
        const sources = normalizedSources(sourceMapPath);
        assert.ok(sources.some(source => source.endsWith(DEV_NATIVE)), `${bundlePath} must include development natives in a reporter build`);
        assert.ok(bundle.includes("UserpluginInstaller"), `${bundlePath} must register development natives in a reporter build`);
    }
    build();
    for (const [bundlePath, sourceMapPath] of OUTPUTS) {
        const bundle = readFileSync(bundlePath, "utf8");
        const sources = normalizedSources(sourceMapPath);
        assert.match(bundle, /\/\/ Development: false/u, `${bundlePath} must be a production build`);
        assert.equal(sources.some(source => /\/[^/]+\.dev\/native(?:\/index)?\.ts$/u.test(source)), false, `${bundlePath} must exclude every development native`);
        assert.equal(bundle.includes("UserpluginInstaller"), false, `${bundlePath} must not register UserpluginInstaller in production`);
    }
} finally {
    rmSync(OUTPUT_DIRECTORY, { recursive: true, force: true });
    assert.deepEqual(installedBuildHashes(), originalBuildHashes, "native build fixtures must never replace the installed build");
}

console.log("development native build filtering checks passed");
