/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

const tick = () => new Promise(resolve => setImmediate(resolve));
const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = "") {
    return loadTestModule(file, imports, { React, URL, AbortController, console, ...globals }, expose);
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const logger = { Logger: class { error() {} warn() {} info() {} } };
const presencePath = "src/equicordplugins/richPresence/";
function serviceFixture(file: string, store: Record<string, unknown>, extraImports: Record<string, unknown> = {}, extraGlobals: Record<string, unknown> = {}) {
    const actions: any[] = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const addTimer = (fn: () => void) => { timers.set(++timerId, fn); return timerId; };
    const imports = {
        "../settings": { settings: { store } },
        "@utils/Logger": logger,
        "@utils/text": { formatDurationMs: (value: number) => String(value) },
        "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@webpack/common": {
            FluxDispatcher: { dispatch: (action: unknown) => { actions.push(action); } },
            showToast() {}, ApplicationAssetUtils: { fetchAssetIds: async () => ["asset"] }
        },
        "@vencord/discord-types/enums": { ActivityType: { PLAYING: 0, LISTENING: 2 }, ActivityFlags: { INSTANCE: 1 }, ActivityStatusDisplayType: {} },
        "./assetCache": { getCachedApplicationAsset: async () => "asset" },
        ...extraImports
    };
    const api = load(presencePath + file, imports, {
        setInterval: addTimer, setTimeout: addTimer,
        clearInterval: (id: number) => timers.delete(id), clearTimeout: (id: number) => timers.delete(id),
        ...extraGlobals
    });
    return { api, actions, timers };
}

test("RichPresence migration retains legacy data and respects destination preferences", () => {
    const plugins: Record<string, any> = {
        RichPresence: { enabled: true, abs_enabled: false, abs_serverUrl: "https://chosen.invalid", unrelated: 7 },
        AudioBookShelfRichPresence: { enabled: true, serverUrl: "https://old.invalid", username: "old-user", password: "fixture", unknown: { keep: true } },
        StatsfmPresence: { enabled: true, shareSong: false },
        TosuRPC: { enabled: true, future: "keep" }
    };
    const before = structuredClone(plugins.AudioBookShelfRichPresence);
    const api = load(presencePath + "migration.ts", {
        "@api/Settings": { PlainSettings: { plugins }, Settings: { plugins } },
        "@utils/Logger": logger, "./settings": { settings: { store: plugins.RichPresence } }
    });
    api.migrateOldSettings();
    assert.equal(plugins.RichPresence.abs_enabled, false);
    assert.equal(plugins.RichPresence.abs_serverUrl, "https://chosen.invalid");
    assert.equal(plugins.RichPresence.abs_username, "old-user");
    assert.equal(plugins.RichPresence.sfm_shareSong, false);
    assert.equal(plugins.RichPresence.sfm_enabled, true);
    assert.equal(plugins.RichPresence.tosu_enabled, true);
    assert.equal(plugins.RichPresence.unrelated, 7);
    assert.deepEqual(plugins.AudioBookShelfRichPresence, before);
    plugins.RichPresence.abs_username = "new-user";
    api.migrateOldSettings();
    assert.equal(plugins.RichPresence.abs_username, "new-user");
});

test("RichPresence isolates partial service failure and removes callbacks before cleanup", () => {
    const calls: string[] = [];
    let callback: (() => void) | null = null;
    const ids = ["AudioBookShelf", "Tosu", "StatsFm", "Jellyfin", "GensokyoRadio", "Navidrome"];
    const serviceNames = ["audiobookshelf", "tosu", "statsfm", "jellyfin", "gensokyoRadio", "navidrome"];
    const imports: Record<string, unknown> = {
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/Logger": logger,
        "@utils/types": { __esModule: true, default: (value: unknown) => value, ReporterTestable: {} },
        "./types": { ServiceTab: Object.fromEntries(ids.map((id, i) => [id, serviceNames[i]])) },
        "./migration": { migrateOldSettings() {} },
        "./settings": { settings: { store: { enabled: true, abs_enabled: true, tosu_enabled: true, sfm_enabled: true } }, setOnServiceChange: (value: typeof callback) => { callback = value; } }
    };
    serviceNames.forEach(name => {
        imports[`./services/${name}`] = {
            start() { calls.push(`start:${name}`); if (name === "audiobookshelf") throw new Error("start failed"); },
            stop() { calls.push(`stop:${name}`); if (name === "tosu") { assert.equal(callback, null); throw new Error("stop failed"); } }
        };
    });
    const plugin = load(presencePath + "index.tsx", imports).default;
    plugin.start();
    assert.deepEqual(calls, ["start:audiobookshelf", "stop:audiobookshelf", "start:tosu", "start:statsfm"]);
    plugin.stop();
    assert.deepEqual(calls.slice(-2), ["stop:tosu", "stop:statsfm"]);
    const count = calls.length;
    plugin.stop();
    assert.equal(calls.length, count);
});

test("evicted asset rejection cannot delete the replacement request", async () => {
    const requests: ReturnType<typeof deferred<string[]>>[] = [];
    const api = load(presencePath + "services/assetCache.ts", {
        "@webpack/common": { ApplicationAssetUtils: { fetchAssetIds() { const request = deferred<string[]>(); requests.push(request); return request.promise; } } }
    });
    const first = api.getCachedApplicationAsset("app", "first");
    const rejection = assert.rejects(first, /old request/);
    for (let i = 0; i < 150; i++) api.getCachedApplicationAsset("app", `entry-${i}`);
    const replacement = api.getCachedApplicationAsset("app", "first");
    requests[0].reject(new Error("old request"));
    await rejection;
    assert.equal(api.getCachedApplicationAsset("app", "first"), replacement);
    requests.at(-1)!.resolve(["replacement"]);
    assert.equal(await replacement, "replacement");
    const missing = api.getCachedApplicationAsset("app", "missing");
    requests.at(-1)!.resolve([]);
    await assert.rejects(missing, /unavailable/);
    const retry = api.getCachedApplicationAsset("app", "missing");
    requests.at(-1)!.resolve(["now available"]);
    assert.equal(await retry, "now available");
});

test("AudioBookShelf discards a login completed after stop and uses only the new session", async () => {
    const requests: { url: string; init: RequestInit; response: ReturnType<typeof deferred<any>>; }[] = [];
    const fixture = serviceFixture("services/audiobookshelf.ts", { abs_serverUrl: "https://abs.invalid", abs_username: "user", abs_password: "fixture" }, {}, {
        fetch: (url: string, init: RequestInit) => { const response = deferred<any>(); requests.push({ url, init, response }); return response.promise; }
    });
    fixture.api.start();
    fixture.api.stop();
    fixture.api.start();
    requests[0].response.resolve({ ok: true, json: async () => ({ user: { token: "old-token" } }) });
    await tick();
    assert.equal(requests.length, 2);
    requests[1].response.resolve({ ok: true, json: async () => ({ user: { token: "new-token" } }) });
    await tick();
    assert.equal((requests[2].init.headers as any).Authorization, "Bearer new-token");
    requests[2].response.resolve({ ok: true, json: async () => ({ sessions: [] }) });
    await tick();
    fixture.api.stop();
    assert.equal(fixture.timers.size, 0);
});

test("AudioBookShelf does not reuse tokens after server edits and bounds 401 reauthentication", async () => {
    const store = { abs_serverUrl: "https://first.invalid", abs_username: "user", abs_password: "fixture" };
    const requests: { url: string; init: any; }[] = [];
    let unauthorized = false;
    const fixture = serviceFixture("services/audiobookshelf.ts", store, {}, {
        fetch: async (url: string, init: any) => {
            requests.push({ url, init });
            if (url.endsWith("/login")) return { ok: true, json: async () => ({ user: { token: url.includes("first") ? "first-token" : "second-token" } }) };
            return unauthorized ? { ok: false, status: 401 } : { ok: true, json: async () => ({ sessions: [] }) };
        }
    });
    fixture.api.start();
    await tick();
    store.abs_serverUrl = "https://second.invalid";
    unauthorized = true;
    fixture.timers.values().next().value!();
    await tick();
    assert.equal(requests.length, 6, "one initial session and one bounded retry on the edited server");
    assert.equal(requests[2].url, "https://second.invalid/login");
    assert.equal(requests[3].init.headers.Authorization, "Bearer second-token");
    fixture.timers.values().next().value!();
    await tick();
    assert.equal(requests.length, 6, "failed authorization observes cooldown");
    fixture.api.stop();
});

test("Jellyfin privacy mode hides media labels and normal playback retains position zero", async () => {
    for (const format of ["default", "full", "custom"]) {
        const store: Record<string, unknown> = { jf_serverUrl: "https://jf.invalid", jf_apiKey: "fixture", jf_userId: "me", jf_privacyMode: true, jf_showPausedState: true, jf_nameDisplay: format, jf_customName: "{name} {series} {album} {name}", jf_overrideType: "off" };
        const fixture = serviceFixture("services/jellyfin.ts", store, {}, {
            fetch: async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => [{ UserId: "me", PlayState: { PositionTicks: 0 }, NowPlayingItem: { Name: "PRIVATE_TITLE", Type: "Episode", SeriesName: "PRIVATE_SERIES", Album: "PRIVATE_ALBUM", ParentIndexNumber: 7, IndexNumber: 3, RunTimeTicks: 100000000 } }] })
        });
        fixture.api.start();
        await tick();
        const activity = fixture.actions.at(-1).activity;
        assert.equal(activity.name, "Jellyfin");
        assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_|S07E03/);
        store.jf_privacyMode = false;
        fixture.timers.values().next().value!();
        await tick();
        assert.equal(typeof fixture.actions.at(-1).activity.timestamps.start, "number");
        fixture.api.stop();
    }
});

test("Navidrome starts once and does not duplicate a restarted polling timer", async () => {
    let fetches = 0;
    let restartOnNextDispatch = false;
    let fixture: ReturnType<typeof serviceFixture>;
    fixture = serviceFixture("services/navidrome.ts", { nd_serverUrl: "https://nd.invalid", nd_username: "user", nd_password: "fixture" }, {
        "md5": { __esModule: true, default: () => "fixture-token" },
        "./navidromePrivacy": { normalizeNavidromeAlbumArtMode: () => "none" },
        "@webpack/common": { ApplicationAssetUtils: {}, FluxDispatcher: { dispatch() {
            if (restartOnNextDispatch) { restartOnNextDispatch = false; fixture.api.stop(); fixture.api.start(); }
        } } }
    }, { fetch: async () => { fetches++; return { ok: true, json: async () => ({ "subsonic-response": { nowPlaying: { entry: [] } } }) }; } });
    fixture.api.start();
    fixture.api.start();
    restartOnNextDispatch = true;
    await tick();
    assert.equal(fetches, 2);
    assert.equal(fixture.timers.size, 1);
    fixture.api.stop();
    assert.equal(fixture.timers.size, 0);
});

test("tosu contains malformed messages and cleans connection timers", async () => {
    const sockets: { callbacks: Record<string, (event: any) => void>; close(): void; }[] = [];
    class Socket {
        callbacks: Record<string, (event: any) => void> = {};
        constructor() { sockets.push(this); }
        addEventListener(name: string, fn: (event: any) => void) { this.callbacks[name] = fn; }
        close() {}
    }
    const fixture = serviceFixture("services/tosu.ts", {}, {
        "../types/tosu": { BanchoStatusEnum: {}, GameState: {}, Modes: {} }
    }, { WebSocket: Socket });
    fixture.api.start();
    sockets[0].callbacks.message({ data: "invalid json" });
    await tick();
    assert.equal(fixture.actions.at(-1).activity, null);
    fixture.api.stop();
    assert.equal(fixture.timers.size, 0);
});

test("RichPresence fields subscribe to current settings and hide credential values", () => {
    const store: Record<string, unknown> = { abs_password: "fixture", abs_enabled: true };
    const api = load(presencePath + "SettingsPanel.tsx", {
        "@components/settings/tabs/plugins/components/Common": { SettingsSection: "section" },
        "@components/Switch": { Switch: "switch" }, "@utils/margins": { Margins: {} }, "@utils/misc": { classes() {} },
        "@webpack/common": { Select: "select", TextInput: "input", useState() { throw new Error("must subscribe"); } },
        "./settings": { settings: { store, use: () => store } }, "./types": { ServiceTab: {}, NameFormat: {} }
    }, {}, "\nexport { TextSetting, SwitchSetting };\n");
    const password = api.TextSetting({ name: "Password", description: "", settingsKey: "abs_password" });
    assert.equal(password.props.children[0].props.type, "password");
    assert.equal(password.props.children[0].props.value, "fixture");
    store.abs_password = "edited";
    assert.equal(api.TextSetting({ settingsKey: "abs_password" }).props.children[0].props.value, "edited");
    api.SwitchSetting({ settingsKey: "abs_enabled" }).props.children[0].props.onChange(false);
    assert.equal(store.abs_enabled, false);
});
