/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { IpcEvents } from "../src/shared/IpcEvents";
import { classifyUpdateChanges } from "../src/utils/updateClassification";

async function compileUpdater(standalone: boolean, disabled = false) {
    const result = await build({
        entryPoints: ["src/main/updater/index.ts"],
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
        external: ["electron", "original-fs"],
        define: { IS_STANDALONE: String(standalone), IS_UPDATER_DISABLED: String(disabled) },
        plugins: [{
            name: "updater-backend-fixtures",
            setup(builder) {
                builder.onResolve({ filter: /^(?:\.\/(?:git|http)|~git-(?:hash|remote))$/ }, args => ({ path: args.path, namespace: "fixture" }));
                builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
                    contents: args.path === "~git-hash" ? 'export default "fixture-build";'
                        : args.path === "~git-remote" ? 'export default "ProtonDev-sys/ProtonnCord";'
                            : `globalThis.selectedBackends.push(${JSON.stringify(args.path.slice(2))});`
                }));
            },
        }],
    });
    return result.outputFiles[0].text;
}

test("HTTP updates require an actual archive file, including standalone builds with unpacked folders", async t => {
    const directory = await mkdtemp(join(tmpdir(), "protonncord-updater-backend-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const targets = [
        { path: join(directory, "desktop"), archive: false },
        { path: join(directory, "equibop"), archive: false },
        { path: join(directory, "folder-named.asar"), archive: false },
        { path: join(directory, "desktop.asar"), archive: true },
        { path: join(directory, "equibop.asar"), archive: true },
    ];
    for (const target of targets) {
        if (target.archive) await writeFile(target.path, "archive fixture");
        else await mkdir(target.path);
    }
    const nativeFs = await import("node:fs");
    for (const standalone of [false, true]) {
        const code = await compileUpdater(standalone);
        for (const target of targets) {
            const selectedBackends: string[] = [];
            runInNewContext(code, {
                __dirname: target.path, selectedBackends,
                require(name: string) {
                    if (name === "original-fs") return nativeFs;
                    if (name === "electron") return { ipcMain: {} };
                    throw new Error(`Unexpected updater dependency: ${name}`);
                },
            });
            assert.deepEqual(selectedBackends, [target.archive ? "http" : "git"], `${target.path}, standalone=${standalone}`);
        }
    }
});

test("disabled builds never inspect files or initialize an updater backend", async () => {
    const code = await compileUpdater(true, true);
    const selectedBackends: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    runInNewContext(code, {
        selectedBackends,
        require(name: string) {
            assert.equal(name, "electron", "disabled builds must not load original-fs");
            return { ipcMain: { handle: (channel: string, method: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, method) } };
        },
    });
    assert.deepEqual(selectedBackends, []);
    const diagnostics = await handlers.get(IpcEvents.GET_UPDATER_DIAGNOSTICS)?.({}, "nightly");
    assert.equal(JSON.stringify(diagnostics), JSON.stringify({
        ok: true,
        value: { backend: "disabled", branch: "nightly", builtHead: "fixture-build", sourceRoot: null }
    }));
});

test("renderer update status follows the native backend instead of the standalone build flag", async () => {
    const { outputText } = transpileModule(await readFile("src/utils/updater.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const currentHash = "a".repeat(40);
    for (const standalone of [false, true]) {
        for (const backend of ["git", "http"] as const) {
            const settings = { updateBranch: "nightly" };
            const calls: string[] = [];
            let remoteChanges = [{ hash: currentHash, author: "Fixture", message: "Fixture" }];
            const dependencies = {
                "@api/Settings": { Settings: settings },
                "~git-hash": { __esModule: true, default: currentHash },
                "./Logger": { Logger: class { } },
                "./native": { relaunch() { assert.fail("The fixture must never restart Discord"); } },
                "./updateClassification": { classifyUpdateChanges },
            };
            const updater = runInNewContext(`${outputText}\nexports;`, {
                exports: {}, IS_STANDALONE: standalone,
                require(name: string) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
                VencordNative: { updater: {
                    async getUpdates(branch: string) {
                        calls.push(`changes:${branch}`);
                        // Both concurrent requests must retain the originally selected branch.
                        settings.updateBranch = "staging";
                        return { ok: true, value: remoteChanges };
                    },
                    async getDiagnostics(branch: string) {
                        calls.push(`diagnostics:${branch}`);
                        return { ok: true, value: { backend, branch, builtHead: currentHash } };
                    },
                } },
            });
            assert.equal(calls.length, 0, "rendering or importing update controls performs no diagnostic IPC");
            assert.equal(await updater.checkForUpdates(), backend === "http");
            assert.equal(updater.isNewer, backend === "git");
            assert.deepEqual(calls, ["changes:nightly", "diagnostics:nightly"]);

            remoteChanges = [];
            assert.equal(await updater.checkForUpdates(), false);
            assert.equal(updater.isNewer, false);
            remoteChanges = [{ hash: "b".repeat(40), author: "Fixture", message: "Fixture" }];
            assert.equal(await updater.checkForUpdates(), true);
            assert.equal(updater.isNewer, false);
            assert.equal(calls.filter(call => call.startsWith("diagnostics:")).length, 3, "each explicit check performs exactly one diagnostics request");
        }
    }
});
