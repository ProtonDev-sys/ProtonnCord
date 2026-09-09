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

function load(file: string, mocks: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, expose = "") {
    const imports: Record<string, unknown> = {
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {}, makeRange: () => [0.25, 1, 3.5] },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@api/Settings": { definePluginSettings(def: any) { const store = Object.fromEntries(Object.entries(def).map(([key, value]: [string, any]) => [key, value.default])); return { store, use: () => store }; } },
        "@utils/Logger": { Logger: class { error() {} } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        ...mocks
    };
    const code = transpileModule(readFileSync(file, "utf8") + expose, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, console,
        require(name: string) {
            if (name.includes(".css")) return {};
            assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
            return imports[name];
        },
        ...globals
    });
}

function burst(editMessage: (...args: any[]) => unknown, timestamp: Date | string = new Date()) {
    return load("src/equicordplugins/messageBurst/index.ts", {
        "@webpack/common": {
            ChannelStore: { getChannel: () => ({ isGroupDM: () => false }) },
            MessageStore: { getMessages: () => ({ last: () => ({ id: "last", author: { id: "self" }, timestamp, content: "earlier" }) }) },
            UserStore: { getCurrentUser: () => ({ id: "self" }) }, MessageActions: { editMessage }, showToast() {}, Toasts: { Type: {} }
        }
    }, { document: { querySelector: () => null } }).default;
}

test("MessageBurst preserves the composed text while an edit is pending and when it rejects", async () => {
    let reject!: (error: Error) => void;
    const plugin = burst(() => new Promise((_, no) => { reject = no; }));
    const message = { content: "new text" };
    const pending = plugin.onBeforeMessageSend("channel", message, {}, {});
    assert.equal(message.content, "new text");
    reject(new Error("network failure"));
    assert.equal((await pending).cancel, true);
    assert.equal(message.content, "new text");
});

test("MessageBurst clears text only after a successful edit and preserves the configured separator", async () => {
    let finish!: () => void;
    const edits: any[] = [];
    const plugin = burst((...args: any[]) => { edits.push(args); return new Promise<void>(resolve => { finish = resolve; }); });
    plugin.settings.store.useSpace = true;
    const message = { content: "new text" };
    const pending = plugin.onBeforeMessageSend("channel", message, {}, {});
    assert.equal(edits[0][2].content, "earlier new text");
    assert.equal(message.content, "new text");
    finish();
    await pending;
    assert.equal(message.content, "");
});

test("MessageBurst leaves replies, uploads, stickers and invalid timestamps on the normal send path", async () => {
    let edits = 0;
    const plugin = burst(() => { edits++; });
    for (const [options, props] of [[{ messageReference: {} }, {}], [{}, { hasAttachments: true }], [{}, { hasStickers: true }]]) {
        const message = { content: "new text" };
        await plugin.onBeforeMessageSend("channel", message, options, props);
        assert.equal(message.content, "new text");
    }
    await burst(() => { edits++; }, "invalid").onBeforeMessageSend("channel", { content: "text" }, {}, {});
    assert.equal(edits, 0);
});

test("Markdown table parser preserves original raw text, alignment and fenced code", () => {
    const parser = load("src/equicordplugins/markdownTables/parser.ts");
    const table = "| A | B |\r\n| :--- | ---: |\r\n| one | two |";
    const result = parser.parseMarkdownTableMatch("prefix\r\n" + table + "\r\nafter");
    assert.equal(result.leadingMarkdown, "prefix\r\n");
    assert.equal(result.tableRaw, table);
    assert.deepEqual(Array.from(result.table.alignments), ["left", "right"]);
    assert.equal(parser.parseMarkdownTableMatch("```\n" + table + "\n```"), null);
    assert.deepEqual(Array.from(parser.splitTableRow("| escaped \\| pipe | text |")), ["escaped | pipe", "text"]);
});

test("MarkdownTables removes all owned rules and pending installs while preserving another rule owner", () => {
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const primary: any = { defaultRules: { paragraph: { order: 1 } } };
    let found!: (parser: unknown) => void;
    const plugin = load("src/equicordplugins/markdownTables/index.tsx", {
        "@components/CodeBlock": {}, "./parser": {}, "@webpack": { waitFor: (_: unknown, callback: any) => { found = callback; } }, "@webpack/common": { Parser: primary }
    }, { window: { setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id) } }).default;
    const secondary: any = { defaultRules: { paragraph: { order: 4 } } };
    plugin.start();
    found(secondary);
    for (const [id, callback] of timers) { timers.delete(id); callback(); }
    assert.equal(primary.defaultRules.markdownTable.order, 0.5);
    assert.equal(secondary.defaultRules.markdownTable.order, 3.5);
    const replacement = {};
    primary.defaultRules.markdownTable = replacement;
    plugin.stop();
    assert.equal(primary.defaultRules.markdownTable, replacement);
    assert.equal(secondary.defaultRules.markdownTable, undefined);
    plugin.start();
    plugin.stop();
    found(secondary);
    assert.equal(timers.size, 0);
});

test("MessageFetchTimer refreshes subscribers and records later fetches for revisited channels", () => {
    let now = 0;
    const subscriptions = new Map<string, Function>();
    const api = load("src/equicordplugins/messageFetchTimer/index.tsx", {
        "@api/ChatButtons": {}, "@utils/discord": { getCurrentChannel: () => null },
        "@webpack/common": { FluxDispatcher: { subscribe: (event: string, fn: Function) => subscriptions.set(event, fn), unsubscribe: (event: string) => subscriptions.delete(event) } }
    }, { performance: { now: () => now } }, "\nexport { channelTimings, subscribeTimings };\n");
    let notifications = 0;
    const unsubscribe = api.subscribeTimings(() => { notifications++; });
    api.default.start();
    assert.equal(subscriptions.has("MESSAGE_CREATE"), false);
    subscriptions.get("CHANNEL_SELECT")!({ channelId: "a" });
    now = 10;
    subscriptions.get("LOAD_MESSAGES_SUCCESS")!({ channelId: "a" });
    assert.equal(api.channelTimings.get("a").time, 10);
    subscriptions.get("CHANNEL_SELECT")!({ channelId: "b" });
    subscriptions.get("CHANNEL_SELECT")!({ channelId: "a" });
    now = 35;
    subscriptions.get("LOAD_MESSAGES_SUCCESS")!({ channelId: "a" });
    assert.equal(api.channelTimings.get("a").time, 25);
    assert.ok(notifications >= 5);
    api.default.flux.LOGOUT();
    assert.equal(api.channelTimings.size, 0);
    unsubscribe();
    const finalCount = notifications;
    api.default.stop();
    assert.equal(notifications, finalCount);
    assert.equal(subscriptions.size, 0);
});

test("MediaPlaybackSpeed applies voice defaults to already playing media and bounds invalid saved speeds", () => {
    let effect!: () => (() => void) | undefined;
    const listeners = new Map<string, Function>();
    const plugin = load("src/equicordplugins/mediaPlaybackSpeed/index.tsx", {
        "./components/SpeedIcon": {}, "@webpack/common": { React, Tooltip: "tooltip", useEffect: (fn: typeof effect) => { effect = fn; } }
    }).default;
    const media = { tagName: "AUDIO", className: "audioElement", paused: false, playbackRate: 1, addEventListener: (type: string, fn: Function) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) };
    plugin.settings.store.defaultVoiceMessageSpeed = 2;
    plugin.renderPlaybackSpeedComponent({ mediaRef: { current: media } });
    const cleanup = effect();
    assert.equal(media.playbackRate, 2);
    plugin.settings.store.defaultVoiceMessageSpeed = Infinity;
    listeners.get("play")!();
    assert.equal(media.playbackRate, 1);
    cleanup!();
    assert.equal(listeners.size, 0);
});
