/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import * as httpOperations from "../src/main/updater/httpOperations";
import { createOperationQueue, serializeErrors } from "../src/main/updater/ipc";
import { IpcEvents } from "../src/shared/IpcEvents";
import { SettingsStore } from "../src/shared/SettingsStore";
import { parseUpdaterBranch, updaterReleaseEndpoint } from "../src/shared/Updater";
import { loadTestModule } from "./utils/loadTestModule";

const CURRENT = "a".repeat(40);
const NEXT = "b".repeat(40);
const bytes = Buffer.from("verified archive fixture");

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(data: { autoUpdate?: unknown; updateBranch?: unknown; } = {}, flags = {}) {
    const settings = new SettingsStore(data);
    const app = new EventEmitter();
    const handlers = new Map<IpcEvents, (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; }>>();
    const requests: string[] = [];
    const installs: string[] = [];
    const errors: unknown[] = [];
    const timers = new Set<{ callback(): void; delay: number; unref(): void; unrefed: boolean; }>();
    const hooks = {
        metadata: async () => {}, download: async () => {}, install: () => {},
        hash: NEXT, comparison: "ahead", downloads: 0,
    };
    const { drain } = loadTestModule<{ drain(): Promise<void>; }>("src/main/updater/http.ts", {
        "node:crypto": { randomUUID: () => "fixture" },
        "@main/ipc": { ipcMain: { handle: (event: IpcEvents, handler: (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; }>) => handlers.set(event, handler) } },
        "@main/settings": { RendererSettings: settings },
        "@main/utils/constants": { IS_VANILLA: false, ...flags },
        "@shared/IpcEvents": { IpcEvents: {
            GET_REPO: IpcEvents.GET_REPO, GET_UPDATES: IpcEvents.GET_UPDATES, UPDATE: IpcEvents.UPDATE,
            BUILD: IpcEvents.BUILD, GET_UPDATER_DIAGNOSTICS: IpcEvents.GET_UPDATER_DIAGNOSTICS,
        } }, "@shared/Updater": { parseUpdaterBranch },
        "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "Fixture" },
        "electron": { app }, "original-fs": {},
        "~git-hash": { __esModule: true, default: CURRENT, buildChannel: "main" },
        "~git-remote": { __esModule: true, default: "Fixture/Fixture" },
        "./common": { ASAR_FILE: "desktop.asar" }, "./ipc": { createOperationQueue, serializeErrors },
        "./httpOperations": {
            ...httpOperations,
            async requestJson(_fetch: unknown, url: string) {
                const endpoint = new URL(url).pathname.slice("/repos/Fixture/Fixture".length);
                requests.push(endpoint);
                if (endpoint.startsWith("/compare/")) return { status: hooks.comparison, commits: [] };
                await hooks.metadata();
                return {
                    name: `Protonn Cord ${hooks.hash}`,
                    assets: [{ name: "desktop.asar", state: "uploaded", size: bytes.length,
                        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                        browser_download_url: `https://github.com/Fixture/Fixture/releases/download/${endpoint.split("/").at(-1)}/desktop.asar` }],
                };
            },
            async requestBytes() {
                hooks.downloads++;
                await hooks.download();
                return bytes;
            },
            replaceAsarAtomically(_target: string, _temporary: string, data: Buffer) {
                hooks.install();
                assert.deepEqual(data, bytes);
                installs.push(hooks.hash);
            },
        },
    }, {
        __dirname: "fixture.asar", process: { pid: 1 }, fetch: () => assert.fail("No live network"),
        IS_DEV: false, IS_UPDATER_DISABLED: false, ...flags,
        console: { error: (...args: unknown[]) => errors.push(args) },
        setTimeout(callback: () => void, delay: number) {
            const timer = { callback, delay, unrefed: false, unref() { this.unrefed = true; } };
            timers.add(timer);
            return timer;
        },
        clearTimeout(timer: Parameters<typeof timers.delete>[0]) { timers.delete(timer); },
    }, "\nexports.drain = () => enqueue(() => undefined);\n");
    return {
        settings, app, requests, installs, errors, timers, hooks, drain,
        invoke: (event: IpcEvents, ...args: unknown[]) => handlers.get(event)!({}, ...args),
        fire() {
            assert.equal(timers.size, 1, "only one fallback timer may exist");
            const timer = [...timers][0];
            assert.equal(timer.unrefed, true);
            timers.delete(timer);
            timer.callback();
        },
        async tick() { this.fire(); await drain(); },
    };
}

test("native HTTP updates need no renderer and use saved branches and defaults", async () => {
    for (const branch of [undefined, null, "main", "staging", "nightly"]) {
        const data = { updateBranch: branch, ...(branch === null && { autoUpdate: null }) };
        const f = fixture(data);
        assert.equal([...f.timers][0].delay, 60_000);
        await f.tick();
        assert.equal(f.requests[0], updaterReleaseEndpoint(parseUpdaterBranch(branch ?? undefined)));
        assert.equal(f.hooks.downloads, 1);
        assert.deepEqual(f.installs, [NEXT]);
        assert.equal([...f.timers][0].delay, 30 * 60_000);
        await f.tick();
        assert.equal(f.hooks.downloads, 1, "an installed archive is not downloaded again before restart");
        assert.deepEqual(f.settings.plain, data, "native defaults do not write settings");
        f.app.emit("will-quit");
        assert.equal(f.timers.size, 0);
        assert.equal(f.app.listenerCount("will-quit"), 0);
    }
});

test("disabled preferences avoid network work, can be enabled later, and retain explicit updates", async () => {
    const f = fixture({ autoUpdate: false });
    await f.tick();
    assert.equal(f.requests.length, 0);
    assert.equal((await f.invoke(IpcEvents.UPDATE, "main")).value, true);
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal(f.hooks.downloads, 1, "manual updates remain available when auto update is off");
    f.settings.setData({ autoUpdate: true, updateBranch: "nightly" });
    await f.tick(); // Defer to the preceding renderer operations.
    await f.tick();
    assert.ok(f.requests.includes("/releases/tags/nightly"));
    assert.equal(f.hooks.downloads, 2, "channel bundles are installed even at the same source hash");
    f.app.emit("will-quit");
    for (const flags of [{ IS_DEV: true }, { IS_UPDATER_DISABLED: true }, { IS_VANILLA: true }]) {
        const excluded = fixture({}, flags);
        assert.equal(excluded.timers.size, 0);
        assert.equal(excluded.app.listenerCount("will-quit"), 0);
        assert.deepEqual(excluded.requests, []);
    }
});

test("changed branches, disabled auto update and shutdown cancel lookup or download installation", async () => {
    for (const stage of ["metadata", "download"] as const) {
        for (const change of ["branch", "off", "branchBack", "offBack", "quit"] as const) {
            const f = fixture();
            const started = deferred();
            const gate = deferred();
            f.hooks[stage] = async () => { started.resolve(); await gate.promise; };
            f.fire();
            await started.promise;
            if (change === "quit") f.app.emit("will-quit");
            else {
                f.settings.setData(change.startsWith("off") ? { autoUpdate: false } : { updateBranch: "nightly" });
                if (change.endsWith("Back")) f.settings.setData({});
            }
            gate.resolve();
            await f.drain();
            assert.deepEqual(f.installs, [], `${change} during ${stage}`);
            assert.equal(f.hooks.downloads, stage === "metadata" ? 0 : 1);
            const status = await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS, "main");
            assert.equal((status.value as { builtHead: string; }).builtHead, CURRENT);
            assert.equal(f.timers.size, change === "quit" ? 0 : 1);
            f.app.emit("will-quit");
        }
    }
});

test("transient metadata, download and install failures retry without overlapping cycles", async () => {
    for (const stage of ["metadata", "download", "install"] as const) {
        const f = fixture();
        f.hooks[stage] = () => { throw new Error("Transient fixture failure"); };
        await f.tick();
        assert.deepEqual(f.installs, []);
        assert.equal(f.errors.length, 1);
        assert.equal(f.timers.size, 1);
        f.hooks[stage] = async () => {};
        await f.tick();
        assert.deepEqual(f.installs, [NEXT]);
        f.app.emit("will-quit");
    }
    const f = fixture();
    f.hooks.comparison = "behind";
    await f.tick();
    assert.equal(f.hooks.downloads, 0, "automatic fallback cannot force a same-channel downgrade");
    f.app.emit("will-quit");
});

test("renderer work keeps its first turn and resumes an abandoned selection without a duplicate download", async () => {
    const f = fixture();
    assert.equal((await f.invoke(IpcEvents.UPDATE, "main")).value, true);
    const count = f.requests.length;
    await f.tick();
    assert.equal(f.requests.length, count, "renderer gets its normal update and notice flow first");
    await f.tick();
    assert.equal(f.hooks.downloads, 1, "a broken renderer cannot strand its pending selection forever");
    assert.equal((await f.invoke(IpcEvents.BUILD)).value, true, "branchless BUILD acknowledges the native installation");
    assert.equal(f.hooks.downloads, 1);
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, false, "an empty BUILD still fails");
    assert.equal((await f.invoke(IpcEvents.UPDATE, "main", true)).value, true);
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal(f.hooks.downloads, 2, "an explicit repair still reinstalls the current archive");
    f.app.emit("will-quit");
});

test("renderer operations serialize behind a native download and do not redownload its release", async () => {
    const f = fixture();
    const started = deferred();
    const gate = deferred();
    f.hooks.download = async () => { started.resolve(); await gate.promise; };
    f.fire();
    await started.promise;
    assert.equal(f.timers.size, 0, "another fallback is not scheduled during an in-flight cycle");
    const count = f.requests.length;
    const manual = f.invoke(IpcEvents.UPDATE, "main");
    assert.equal(f.requests.length, count, "manual metadata waits for native replacement");
    gate.resolve();
    assert.equal((await manual).value, true, "the renderer can finish its install and offer Restart");
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, true);
    await f.drain();
    assert.equal(f.hooks.downloads, 1);
    assert.deepEqual(f.installs, [NEXT]);
    f.app.emit("will-quit");
});

test("renderer selection during native lookup takes over without a native download", async () => {
    const f = fixture();
    const started = deferred();
    const gate = deferred();
    f.hooks.metadata = async () => { started.resolve(); await gate.promise; };
    f.fire();
    await started.promise;
    const manual = f.invoke(IpcEvents.UPDATE, "main");
    gate.resolve();
    assert.equal((await manual).value, true);
    assert.equal(f.hooks.downloads, 0);
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal(f.hooks.downloads, 1);
    f.app.emit("will-quit");
});

test("intervening native installs revalidate other-channel selections and preserve repair intent", async () => {
    for (const repair of [false, true]) {
        const f = fixture();
        const branch = repair ? "main" : "nightly";
        assert.equal((await f.invoke(IpcEvents.UPDATE, branch, repair)).value, true);
        await f.tick();
        await f.tick();
        assert.equal(f.hooks.downloads, 1);
        if (!repair) f.hooks.hash = "c".repeat(40);
        const count = f.requests.length;
        assert.equal((await f.invoke(IpcEvents.BUILD)).value, true, "native fallback preserves the branchless renderer selection");
        assert.equal(f.hooks.downloads, 2);
        assert.equal(f.requests[count], updaterReleaseEndpoint(branch), "stale candidates reacquire selected-channel metadata");
        const status = await f.invoke(IpcEvents.GET_UPDATER_DIAGNOSTICS, branch);
        assert.equal((status.value as { builtHead: string; }).builtHead, f.hooks.hash);
        f.app.emit("will-quit");
    }
});

test("a manual update after native completion still offers Restart without another download", async () => {
    const f = fixture();
    const changes = await f.invoke(IpcEvents.GET_UPDATES, "main");
    assert.ok((changes.value as unknown[]).length > 0);
    await f.tick();
    await f.tick();
    assert.equal(f.hooks.downloads, 1);
    assert.equal((await f.invoke(IpcEvents.UPDATE, "main")).value, true);
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal(f.hooks.downloads, 1);
    assert.deepEqual((await f.invoke(IpcEvents.GET_UPDATES, "main")).value, []);
    f.app.emit("will-quit");
});

test("renderer startup during native installation receives the restart handshake", async () => {
    const f = fixture();
    const started = deferred();
    const gate = deferred();
    f.hooks.download = async () => { started.resolve(); await gate.promise; };
    f.fire();
    await started.promise;
    const initialCheck = f.invoke(IpcEvents.GET_UPDATES, "main");
    gate.resolve();
    const changes = (await initialCheck).value as Array<{ hash: string; message: string; }>;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].hash, NEXT);
    assert.match(changes[0].message, /restart/iu);
    assert.equal((await f.invoke(IpcEvents.UPDATE, "main")).value, true);
    assert.equal((await f.invoke(IpcEvents.BUILD, "main")).value, true);
    assert.equal(f.hooks.downloads, 1);
    assert.deepEqual((await f.invoke(IpcEvents.GET_UPDATES, "main")).value, []);
    f.app.emit("will-quit");
});

test("invalid saved branches fail closed and retry after settings are corrected", async () => {
    const f = fixture({ updateBranch: "invalid" });
    await f.tick();
    assert.equal(f.requests.length, 0);
    assert.equal(f.errors.length, 1);
    assert.equal(f.timers.size, 1);
    f.settings.setData({ updateBranch: "staging" });
    await f.tick();
    assert.deepEqual(f.installs, [NEXT]);
    f.app.emit("will-quit");
});
