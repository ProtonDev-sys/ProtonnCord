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

function load(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}, result = "exports.default") {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + `\n${result};`, {
        exports: {}, ...globals, require: (name: string) => mocks[name] ?? {}
    });
}

test("text replacement tolerates invalid saved rows and delayed edits follow the original rule ID", () => {
    const store = { stringRules: [null, { find: "hello", replace: "hi" }], regexRules: {} };
    const react = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    let id = 0;
    const api = load("src/plugins/textReplace/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@utils/constants": { Devs: {}, EquicordDevs: {}, SUPPORT_CHANNEL_IDS: [] },
        "@utils/index": { classNameFactory: () => () => "" }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": { React: react, useState: (value: unknown) => [value, () => {}] }
    }, { crypto: { randomUUID: () => String(++id) } }, "({ plugin: exports.default, applyRules, TextReplace })");
    api.plugin.start();
    assert.equal(api.applyRules("hello", "myMessages"), "hi");
    const rules = [{ id: "first", name: "First", find: "a", replace: "b", onlyIfIncludes: "", scope: "myMessages" },
        { id: "second", name: "Second", find: "c", replace: "d", onlyIfIncludes: "", scope: "myMessages" }];
    const tree = api.TextReplace({ title: "Fixture", description: "Fixture", rulesArray: rules });
    function find(node: any, predicate: (node: any) => boolean): any {
        if (!node || typeof node !== "object") return;
        if (predicate(node)) return node;
        for (const child of Array.isArray(node) ? node : Object.values(node)) {
            const result = find(child, predicate);
            if (result) return result;
        }
    }
    const row = find(tree, node => typeof node.props?.renderContent === "function");
    const input = find(row.props.renderContent(), node => node.props?.label === "Find");
    rules.shift();
    input.props.onChange("late edit");
    assert.equal(rules[0].find, "c");
});

test("silent message hooks stay in their own main chat and persist the actual one-shot state", () => {
    const store = { persistState: "restarts", savedState: true, autoDisable: true };
    function mount(isMainChat: boolean) {
        const effects: (() => void | (() => void))[] = [];
        const listeners = new Set<(id: string, message: { content: string; }) => void>();
        const settings = { store, use: () => store, withPrivateSettings() { return this; } };
        const plugin = load("src/plugins/silentMessageToggle/index.tsx", {
            "@api/Settings": { definePluginSettings: () => settings },
            "@api/MessageEvents": { addMessagePreSendListener: (fn: any) => listeners.add(fn), removeMessagePreSendListener: (fn: any) => listeners.delete(fn) },
            "@utils/constants": { Devs: {}, EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
            "@webpack/common": { React: { createElement: (type: unknown, props: unknown) => ({ type, props }) },
                useState: (initial: unknown) => [initial, () => {}], useRef: (initial: unknown) => ({ current: initial }),
                useEffect: (effect: () => void | (() => void)) => effects.push(effect) }
        });
        plugin.chatBarButton.render({ isMainChat, channel: { id: "current" } });
        const cleanup = effects.map(effect => effect());
        return { listeners, cleanup: () => cleanup.forEach(fn => fn?.()) };
    }
    const hidden = mount(false);
    assert.equal(hidden.listeners.size, 0);
    const main = mount(true);
    const send = [...main.listeners][0];
    const other = { content: "other channel" };
    send("other", other);
    assert.equal(other.content, "other channel");
    const first = { content: "first" };
    send("current", first);
    assert.equal(first.content, "@silent first");
    const second = { content: "second" };
    send("current", second);
    assert.equal(second.content, "second");
    assert.equal(store.savedState, false);
    const restarted = mount(true);
    const third = { content: "third" };
    [...restarted.listeners][0]("current", third);
    assert.equal(third.content, "third");
    main.cleanup();
    assert.equal(main.listeners.size, 0);
    hidden.cleanup();
    restarted.cleanup();
});

test("Spotify share commands await send failures and retain a reply selected during the send", async () => {
    let reply = { id: "first" };
    let finish!: () => void;
    let reject!: (error: Error) => void;
    const events: unknown[] = [];
    const notices: unknown[] = [];
    const plugin = load("src/plugins/spotifyShareCommands/index.ts", {
        "@api/Commands": { ApplicationCommandInputType: {}, findOption: () => undefined, sendBotMessage: (_id: string, data: unknown) => notices.push(data) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@utils/discord": { sendMessage: () => new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; }) },
        "@webpack": { findByPropsLazy: () => ({ getTrack: () => ({ id: "fixture-track", artists: [] }) }) },
        "@webpack/common": { FluxDispatcher: { dispatch: (event: unknown) => events.push(event) },
            MessageActions: { getSendMessageOptionsForReply: (value: unknown) => value }, PendingReplyStore: { getPendingReply: () => reply } }
    });
    const context = { channel: { id: "fixture-channel" } };
    const first = plugin.commands[0].execute([], context);
    reply = { id: "second" };
    finish();
    await first;
    assert.equal(events.length, 0);
    const failed = plugin.commands[0].execute([], context);
    reject(new Error("Send unavailable"));
    await assert.rejects(failed, /Send unavailable/);
    assert.equal(events.length, 0);
    await plugin.commands[2].execute([], context);
    assert.equal(notices.length, 1);
});

function loadEmbeds() {
    let account = "first";
    const pending: ((response: unknown) => void)[] = [];
    const received: unknown[] = [];
    const queues: { limit: number; tasks: (() => Promise<void>)[]; }[] = [];
    const mocks = {
        "@api/Settings": { definePluginSettings: () => ({ store: { idList: "" } }) },
        "@api/UserSettings": { getUserSettingLazy: () => ({}) },
        "@api/MessageAccessories": { addMessageAccessory() {}, removeMessageAccessory() {} },
        "@utils/constants.js": { Devs: {} },
        "@utils/Queue": { Queue: class {
            tasks: (() => Promise<void>)[] = [];
            constructor(public limit: number) { queues.push(this); }
            unshift(callback: () => Promise<void>) { this.tasks.unshift(callback); }
        } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findComponentLazy() {}, findComponentByCodeLazy() {}, findCssClassesLazy() {} },
        "@webpack/common": {
            AuthenticationStore: { getId: () => account },
            RestAPI: { get: () => new Promise(resolve => pending.push(resolve)) },
            Constants: { Endpoints: { MESSAGES: (id: string) => id } },
            MessageStore: { getMessages: () => ({ receiveMessage: (message: unknown) => {
                received.push(message);
                return { get: () => message };
            } }) }
        }
    };
    const api = load("src/plugins/messageLinkEmbeds/index.tsx", mocks, {},
        "({ plugin: exports.default, fetchMessage, messageCache, computeWidthAndHeight, getImages, requiresRichEmbed })");
    return { ...api, pending, received, queues, setAccount: (value: string) => account = value };
}

test("linked message previews discard responses after stop, cache resets, or account changes", async () => {
    const api = loadEmbeds();
    api.plugin.start();
    const first = api.fetchMessage("channel", "message");
    api.plugin.stop();
    api.pending.shift()!({ body: [{ id: "message", channel_id: "channel" }] });
    assert.equal(await first, undefined);
    assert.equal(api.messageCache.size, 0);
    assert.equal(api.received.length, 0);

    api.plugin.start();
    const second = api.fetchMessage("channel", "message");
    api.setAccount("second");
    api.plugin.flux.LOGOUT();
    api.pending.shift()!({ body: [{ id: "message", channel_id: "channel" }] });
    assert.equal(await second, undefined);
    assert.equal(api.messageCache.size, 0);
    assert.equal(api.received.length, 0);
    assert.ok(api.queues.every(queue => queue.limit === 200));
});

test("linked message previews accept only the requested message in its requested channel", async () => {
    const api = loadEmbeds();
    for (const body of [
        [{ id: "neighbor", channel_id: "channel" }],
        [{ id: "message", channel_id: "other" }],
        []
    ]) {
        api.plugin.flux.CONNECTION_OPEN();
        const request = api.fetchMessage("channel", "message");
        api.pending.shift()!({ body });
        assert.equal(await request, undefined);
    }
    assert.equal(api.received.length, 0);
    api.plugin.flux.CONNECTION_OPEN();
    const request = api.fetchMessage("channel", "message");
    const message = { id: "message", channel_id: "channel" };
    api.pending.shift()!({ body: [message] });
    assert.equal(await request, message);
    assert.equal(await api.fetchMessage("channel", "message"), message);
    assert.equal(api.received.length, 1);
    assert.equal(api.pending.length, 0);
});

test("linked message images fit both limits and tolerate absent optional media", () => {
    const api = loadEmbeds();
    for (const [width, height] of [[800, 700], [100, 1000], [100, 50], [0, 0], [NaN, Infinity]]) {
        const fitted = api.computeWidthAndHeight(width, height);
        assert.ok(fitted.width > 0 && fitted.width <= 400);
        assert.ok(fitted.height > 0 && fitted.height <= 300);
    }
    assert.equal(api.getImages({ embeds: [{ type: "image" }, { type: "gifv", url: "https://example.test/a" }] }).length, 0);
    assert.equal(api.requiresRichEmbed({}), false);
});

test("restarting click actions does not retain a previously held modifier", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const copied: string[] = [];
    const mocks = {
        "@api/Settings": { definePluginSettings: () => ({ store: {
            singleClickAction: "COPY_ID", singleClickModifier: "BACKSPACE", doubleClickAction: "NONE",
            doubleClickModifier: "NONE", clickTimeout: 300, selectionHoldTimeout: 300
        } }) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/Logger": { Logger: class {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {}, makeRange: () => [] },
        "@utils/discord": { copyWithToast: (value: string) => copied.push(value) },
        "@webpack/common": {
            AuthenticationStore: { getId: () => "me" },
            WindowStore: { addChangeListener() {}, removeChangeListener() {} }
        }
    };
    const plugin = load("src/plugins/messageClickActions/index.ts", mocks, {
        Node: { TEXT_NODE: 3 }, clearTimeout, setTimeout,
        document: { addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
            removeEventListener: (name: string) => listeners.delete(name) }
    });
    plugin.start();
    listeners.get("keydown")!({ key: "Backspace" });
    plugin.stop();
    plugin.start();
    listeners.get("mousedown")!({ button: 0 });
    plugin.onMessageClick({ author: { id: "me" }, id: "message" }, { isDM: () => false, isSystemDM: () => false },
        { target: { nodeType: 1 }, detail: 1, button: 0, preventDefault() {} });
    assert.deepEqual(copied, []);
    plugin.stop();
    assert.equal(listeners.size, 0);
});

test("new guild defaults await one complete notification update and contain rejected saves", async () => {
    const requests: { id: string; value: Record<string, unknown>; reject(error: Error): void; }[] = [];
    const notices: unknown[] = [];
    const plugin = load("src/plugins/newGuildSettings/index.tsx", {
        "@api/Settings": { definePluginSettings: () => ({ store: { guild: true, messages: 2 } }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": {
            findByCodeLazy() {}, mapMangledModuleLazy: () => ({}),
            findByPropsLazy: () => ({ updateGuildNotificationSettings: (id: string, value: Record<string, unknown>) =>
                new Promise((_resolve, reject) => requests.push({ id, value, reject })) })
        }
    }, { console: { warn: (...args: unknown[]) => notices.push(args) } });
    for (const id of ["@me", "null", null]) await plugin.applyDefaultSettings(id);
    assert.equal(requests.length, 0);
    const save = plugin.applyDefaultSettings("guild");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].value.muted, true);
    assert.equal(requests[0].value.message_notifications, 2);
    requests[0].reject(new Error("Save failed"));
    await save;
    assert.equal(notices.length, 1);
});

test("pausing invites reports save failure, deduplicates clicks, and rechecks permission", async () => {
    const requests: { reject(error: Error): void; }[] = [];
    const notices: unknown[] = [];
    let allowed = true;
    const api = load("src/plugins/pauseInvitesForever/index.tsx", {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { hasGuildFeature: () => false },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@webpack/common": {
            GuildStore: { getGuild: () => ({ features: [] }) },
            PermissionStore: { getGuildPermissionProps: () => ({ canManageRoles: allowed }) },
            Constants: { Endpoints: { GUILD: (id: string) => id } },
            RestAPI: { patch: () => new Promise((_resolve, reject) => requests.push({ reject })) },
            showToast: (notice: unknown) => notices.push(notice), Toasts: { Type: {} }
        }
    }, {}, "({ disableInvites })");
    const first = api.disableInvites("guild");
    assert.equal(await api.disableInvites("guild"), false);
    assert.equal(requests.length, 1);
    requests[0].reject(new Error("Save failed"));
    assert.equal(await first, false);
    assert.equal(notices.length, 1);
    allowed = false;
    assert.equal(await api.disableInvites("guild"), false);
    assert.equal(requests.length, 1);
});
