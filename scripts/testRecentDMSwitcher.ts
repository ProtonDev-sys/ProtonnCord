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

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";

function deferred<T>() {
    let resolve: ((value: T) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    assert.ok(resolve && reject);
    return { promise, resolve, reject };
}

interface TestPlugin {
    start(): Promise<void>;
    stop(): void;
    flux: { CHANNEL_SELECT(event: { channelId: string; }): void; LOGOUT(): void; };
    settings: { def: { clearRdms: { component(): { props: { onClick(): Promise<void>; }; }; }; }; };
}

function fixture(mac = false) {
    let userId = "account-a";
    let selected = A;
    const channels = new Set([A, B, C]);
    const reads: { key: string; result: ReturnType<typeof deferred<unknown>>; }[] = [];
    const writes: { key: string; ids: string[]; result: ReturnType<typeof deferred<void>>; }[] = [];
    const errors: unknown[][] = [], toasts: object[] = [], transitions: string[] = [];
    const listeners = new Map<string, (event?: object) => void>();
    const modals: { key: string; onCloseCallback(): void; }[] = [];
    const closed: string[] = [];
    const store = { visualStyle: "off", amountOfUsers: 20, overlayMode: "row", overlayRowLength: 5, overlayShowAvatars: true, toastDurationMs: 600 };
    const target = (prefix: string) => ({
        addEventListener: (name: string, callback: (event?: object) => void) => listeners.set(prefix + name, callback),
        removeEventListener: (name: string, callback: (event?: object) => void) => { if (listeners.get(prefix + name) === callback) listeners.delete(prefix + name); }
    });
    const React = {
        createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
        useState: () => [false, () => {}]
    };
    const mocks: Record<string, object> = {
        "./styles.css": {},
        "@api/DataStore": {
            get(key: string) { const result = deferred<unknown>(); reads.push({ key, result }); return result.promise; },
            set(key: string, ids: string[]) { const result = deferred<void>(); writes.push({ key, ids: [...ids], result }); return result.promise; }
        },
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store, use: () => store }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { EquicordDevs: {}, IS_MAC: mac },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/react": { useForceUpdater: () => () => {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {}, makeRange: () => [] },
        "@webpack/common": {
            React, Button: Object.assign(() => {}, { Colors: { RED: "red" } }),
            UserStore: { getCurrentUser: () => ({ id: userId }), getUser: (id: string) => ({ id, username: id }) },
            SelectedChannelStore: { getChannelId: () => selected },
            ChannelStore: { getChannel: (id: string) => channels.has(id) ? { isDM: () => true, isGroupDM: () => false, recipients: [id] } : undefined },
            RelationshipStore: { getNickname: () => undefined },
            IconUtils: { getUserAvatarURL: () => "" },
            ChannelRouter: { transitionToChannel: (id: string) => transitions.push(id) },
            Toasts: { Type: { FAILURE: "failure", SUCCESS: "success", MESSAGE: "message" }, Position: { BOTTOM: 1 }, genId: () => "toast", create: (message: string, type: string) => ({ message, type }), show: (value: object) => toasts.push(value) },
            openModal: (_render: unknown, options: { onCloseCallback(): void; }) => { const key = String(modals.length); modals.push({ key, ...options }); return key; },
            closeModal: (key: string) => { closed.push(key); modals.find(m => m.key === key)?.onCloseCallback(); },
            lodash: {}
        }
    };
    const exports: { default?: TestPlugin; } = {};
    const source = readFileSync("src/equicordplugins/recentDMSwitcher/index.tsx", "utf8");
    runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText, {
        exports, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        document: target("document:"), window: target("window:")
    });
    assert.ok(exports.default);
    const plugin: TestPlugin = exports.default;
    async function ready(ids = [A, B, C]) { const pending = plugin.start(); reads.at(-1)?.result.resolve(ids); await pending; }
    function key(type: "keydown" | "keyup", keyName: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; } = {}) {
        let prevented = false;
        listeners.get("document:" + type)?.({ key: keyName, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers, preventDefault: () => { prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
        return prevented;
    }
    return { plugin, reads, writes, errors, toasts, listeners, transitions, channels, store, modals, closed, ready, key,
        setAccount: (value: string) => { userId = value; }, setSelected: (value: string) => { selected = value; } };
}

test("stopped or replaced history loads never install late listeners or write another account", async () => {
    const f = fixture();
    const old = f.plugin.start();
    f.plugin.stop();
    f.setAccount("account-b");
    const current = f.plugin.start();
    f.reads[0].result.resolve([C]);
    await old;
    assert.equal(f.listeners.size, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.reads[1].key, "RDMSwitch_history_account-b");
    f.reads[1].result.resolve([A, B]);
    await current;
    assert.equal(f.listeners.size, 3);
    f.plugin.flux.LOGOUT();
    assert.equal(f.listeners.size, 0);
});

test("failed loads preserve storage and allow a later start to retry", async () => {
    const f = fixture();
    const pending = f.plugin.start();
    f.reads[0].result.reject(new Error("offline"));
    await pending;
    assert.equal(f.writes.length, 0);
    assert.equal(f.listeners.size, 0);
    await f.ready();
    assert.equal(f.listeners.size, 3);
    f.plugin.stop();
});

test("legacy import preserves its key and only includes available DM identifiers", async () => {
    const f = fixture();
    const pending = f.plugin.start();
    f.reads[0].result.resolve(undefined);
    await setImmediate();
    assert.equal(f.reads[1].key, "RDMSwitch_history");
    const unavailable = Array.from({ length: 25 }, (_, i) => String(100000000000000000n + BigInt(i)));
    f.reads[1].result.resolve([...unavailable, A, B, B, null, 12]);
    await pending;
    f.key("keydown", "Tab", { ctrlKey: true });
    f.key("keyup", "Control");
    assert.deepEqual(f.transitions, [B]);
    assert.equal(f.writes[0].key, "RDMSwitch_history_account-a");
    assert.deepEqual(f.writes[0].ids, [B, A]);
    f.plugin.stop();
});

test("failed saves retry unchanged selections and successful saves suppress duplicate writes", async () => {
    const f = fixture();
    await f.ready();
    f.plugin.flux.CHANNEL_SELECT({ channelId: B });
    f.writes[0].result.reject(new Error("disk full"));
    await setImmediate();
    assert.equal(f.errors.length, 1);
    f.plugin.flux.CHANNEL_SELECT({ channelId: B });
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.writes[1].ids, [B, A, C]);
    f.writes[1].result.resolve();
    await setImmediate();
    f.plugin.flux.CHANNEL_SELECT({ channelId: B });
    assert.equal(f.writes.length, 2);
    f.plugin.stop();
});

test("cycling commits only on modifier release and cancellation never navigates", async () => {
    const f = fixture();
    await f.ready();
    assert.equal(f.key("keydown", "Tab", { ctrlKey: true }), true);
    f.key("keydown", "Tab", { ctrlKey: true });
    f.key("keydown", "Tab", { ctrlKey: true, shiftKey: true });
    assert.deepEqual(f.transitions, []);
    f.key("keyup", "Control");
    assert.deepEqual(f.transitions, [B]);
    for (const cancel of [() => f.key("keydown", "Escape"), () => f.listeners.get("window:blur")?.(), () => f.plugin.flux.CHANNEL_SELECT({ channelId: C })]) {
        f.key("keydown", "Tab", { ctrlKey: true });
        cancel();
        f.key("keyup", "Control");
        assert.deepEqual(f.transitions, [B]);
    }
    f.plugin.stop();
});

test("unusable cycles leave browser shortcuts alone and one DM remains reachable from a guild", async () => {
    const f = fixture();
    await f.ready([A]);
    assert.equal(f.key("keydown", "Tab", { ctrlKey: true }), false);
    assert.equal(f.key("keyup", "Control"), false);
    f.setSelected("guild-channel");
    assert.equal(f.key("keydown", "Tab", { ctrlKey: true, shiftKey: true }), true);
    f.key("keyup", "Control");
    assert.deepEqual(f.transitions, [A]);
    f.plugin.stop();
});

test("closing an old overlay cannot cancel its replacement or a switch to toast mode", async () => {
    const f = fixture();
    f.store.visualStyle = "overlay";
    await f.ready();
    f.key("keydown", "Tab", { ctrlKey: true });
    f.store.visualStyle = "toast";
    f.key("keydown", "Tab", { ctrlKey: true });
    assert.deepEqual(f.closed, ["0"]);
    f.key("keyup", "Control");
    assert.deepEqual(f.transitions, [C]);
    f.store.visualStyle = "overlay";
    f.key("keydown", "Tab", { ctrlKey: true });
    f.modals[0].onCloseCallback();
    f.key("keyup", "Control");
    assert.equal(f.transitions.length, 2);
    f.key("keydown", "Tab", { ctrlKey: true });
    f.modals.at(-1)?.onCloseCallback();
    f.key("keyup", "Control");
    assert.equal(f.transitions.length, 2);
    f.plugin.stop();
});

test("Mac modifiers and account changes do not commit an obsolete cycle", async () => {
    const f = fixture(true);
    await f.ready();
    f.key("keydown", "Tab", { metaKey: true });
    f.key("keyup", "Control", { metaKey: true });
    assert.equal(f.transitions.length, 0);
    f.key("keyup", "Meta");
    assert.deepEqual(f.transitions, [B]);
    f.key("keydown", "Tab", { metaKey: true });
    f.setAccount("account-b");
    f.key("keyup", "Meta");
    assert.deepEqual(f.transitions, [B]);
    f.plugin.stop();
});

test("clearing history retains failure feedback and does not erase newer selections", async () => {
    const f = fixture();
    await f.ready();
    const click = f.plugin.settings.def.clearRdms.component().props.onClick;
    const failed = click();
    f.writes[0].result.reject(new Error("disk full"));
    await failed;
    assert.equal(f.errors.length, 1);
    const retry = click();
    assert.deepEqual(f.writes[1].ids, []);
    f.plugin.flux.CHANNEL_SELECT({ channelId: B });
    assert.deepEqual(f.writes[2].ids, [B]);
    f.writes[1].result.resolve();
    await retry;
    f.writes[2].result.resolve();
    await setImmediate();
    f.plugin.flux.CHANNEL_SELECT({ channelId: B });
    assert.equal(f.writes.length, 3);
    f.plugin.stop();
});

test("invalid stored roots are preserved and unavailable cached channels are not discarded", async () => {
    const f = fixture();
    const pending = f.plugin.start();
    f.reads[0].result.resolve({ invalid: true });
    await pending;
    assert.equal(f.writes.length, 0);
    assert.equal(f.listeners.size, 0);
    const unavailable = "444444444444444444";
    await f.ready([A, unavailable, B]);
    f.plugin.flux.CHANNEL_SELECT({ channelId: B });
    assert.deepEqual(f.writes[0].ids, [B, A, unavailable]);
    f.plugin.stop();
});

test("history bounds tolerate tampered numeric settings", async () => {
    const f = fixture();
    f.store.amountOfUsers = Number.NaN;
    const ids = Array.from({ length: 60 }, (_, i) => String(100000000000000000n + BigInt(i)));
    await f.ready(ids);
    assert.equal(f.writes[0].ids.length, 20);
    f.store.amountOfUsers = -1;
    f.plugin.flux.CHANNEL_SELECT({ channelId: B });
    assert.equal(f.writes[1].ids.length, 10);
    f.plugin.stop();
});
