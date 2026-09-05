/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";

function deferred<T>() {
    let resolve: ((value: T) => void) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    assert.ok(resolve && reject);
    return { promise, resolve, reject };
}

function fixture(platform: "browser" | "equibop" | "vesktop" | "legcord" = "browser") {
    const actions: { type: string; socketId: string; activity: { name: string; } | null; }[] = [];
    const assets: { applicationId: string; keys: string[]; result: ReturnType<typeof deferred<string[]>>; }[] = [];
    const notices: (() => void)[] = [];
    const errors: unknown[] = [];
    const sockets: FakeSocket[] = [];
    const controls = { failDispatch: false, failConnection: false };
    class FakeSocket {
        static OPEN = 1;
        readyState = 0;
        onclose?: () => void;
        onopen?: () => void;
        onmessage?: (event: { data: string; }) => void;
        constructor() { if (controls.failConnection) throw new Error("connection blocked"); sockets.push(this); }
        close() { this.readyState = 3; this.onclose?.(); }
    }
    const mocks: Record<string, object> = {
        "@api/Notices": { popNotice() {}, showNotice: (_message: string, _label: string, action: () => void) => notices.push(action) },
        "@api/Settings": { migratePluginSettings() {} },
        "@components/Heading": {}, "@components/Link": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error(error: unknown) { errors.push(error); } } },
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, ReporterTestable: {} },
        "@webpack/common": {
            ApplicationAssetUtils: { fetchAssetIds(applicationId: string, keys: string[]) {
                const result = deferred<string[]>(); assets.push({ applicationId, keys, result }); return result.promise;
            } },
            fetchApplicationsRPC: async (socket: { application?: { name: string; }; }, id: string) => { socket.application = { name: `Application ${id}` }; },
            FluxDispatcher: { dispatch(action: typeof actions[number]) {
                if (controls.failDispatch) { controls.failDispatch = false; throw new Error("dispatch failed"); }
                actions.push(action);
            } },
            Toasts: { show() {}, genId: () => "toast", Type: { SUCCESS: "success" }, Position: { BOTTOM: 1 } }
        }
    };
    const code = transpileModule(readFileSync("src/plugins/arRPC.web/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const plugin = runInNewContext(code + "\nexports.default;", {
        exports: {}, IS_EQUIBOP: platform === "equibop", IS_VESKTOP: platform === "vesktop",
        window: platform === "legcord" ? { legcord: {} } : {}, WebSocket: FakeSocket,
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const event = (value: unknown) => plugin.handleEvent({ data: JSON.stringify(value) });
    return { plugin, event, actions, assets, notices, sockets, errors, controls };
}

function message(name: string, socketId = "0", applicationId?: string, image?: string) {
    return { socketId, pid: 123, activity: { name, type: 0, flags: 0, application_id: applicationId, assets: image ? { large_image: image } : undefined } };
}

test("RPC remains available in browsers and hidden in clients with their own bridge", () => {
    assert.equal(fixture().plugin.hidden, false);
    for (const platform of ["equibop", "vesktop", "legcord"] as const)
        assert.equal(fixture(platform).plugin.hidden, true);
});

test("RPC accepts activity messages and discards unrelated envelope fields", async () => {
    const { event, actions } = fixture();
    await event({ ...message("Fixture"), type: "IGNORED", extra: "ignored" });
    assert.deepEqual(Object.keys(actions[0]).sort(), ["activity", "pid", "socketId", "type"]);
    assert.equal(actions[0].type, "LOCAL_ACTIVITY_UPDATE");
    assert.equal(actions[0].socketId, "arRPC:0");
    assert.equal(actions[0].activity?.name, "Fixture");
});

test("RPC ignores malformed messages before lookups or dispatch", async () => {
    const { event, plugin, actions, assets } = fixture();
    await plugin.handleEvent({ data: "invalid json" });
    await plugin.handleEvent({ data: {} });
    for (const value of [null, [], 0, {}, { activity: null },
        { socketId: 0, activity: null }, { socketId: "0", activity: "wrong" },
        { socketId: "0", activity: { name: 7 } }, { socketId: "0", activity: { application_id: [] } },
        { socketId: "0", activity: { assets: [] } }, { socketId: "0", activity: { assets: { large_image: {} } } },
        { ...message("Fixture"), pid: -1 }]) await event(value);
    assert.equal(actions.length, 0);
    assert.equal(assets.length, 0);
});

test("newer RPC messages supersede pending lookups only for their own socket", async () => {
    const { event, assets, actions } = fixture();
    const old = event(message("Old", "0", "1", "old-image"));
    const other = event(message("Other socket", "1", "1", "other-image"));
    const current = event(message("Current", "0", "1", "current-image"));
    assets[2].result.resolve(["current-id"]);
    await current;
    assets[1].result.resolve(["other-id"]);
    await other;
    assets[0].result.resolve(["old-id"]);
    await old;
    assert.deepEqual(actions.map(action => action.activity?.name), ["Current", "Other socket"]);
});

test("clearing or stopping RPC cannot be undone by an older update", async () => {
    for (const stop of [false, true]) {
        const { plugin, event, assets, actions } = fixture();
        const pending = event(message("Pending", "0", "1", "image"));
        if (stop) plugin.stop(); else await event({ socketId: "0", activity: null });
        assert.equal(actions[0].activity, null);
        assert.equal(actions[0].socketId, "arRPC:0");
        assets[0].result.resolve(["image-id"]);
        await pending;
        assert.equal(actions.length, 1);
    }
});

test("RPC stop clears only its remaining sockets", async () => {
    const { plugin, event, actions } = fixture();
    await event(message("First", "0"));
    await event(message("Second", "1"));
    await event({ socketId: "0", activity: null });
    actions.length = 0;
    plugin.stop();
    assert.deepEqual(actions.map(action => [action.socketId, action.activity]), [["arRPC:1", null]]);
});

test("late asset failures cannot remove a replacement RPC cache entry", async () => {
    const { plugin, event, assets, actions } = fixture();
    const old = event(message("Old", "0", "1", "image"));
    plugin.stop();
    const replacement = event(message("Replacement", "0", "1", "image"));
    assets[0].result.reject(new Error("old request failed"));
    await old;
    const newest = event(message("Newest", "0", "1", "image"));
    assert.equal(assets.length, 2);
    assets[1].result.resolve(["image-id"]);
    await Promise.all([replacement, newest]);
    assert.equal(actions.at(-1)?.activity?.name, "Newest");
});

test("RPC retry notices expire on stop and socket callbacks report failures", async () => {
    const { plugin, sockets, notices, actions, errors, controls, event } = fixture();
    plugin.start();
    sockets[0].close();
    plugin.stop();
    notices[0]();
    assert.equal(sockets.length, 1);
    plugin.start();
    sockets[1].readyState = 1;
    sockets[1].onopen?.();
    controls.failDispatch = true;
    sockets[1].onmessage?.({ data: JSON.stringify(message("Failure")) });
    await setImmediate();
    assert.equal(errors.length, 1);
    await event(message("Current"));
    actions.length = 0;
    sockets[1].close();
    assert.deepEqual(actions.map(action => [action.socketId, action.activity]), [["arRPC:0", null]]);
});


test("RPC startup reports constructor failures without leaving an asynchronous start rejection", () => {
    const { plugin, controls, notices, errors, sockets } = fixture();
    controls.failConnection = true;
    assert.doesNotThrow(() => plugin.start());
    assert.equal(errors.length, 1);
    assert.equal(notices.length, 1);
    plugin.stop();
    controls.failConnection = false;
    notices[0]();
    assert.equal(sockets.length, 0);
    plugin.start();
    assert.equal(sockets.length, 1);
});
function loadMusicSource(file: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, ...globals,
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
}

function appleFixture() {
    const tracks: ReturnType<typeof deferred<object | null>>[] = [];
    const actions: { socketId: string; activity: { details: string; } | null; }[] = [];
    const settings: Record<string, unknown> = {};
    const intervals = new Map<number, number>();
    const images: string[] = [];
    const errors: unknown[] = [];
    const controls = { failArtwork: false };
    let intervalId = 0;
    const plugin = loadMusicSource("src/plugins/appleMusic.desktop/index.tsx", {
        "@api/Settings": { definePluginSettings(def: Record<string, { default?: unknown; options?: { value: unknown; default?: boolean; }[]; }>) {
            for (const [key, value] of Object.entries(def)) settings[key] = value.default ?? value.options?.find(option => option.default)?.value;
            return { store: settings };
        } },
        "@components/Paragraph": {}, "@utils/constants": { Devs: {}, IS_MAC: true },
        "@utils/Logger": { Logger: class { error(error: unknown) { errors.push(error); } warn(error: unknown) { errors.push(error); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, ReporterTestable: {} },
        "@vencord/discord-types/enums": { ActivityFlags: { INSTANCE: 1 }, ActivityType: { PLAYING: 0, LISTENING: 2 }, ActivityStatusDisplayType: { NAME: 0, STATE: 1, DETAILS: 2 } },
        "@webpack/common": {
            FluxDispatcher: { dispatch: (action: typeof actions[number]) => actions.push(action) },
            ApplicationAssetUtils: { fetchAssetIds: async (_id: string, keys: string[]) => {
                images.push(...keys);
                if (controls.failArtwork) throw new Error("artwork unavailable");
                return keys;
            } }
        }
    }, {
        VencordNative: { pluginHelpers: { AppleMusicRichPresence: { fetchTrackData() {
            const request = deferred<object | null>(); tracks.push(request); return request.promise;
        } } } },
        setInterval: (_callback: unknown, delay: number) => { intervals.set(++intervalId, delay); return intervalId; },
        clearInterval: (id: number) => intervals.delete(id)
    }).default;
    return { plugin, tracks, actions, settings, intervals, images, errors, controls };
}

test("Apple Music preserves literal track text, omits disabled artwork and accepts position zero", async () => {
    const { plugin, tracks, settings, images, controls, errors } = appleFixture();
    settings.largeImageType = "Disabled";
    settings.smallImageType = "Disabled";
    const track = { name: "$& {album}", album: "Album", artist: "Artist", playerPosition: 0, duration: 60, albumArtwork: "album-image", artistArtwork: "artist-image" };
    let pending = plugin.getActivity();
    tracks[0].resolve(track);
    const activity = await pending;
    assert.equal(activity.details, "$& {album}");
    assert.equal(activity.timestamps.end - activity.timestamps.start, 60_000);
    assert.equal(images.length, 0);
    settings.largeImageType = "Album";
    settings.smallImageType = "Artist";
    controls.failArtwork = true;
    pending = plugin.getActivity();
    tracks[1].resolve(track);
    const withoutArtwork = await pending;
    assert.equal(withoutArtwork.details, "$& {album}");
    assert.equal(withoutArtwork.assets.large_image, undefined);
    assert.equal(withoutArtwork.assets.small_image, undefined);
    assert.equal(errors.length, 2);
});

test("Apple Music coalesces polls, rejects stopped results and releases failed polls for retry", async () => {
    const { plugin, tracks, actions, intervals, errors } = appleFixture();
    plugin.start();
    const old = plugin.updatePresence();
    assert.equal(plugin.updatePresence(), old);
    assert.equal(tracks.length, 1);
    plugin.stop();
    assert.equal(intervals.size, 0);
    assert.equal(actions[0].socketId, "AppleMusic");
    assert.equal(actions[0].activity, null);
    plugin.start();
    const current = plugin.updatePresence();
    tracks[0].resolve({ name: "Old" });
    await old;
    assert.equal(plugin.updatePresence(), current);
    assert.equal(tracks.length, 2);
    tracks[1].reject(new Error("Music unavailable"));
    await current;
    assert.equal(errors.length, 1);
    assert.equal(actions.at(-1)?.activity, null);
    const retry = plugin.updatePresence();
    tracks[2].resolve({ name: "Current" });
    await retry;
    assert.equal(actions.at(-1)?.activity?.details, "Current");
    assert.equal(intervals.size, 1);
    plugin.stop();
});

test("Apple Music uses its default interval for invalid imported values", async () => {
    for (const value of [0, -1, NaN, Infinity, 16, "5"]) {
        const { plugin, settings, intervals, tracks } = appleFixture();
        settings.refreshInterval = value;
        plugin.start();
        assert.deepEqual([...intervals.values()], [5000]);
        const pending = plugin.updatePresence();
        plugin.stop();
        tracks[0].resolve(null);
        await pending;
    }
});

test("Apple Music native metadata preserves an empty album field without shifting later fields", async () => {
    const commands: string[] = [];
    const native = loadMusicSource("src/plugins/appleMusic.desktop/native.ts", {
        "@shared/vencordUserAgent": { VENCORD_USER_AGENT: "fixture" },
        child_process: { execFile: async (command: string, args: string[]) => {
            commands.push(command);
            const stdout = command === "pgrep" ? "123\n"
                : args.includes("get player state") ? "playing\n"
                    : args.includes("get player position") ? "0\n"
                        : "42\nSong\n\nArtist\n60\n";
            return { stdout };
        } },
        util: { promisify: (fn: unknown) => fn }
    }, {
        URL,
        fetch: async () => ({
            json: async () => ({ resultCount: 1, results: [{ collectionName: "", trackViewUrl: "https://music.apple.com/album/fixture?i=42", artistViewUrl: "https://music.apple.com/artist/fixture", artworkUrl100: "https://fixture.invalid/100x100.png" }] }),
            text: async () => '<meta property="og:image" content="https://fixture.invalid/100x100.png">'
        })
    });
    const track = await native.fetchTrackData();
    assert.equal(track.album, "");
    assert.equal(track.artist, "Artist");
    assert.equal(track.duration, 60);
    assert.deepEqual(commands, ["pgrep", "osascript", "osascript", "osascript"]);
});


function customRpcFixture() {
    const initialTime = 1_735_689_610_000;
    const state = { now: initialTime, userId: "account" as string | undefined };
    const store = new SettingsStore({ plugins: { CustomRPC: { appName: "Fixture" } as Record<string, unknown> } }, { readOnly: true });
    const settings = { get store() { return store.store.plugins.CustomRPC; }, withPrivateSettings() { return this; } };
    const timers = new Map<number, { callback: () => void; delay: number; at: number; }>();
    let timerId = 0;
    const actions: { activity: { name: string; application_id: string; timestamps?: { start?: number; end?: number; }; buttons?: string[]; metadata?: { button_urls: string[]; }; assets?: { large_image?: string; small_image?: string; }; } | null; }[] = [];
    const assets: { appId: string; keys: string[]; result: ReturnType<typeof deferred<string[]>>; }[] = [];
    const errors: unknown[][] = [];
    const mocks: Record<string, object> = {
        "@api/Settings": { SettingsStore: store, definePluginSettings: () => settings },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@components/Divider": {}, "@components/ErrorCard": {}, "@components/Flex": {},
        "@components/Heading": {}, "@components/Link": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} }, "@utils/margins": {}, "@utils/misc": {}, "@utils/react": {},
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@vencord/discord-types/enums": { ActivityType: { PLAYING: 0, STREAMING: 1 } },
        "@webpack": { findByCodeLazy: () => {}, findComponentByCodeLazy: () => {} },
        "@webpack/common": {
            ApplicationAssetUtils: { fetchAssetIds(appId: string, keys: string[]) {
                const result = deferred<string[]>(); assets.push({ appId, keys, result }); return result.promise;
            } },
            UserStore: { getCurrentUser: () => state.userId ? { id: state.userId } : undefined },
            FluxDispatcher: { dispatch: (action: typeof actions[number]) => actions.push(action) }
        },
        "./RpcSettings": {}
    };
    const code = transpileModule(readFileSync("src/plugins/customRPC/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const module = runInNewContext(code + "\nexports;", {
        exports: {}, performance: { timeOrigin: initialTime - 10_000 + 0.75 },
        Date: class extends Date { constructor(value = state.now) { super(value); } static now() { return state.now; } },
        setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay, at: state.now + delay }); return timerId; },
        clearTimeout(id?: number) { if (id !== undefined) timers.delete(id); },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    function runNext() {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        assert.ok(next, "Expected a pending timer");
        timers.delete(next[0]); state.now = next[1].at; next[1].callback();
    }
    return { module, plugin: module.default, config: settings.store, store, state, timers, runNext, actions, assets, errors, initialTime };
}

test("custom RPC invalidates old requests immediately on edits and only publishes the latest update", async () => {
    const { module, plugin, config, store, actions, assets, runNext } = customRpcFixture();
    config.appID = "old-app"; config.imageBig = "old-image";
    plugin.start(); await setImmediate();
    assert.equal(assets[0].appId, "old-app");
    config.appName = "New"; config.appID = "new-app"; config.imageBig = "new-image";
    assets[0].result.resolve(["old-id"]); await setImmediate();
    assert.equal(actions.length, 0);
    runNext(); await setImmediate();
    assert.equal(assets[1].appId, "new-app");
    assets[1].result.resolve(["new-id"]); await setImmediate();
    assert.equal(actions.at(-1)?.activity?.name, "New");
    assert.equal(actions.at(-1)?.activity?.application_id, "new-app");
    store.store.plugins = { CustomRPC: { appName: "Imported", appID: "new-app", imageBig: "new-image" } };
    runNext(); await setImmediate();
    assert.equal(actions.at(-1)?.activity?.name, "Imported");
    assert.equal(assets.length, 2);
    const count = actions.length;
    plugin.stop(); await module.setRpc();
    assert.equal(actions.length, count + 1);
    assert.equal(actions.at(-1)?.activity, null);
});

test("custom RPC keeps replacement cache entries after old failures and retries missing assets", async () => {
    const { plugin, module, config, assets, actions } = customRpcFixture();
    config.imageBig = "image";
    plugin.start(); await setImmediate();
    plugin.stop(); plugin.start(); await setImmediate();
    assets[0].result.reject(new Error("Old request failed")); await setImmediate();
    const latest = module.setRpc(); await setImmediate();
    assert.equal(assets.length, 2);
    assets[1].result.resolve([]); await latest;
    assert.equal(actions.at(-1)?.activity?.assets, undefined);
    const retry = module.setRpc(); await setImmediate();
    assert.equal(assets.length, 3);
    assets[2].result.resolve(["valid-id"]); await retry;
    assert.equal(actions.at(-1)?.activity?.assets?.large_image, "valid-id");
    plugin.stop();
});

test("custom RPC isolates image failures and keeps button labels paired with destinations", async () => {
    const { plugin, config, assets, actions, errors } = customRpcFixture();
    Object.assign(config, { imageBig: "large", imageSmall: "small", buttonOneText: "Incomplete", buttonTwoText: "Complete", buttonTwoURL: "https://example.com" });
    plugin.start(); await setImmediate();
    assets[0].result.reject(new Error("Image unavailable")); assets[1].result.resolve(["small-id"]); await setImmediate();
    assert.equal(actions.at(-1)?.activity?.assets?.small_image, "small-id");
    assert.equal(actions.at(-1)?.activity?.assets?.large_image, undefined);
    assert.equal(JSON.stringify(actions.at(-1)?.activity?.buttons), JSON.stringify(["Complete"]));
    assert.equal(JSON.stringify(actions.at(-1)?.activity?.metadata?.button_urls), JSON.stringify(["https://example.com"]));
    assert.equal(errors.length, 1);
    plugin.stop();
});

test("custom RPC discards account-obsolete results and cancels pending updates on logout and stop", async () => {
    const { plugin, config, state, assets, actions, timers } = customRpcFixture();
    config.imageBig = "image";
    plugin.start(); await setImmediate();
    state.userId = "other-account";
    assets[0].result.resolve(["id"]); await setImmediate();
    assert.equal(actions.length, 0);
    plugin.flux.CONNECTION_OPEN(); await setImmediate();
    assert.equal(actions.length, 1);
    config.appName = "Edited";
    assert.equal(timers.size, 1);
    state.userId = undefined; plugin.flux.LOGOUT();
    assert.equal(timers.size, 0);
    assert.equal(actions.at(-1)?.activity, null);
    state.userId = "third-account"; plugin.flux.CONNECTION_OPEN(); await setImmediate();
    assets[1].result.resolve(["new-id"]); await setImmediate();
    config.appName = "Pending"; plugin.stop();
    assert.equal(timers.size, 0);
});

test("custom RPC timestamps retain document anchors and preserve the zero epoch", async () => {
    const { plugin, module, config, state, actions, initialTime } = customRpcFixture();
    config.timestampMode = 1;
    plugin.start(); await setImmediate();
    assert.equal(actions.at(-1)?.activity?.timestamps?.start, initialTime - 10_000);
    state.now += 100_000; await module.setRpc();
    assert.equal(actions.at(-1)?.activity?.timestamps?.start, initialTime - 10_000);
    config.timestampMode = 2; await module.setRpc();
    const midnight = actions.at(-1)?.activity?.timestamps?.start;
    assert.equal(midnight, new Date(initialTime - 10_000).setHours(0, 0, 0, 0));
    state.now += 86_400_000; await module.setRpc();
    assert.equal(actions.at(-1)?.activity?.timestamps?.start, midnight);
    config.timestampMode = 3; config.startTime = 0; await module.setRpc();
    assert.equal(actions.at(-1)?.activity?.timestamps?.start, 0);
    plugin.stop();
});

test("custom RPC loops restart for changed durations and stop for disabled or invalid timing", async () => {
    const { plugin, config, state, actions, timers, runNext } = customRpcFixture();
    Object.assign(config, { timestampMode: 3, startTime: 0, endTime: 10_000 });
    plugin.start(); await setImmediate();
    assert.equal([...timers.values()][0].delay, 10_000);
    const firstAnchor = actions.at(-1)?.activity?.timestamps?.start;
    state.now += 2000; config.endTime = 20_000;
    assert.equal(timers.size, 2);
    runNext(); await setImmediate();
    assert.notEqual(actions.at(-1)?.activity?.timestamps?.start, firstAnchor);
    assert.equal([...timers.values()][0].delay, 20_000);
    runNext(); await setImmediate();
    assert.equal(actions.at(-1)?.activity?.timestamps?.start, state.now);
    assert.equal([...timers.values()][0].delay, 20_000);
    config.timestampMode = 0;
    assert.equal(timers.size, 1);
    runNext(); await setImmediate();
    assert.equal(timers.size, 0);
    assert.equal(actions.at(-1)?.activity?.timestamps, undefined);
    config.timestampMode = 3; config.endTime = Number.POSITIVE_INFINITY;
    runNext(); await setImmediate();
    assert.equal(timers.size, 0);
    config.endTime = 1;
    assert.equal([...timers.values()].some(timer => timer.delay === 1000), true);
    config.endTime = 3_000_000_000;
    runNext(); await setImmediate();
    assert.equal([...timers.values()][0].delay, 2_147_483_647);
    runNext(); await setImmediate();
    assert.ok([...timers.values()][0].delay > 0 && [...timers.values()][0].delay <= 2_147_483_647);
    config.endTime = 8_640_000_000_000_000;
    runNext(); await setImmediate();
    assert.equal(timers.size, 0);
    assert.equal(actions.at(-1)?.activity?.timestamps?.end, 8_640_000_000_000_000);
    plugin.stop(); assert.equal(timers.size, 0);
});
