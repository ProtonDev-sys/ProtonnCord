/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { applyPendingHttpUpdate, findHttpUpdate } from "../src/main/updater/httpOperations";
import { createOperationQueue, serializeErrors } from "../src/main/updater/ipc";
import { IpcEvents } from "../src/shared/IpcEvents";
import { parseUpdaterBranch, type UpdaterBranch } from "../src/shared/Updater";
import { classifyUpdateChanges, hashesReferToSameCommit } from "../src/utils/updateClassification";
import { loadTestModule } from "./utils/loadTestModule";

function load<T>(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown>): T {
    return loadTestModule<T>(path, mocks, {
        ...globals,
        require(name: string) {
            assert.ok(Object.hasOwn(mocks, name), `Unexpected updater import: ${name}`);
            return mocks[name];
        },
    }, "", { compilerOptions: { jsx: undefined }, mockImports: false });
}

function rendererFixture() {
    const settingListeners = new Set<() => void>();
    const settings = new Proxy({ updateBranch: "main" as UpdaterBranch }, {
        set(target, key, value) {
            const changed = Reflect.get(target, key) !== value;
            Reflect.set(target, key, value);
            if (changed) for (const listener of settingListeners) listener();
            return true;
        }
    });
    const state = { checks: 0, prompts: 0, relaunches: 0 };
    const alerts: string[] = [];
    let confirm = () => true;
    const calls: unknown[][] = [];
    let check = async (_branch: UpdaterBranch) => [{ hash: "b".repeat(40), author: "Fixture", message: "Update" }];
    let diagnostics: { backend: string; builtHead: string; installedBranch?: UpdaterBranch | null; } = { backend: "http", builtHead: "a".repeat(40) };
    let nativeUpdate = async () => true;
    let build = async () => true;
    const updater = load<typeof import("../src/utils/updater")>("src/utils/updater.ts", {
        "@api/Settings": { Settings: settings, SettingsStore: {
            addChangeListener: (_path: string, listener: () => void) => settingListeners.add(listener),
            removeChangeListener: (_path: string, listener: () => void) => settingListeners.delete(listener),
        } },
        "~git-hash": { __esModule: true, default: "a".repeat(40), buildChannel: "main" },
        "./Logger": { Logger: class { error() {} } },
        "./native": { relaunch: async () => { state.relaunches++; } },
        "./updateClassification": { classifyUpdateChanges, hashesReferToSameCommit },
    }, {
        IS_WEB: false, IS_UPDATER_DISABLED: false, IS_DEV: false,
        confirm: () => { state.prompts++; return confirm(); }, alert: (message: string) => alerts.push(message),
        VencordNative: { updater: {
            getUpdates: async (branch: UpdaterBranch) => { state.checks++; return { ok: true, value: await check(branch) }; },
            getDiagnostics: async () => ({ ok: true, value: diagnostics }),
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
    return { updater, settings, calls, state, alerts, settingListeners, setCheck(value: typeof check) { check = value; },
        setConfirm(value: typeof confirm) { confirm = value; },
        setDiagnostics(value: typeof diagnostics) { diagnostics = value; },
        setUpdate(value: typeof nativeUpdate) { nativeUpdate = value; }, setBuild(value: typeof build) { build = value; } };
}

test("source checks classify against the installed build after a deferred restart", async () => {
    const f = rendererFixture();
    f.setCheck(async () => {
        // A queued build can finish while the native update check is in progress.
        await Promise.resolve();
        f.setDiagnostics({ backend: "git", builtHead: "b".repeat(40) });
        return [{ hash: "a".repeat(40), author: "Fixture", message: "Switch back to main" }];
    });
    f.setDiagnostics({ backend: "git", builtHead: "a".repeat(40) });
    assert.equal(await f.updater.checkForUpdates(), true);
    assert.equal(f.updater.isNewer, false, "the old running renderer must not block restoring its previous branch");
    assert.equal(f.updater.getUpdateState().needsRestart, true, "checks in other windows also discover an installed update");
});

test("same-commit source channel switches remain installable rather than being marked local-newer", async () => {
    const f = rendererFixture();
    f.settings.updateBranch = "nightly";
    f.setDiagnostics({ backend: "git", builtHead: "a".repeat(40), installedBranch: "main" });
    f.setCheck(async () => [{ hash: "a".repeat(40), author: "Fixture", message: "Switch update branch to nightly" }]);
    assert.equal(await f.updater.checkForUpdates(), true);
    assert.equal(f.updater.isNewer, false);
    assert.equal(await f.updater.update(), true);
    assert.deepEqual(f.calls, [["update", "nightly", false], ["build", "nightly"]]);
});

test("another renderer installing a different channel at the same commit still requires a restart", async () => {
    const f = rendererFixture();
    f.settings.updateBranch = "nightly";
    f.setDiagnostics({ backend: "git", builtHead: "a".repeat(40), installedBranch: "nightly" });
    f.setCheck(async () => []);
    assert.equal(await f.updater.checkForUpdates(), false);
    assert.equal(f.updater.getUpdateState().needsRestart, true);
});

test("late branch responses, reset checks, and older overlapping checks cannot overwrite updater state", async () => {
    const f = rendererFixture();
    const delayed = Promise.withResolvers<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => delayed.promise);
    const old = f.updater.checkForUpdates();
    f.settings.updateBranch = "nightly";
    f.setCheck(async () => []);
    assert.equal(await f.updater.checkForUpdates(), false);
    delayed.resolve([{ hash: "b".repeat(40), author: "Fixture", message: "Stale" }]);
    assert.equal(await old, false);
    assert.equal(f.updater.changes.length, 0);

    const reset = Promise.withResolvers<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => reset.promise);
    const pending = f.updater.checkForUpdates();
    f.updater.resetUpdateState();
    reset.resolve([{ hash: "c".repeat(40), author: "Fixture", message: "Reset" }]);
    assert.equal(await pending, false);
    assert.equal(f.updater.isOutdated, false);

    const older = Promise.withResolvers<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => older.promise);
    const overlapping = f.updater.checkForUpdates();
    f.updater.resetUpdateState();
    f.setCheck(async () => [{ hash: "d".repeat(40), author: "Fixture", message: "Newest" }]);
    assert.equal(await f.updater.checkForUpdates(), true);
    older.resolve([]);
    assert.equal(await overlapping, true, "an older same-branch caller receives the latest published status");
    assert.equal(f.updater.changes[0].message, "Newest");
});

test("simultaneous installs share one operation and another branch cannot report its result as success", async () => {
    const f = rendererFixture();
    await f.updater.checkForUpdates();
    const pending = Promise.withResolvers<boolean>();
    f.setUpdate(() => pending.promise);
    const first = f.updater.update();
    const second = f.updater.update();
    await Promise.resolve();
    assert.equal(f.calls.length, 1);
    f.settings.updateBranch = "nightly";
    await assert.rejects(f.updater.update(), /already running for another branch/u);
    pending.resolve(true);
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(f.calls, [["update", "main", false], ["build", "main"]]);
});

test("concurrent checks share one lookup and published snapshots follow external branch changes and installs", async () => {
    const f = rendererFixture();
    const initial = f.updater.getUpdateState();
    assert.equal(f.updater.getUpdateState(), initial, "snapshot identity is stable until state changes");
    let notifications = 0;
    const unsubscribe = f.updater.subscribeToUpdates(() => notifications++);
    const pending = Promise.withResolvers<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => pending.promise);
    const first = f.updater.checkForUpdates();
    const second = f.updater.checkForUpdates();
    assert.equal(f.state.checks, 1);
    assert.equal(f.updater.getUpdateState().isChecking, true);
    pending.resolve([{ hash: "b".repeat(40), author: "Fixture", message: "Update" }]);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(f.updater.getUpdateState().isChecking, false);
    assert.equal(f.updater.getUpdateState().hasChecked, true);
    f.settings.updateBranch = "nightly";
    assert.equal(f.updater.getUpdateState().branch, "nightly");
    assert.equal(f.updater.isOutdated, false);
    assert.equal(f.updater.getUpdateState().hasChecked, false);
    assert.equal(await f.updater.update(), false, "a result from another branch must not authorize an install");
    assert.deepEqual(f.calls, []);
    assert.equal(await f.updater.repair(), true);
    assert.equal(f.updater.getUpdateState().needsRestart, true);
    f.updater.resetUpdateState();
    assert.equal(f.updater.getUpdateState().needsRestart, true, "clearing a check cannot hide the pending restart");
    assert.ok(notifications >= 5);
    unsubscribe();
    assert.equal(f.settingListeners.size, 0);
});

test("an install waits for the current check and checks wait for the complete install", async () => {
    const f = rendererFixture();
    const pending = Promise.withResolvers<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => pending.promise);
    const check = f.updater.checkForUpdates();
    const noUpdate = f.updater.update();
    pending.resolve([]);
    assert.equal(await check, false);
    assert.equal(await noUpdate, false);
    assert.deepEqual(f.calls, [], "a no-op must never report a successful installation");

    const build = Promise.withResolvers<boolean>();
    f.setBuild(() => build.promise);
    const repair = f.updater.repair();
    await new Promise(resolve => setImmediate(resolve));
    const checking = f.updater.checkForUpdates();
    assert.equal(f.state.checks, 1, "do not inspect the archive/source while rebuilding");
    assert.equal(f.updater.getUpdateState().isInstalling, true);
    f.setCheck(async () => []);
    build.resolve(true);
    assert.equal(await repair, true);
    assert.equal(await checking, false);
    assert.equal(f.state.checks, 2);
    assert.equal(f.updater.getUpdateState().isInstalling, false);
    assert.equal(f.updater.getUpdateState().needsRestart, true);
});

test("repair requested during an ordinary update retains its forced rebuild and duplicate repairs share it", async () => {
    const f = rendererFixture();
    await f.updater.checkForUpdates();
    const pending = Promise.withResolvers<boolean>();
    f.setUpdate(() => pending.promise);
    const updating = f.updater.update();
    const firstRepair = f.updater.repair();
    const secondRepair = f.updater.repair();
    pending.resolve(true);
    assert.deepEqual(await Promise.all([updating, firstRepair, secondRepair]), [true, true, true]);
    assert.deepEqual(f.calls, [["update", "main", false], ["build", "main"], ["update", "main", true], ["build", "main"]]);
});

test("crash update prompts deduplicate, respect branch changes, and report unsuccessful installs", async () => {
    const f = rendererFixture();
    const pending = Promise.withResolvers<{ hash: string; author: string; message: string; }[]>();
    f.setCheck(() => pending.promise);
    const first = f.updater.maybePromptToUpdate("Update?");
    const duplicate = f.updater.maybePromptToUpdate("Update again?");
    pending.resolve([{ hash: "b".repeat(40), author: "Fixture", message: "Update" }]);
    await Promise.all([first, duplicate]);
    assert.equal(f.state.prompts, 1);
    assert.equal(f.state.relaunches, 1);
    assert.equal(f.state.checks, 1);

    const switched = rendererFixture();
    switched.setConfirm(() => { switched.settings.updateBranch = "nightly"; return true; });
    await switched.updater.maybePromptToUpdate("Switch branch while confirming");
    assert.deepEqual(switched.calls, []);
    assert.equal(switched.state.relaunches, 0);

    const failed = rendererFixture();
    failed.setUpdate(async () => false);
    await failed.updater.maybePromptToUpdate("Update?");
    assert.equal(failed.state.relaunches, 0);
    assert.match(failed.alerts[0], /could not be installed/u);
    await failed.updater.maybePromptToUpdate("Retry?");
    assert.equal(failed.state.prompts, 2, "an unsuccessful installation must release the prompt slot for retry");
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

test("updater action errors preserve useful messages and ignore duplicate clicks or unmounted dialogs", async () => {
    const modals: unknown[] = [];
    const dispatches: boolean[] = [];
    const logs: unknown[] = [];
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) };
    const { runWithDispatch } = loadTestModule<typeof import("../src/components/settings/tabs/updater/runWithDispatch")>(
        "src/components/settings/tabs/updater/runWithDispatch.tsx", {
            "@components/ErrorCard": { ErrorCard: "ErrorCard" },
            "@utils/updater": { UpdateLogger: { error: (error: unknown) => logs.push(error) } },
            "@webpack/common": {
                ConfirmModal: "ConfirmModal", Parser: { parse: (text: string) => text },
                openModal: (factory: (props: object) => unknown) => modals.push(factory({})),
            },
        }, { React }
    );
    let active = true;
    let actions = 0;
    const pending = Promise.withResolvers<void>();
    const guarded = runWithDispatch(value => dispatches.push(value as boolean), async () => {
        actions++;
        await pending.promise;
        throw new Error("A stale failure");
    }, () => active);
    const first = guarded();
    await guarded();
    assert.equal(actions, 1);
    active = false;
    pending.resolve();
    await first;
    assert.deepEqual(dispatches, [true], "an unmounted component must not receive completion dispatches");
    assert.equal(modals.length, 0, "stale failures must not open a dialog on another settings page");
    assert.equal(logs.length, 1);

    for (const error of ["Checksum verification failed", { message: "Permission denied" }, { code: "ENOENT", cmd: "git fetch", path: "git" }]) {
        await runWithDispatch(value => dispatches.push(value as boolean), async () => { throw error; })();
    }
    assert.match(JSON.stringify(modals[0]), /Checksum verification failed/u);
    assert.match(JSON.stringify(modals[1]), /Permission denied/u);
    assert.match(JSON.stringify(modals[2]), /Command `git` not found/u);
    assert.deepEqual(dispatches.slice(1), [true, false, true, false, true, false]);
});

test("native operation queue preserves order and continues after a failure", async () => {
    const enqueue = createOperationQueue();
    const pending = Promise.withResolvers<void>();
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
        digest: `sha256:${"d".repeat(64)}`, size: 128, state: "uploaded",
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
        "@main/ipc": { ipcMain: { handle: (event: IpcEvents, handler: (...args: any[]) => Promise<any>) => handlers.set(event, handler) } },
        "original-fs": {}, "~git-hash": { default: "a".repeat(40) }, "~git-remote": { default: "Fixture/Fixture" },
        "./common": { ASAR_FILE: "desktop.asar" }, "./ipc": { createOperationQueue, serializeErrors },
        "./httpOperations": {
            applyPendingHttpUpdate,
            findHttpUpdate: async (_request: unknown, _hash: string, _asar: string, branch: UpdaterBranch) => ({
                hash: branch, sha256: createHash("sha256").update(branch).digest("hex"), size: branch.length, url: branch,
            }),
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
