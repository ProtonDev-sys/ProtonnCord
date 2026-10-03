/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTestModule } from "./utils/loadTestModule";

function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, expose = "") {
    return loadTestModule(`src/equicordplugins/${file}`, {}, {
        URL, AbortController, AbortSignal, Error, Promise,
        require(name: string) {
            assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
            return imports[name];
        },
        ...globals
    }, expose, { mockImports: false });
}

function deferred<T = any>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const logger = { Logger: class { warn() {} error() {} } };

function timers() {
    let id = 0;
    const callbacks = new Map<number, { fn: Function; ms: number; }>();
    return {
        callbacks,
        setTimeout(fn: Function, ms: number) { callbacks.set(++id, { fn, ms }); return id; },
        clearTimeout(key: number) { callbacks.delete(key); },
        fire(ms: number) {
            const entry = [...callbacks].find(([, value]) => value.ms === ms);
            assert.ok(entry, `Missing timer ${ms}`);
            callbacks.delete(entry[0]);
            entry[1].fn();
        }
    };
}

function navidrome(fetch: Function) {
    let now = 100_000;
    const clock = timers();
    const listeners = new Set<Function>();
    const events: any[] = [];
    const store: any = {
        nd_serverUrl: "https://music.invalid", nd_username: "self", nd_password: "fixture",
        nd_albumArtMode: "lastfm", nd_detailsString: "{song}", nd_refreshInterval: 10
    };
    const api = load("richPresence/services/navidrome.ts", {
        "@api/Settings": { SettingsStore: {
            addGlobalChangeListener: (fn: Function) => listeners.add(fn),
            removeGlobalChangeListener: (fn: Function) => listeners.delete(fn)
        } },
        "@utils/Logger": logger, "@utils/misc": { parseUrl: (value: string) => new URL(value) },
        "@vencord/discord-types/enums": { ActivityFlags: {}, ActivityStatusDisplayType: {} },
        "@webpack/common": {
            ApplicationAssetUtils: { fetchAssetIds: async (_: string, keys: string[]) => keys },
            FluxDispatcher: { dispatch: (event: any) => events.push(event) }
        },
        md5: { __esModule: true, default: () => "hash" }, "../settings": { settings: { store } },
        "./navidromePrivacy": { normalizeNavidromeAlbumArtMode: (value: string) => value === "lastfm" ? value : "none" }
    }, { ...clock, fetch, Date: class extends Date { static now() { return now; } } }, "\nexport { lastFmCache };\n");
    return { api, store, events, listeners, clock, advance: (ms: number) => { now += ms; } };
}
const track = (id = "track") => ({ id, username: "self", title: id, artist: "artist", album: "album", duration: 3600 });
const nowPlaying = (entry: any) => ({ ok: true, json: async () => ({ "subsonic-response": { nowPlaying: { entry: [entry] } } }) });

test("RZ5-01 cancels old Navidrome configuration and unregisters its listener", async () => {
    for (const key of ["nd_username", "nd_serverUrl", "nd_albumArtMode", "nd_detailsString"]) {
        const pending = deferred();
        let firstSignal: AbortSignal | undefined;
        let calls = 0;
        const h = navidrome((_: string, options: any) => {
            if (++calls === 1) { firstSignal = options.signal; return pending.promise; }
            return Promise.resolve(nowPlaying(null));
        });
        h.api.start();
        h.store[key] = "changed";
        // The real settings store iterates the live Set, so restarting must not
        // remove and re-add the listener during dispatch.
        let notifications = 0;
        for (const listener of h.listeners) {
            assert.ok(++notifications < 3);
            listener(null, `plugins.RichPresence.${key}`);
        }
        assert.equal(firstSignal?.aborted, true);
        pending.resolve(nowPlaying(track("old")));
        await tick();
        assert.equal(h.events.some(event => event.activity), false);
        h.api.stop();
        assert.equal(h.listeners.size, 0);
    }
});

test("RZ5-01 snapshot rejects changes even without a delivered settings notification", async () => {
    const pending = deferred();
    let calls = 0;
    const h = navidrome(() => ++calls === 1 ? pending.promise : Promise.resolve(nowPlaying(null)));
    h.api.start();
    h.store.nd_albumArtMode = "none";
    pending.resolve(nowPlaying(track()));
    await tick();
    assert.equal(h.events.some(event => event.activity), false);
    h.api.stop();
});

test("RZ5-02 retries failed Last.fm artwork on the same unchanged track", async () => {
    let artCalls = 0;
    const h = navidrome((url: string) => {
        if (!url.includes("audioscrobbler")) return Promise.resolve(nowPlaying(track()));
        if (++artCalls === 1) return Promise.reject(new Error("temporary failure"));
        return Promise.resolve({ ok: true, json: async () => ({ album: { image: [{ "#text": "https://art.invalid/cover" }] } }) });
    });
    h.api.start();
    await tick();
    assert.equal(h.events.at(-1).activity.assets.large_image, "navidrome");
    h.clock.fire(10_000);
    await tick();
    assert.equal(artCalls, 1);
    h.advance(60_001);
    h.clock.fire(10_000);
    await tick();
    assert.equal(artCalls, 2);
    assert.equal(h.events.at(-1).activity.assets.large_image, "https://art.invalid/cover");
    h.api.stop();
});

test("RZ5-01 disabling artwork cancels an outstanding Last.fm lookup", async () => {
    const pending = deferred();
    let signal: AbortSignal | undefined;
    const h = navidrome((url: string, options: any) => {
        if (!url.includes("audioscrobbler")) return Promise.resolve(nowPlaying(track()));
        signal = options.signal;
        return pending.promise;
    });
    h.api.start();
    await tick();
    assert.equal(signal?.aborted, false);
    h.store.nd_albumArtMode = "none";
    for (const listener of h.listeners) listener(null, "plugins.RichPresence.nd_albumArtMode");
    assert.equal(signal?.aborted, true);
    pending.resolve({ ok: true, json: async () => ({ album: { image: [{ "#text": "https://old.invalid/cover" }] } }) });
    await tick();
    assert.equal(h.events.filter(event => event.activity).length, 1);
    assert.equal(h.events.at(-1).activity.assets.large_image, "navidrome");
    assert.equal(h.api.lastFmCache.size, 0);
    h.api.stop();
});

test("RZ5-03 bounds Last.fm cache while polling distinct tracks", async () => {
    let tracks = 0;
    const h = navidrome((url: string) => Promise.resolve(url.includes("audioscrobbler")
        ? { ok: true, json: async () => ({ album: { image: [{ "#text": "https://art.invalid/cover" }] } }) }
        : nowPlaying(track(String(++tracks)))));
    h.api.start();
    await tick();
    for (let i = 0; i < 175; i++) { h.clock.fire(10_000); await tick(); }
    assert.equal(h.api.lastFmCache.size, 150);
    h.api.stop();
    assert.equal(h.api.lastFmCache.size, 0);
});

function tosu(asset: Function, fetch: Function) {
    const clock = timers();
    const events: any[] = [];
    let socket: any;
    class Socket {
        listeners = new Map<string, Function>();
        constructor() { socket = this; }
        addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
        close() {}
    }
    const enums = load("richPresence/types/tosu.ts", {});
    const api = load("richPresence/services/tosu.ts", {
        "@vencord/discord-types/enums": { ActivityType: { PLAYING: 0, LISTENING: 2 } },
        "@webpack/common": { FluxDispatcher: { dispatch: (event: any) => events.push(event) } },
        "../types/tosu": enums, "./assetCache": { getCachedApplicationAsset: asset }
    }, { ...clock, WebSocket: Socket, fetch });
    api.start();
    return { api, clock, events, message: (value: any) => socket.listeners.get("message")({ data: JSON.stringify(value) }) };
}
const game = (title: string, set = 1) => ({
    state: { number: 0 }, session: { playTime: 0 }, profile: { mode: { number: 0 }, banchoStatus: { number: 0 } },
    beatmap: { set, artist: "artist", title, version: "version", mapper: "mapper", stats: { stars: { total: 1 } } },
    play: { mods: { name: "" } }
});

test("RZ5-04 slow older tosu messages cannot overwrite the newest activity", async () => {
    const pending = deferred<string>();
    const h = tosu(() => pending.promise, async () => ({ ok: true }));
    h.message(game("old"));
    await tick();
    h.clock.fire(3000);
    h.message(game("new", 0));
    await tick();
    pending.resolve("mp:cover");
    await tick();
    const published = h.events.filter(event => event.activity);
    assert.equal(published.length, 1);
    assert.match(published[0].activity.name, /new/);
    h.api.stop();
});

test("RZ5-05 stopping tosu aborts cover HEAD work", async () => {
    const pending = deferred();
    let signal: AbortSignal | undefined;
    const h = tosu(async () => "mp:cover", (_: string, options: any) => { signal = options.signal; return pending.promise; });
    h.message(game("old"));
    await tick();
    assert.equal(signal?.aborted, false);
    h.api.stop();
    assert.equal(signal?.aborted, true);
    pending.resolve({ ok: true });
    await tick();
    assert.equal(h.events.some(event => event.activity), false);
});

function rpc() {
    let failed = false;
    const React = {
        createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
        useState: () => [failed, (value: boolean) => { failed = value; }]
    };
    const components = Object.fromEntries(["Button", "Card", "CheckedTextInput", "FormSwitch", "Paragraph"].map(name => [`@components/${name}`, { [name]: name }]));
    const api = load("rpcEditor/ReplaceSettings.tsx", {
        ...components, "@components/Heading": { Heading: "Heading", HeadingSecondary: "HeadingSecondary" },
        "@utils/margins": { Margins: {} }, "@utils/misc": {},
        "@vencord/discord-types/enums": { ActivityFlags: {}, ActivityType: { PLAYING: 0, STREAMING: 1 } },
        "@webpack/common": { React, SnowflakeUtils: { extractTimestamp: () => 1 }, TextInput: "TextInput" },
        ".": { makeEmptyAppId: () => ({ appId: "", enabled: true }) }
    }, { React });
    return { api, get failed() { return failed; } };
}
function nodes(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== "object") return [];
    return [node, ...nodes(node.props?.children)];
}

test("RZ5-06 stream URLs require the exact supported hostname", () => {
    const { isValidStreamUrl } = rpc().api;
    for (const url of ["https://youtube.com/watch?v=1", "https://www.twitch.tv/channel", "http://twitch.tv/channel"]) assert.equal(isValidStreamUrl(url), true);
    for (const url of ["https://example.invalid/?next=https://youtube.com/x", "https://youtube.com.example.invalid/x", "ftp://youtube.com/x", "https://user@youtube.com/x", "bad"]) assert.equal(isValidStreamUrl(url), false);
});

test("RZ5-07 failed RPC saves retain edits and expose a working retry", async () => {
    const h = rpc();
    const appIds = [{ appId: "123456789012345678", enabled: true, newActivityType: 0, unknown: "preserved" }, { appId: "" }];
    let writes = 0;
    const props = { appIds, update() {}, save: async () => { if (++writes === 1) throw new Error("disk failure"); } };
    const view = h.api.ReplaceSettings(props);
    nodes(view).find(node => node.type === "TextInput").props.onChange("edited");
    await tick();
    assert.equal(h.failed, true);
    assert.equal((appIds[0] as any).newName, "edited");
    assert.equal(appIds[0].unknown, "preserved");
    const retry = nodes(h.api.ReplaceSettings(props)).find(node => node.type === "Button");
    assert.ok(retry);
    retry.props.onClick();
    await tick();
    assert.equal(writes, 2);
    assert.equal(h.failed, false);
});

test("RZ5-06 invalid saved stream URLs are preserved in storage but never assigned", async () => {
    const saved = [{ appId: "app", enabled: true, newActivityType: 1, newStreamUrl: "https://example.invalid/?next=https://youtube.com/x" }];
    const api = load("rpcEditor/index.tsx", {
        "@api/index": { DataStore: { get: async () => saved } },
        "@api/Settings": { definePluginSettings: () => ({}) }, "@utils/constants": { Devs: {} },
        "@utils/react": {}, "@utils/types": { __esModule: true, default: (value: any) => value, OptionType: {} },
        "@vencord/discord-types/enums": { ActivityType: { PLAYING: 0, STREAMING: 1 } },
        "@webpack/common": {}, "./ReplaceSettings": rpc().api
    });
    await api.default.start();
    const activity: any = { application_id: "app", name: "original" };
    api.default.patchActivity(activity);
    assert.equal(activity.url, undefined);
    assert.equal(saved[0].newStreamUrl, "https://example.invalid/?next=https://youtube.com/x");
    saved[0].newStreamUrl = "https://twitch.tv/channel";
    api.default.patchActivity(activity);
    assert.equal(activity.url, saved[0].newStreamUrl);
});

test("RZ5-08 Jellyfin publishes text when artwork resolution rejects", async () => {
    let getActivity: Function | undefined;
    const api = load("richPresence/services/jellyfin.ts", {
        "@utils/Logger": logger, "@utils/text": {}, "@webpack/common": {},
        "./assetCache": { getCachedApplicationAsset: async () => { throw new Error("unavailable"); } },
        "./polling": { createPresencePolling: (_: string, __: number, fn: Function) => { getActivity = fn; return {}; } }
    }, { fetch: async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => [{
        UserId: "self", NowPlayingItem: { Id: "movie", Name: "Movie", Type: "Movie", ImageTags: { Primary: "image" } }
    }] }) });
    assert.ok(api);
    const activity = await getActivity!({ jf_serverUrl: "https://media.invalid", jf_apiKey: "fixture", jf_userId: "self", jf_overrideType: "off" }, {
        signal: new AbortController().signal, isCurrent: () => true, wait: (promise: Promise<any>) => promise
    });
    assert.equal(activity.details, "Movie");
    assert.equal(activity.assets.large_image, undefined);
});
