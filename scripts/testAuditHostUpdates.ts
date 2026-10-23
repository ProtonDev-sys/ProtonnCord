/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createPackage, extractFile, uncache } from "@electron/asar";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as files from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

import { createHostInjector, readHostInjector } from "../src/main/hostInjector";
import { bootstrapPaths, isBootstrapInjector, upgradeBootstrapInjector } from "../src/main/updater/bootstrapFiles";
import { loadTestModule } from "./utils/loadTestModule";

function temporaryDirectory(t: TestContext) {
    const root = files.mkdtempSync(path.join(tmpdir(), "protonn-cord-host-updates-"));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith("protonn-cord-host-updates-"));
        files.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

function hostPatcher(fs = files) {
    return loadTestModule<typeof import("../src/main/applyHostPatch")>("src/main/applyHostPatch.ts", {
        "node:crypto": { randomUUID }, "original-fs": fs, path, "./hostInjector": { createHostInjector },
    }, { console, Error });
}

function folderShim(folder: string, contents: string) {
    files.mkdirSync(folder, { recursive: true });
    files.writeFileSync(path.join(folder, "index.js"), contents);
    files.writeFileSync(path.join(folder, "package.json"), '{"name":"discord","main":"index.js"}\n');
}

test("source startup restarts after recovery before loading mixed build outputs", () => {
    for (const recovered of [false, true]) {
        const calls: string[] = [];
        const exit = new Error("fixture process exit");
        const start = () => loadTestModule("src/main/updater/installBootstrap.ts", {
            "node:fs": {}, "node:path": path, "./bootstrapFiles": {},
            "original-fs": { statSync: () => ({ isDirectory: () => true }) },
            "./buildOperations": { recoverBuildInstallations(directory: string) {
                assert.equal(directory, path.join("fixture", "desktop", ".."));
                calls.push("recover");
                return recovered;
            } },
            electron: { app: { relaunch() { calls.push("relaunch"); }, exit(code: number) {
                assert.equal(code, 0);
                calls.push("exit");
                throw exit;
            } } },
        }, { __dirname: path.join("fixture", "desktop"), IS_DEV: false, IS_UPDATER_DISABLED: false, IS_DISCORD_DESKTOP: false });
        if (recovered) assert.throws(start, error => error === exit);
        else start();
        assert.deepEqual(calls, recovered ? ["recover", "relaunch", "exit"] : ["recover"]);
    }
});

const escapedJson = (value: string) => JSON.stringify(value)
    .replace(/[&'<>\u2028\u2029]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/\//gu, "\\/");

function hookFixture(lazy = false) {
    const patched: string[] = [];
    const errors: unknown[] = [];
    const calls: unknown[][] = [];
    const rootPath = path.resolve("fixture-host");
    const updater = Object.assign(new EventEmitter(), {
        rootPath,
        committedHostVersion: [1, 0, 1],
        queryCurrentVersionsSync: () => ({ current_host: [1, 0, 2] }),
        startCurrentVersionSync(options?: object) { calls.push([this, options]); },
        async startCurrentVersion(query?: object, options?: object) { calls.push([this, query, options]); },
    });
    let initialized = !lazy;
    const updaterModule = {
        getUpdater: () => initialized ? updater : undefined,
        tryInitUpdater(...args: unknown[]) { calls.push([this, ...args]); initialized = true; return true; },
    };
    const core = { startup(options: unknown) { calls.push([this, options]); } };
    const prototype = { require: (_id: string) => core };
    const originalRequire = prototype.require;
    const { installHostUpdateHook } = loadTestModule<typeof import("../src/main/hostUpdateHook")>("src/main/hostUpdateHook.ts", {
        module: { __esModule: true, default: { prototype } }, path,
        "./applyHostPatch": { patchResourcesDir: (resources: string) => patched.push(resources), findStaleSibling: () => null },
    }, {
        __dirname: path.resolve("fixture-mod"), Error,
        process: { platform: "win32", execPath: path.join(rootPath, "app-1.0.1", "Discord.exe") },
        console: { error: (...args: unknown[]) => errors.push(args) },
    });
    installHostUpdateHook();
    installHostUpdateHook();
    prototype.require("discord_desktop_core");
    assert.equal(prototype.require, originalRequire, "the global require interception is removed after finding the core");
    const options = { updater: updaterModule };
    core.startup(options);
    core.startup(options);
    if (lazy) assert.equal(updaterModule.tryInitUpdater("build", "repository", true), true);
    assert.equal(updater.listenerCount("host-updated"), 1);
    return { updater, patched, errors, calls, rootPath };
}

test("host-updated queries the new host before a stale committedHostVersion", () => {
    const fixture = hookFixture();
    fixture.updater.emit("host-updated");
    assert.deepEqual(fixture.patched, [path.join(fixture.rootPath, "app-1.0.2", "resources")]);
    assert.equal(fixture.updater.committedHostVersion.join("."), "1.0.1");
    assert.equal(fixture.errors.length, 0);
});

test("host-updated falls back to committed state when the native query fails", () => {
    const fixture = hookFixture();
    fixture.updater.committedHostVersion = [1, 0, 3];
    fixture.updater.queryCurrentVersionsSync = () => { throw new Error("native updater unavailable"); };
    fixture.updater.emit("host-updated");
    assert.deepEqual(fixture.patched, [path.join(fixture.rootPath, "app-1.0.3", "resources")]);
    assert.equal(fixture.errors.length, 1);
});

test("lazy updater initialization and both relaunch entrypoints retain the new host", async () => {
    const fixture = hookFixture(true);
    const options = { allowObsoleteHost: true };
    const query = { fixture: true };
    fixture.updater.startCurrentVersionSync(options);
    await fixture.updater.startCurrentVersion(query, options);
    assert.deepEqual(fixture.patched, Array(2).fill(path.join(fixture.rootPath, "app-1.0.2", "resources")));
    assert.deepEqual(fixture.calls.slice(-2), [[fixture.updater, options], [fixture.updater, query, options]]);
    fixture.updater.queryCurrentVersionsSync = () => ({ current_host: [1, 0, 1] });
    fixture.updater.emit("host-updated");
    assert.equal(fixture.patched.length, 2, "the running host is left alone");
});

test("an interrupted host patch is completed without replacing its original backup", t => {
    const resources = temporaryDirectory(t);
    const app = path.join(resources, "app.asar");
    const original = Buffer.from("original host saved before the process stopped");
    files.writeFileSync(path.join(resources, "_app.asar"), original);
    const patcher = path.join(resources, "mod", "patcher.js");
    const { patchResourcesDir } = hostPatcher();
    assert.equal(patchResourcesDir(resources, patcher), true);
    assert.equal(readHostInjector(files.readFileSync(app)), `require(${JSON.stringify(patcher)})`);
    assert.deepEqual(files.readFileSync(path.join(resources, "_app.asar")), original);
    assert.equal(patchResourcesDir(resources, patcher), false);
});

test("host injector publication failures preserve fresh and interrupted hosts for retry", t => {
    const root = temporaryDirectory(t);
    for (const interrupted of [false, true]) {
        const resources = path.join(root, String(interrupted));
        const app = path.join(resources, "app.asar");
        const backup = path.join(resources, "_app.asar");
        files.mkdirSync(resources);
        files.writeFileSync(interrupted ? backup : app, "original host");
        const failure = new Error("cannot activate the injector");
        const failingFs: typeof files = { ...files, renameSync(source, destination) {
            if (destination === app && String(source).endsWith(".tmp")) throw failure;
            files.renameSync(source, destination);
        } };
        assert.throws(() => hostPatcher(failingFs).patchResourcesDir(resources, "patcher.js"), error => error === failure);
        assert.equal(files.readFileSync(interrupted ? backup : app, "utf8"), "original host");
        assert.deepEqual(files.readdirSync(resources), [interrupted ? "_app.asar" : "app.asar"]);
        assert.equal(hostPatcher().patchResourcesDir(resources, "patcher.js"), true);
        assert.equal(files.readFileSync(backup, "utf8"), "original host");
    }
});

test("packed shims with Go/C# JSON escapes migrate atomically and reject unrelated injectors", async t => {
    const root = temporaryDirectory(t);
    const archive = path.join(root, "Mod &'\u2028", "desktop.asar");
    const { bootstrap, loader } = bootstrapPaths(archive);
    const stubs = [
        `require(${escapedJson(archive)})`,
        `require(${escapedJson(path.join(archive, "patcher.js"))});`,
        `require(${escapedJson(bootstrap)}).load(${escapedJson(archive)});`,
    ];
    for (const [index, stub] of stubs.entries()) {
        assert.equal(isBootstrapInjector(stub, archive), true);
        const source = path.join(root, `source-${index}`);
        const app = path.join(root, `${index}.asar`);
        folderShim(source, stub);
        await createPackage(source, app);
        const original = files.readFileSync(app);
        const failure = new Error("injector is locked");
        const failingFs: typeof files = { ...files, renameSync() { throw failure; } };
        assert.throws(() => upgradeBootstrapInjector(path.join(app, "index.js"), archive, failingFs), error => error === failure);
        assert.deepEqual(files.readFileSync(app), original);
        upgradeBootstrapInjector(path.join(app, "index.js"), archive, files);
        const upgraded = files.readFileSync(app);
        assert.equal(readHostInjector(upgraded), `require(${JSON.stringify(loader)})`);
        upgradeBootstrapInjector(path.join(app, "index.js"), archive, files);
        assert.deepEqual(files.readFileSync(app), upgraded);
    }
    const unrelated = path.join(root, "unrelated.asar");
    const original = createHostInjector(path.join(root, "other-mod.js"));
    files.writeFileSync(unrelated, original);
    assert.throws(() => upgradeBootstrapInjector(path.join(unrelated, "index.js"), archive, files), /does not match/iu);
    assert.deepEqual(files.readFileSync(unrelated), original);
    assert.equal(files.readdirSync(root).some(name => name.endsWith(".tmp")), false);
});

test("legacy app.asar folders become packed shims with exact folder backups", t => {
    const root = temporaryDirectory(t);
    const archive = path.join(root, "desktop.asar");
    const { loader } = bootstrapPaths(archive);
    for (const [index, target] of [archive, loader].entries()) {
        const app = path.join(root, String(index), "app.asar");
        const previous = `require(${escapedJson(target)});\n`;
        folderShim(app, previous);
        upgradeBootstrapInjector(path.join(app, "index.js"), archive, files);
        assert.ok(files.statSync(app).isFile());
        assert.equal(readHostInjector(files.readFileSync(app)), `require(${JSON.stringify(loader)})`);
        const backups = files.readdirSync(path.dirname(app)).filter(name => name.endsWith(".bak"));
        assert.equal(backups.length, 1);
        const backup = path.join(path.dirname(app), backups[0]);
        assert.equal(files.readFileSync(path.join(backup, "index.js"), "utf8"), previous);
        assert.equal(files.readFileSync(path.join(backup, "package.json"), "utf8"), '{"name":"discord","main":"index.js"}\n');
        upgradeBootstrapInjector(path.join(app, "index.js"), archive, files);
        assert.equal(files.readdirSync(path.dirname(app)).length, 2, "repeated migration creates no new backups");
    }
});

test("folder migration refuses unknown files and restores the folder after activation failure", t => {
    const root = temporaryDirectory(t);
    const app = path.join(root, "app.asar");
    const archive = path.join(root, "desktop.asar");
    const previous = `require(${JSON.stringify(archive)})`;
    folderShim(app, previous);
    const unknown = path.join(app, "unknown.js");
    files.writeFileSync(unknown, "keep me");
    assert.throws(() => upgradeBootstrapInjector(path.join(app, "index.js"), archive, files), /unexpected files/iu);
    assert.equal(files.readFileSync(unknown, "utf8"), "keep me");
    files.unlinkSync(unknown);
    const failure = new Error("cannot activate the packed shim");
    const failingFs: typeof files = { ...files, renameSync(source, destination) {
        if (destination === app && String(source).endsWith(".tmp")) throw failure;
        files.renameSync(source, destination);
    } };
    assert.throws(() => upgradeBootstrapInjector(path.join(app, "index.js"), archive, failingFs), error => error === failure);
    assert.equal(files.readFileSync(path.join(app, "index.js"), "utf8"), previous);
    assert.deepEqual(files.readdirSync(root), ["app.asar"]);
    const writeFailure = new Error("injector disk is full");
    assert.throws(() => upgradeBootstrapInjector(path.join(app, "index.js"), archive, {
        ...files,
        writeFileSync(target, contents, options) {
            files.writeFileSync(target, contents, options);
            throw writeFailure;
        },
    }), error => error === writeFailure);
    assert.equal(files.readFileSync(path.join(app, "index.js"), "utf8"), previous);
    assert.deepEqual(files.readdirSync(root), ["app.asar"], "a failed temporary write cannot leak an injector file");
});

test("the offline repair command preserves packed and folder injector backups", { skip: process.platform !== "win32" }, async t => {
    const root = temporaryDirectory(t);
    const archive = path.join(root, "Mod &'", "desktop.asar");
    const source = path.join(root, "source");
    folderShim(source, "module.exports = {};\n");
    files.mkdirSync(path.dirname(archive));
    await createPackage(source, archive);
    const originalArchive = files.readFileSync(archive);
    const previous = `require(${escapedJson(archive)});\n`;
    for (const packed of [false, true]) {
        const resources = path.join(root, String(packed));
        const app = path.join(resources, "app.asar");
        files.mkdirSync(resources);
        if (packed) {
            files.writeFileSync(path.join(source, "index.js"), previous);
            await createPackage(source, app);
        } else {
            folderShim(app, previous);
        }
        const originalInjector = packed ? files.readFileSync(app) : undefined;
        const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/repairWindowsUpdater.mjs", path.join(app, "index.js"), archive], {
            encoding: "utf8", timeout: 15_000, windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(readHostInjector(files.readFileSync(app)), `require(${JSON.stringify(bootstrapPaths(archive).loader)})`);
        const backups = files.readdirSync(resources).filter(name => name.endsWith(".bak"));
        assert.equal(backups.length, 1);
        const backup = path.join(resources, backups[0]);
        if (packed) assert.deepEqual(files.readFileSync(backup), originalInjector);
        else assert.equal(files.readFileSync(path.join(backup, "index.js"), "utf8"), previous);
        assert.deepEqual(files.readFileSync(archive), originalArchive);
        const { bootstrap, loader } = bootstrapPaths(archive);
        assert.ok(files.statSync(bootstrap).size > 0);
        assert.equal(files.readFileSync(loader, "utf8"), `require(${JSON.stringify(bootstrap)}).load(${JSON.stringify(archive)});\n`);
        const repeated = spawnSync(process.execPath, ["--import", "tsx", "scripts/repairWindowsUpdater.mjs", path.join(app, "index.js"), archive], {
            encoding: "utf8", timeout: 15_000, windowsHide: true,
        });
        assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
        assert.equal(files.readdirSync(resources).filter(name => name.endsWith(".bak")).length, 1, "repeated repair must reuse the existing injector and backup");
    }
});

test("generated host injectors support pinned Equilotl repair and uninstall", { skip: process.platform !== "win32" }, async t => {
    const { EQUILOTL_ARTIFACTS, INSTALLER_CACHE_DIR, verifyArtifact } = await import("./runInstaller.mjs");
    const cached = path.join(INSTALLER_CACHE_DIR, EQUILOTL_ARTIFACTS.win32.filename);
    if (!files.existsSync(cached)) return t.skip("The pinned Windows CLI is not cached; this test never downloads it");
    assert.ok(await verifyArtifact(cached, EQUILOTL_ARTIFACTS.win32), "only execute the reviewed CLI bytes");
    const root = files.mkdtempSync(path.join(tmpdir(), "protonn-cord-host-updates-"));
    try {
        const cli = path.join(root, "EquilotlCli.exe");
        files.copyFileSync(cached, cli);
        // GetBranch infers "development", which has no process-name mapping in
        // this pinned CLI. --branch stable would kill the user's live Discord.
        const discord = path.join(root, "FixtureDevelopment");
        const resources = path.join(discord, "app-9.0.10", "resources");
        const app = path.join(resources, "app.asar");
        const archive = path.join(root, "Mod Files", "desktop.asar");
        const loader = `${archive}.loader.cjs`;
        const source = path.join(root, "source");
        for (const directory of [resources, source, path.dirname(archive)]) files.mkdirSync(directory, { recursive: true });
        files.writeFileSync(path.join(source, "package.json"), '{"name":"discord","main":"index.js"}');
        files.writeFileSync(path.join(source, "index.js"), "module.exports = 'original Discord';\n");
        await createPackage(source, app);
        const original = files.readFileSync(app);
        files.writeFileSync(archive, original);
        const { patchResourcesDir } = hostPatcher();
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
            if (/^(?:APPDATA|LOCALAPPDATA|PROGRAMDATA|EQUICORD_DIRECTORY|EQUICORD_USER_DATA_DIR|EQUICORD_DEV_INSTALL|PROTONN_CORD_USER_DATA_DIR|DISCORD_USER_DATA_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu.test(key)) delete env[key];
        }
        Object.assign(env, {
            APPDATA: path.join(root, "Roaming"), LOCALAPPDATA: path.join(root, "Local"), PROGRAMDATA: path.join(root, "ProgramData"),
            EQUICORD_USER_DATA_DIR: path.dirname(archive), EQUICORD_DEV_INSTALL: "1",
            HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "",
        });
        const run = (operation: string, target: string) => {
            const result = spawnSync(cli, [operation, "--location", discord, "--debug"], {
                cwd: root, env: { ...env, EQUICORD_DIRECTORY: target }, encoding: "utf8", timeout: 15_000, windowsHide: true,
            });
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            assert.doesNotMatch(result.stdout + result.stderr, /Trying to kill Discord/iu);
        };
        for (const externalLoader of [false, true]) {
            const target = externalLoader ? loader : path.join(archive, "patcher.js");
            if (externalLoader) files.writeFileSync(loader, "module.exports = {};\n");
            assert.equal(patchResourcesDir(resources, path.join(archive, "patcher.js")), true);
            uncache(app); // A previous extraction cached the other injector's header at this same path.
            assert.equal(extractFile(app, "index.js").toString(), `require(${JSON.stringify(target)})`);
            run("--uninstall", target);
            assert.deepEqual(files.readFileSync(app), original, "removal of a generated injector restores the original host");
            assert.equal(files.existsSync(path.join(resources, "_app.asar")), false);
            assert.equal(patchResourcesDir(resources, path.join(archive, "patcher.js")), true);
            run("--repair", target);
            assert.deepEqual(files.readFileSync(path.join(resources, "_app.asar")), original, "repair must not back up the injector as Discord");
            assert.equal(readHostInjector(files.readFileSync(app)), `require(${JSON.stringify(target)})`);
            run("--uninstall", target);
            assert.deepEqual(files.readFileSync(app), original);
            assert.deepEqual(files.readFileSync(archive), original, "the developer CLI must not replace the provided mod archive");
        }
    } finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith("protonn-cord-host-updates-"));
        files.rmSync(root, { recursive: true, force: true });
    }
});
