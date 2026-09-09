/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { applyPendingHttpUpdate, findHttpUpdate } from "../src/main/updater/httpOperations";
import { createOperationQueue, serializeErrors } from "../src/main/updater/ipc";
import { IpcEvents } from "../src/shared/IpcEvents";
import { parseUpdaterBranch, type UpdaterBranch } from "../src/shared/Updater";
import { classifyUpdateChanges } from "../src/utils/updateClassification";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function load<T>(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown>): T {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    });
    return runInNewContext(`${outputText}\nexports;`, {
        exports: {}, ...globals,
        require(name: string) {
            assert.ok(Object.hasOwn(mocks, name), `Unexpected updater import: ${name}`);
            return mocks[name];
        },
    });
}

function rendererFixture() {
    const settings = { updateBranch: "main" as UpdaterBranch };
    const calls: unknown[][] = [];
    let check = async (_branch: UpdaterBranch) => [{ hash: "b".repeat(40), author: "Fixture", message: "Update" }];
    let nativeUpdate = async () => true;
    let build = async () => true;
    const updater = load<typeof import("../src/utils/updater")>("src/utils/updater.ts", {
        "@api/Settings": { Settings: settings },
        "~git-hash": { default: "a".repeat(40) },
        "./Logger": { Logger: class {} },
        "./native": { relaunch: () => assert.fail("Must not restart Discord") },
        "./updateClassification": { classifyUpdateChanges },
    }, {
        VencordNative: { updater: {
            getUpdates: async (branch: UpdaterBranch) => ({ ok: true, value: await check(branch) }),
            getDiagnostics: async () => ({ ok: true, value: { backend: "http" } }),
            update: async (branch: UpdaterBranch, force: boolean) => {
                calls.push(["update", branch, force]);
                return { ok: true, value: await nativeUpdate() };
            },
            rebuild: async (branch: UpdaterBranch) => {
                calls.push(["build", branch]);
                return { ok: true, value: await build() };
            },
        } },
    });
    return { updater, settings, calls, setCheck(value: typeof check) { check = value; },
        setUpdate(value: typeof nativeUpdate) { nativeUpdate = value; }, setBuild(value: typeof build) { build = value; } };
}

test("late branch responses, reset checks, and older overlapping checks cannot overwrite updater state", async () => {
    const f = rendererFixture();
    const delayed = deferred<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => delayed.promise);
    const old = f.updater.checkForUpdates();
    f.settings.updateBranch = "nightly";
    f.setCheck(async () => []);
    assert.equal(await f.updater.checkForUpdates(), false);
    delayed.resolve([{ hash: "b".repeat(40), author: "Fixture", message: "Stale" }]);
    assert.equal(await old, false);
    assert.equal(f.updater.changes.length, 0);

    const reset = deferred<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => reset.promise);
    const pending = f.updater.checkForUpdates();
    f.updater.resetUpdateState();
    reset.resolve([{ hash: "c".repeat(40), author: "Fixture", message: "Reset" }]);
    assert.equal(await pending, false);
    assert.equal(f.updater.isOutdated, false);

    const older = deferred<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => older.promise);
    const overlapping = f.updater.checkForUpdates();
    f.setCheck(async () => [{ hash: "d".repeat(40), author: "Fixture", message: "Newest" }]);
    assert.equal(await f.updater.checkForUpdates(), true);
    older.resolve([]);
    assert.equal(await overlapping, true, "an older same-branch caller receives the latest published status");
    assert.equal(f.updater.changes[0].message, "Newest");
});

test("simultaneous installs share one operation and another branch cannot report its result as success", async () => {
    const f = rendererFixture();
    await f.updater.checkForUpdates();
    const pending = deferred<boolean>();
    f.setUpdate(() => pending.promise);
    const first = f.updater.update();
    const second = f.updater.update();
    assert.equal(f.calls.length, 1);
    f.settings.updateBranch = "nightly";
    await assert.rejects(f.updater.update(), /already running for another branch/u);
    pending.resolve(true);
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(f.calls, [["update", "main", false], ["build", "main"]]);
});

test("repair forces a release lookup and rebuild even when the current version has no update", async () => {
    const f = rendererFixture();
    f.setUpdate(async () => false);
    assert.equal(await f.updater.repair(), true);
    assert.deepEqual(f.calls, [["update", "main", true], ["build", "main"]]);
    f.setBuild(async () => false);
    await assert.rejects(f.updater.repair(), /installation failed/u);
    f.setBuild(async () => true);
    assert.equal(await f.updater.repair(), true, "failure releases the install slot for retry");
});

test("native operation queue preserves order and continues after a failure", async () => {
    const enqueue = createOperationQueue();
    const pending = deferred<void>();
    const calls: string[] = [];
    const first = enqueue(async () => { calls.push("first"); await pending.promise; throw new Error("Fixture failure"); });
    const rejected = assert.rejects(first, /Fixture failure/u);
    const second = enqueue(() => { calls.push("second"); return 42; });
    await Promise.resolve();
    assert.deepEqual(calls, ["first"]);
    pending.resolve();
    await rejected;
    assert.equal(await second, 42);
    assert.deepEqual(calls, ["first", "second"]);
});

test("HTTP repair selects the current release archive while ordinary checks remain current", async () => {
    const hash = "a".repeat(40);
    const release = { name: `Protonn Cord ${hash}`, assets: [{ name: "desktop.asar",
        browser_download_url: "https://github.com/ProtonDev-sys/ProtonnCord/releases/download/latest/desktop.asar" }] };
    assert.equal(await findHttpUpdate(async () => release, hash, "desktop.asar"), null);
    assert.equal((await findHttpUpdate(async () => release, hash, "desktop.asar", "main", true))?.hash, hash);
});

test("HTTP branch selections survive checks and other selections, and failed installs remain retryable", async () => {
    const handlers = new Map<IpcEvents, (...args: any[]) => Promise<any>>();
    const installs: string[] = [];
    let failInstall = true;
    load("src/main/updater/http.ts", {
        "node:crypto": { randomUUID: () => "fixture" },
        "@shared/IpcEvents": { IpcEvents: {
            GET_REPO: IpcEvents.GET_REPO, GET_UPDATES: IpcEvents.GET_UPDATES, UPDATE: IpcEvents.UPDATE,
            BUILD: IpcEvents.BUILD, GET_UPDATER_DIAGNOSTICS: IpcEvents.GET_UPDATER_DIAGNOSTICS,
        } },
        "@shared/Updater": { parseUpdaterBranch },
        "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "Fixture" },
        electron: { ipcMain: { handle: (event: IpcEvents, handler: (...args: any[]) => Promise<any>) => handlers.set(event, handler) } },
        "original-fs": {}, "~git-hash": { default: "a".repeat(40) }, "~git-remote": { default: "Fixture/Fixture" },
        "./common": { ASAR_FILE: "desktop.asar" }, "./ipc": { createOperationQueue, serializeErrors },
        "./httpOperations": {
            applyPendingHttpUpdate,
            findHttpUpdate: async (_request: unknown, _hash: string, _asar: string, branch: UpdaterBranch) => ({ hash: branch, url: branch }),
            inspectHttpUpdates: async () => ({ changes: [], pending: null }),
            requestBytes: async (_fetch: unknown, url: string) => Buffer.from(url),
            replaceAsarAtomically: (_target: string, _temporary: string, bytes: Buffer) => {
                if (failInstall) throw new Error("Fixture install failure");
                installs.push(bytes.toString());
            },
        },
    }, { __dirname: "fixture.asar", process: { pid: 1 }, fetch: () => assert.fail("No live network") });
    const invoke = (event: IpcEvents, ...args: unknown[]) => handlers.get(event)!({}, ...args);
    assert.equal((await invoke(IpcEvents.UPDATE, "main")).value, true);
    assert.equal((await invoke(IpcEvents.UPDATE, "nightly")).value, true);
    assert.equal((await invoke(IpcEvents.GET_UPDATES, "main")).ok, true);
    assert.equal((await invoke(IpcEvents.BUILD, "main")).ok, false);
    failInstall = false;
    assert.equal((await invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal((await invoke(IpcEvents.BUILD, "nightly")).value, true);
    assert.deepEqual(installs, ["main", "nightly"]);
    assert.equal((await invoke(IpcEvents.BUILD, "nightly")).value, false, "an empty pending selection is not a completed repair");
    assert.equal((await invoke(IpcEvents.UPDATE, "main", "yes")).ok, false);
});
