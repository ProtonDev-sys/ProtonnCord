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

function load(path: string, helpers = "", mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
    const settings: any = { store: {}, use: () => settings.store };
    const defaults: Record<string, any> = {
        "@api/Settings": { definePluginSettings: (options: any) => {
            for (const [key, value] of Object.entries<any>(options)) settings.store[key] = value.default ?? value.options?.find((entry: any) => entry.default)?.value;
            return settings;
        } },
        "@utils/types": { default: (plugin: any) => plugin, OptionType: {}, StartAt: {}, makeRange: () => [] },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/guards": { isNonNullish: (value: any) => value != null },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack": { findByPropsLazy: () => ({}) },
        "@shared/debounce": { debounce: (callback: any) => callback }
    };
    const source = readFileSync(`src/equicordplugins/${path}`, "utf8") + helpers;
    const output = transpileModule(source, { fileName: path, compilerOptions: {
        module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, esModuleInterop: false
    } }).outputText;
    const exports: any = {};
    runInNewContext(output, {
        exports, require: (id: string) => mocks[id] ?? defaults[id] ?? {},
        React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
        console, setTimeout, clearTimeout, AbortSignal, AbortController, URL, Blob, File,
        ...globals
    });
    exports.settingsFixture = settings;
    return exports;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("PolishWording preserves literal placeholder text and inline code", () => {
    const plugin = load("polishWording/index.ts");
    const source = "__CODE_BLOCK_0__ __VC_POLISH_CODE_0__ `dont change` and dont";
    const message = { content: source };
    plugin.default.onBeforeMessageSend("channel", message);
    assert.equal(message.content, "__CODE_BLOCK_0__ __VC_POLISH_CODE_0__ `dont change` and don't");
    plugin.settingsFixture.store.fixApostrophes = false;
    const literal = { content: "__CODE_BLOCK_100__ __VC_POLISH_CODE_1__" };
    plugin.default.onBeforeMessageSend("channel", literal);
    assert.equal(literal.content, "__CODE_BLOCK_100__ __VC_POLISH_CODE_1__");
});

test("NotificationTitle handles uncached thread parents and reply authors", () => {
    const plugin = load("notificationTitle.discordDesktop/index.tsx", "", {
        "@utils/discord": { getIntlMessage: (_key: string, values: any) => `${values.author} replied to ${values.repliedAuthor}` },
        "@webpack": {
            findByPropsLazy: (...props: string[]) => props[0] === "getName" ? { getName: (_guild: string, _channel: string, user: any) => user.username }
                : props[0] === "DM" ? { DM: 1 } : props[0] === "THREADS" ? { THREADS: new Set([11]) } : { REPLY: 19 },
            findByCodeLazy: () => (channel: any) => channel.name
        },
        "@webpack/common": { UserStore: { getUser: () => undefined }, GuildStore: { getGuild: () => undefined }, ChannelStore: { getChannel: () => undefined } }
    }).default;
    const result = plugin.makeTitle({}, { id: "thread", type: 11, name: "topic" }, {
        type: 19, referenced_message: { author: { id: "uncached", username: "reply" } }
    }, { username: "sender" });
    assert.equal(result.title, "sender replied to reply\n(topic)");
    assert.equal(plugin.makeTitle(null, null, null, null), null);
});

test("CancelFriendRequest ignores absent users and catches rejected cancellations", async () => {
    let checked = 0;
    let errors = 0;
    const plugin = load("pendingFriendRequest/index.tsx", "", {
        "@vencord/discord-types/enums": { RelationshipType: { OUTGOING_REQUEST: 4 } },
        "@webpack": { findByPropsLazy: () => ({ cancelFriendRequest: async () => { throw new Error("offline"); } }) },
        "@webpack/common": { RelationshipStore: { getRelationshipType: () => { checked++; return 4; } }, showToast: () => errors++, Toasts: { Type: { FAILURE: 1 } } }
    }).default;
    await plugin.getCancelFriendRequestTextButtonProps(undefined).onClick();
    assert.equal(checked, 0);
    await plugin.getCancelFriendRequestTextButtonProps("user").onClick();
    assert.equal(errors, 1);
});

test("PersistentAudioPlayback isolates replacement players from stale rejection and stop", async () => {
    const plays: ReturnType<typeof deferred<void>>[] = [];
    class AudioFixture {
        paused = false; ended = false; currentTime = 0; duration = NaN; muted = false; playbackRate = 1; volume = 1;
        constructor(public src: string) {}
        addEventListener() {} removeEventListener() {} pause() { this.paused = true; }
        play() { const pending = deferred<void>(); plays.push(pending); return pending.promise; }
    }
    const plugin = load("persistentAudioPlayback/index.tsx", "\nexport { continueDetached, detachedPlayers, seek };", {
        "@webpack/common": { showToast() {}, Toasts: { Type: {} } }
    }, { Audio: AudioFixture });
    plugin.default.start();
    plugin.settingsFixture.store.showWidget = false;
    const snapshot = { src: "fixture", duration: 30, currentTime: 2, volume: 1, muted: false, playbackRate: 1 };
    plugin.continueDetached("audio", snapshot);
    plugin.continueDetached("audio", snapshot);
    const current = plugin.detachedPlayers.get("fixture");
    plays[0].reject(new Error("stale"));
    await tick();
    assert.equal(plugin.detachedPlayers.get("fixture"), current);
    plugin.seek(current, -15);
    assert.equal(current.audio.currentTime, 0);
    plugin.default.stop();
    plugin.continueDetached("audio", snapshot);
    assert.equal(plugin.detachedPlayers.size, 0);
    plays[1].resolve();
});

function storageFixture(data = new Map<string, any>(), write?: (key: string, value: any) => Promise<void>) {
    const state = { user: "alice", errors: 0 };
    const storage = load("profileSets/utils/storage.ts", "", {
        "@api/index": { DataStore: {
            get: async (key: string) => data.get(key),
            set: write ?? (async (key: string, value: any) => { data.set(key, value); }),
            del: async (key: string) => { data.delete(key); }
        } },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: state.user }) }, showToast: () => state.errors++, Toasts: { Type: { FAILURE: 1 } } }
    });
    return { storage, state, data };
}

test("ProfileSets validates stored/imported shapes and migrates legacy arrays", async () => {
    const legacy = [{ name: "legacy", timestamp: 1, bio: "saved" }];
    const { storage, data } = storageFixture(new Map([ ["ProfileDataset", legacy] ]));
    await storage.loadPresets("main");
    assert.equal(storage.presets[0].bio, "saved");
    assert.equal(data.has("ProfileDataset"), false);
    assert.deepEqual(data.get("ProfilePresets_v2_Main:alice"), legacy);
    assert.equal(storage.isProfilePresetList([{ name: "broken", timestamp: 1, bio: {} }]), false);
    assert.equal(storage.isProfilePresetList([null]), false);
    data.set("ProfilePresets_v2_Main:alice", [{ name: 123 }]);
    await storage.loadPresets("main");
    assert.equal(storage.getPresetScope("main"), null);
    assert.equal(await storage.savePresetsData("main"), false);
    assert.deepEqual(data.get("ProfilePresets_v2_Main:alice"), [{ name: 123 }]);
});

test("ProfileSets serializes immutable snapshots and rejects other account/section writes", async () => {
    const first = deferred<void>();
    const writes: any[] = [];
    const { storage, state } = storageFixture(new Map(), async (key, value) => {
        writes.push({ key, value });
        if (writes.length === 1) await first.promise;
    });
    await storage.loadPresets("main");
    storage.addPreset({ name: "one", timestamp: 1 });
    const one = storage.savePresetsData("main");
    storage.addPreset({ name: "two", timestamp: 2 });
    const two = storage.savePresetsData("main");
    await tick();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].value.length, 1);
    assert.equal(await storage.savePresetsData("server"), false);
    state.user = "bob";
    assert.equal(storage.getPresetScope("main"), null);
    assert.equal(await storage.savePresetsData("main"), false);
    first.resolve();
    await Promise.all([one, two]);
    assert.equal(writes[1].value.length, 2);
    assert.equal(writes[1].key, "ProfilePresets_v2_Main:alice");
});

test("ProfileSets drops stale saves and refreshes all fields in one persistence call", async () => {
    const { storage } = storageFixture();
    await storage.loadPresets("main");
    const pending = deferred<any>();
    const actions = load("profileSets/utils/actions.ts", "", {
        "./storage": storage, "./profile": { getCurrentProfile: () => pending.promise },
        "@webpack/common": { UserProfileSettingsStore: { getPendingChanges: () => ({}) } }
    });
    const saving = actions.savePreset("stale", "main");
    await storage.loadPresets("server");
    pending.resolve({ bio: "stale" });
    assert.equal(await saving, false);
    assert.equal(storage.presets.length, 0);
    const preset = { name: "fixture", timestamp: 1, bio: "before", avatarDecoration: { skuId: "old" } };
    storage.addPreset(preset);
    let writes = 0;
    const refresh = load("profileSets/utils/actions.ts", "", {
        "./storage": Object.assign({}, storage, { savePresetsData: async () => { writes++; } }),
        "./profile": { getCurrentProfile: async () => ({ bio: "after", avatarDecoration: null }) },
        "@webpack/common": { showToast() {}, Toasts: { Type: {} } }
    });
    await refresh.refreshPreset(0, "server");
    assert.equal(storage.presets[0].bio, "after");
    assert.equal(storage.presets[0].avatarDecoration, null);
    assert.equal(writes, 1);
});

test("ProfileSets dismissed import prompts settle as cancelled once", () => {
    const cleanups: (() => void)[] = [];
    let cancellations = 0;
    let confirmations = 0;
    const plugin = load("profileSets/components/confirmModal.tsx", "", {
        "@webpack/common": { React: {
            useRef: (current: any) => ({ current }), useEffect: (callback: any) => cleanups.push(callback()),
            createElement: (_type: any, props: any) => props
        } }
    });
    plugin.ImportProfilesModal({ onCancel: () => cancellations++, onClose() {}, onMerge() {}, onOverride() {} });
    cleanups[0]();
    assert.equal(cancellations, 1);
    const modal = plugin.ImportProfilesModal({ onCancel: () => cancellations++, onClose() {}, onMerge() {}, onOverride: () => confirmations++ });
    modal.actions[0].onClick();
    modal.actions[0].onClick();
    cleanups[1]();
    assert.equal(confirmations, 1);
    assert.equal(cancellations, 1);
});

test("QuickThemeSwitcher discards startup results after stop", async () => {
    const pending = deferred<any[]>();
    let listeners = 0;
    const fixture = load("quickThemeSwitcher.discordDesktop/index.tsx", "\nexport { themeList };", {
        "@api/Settings": { definePluginSettings: () => ({ store: { includeLocal: true, includeOnline: false } }), Settings: {}, SettingsStore: { removeChangeListener() {} } },
        "@webpack/common": {}
    }, { window: { VencordNative: { themes: { getThemesList: () => pending.promise } } }, document: { addEventListener: () => listeners++, removeEventListener() {} } });
    const current = fixture.default.start();
    fixture.default.stop();
    pending.resolve([{ fileName: "fixture.css" }]);
    await current;
    assert.equal(fixture.themeList.length, 0);
    assert.equal(listeners, 0);
});

test("PersistentAudioPlayback retains position identity when clamping does not move it", () => {
    const position = { left: 20, top: 20 };
    let refs = 0;
    let updates = 0;
    const fixture = load("persistentAudioPlayback/index.tsx", "\nexport { DetachedAudioWidget };", {
        "@webpack/common": { React: {
            useReducer: () => [0, () => {}],
            useState: () => [position, (update: any) => { updates++; assert.equal(update(position), position); }],
            useRef: () => ({ current: refs++ === 0 ? null : { getBoundingClientRect: () => ({ width: 100, height: 100 }) } }),
            useCallback: (callback: any) => callback,
            useEffect: (callback: any) => callback()
        } }
    }, { window: { innerWidth: 800, innerHeight: 600, addEventListener() {} }, document: { addEventListener() {} } });
    fixture.DetachedAudioWidget();
    assert.equal(updates, 1);
});

test("ProfileSets applies only the latest selection and restores cleared preferences", async () => {
    const dispatched: any[] = [];
    const statuses: any[] = [];
    const fixture = load("profileSets/utils/profile.ts", "", {
        "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => ({ text: "before" }), updateSetting: (value: any) => statuses.push(value) }) },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "alice", avatar: "data:image/png,fixture", primaryGuild: { identityGuildId: "guild" }, displayNameStyles: { font_id: 1, effect_id: 1, colors: [1] } }) },
            UserProfileStore: { getUserProfile: () => ({ bio: "before", accentColor: 123, themeColors: [1, 2] }) },
            UserProfileSettingsStore: { getPendingChanges: () => ({}) },
            FluxDispatcher: { dispatch: (value: any) => dispatched.push(value) }
        }
    });
    const one = fixture.loadPresetAsPending({ name: "one", timestamp: 1, bio: "obsolete" });
    const two = fixture.loadPresetAsPending({ name: "two", timestamp: 2, bio: "latest", accentColor: null, themeColors: null, primaryGuildId: null, displayNameStyles: null, customStatus: null });
    await Promise.all([one, two]);
    assert.equal(dispatched.some(event => event.pendingBio === "obsolete"), false);
    assert.equal(dispatched.some(event => event.pendingBio === "latest"), true);
    for (const field of ["pendingAccentColor", "pendingThemeColors", "pendingPrimaryGuildId", "pendingDisplayNameStyles"])
        assert.equal(dispatched.some(event => field in event && event[field] === null), true, field);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].text, "");
    const before = dispatched.length;
    const cancelled = fixture.loadPresetAsPending({ name: "cancelled", timestamp: 3, bio: "cancelled" });
    fixture.cancelPendingPresetLoad();
    await cancelled;
    assert.equal(dispatched.length, before);
});

test("Quoter ignores completed preview work after its modal is disposed", async () => {
    const pending = deferred<Blob>();
    const effects: (() => void)[] = [];
    let timer: () => void = () => {};
    let created = 0;
    const fixture = load("quoter/index.tsx", "\nexport { QuoteModal };", {
        "./types": { QuoteFont: {} },
        "./utils": { createQuoteImage: () => pending.promise },
        "@webpack/common": {
            useState: (initial: any) => [initial, () => {}],
            useEffect: (callback: any) => { const cleanup = callback(); if (cleanup) effects.push(cleanup); },
            IconUtils: { getUserAvatarURL: () => "fixture" }
        }
    }, { setTimeout: (callback: any) => { timer = callback; return 1; }, clearTimeout() {}, URL: { createObjectURL: () => { created++; return "blob:fixture"; } } });
    fixture.QuoteModal({ message: { content: "quote", author: { username: "author" } } });
    timer();
    for (const cleanup of effects) cleanup();
    pending.resolve(new Blob());
    await tick();
    assert.equal(created, 0);
});

test("Remix initializes mouse coordinates on left-button down and cleans listeners", () => {
    const listeners = new Map<string, any>();
    const target = { width: 200, height: 100, getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
        addEventListener: (name: string, callback: any) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) };
    const emitter = load("remix/editor/utils/eventEmitter.ts");
    const fixture = load("remix/editor/input.ts", "", { "./components/Canvas": { canvas: target }, "./utils/eventEmitter": emitter });
    const cleanup = fixture.initInput();
    listeners.get("mousedown")({ button: 2, clientX: 30, clientY: 40 });
    assert.equal(fixture.Mouse.down, false);
    listeners.get("mousedown")({ button: 0, clientX: 30, clientY: 40 });
    assert.equal(fixture.Mouse.down, true);
    assert.equal(fixture.Mouse.x, 40);
    assert.equal(fixture.Mouse.prevY, 40);
    cleanup();
    assert.equal(listeners.size, 0);
    assert.equal(fixture.Mouse.down, false);
});
