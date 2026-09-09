/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function loadPlugin(path: string, helpers = "", mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
    const settings: any = { store: {}, use: () => settings.store };
    const defaults = {
        "@api/Settings": {
            definePluginSettings: (options: any) => {
                settings.def = options;
                for (const [key, value] of Object.entries<any>(options)) {
                    settings.store[key] = value.default ?? value.options?.find((v: any) => v.default)?.value;
                }
                return settings;
            },
            migratePluginSetting() { }
        },
        "@utils/types": { default: (plugin: any) => plugin, OptionType: {}, StartAt: {} },
        "@utils/constants": { EquicordDevs: {}, Devs: {} },
        "@utils/Logger": { Logger: class { error() { } } },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/misc": { isObject: (value: any) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@webpack": { findByCodeLazy: () => () => undefined, findCssClassesLazy: () => ({}) },
        "@components/ErrorBoundary": { default: { wrap: (component: any) => component } }
    };
    const output = transpileModule(readFileSync(`src/equicordplugins/${path}`, "utf8") + helpers, {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false }
    }).outputText;
    const exports: any = {};
    runInNewContext(output, {
        exports, structuredClone, Set, Map, setTimeout, clearTimeout, setInterval, clearInterval,
        console: { error() { } },
        React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
        require: (id: string) => mocks[id] ?? defaults[id] ?? {},
        ...globals
    });
    return { ...exports, settings };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

test("GlobalBadges avoids settings work for users without badges", () => {
    let reads = 0;
    const store = new Proxy({}, { get: () => { reads++; return true; } });
    const { getBadges, setBadges } = loadPlugin("globalBadges/utils.ts", "\nexport function setBadges(badges) { GlobalBadges = badges; }", {
        "./settings": { settings: { store } }
    });
    assert.equal(getBadges("missing"), undefined);
    assert.equal(reads, 0);
    setBadges({ empty: [] });
    assert.equal(getBadges("empty").length, 0);
    assert.equal(reads, 0);
    setBadges({ user: [{ mod: "aero", badge: "fixture.png", tooltip: "Fixture" }] });
    assert.equal(getBadges("user")[0].tooltip, "Fixture");
    assert.ok(reads > 0);
});

test("HideChatButtons keeps hooks unconditional and remembers the last open state", () => {
    const hookCalls: string[] = [];
    const effects: (() => void)[] = [];
    let initialState: any;
    const { ButtonsInnerComponent, settings, setOpenFixture } = loadPlugin("hideChatButtons/index.tsx",
        "\nexport { ButtonsInnerComponent }; export function setOpenFixture(value) { hidechatbuttonsopen = value; }", {
            "@webpack/common": {
                useState: (value: any) => { hookCalls.push("state"); initialState = value; return [value, () => { throw new Error("Remount must preserve toggle"); }]; },
                useRef: (value: any) => { hookCalls.push("ref"); return { current: value }; },
                useEffect: (callback: any) => { hookCalls.push("effect"); effects.push(callback); }
            }
        });
    settings.store.open = false;
    setOpenFixture(true);
    assert.equal(ButtonsInnerComponent({ buttons: [] }), null);
    const emptyHookCalls = [...hookCalls];
    hookCalls.length = 0;
    ButtonsInnerComponent({ buttons: [{ props: {} }] });
    assert.deepEqual(hookCalls, emptyHookCalls);
    assert.equal(initialState, true);
    for (const effect of effects) effect();
});

test("HideMessages restores the original DM list when its patched props already contain filtered IDs", () => {
    const { default: plugin, toggleDm } = loadPlugin("hideMessages/index.tsx", "\nexport { toggleDm };", {
        "@api/PluginManager": { isPluginEnabled: () => false }
    });
    const original = ["visible", "hidden"];
    const instance = { forceUpdate() { } };
    toggleDm("hidden");
    const filtered = plugin.filterPrivateChannelIds(original, instance);
    assert.deepEqual(Array.from(filtered), ["visible"]);
    toggleDm("hidden");
    assert.equal(plugin.filterPrivateChannelIds(filtered, instance), original);
    toggleDm("hidden");
    const filteredAgain = plugin.filterPrivateChannelIds(original, instance);
    plugin.stop();
    assert.equal(plugin.filterPrivateChannelIds(filteredAgain, instance), original);
});

function hiddenServers(dataStore: any) {
    return loadPlugin("hideServers/HiddenServersStore.ts", "", {
        "@api/DataStore": dataStore,
        "@webpack": { proxyLazyWebpack: (factory: any) => factory() },
        "@webpack/common": { Flux: { Store: class { emitChange() { } } } }
    }).HiddenServersStore;
}

test("HideServers stop before loading completes does not overwrite persisted guilds", async () => {
    const pending = deferred<string[]>();
    const writes: any[] = [];
    const store = hiddenServers({ get: () => pending.promise, set: (_: string, value: any) => writes.push(value) });
    const loading = store.load();
    await Promise.resolve();
    store.unload();
    pending.resolve(["saved-guild"]);
    await loading;
    assert.deepEqual(writes, []);
    assert.equal(store.hiddenGuilds.size, 0);
});

test("HideServers orders pending saves before reset and reload", async () => {
    const writing = deferred<void>();
    const operations: string[] = [];
    const store = hiddenServers({
        get: () => { operations.push("get"); return []; },
        set: () => { operations.push("set"); return writing.promise; },
        del: () => { operations.push("delete"); }
    });
    store.addHiddenGuild("a");
    store.unload();
    await Promise.resolve();
    store.clearHidden();
    const loading = store.load();
    assert.deepEqual(operations, ["set"]);
    writing.resolve();
    await loading;
    assert.deepEqual(operations, ["set", "delete", "get"]);
});

test("IRememberYou preserves changes made during a save and does not save an unloaded collection", async () => {
    const pending = deferred<void>();
    const writes: any[] = [];
    const { Data } = loadPlugin("iRememberYou/components/data.tsx", "", {
        "@api/DataStore": { set: (_: string, value: any) => { writes.push(value); return writes.length === 1 ? pending.promise : Promise.resolve(); } }
    });
    const data = new Data();
    await data.stop();
    assert.equal(writes.length, 0);
    const user = (username: string) => ({ id: "1", username, discriminator: "0", getAvatarURL: () => "fixture.png" });
    data.processUsersToCollection([{ user: user("before") }]);
    const saving = data.updateStorage();
    await Promise.resolve();
    data.processUsersToCollection([{ user: user("after") }]);
    pending.resolve();
    await saving;
    await data.updateStorage();
    assert.deepEqual(writes.map(value => value.dm.users["1"].username), ["before", "after"]);
});

test("IRememberYou rejects malformed persisted data without overwriting it", async () => {
    let writes = 0;
    const { Data } = loadPlugin("iRememberYou/components/data.tsx", "", {
        "@api/DataStore": { get: async () => ({ broken: null }), set: () => { writes++; } }
    });
    const data = new Data();
    await assert.rejects(data.initializeUsersCollection(), /Invalid saved/);
    await data.stop();
    assert.equal(writes, 0);
});

test("IdleAutoRestart settings cannot attach listeners or timers after stop", () => {
    let listeners = 0;
    let timers = 0;
    const { default: plugin, settings, getIdleMs } = loadPlugin("idleAutoRestart/index.tsx", "\nexport { getIdleMs };", {}, {
        document: { addEventListener: () => listeners++, removeEventListener: () => listeners-- },
        setTimeout: () => ++timers,
        clearTimeout: () => timers--
    });
    settings.def.isEnabled.onChange(true);
    assert.equal(listeners, 0);
    plugin.start();
    assert.equal(listeners, 4);
    plugin.stop();
    settings.def.isEnabled.onChange(true);
    assert.equal(listeners, 0);
    assert.equal(timers, 0);
    settings.store.idleMinutes = NaN;
    assert.equal(getIdleMs(), 30 * 60_000);
});

function keywordPlugin(dataStore: any, dispatcher: any = {}) {
    return loadPlugin("keywordNotify/index.tsx", "\nexport { compiledRegex, safeMatchesRegex, highlightKeywords }; export function setEntries(entries) { keywordEntries = entries; }", {
        "@api/index": { DataStore: dataStore },
        "@webpack/common": {
            FluxDispatcher: { _interceptors: [], ...dispatcher },
            UserStore: { getCurrentUser: () => ({ id: "me" }) },
            ChannelStore: { getChannel: () => ({ guild_id: "guild" }) }
        }
    });
}

test("KeywordNotify does not install its interceptor after a pending startup is stopped", async () => {
    const reading = deferred<any[]>();
    let added = 0;
    const { default: plugin } = keywordPlugin({ get: () => reading.promise }, { addInterceptor: () => added++ });
    const starting = plugin.start();
    await Promise.resolve();
    plugin.stop();
    reading.resolve([]);
    await starting;
    assert.equal(added, 0);
});

test("KeywordNotify tolerates partial updates, caches regexes, and adds only one mention", () => {
    const { default: plugin, setEntries, compiledRegex, safeMatchesRegex, highlightKeywords } = keywordPlugin({});
    setEntries([{ regex: "hello", whitelist: [], blacklist: [], ignoreBots: true }]);
    assert.equal(compiledRegex("hello", "i"), compiledRegex("hello", "i"));
    assert.equal(safeMatchesRegex(undefined, "hello", ""), false);
    assert.equal(safeMatchesRegex("hello", "[", ""), false);
    plugin.applyKeywordEntries({ id: "partial" });
    plugin.storeMessage = () => undefined;
    plugin.addToLog = () => undefined;
    const message = { id: "m", channel_id: "c", author: { id: "other" }, content: "hello", mentions: [] };
    plugin.applyKeywordEntries(message);
    plugin.applyKeywordEntries(message);
    assert.equal(message.mentions.length, 1);
    const highlighted = highlightKeywords("hello", [{ regex: "[" }, { regex: "" }, { regex: "hello" }]);
    assert.equal(highlighted.props.children[1].props.children[0], "hello");
});
