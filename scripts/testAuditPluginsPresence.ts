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

function load(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", { exports: {}, ...globals, require: (name: string) => mocks[name] ?? {} });
}

function presenceFixture() {
    const store = { username: "user", scrobblerBackend: "lastfm" };
    const updates: unknown[] = [];
    const requests: { resolve(value: unknown): void; reject(error: Error): void; }[] = [];
    const timers = new Set<() => void>();
    let account = "first";
    const plugin = load("src/plugins/musicRichPresence/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }), migratePluginSetting() {}, migratePluginSettings() {} },
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": {
            AuthenticationStore: { getId: () => account },
            FluxDispatcher: { dispatch: (event: { activity: unknown; }) => updates.push(event.activity) }
        }
    }, {
        setInterval: (callback: () => void) => { timers.add(callback); return callback; },
        clearInterval: (callback: () => void) => timers.delete(callback)
    }).default;
    plugin.getActivity = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
    return { plugin, store, updates, requests, timers, setAccount: (value: string) => account = value };
}

test("music presence serializes polls, clears on stop, and ignores old completions after restart", async () => {
    const api = presenceFixture();
    api.plugin.start();
    await api.plugin.updatePresence();
    assert.equal(api.requests.length, 1);
    api.plugin.stop();
    assert.deepEqual(api.updates, [null]);
    assert.equal(api.timers.size, 0);
    api.plugin.start();
    assert.equal(api.requests.length, 2);
    api.requests[0].resolve({ name: "old" });
    await setImmediate();
    await api.plugin.updatePresence();
    assert.equal(api.requests.length, 2);
    const current = { name: "current" };
    api.requests[1].resolve(current);
    await setImmediate();
    assert.deepEqual(api.updates, [null, current]);
    api.plugin.stop();
});

test("music presence discards switched-account and changed-source results and contains failures", async () => {
    const api = presenceFixture();
    api.plugin.start();
    api.setAccount("second");
    api.requests.shift()!.resolve({ name: "old account" });
    await setImmediate();
    assert.deepEqual(api.updates, []);
    const second = api.plugin.updatePresence();
    api.store.username = "other";
    api.requests.shift()!.resolve({ name: "old source" });
    await second;
    assert.deepEqual(api.updates, []);
    const third = api.plugin.updatePresence();
    api.requests.shift()!.reject(new Error("Asset lookup failed"));
    await third;
    assert.deepEqual(api.updates, [null]);
    api.store.username = "";
    await api.plugin.updatePresence();
    assert.deepEqual(api.updates, [null, null]);
    api.plugin.stop();
});

test("scrobbler requests have deadlines and encode username path segments", async () => {
    const deadlines: number[] = [];
    const requests: { url: string; options: { signal: unknown; }; }[] = [];
    const mocks = {
        ".": { settings: { store: { username: "a/b", scrobblerBackend: "lastfm" } } },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/TTLMap": { TTLMap: Map }
    };
    const globals = {
        URLSearchParams,
        AbortSignal: { timeout: (ms: number) => { deadlines.push(ms); return { deadline: ms }; } },
        fetch: async (url: string, options: { signal: unknown; }) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ recenttracks: { track: [] }, payload: { listens: [] } }) };
        }
    };
    const lastfm = load("src/plugins/musicRichPresence/lastfm.ts", mocks, globals).LastFMScrobbler;
    // TTLMap accepts a duration whereas native Map accepts entries.
    mocks["@utils/TTLMap"] = { TTLMap: class extends Map { constructor() { super(); } } };
    const listenbrainz = load("src/plugins/musicRichPresence/listenbrainz.ts", mocks, globals).ListenBrainzScrobbler;
    assert.equal(await lastfm.fetchTrackData(), null);
    assert.equal(await listenbrainz.fetchTrackData(), null);
    assert.deepEqual(deadlines, [10000, 10000]);
    assert.ok(requests.every(request => request.options.signal));
    assert.ok(requests[1].url.includes("/a%2Fb/"));
    assert.ok(lastfm.getUserURL("a/b").endsWith("/a%2Fb"));
    assert.ok(listenbrainz.getUserURL("a/b").endsWith("/a%2Fb"));
});
