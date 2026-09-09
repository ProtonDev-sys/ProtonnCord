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

const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
const tick = () => new Promise(resolve => setImmediate(resolve));

function load(file: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, expose = "") {
    const imports: Record<string, unknown> = {
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {}, ReporterTestable: {} },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@api/Settings": { definePluginSettings(def: any) { const store = Object.fromEntries(Object.entries(def).map(([key, value]: [string, any]) => [key, value.default])); return { store, def, use: () => store }; } },
        "@utils/Logger": { Logger: class { error() {} } },
        ...mocks
    };
    const code = transpileModule(readFileSync(file, "utf8") + expose, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, console, URL,
        require(name: string) {
            if (name.includes(".css")) return {};
            assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
            return imports[name];
        },
        ...globals
    });
}

test("InvisibleChat keeps decrypted URLs local by default and does not mutate shared embeds", async () => {
    const updates: any[] = [];
    const requests: unknown[] = [];
    const api = load("src/equicordplugins/invisibleChat.desktop/index.tsx", {
        "@api/ChatButtons": {}, "@api/MessageUpdater": { updateMessage: (...args: unknown[]) => updates.push(args) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } }, "@utils/dependencies": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, Constants: { Endpoints: {} }, RestAPI: { post: async (request: unknown) => { requests.push(request); return { body: { embeds: [{ color: 258 }] } }; } } },
        "./components/DecryptionModal": {}, "./components/EncryptionModal": {}
    });
    const message = { channel_id: "channel", id: "message", embeds: Object.freeze([{ title: "existing" }]) };
    await api.buildEmbed(message, "https://example.com/private");
    assert.equal(requests.length, 0);
    assert.equal(message.embeds.length, 1);
    assert.equal(updates[0][2].embeds.length, 2);
    api.default.settings.store.previewDecryptedLinks = true;
    await api.buildEmbed(message, "https://example.com/private");
    assert.equal(requests.length, 1);
    assert.equal(updates[1][2].embeds[2].color, "#000102");
});

test("InvisibleChat ignores a stopped initialization and stale optional preview completion", async () => {
    let finishLoad: ((value: unknown) => void) | undefined;
    let finishPreview: ((value: unknown) => void) | undefined;
    let initialized = 0;
    let updated = 0;
    const api = load("src/equicordplugins/invisibleChat.desktop/index.tsx", {
        "@api/ChatButtons": {}, "@api/MessageUpdater": { updateMessage() { updated++; } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@utils/dependencies": { getStegCloak: () => new Promise(resolve => { finishLoad = resolve; }) },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "self" }) }, Constants: { Endpoints: {} }, RestAPI: { post: () => new Promise(resolve => { finishPreview = resolve; }) } },
        "./components/DecryptionModal": {}, "./components/EncryptionModal": {}
    });
    const start = api.default.start();
    api.default.stop();
    finishLoad!({ default: class { constructor() { initialized++; } } });
    await start;
    assert.equal(initialized, 0);
    api.default.settings.store.previewDecryptedLinks = true;
    const pending = api.buildEmbed({ channel_id: "channel", id: "message", embeds: [] }, "https://example.com/private");
    api.default.stop();
    finishPreview!({ body: { embeds: [] } });
    await pending;
    assert.equal(updated, 0);
});

test("JumpTo searches the message's own guild and selects a matching hit over surrounding context", async () => {
    const jumps: string[] = [];
    const requests: any[] = [];
    const plugin = load("src/equicordplugins/jumpTo/index.tsx", {
        "@webpack/common": {
            Menu: { MenuItem: "item" }, ChannelStore: { getChannel: () => ({ guild_id: "message-guild" }) }, UserStore: { getCurrentUser: () => ({ id: "self" }) },
            Constants: { Endpoints: { SEARCH_GUILD: (id: string) => id } }, NavigationRouter: { transitionTo: (path: string) => jumps.push(path) },
            RestAPI: { get: async (request: unknown) => { requests.push(request); return { body: { messages: [[{ id: "context", channel_id: "channel", author: { id: "other" } }, { id: "hit", channel_id: "channel", author: { id: "author" }, hit: true }]] } }; } }
        }
    }).default;
    const menu: any[] = [];
    plugin.contextMenus.message(menu, { message: { channel_id: "channel", author: { id: "author" } } });
    await menu[0].props.action();
    assert.equal(requests[0].url, "message-guild");
    assert.deepEqual(jumps, ["/channels/message-guild/channel/hit"]);
});

test("JumpTo does not apply an old response after plugin stop", async () => {
    let finish: ((response: unknown) => void) | undefined;
    let jumps = 0;
    const plugin = load("src/equicordplugins/jumpTo/index.tsx", {
        "@webpack/common": {
            Menu: { MenuItem: "item" }, SelectedChannelStore: { getChannelId: () => null }, UserStore: { getCurrentUser: () => ({ id: "self" }) },
            Constants: { Endpoints: { MESSAGES: () => "messages" } }, NavigationRouter: { transitionTo() { jumps++; } },
            RestAPI: { get: () => new Promise(resolve => { finish = resolve; }) }
        }
    }).default;
    const menu: any[] = [];
    plugin.contextMenus["channel-context"](menu, { channel: { id: "channel" } });
    const pending = menu[1].props.action();
    plugin.stop();
    finish!({ body: [{ id: "last" }] });
    await pending;
    assert.equal(jumps, 0);
});

test("KeyboardNavigation dialog promises settle when closed and preserve selected values", async () => {
    for (const [file, functionName, value] of [
        ["MultipleChoice", "openMultipleChoice", { id: "one", label: "One" }],
        ["TextInput", "openSimpleTextInput", "typed"]
    ] as const) {
        const opened: any[] = [];
        const api = load(`src/equicordplugins/keyboardNavigation/components/${file}.tsx`, {
            "@webpack/common": { React, openModal: (render: unknown, options: unknown) => { opened.push({ render, options }); return "dialog"; } },
            "..": {}
        });
        const cancelled = api[functionName]([]);
        opened[0].options.onCloseCallback();
        assert.equal(await cancelled, null);
        const selected = api[functionName]([]);
        opened[1].render({}).props.onSelect(value);
        opened[1].options.onCloseCallback();
        assert.equal(await selected, value);
    }
});

test("KeyboardNavigation records safely from an empty key sequence and cancels on unmount", () => {
    const listeners = new Map<string, (event?: any) => void>();
    const effects: (() => (() => void))[] = [];
    const target = {
        addEventListener(name: string, callback: any, capture = false) { listeners.set(`${name}:${capture}`, callback); },
        removeEventListener(name: string, callback: any, capture = false) { if (listeners.get(`${name}:${capture}`) === callback) listeners.delete(`${name}:${capture}`); }
    };
    const api = load("src/equicordplugins/keyboardNavigation/index.tsx", {
        "./commands": {}, "./components/CommandPalette": { closeCommandPalette() {} },
        "@webpack/common": { useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }), useEffect: (effect: any) => effects.push(effect) }
    }, { document: target, window: target, IS_DEV: false });
    const recorder = api.settings.def.hotkey.component();
    const cleanup = effects[0]();
    recorder.props.onClick();
    listeners.get("keyup:true")!({ key: "Shift", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(Array.from(api.settings.store.hotkey), ["Control", "Shift", "P"]);
    recorder.props.onClick();
    for (const key of ["Control", "Shift", "P"]) listeners.get("keydown:true")!({ key, preventDefault() {}, stopPropagation() {} });
    for (const key of ["p", "Shift", "Control"]) listeners.get("keyup:true")!({ key, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(Array.from(api.settings.store.hotkey), ["control", "shift", "p"]);
    recorder.props.onClick();
    cleanup();
    assert.equal(listeners.size, 0);
    api.default.stop();
});

test("KeyboardNavigation contains rejected callbacks and closes only its own palette", async () => {
    let closed = 0;
    let failures = 0;
    const tree = load("src/equicordplugins/keyboardNavigation/components/CommandPalette.tsx", {
        "@equicordplugins/keyboardNavigation/commands": { actions: [{ id: "failure", label: "Failure", callback: () => Promise.reject(new Error("failed")) }] },
        "..": { settings: { store: { allowMouseControl: true } } },
        "@webpack/common": {
            React, useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }), useEffect() {},
            showToast() { failures++; }, Toasts: { Type: {} }, closeAllModals() { assert.fail("unrelated dialogs remain open"); }
        }
    }).CommandPalette({ modalProps: { onClose() { closed++; } } });
    const click = tree.props.children[0].props.children[1].props.children[0][0].props.onClick;
    click();
    click();
    await tick();
    assert.equal(closed, 1);
    assert.equal(failures, 1);
});

test("KeyboardNavigation action registration replaces duplicate IDs and restores previous registrations on cleanup", () => {
    const api = load("src/equicordplugins/keyboardNavigation/commands.tsx", {
        "@api/Notifications": {}, "@api/PluginManager": {}, "@shared/vencordUserAgent": {}, "@utils/clipboard": {}, "@utils/native": {}, "@utils/updater": {}, "@webpack/common": {},
        "~git-remote": {}, "~plugins": {}, "./components/MultipleChoice": {}, "./components/TextInput": {}
    });
    const original = { id: "owned", label: "First" };
    const removeOriginal = api.registerAction(original);
    const replacement = { id: "owned", label: "Second" };
    const removeReplacement = api.registerAction(replacement);
    assert.equal(api.actions.filter((action: any) => action.id === "owned").length, 1);
    removeReplacement();
    assert.equal(api.actions.find((action: any) => action.id === "owned"), original);
    removeOriginal();
    assert.equal(api.actions.some((action: any) => action.id === "owned"), false);
});

test("KeyboardSounds does not allocate disabled previews and releases active players on stop", () => {
    let created = 0;
    let deleted = 0;
    const target = { addEventListener() {}, removeEventListener() {} };
    const plugin = load("src/equicordplugins/keyboardSounds/index.ts", {
        "@api/AudioPlayer": { createAudioPlayer() { created++; return { delete() { deleted++; }, restart() { throw new Error("unavailable"); } }; } },
        "./packs": { ignoredKeys: [], packs: { operagx: { others: ["mock-sound"], backspaces: [] } } }
    }, { document: target, window: target }).default;
    plugin.settings.store.soundPack = "operagx";
    plugin.settings.def.volume.onChange(50);
    assert.equal(created, 0);
    plugin.start();
    assert.equal(created, 3);
    plugin.stop();
    assert.equal(deleted, 3);
    plugin.settings.def.volume.onChange(75);
    assert.equal(created, 3);
});
