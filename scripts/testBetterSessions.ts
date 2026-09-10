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

function deferred<T>() {
    let resolve: ((value: T) => void) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    assert.ok(resolve && reject);
    return { promise, resolve, reject };
}

function fixture() {
    let account: string | undefined = "account-a";
    const reads: { key: string; result: ReturnType<typeof deferred<unknown>>; }[] = [];
    const writes: { key: string; value: Map<string, { name: string; isNew: boolean; }>; result: ReturnType<typeof deferred<void>>; }[] = [];
    const requests: ReturnType<typeof deferred<object>>[] = [];
    const notices: object[] = [];
    const errors: unknown[][] = [];
    const toasts: object[] = [];
    const intervals = new Map<number, { callback(): Promise<void>; delay: number; }>();
    const hooks: unknown[] = [];
    let hookIndex = 0;
    let lastInterval = 0;
    let changes = 0;
    const subscriptions: (() => void)[] = [];
    const store = { backgroundCheck: true, checkInterval: 20 };
    const React = {
        createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
        useState(initial: unknown) {
            const index = hookIndex++;
            if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
            return [hooks[index], (value: unknown) => hooks[index] = value];
        },
        useSyncExternalStore(subscribe: (listener: () => void) => () => void, snapshot: () => unknown) {
            subscriptions.push(subscribe(() => changes++));
            return snapshot();
        },
        useEffect: (effect: () => void) => effect()
    };
    const mocks: Record<string, object> = {
        "@api/DataStore": {
            get(key: string) { const result = deferred<unknown>(); reads.push({ key, result }); return result.promise; },
            set(key: string, value: Map<string, { name: string; isNew: boolean; }>) { const result = deferred<void>(); writes.push({ key, value, result }); return result.promise; }
        },
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }) },
        "@api/Notifications": { showNotification: (notice: object) => notices.push(notice) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Paragraph": { Paragraph: "paragraph" },
        "@components/Heading": { Heading: "heading" },
        "@components/Button": { TextButton: "text-button" },
        "@utils/constants": { Devs: {} },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { NUMBER: 0, BOOLEAN: 1 } },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@webpack": { findCssClassesLazy: () => ({}), findComponentByCodeLazy: () => "component" },
        "@webpack/common": {
            React, UserStore: { getCurrentUser: () => account ? { id: account } : undefined },
            useStateFromStores: (_stores: unknown, callback: () => unknown) => callback(),
            Constants: { Endpoints: { AUTH_SESSIONS: "fixture-sessions" } },
            RestAPI: { get() { const request = deferred<object>(); requests.push(request); return request.promise; } },
            AuthSessionsStore: { getSessions: () => [] },
            Modal: "modal", TextInput: "input", Toasts: { genId: () => "toast", Type: { FAILURE: "failure" }, show: (toast: object) => toasts.push(toast) }
        },
        "./components/icons": {}, "./components/RenameButton": { RenameButton: "rename-button" }
    };
    function load(path: string) {
        const code = transpileModule(readFileSync(path, "utf8"), {
            fileName: path,
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
        }).outputText;
        return runInNewContext(code + "\nexports;", {
            exports: {}, Map, React,
            setInterval(callback: () => Promise<void>, delay: number) { intervals.set(++lastInterval, { callback, delay }); return lastInterval; },
            clearInterval: (id: number) => intervals.delete(id),
            require(name: string) {
                if (name.endsWith(".css")) return {};
                assert.ok(name in mocks, name);
                return mocks[name];
            }
        });
    }
    const utils = load("src/plugins/betterSessions/utils.ts");
    mocks["./utils"] = mocks["@plugins/betterSessions/utils"] = utils;
    const plugin = load("src/plugins/betterSessions/index.tsx").default;
    const { RenameModal } = load("src/plugins/betterSessions/components/RenameModal.tsx");
    async function ready() {
        plugin.start();
        const pending = plugin.checkNewSessions();
        reads.at(-1)?.result.resolve(new Map([["known", { name: "Saved name", isNew: false }]]));
        await setImmediate();
        requests.at(-1)?.resolve({ body: { user_sessions: [{ id_hash: "known" }] } });
        await setImmediate();
        writes.at(-1)?.result.resolve();
        await pending;
        writes.length = 0;
    }
    function renderModal(onClose: () => void) {
        hookIndex = 0;
        return RenameModal({ props: { onClose }, session: { id_hash: "known", client_info: { os: "Fixture", platform: "Fixture" } } });
    }
    return { plugin, utils, reads, writes, requests, errors, notices, toasts, intervals, store, hooks, subscriptions, ready, renderModal,
        setAccount: (id: string | undefined) => account = id, getChanges: () => changes };
}

test("stopping sessions during startup prevents requests, persistence and late timers", async () => {
    const { plugin, reads, requests, writes, intervals } = fixture();
    plugin.start();
    const pending = plugin.checkNewSessions();
    assert.equal(reads.length, 1);
    assert.equal(intervals.size, 1);
    plugin.stop();
    reads[0].result.resolve(new Map());
    await pending;
    assert.equal(requests.length, 0);
    assert.equal(writes.length, 0);
    assert.equal(intervals.size, 0);
});

test("sessions retry a failed initial load and coalesce overlapping checks", async () => {
    const { plugin, reads, requests, writes, intervals, errors } = fixture();
    plugin.start();
    const initial = plugin.checkNewSessions();
    reads[0].result.reject(new Error("storage unavailable"));
    await initial;
    assert.equal(errors.length, 1);
    const retry = Array.from(intervals.values())[0].callback();
    assert.equal(plugin.checkNewSessions(), retry);
    reads[1].result.resolve(new Map());
    await setImmediate();
    assert.equal(requests.length, 1);
    requests[0].resolve({ body: { user_sessions: [{ id_hash: "new", client_info: { os: "Fixture", platform: "Fixture", location: "Fixture" } }] } });
    await setImmediate();
    writes[0].result.resolve();
    await retry;
    plugin.stop();
});

test("late session reads cannot replace another account's cache", async () => {
    const { plugin, utils, reads, requests, writes, setAccount } = fixture();
    plugin.start();
    const first = plugin.checkNewSessions();
    setAccount("account-b");
    plugin.flux.CONNECTION_OPEN();
    const second = plugin.checkNewSessions();
    reads[1].result.resolve(new Map([["b", { name: "B device", isNew: false }]]));
    await setImmediate();
    reads[0].result.resolve(new Map([["a", { name: "A device", isNew: false }]]));
    await first;
    assert.equal(utils.savedSessionsCache.has("a"), false);
    assert.equal(utils.savedSessionsCache.get("b").name, "B device");
    assert.equal(plugin.checkNewSessions(), second);
    requests[0].resolve({ body: { user_sessions: [] } });
    await setImmediate();
    assert.equal(writes[0].key, "BetterSessions_savedSessions_account-b");
    writes[0].result.resolve();
    await second;
    plugin.stop();
});

test("stale session responses cannot notify or save after account changes or stop", async () => {
    for (const action of ["switch", "stop"] as const) {
        const { plugin, reads, requests, writes, notices, setAccount } = fixture();
        plugin.start();
        const pending = plugin.checkNewSessions();
        reads[0].result.resolve(new Map());
        await setImmediate();
        if (action === "switch") setAccount("account-b"); else plugin.stop();
        requests[0].resolve({ body: { user_sessions: [{ id_hash: "new", client_info: { os: "Fixture", platform: "Fixture", location: "Fixture" } }] } });
        await pending;
        assert.equal(notices.length, 0);
        assert.equal(writes.length, 0);
        plugin.stop();
    }
});

test("session persistence captures its owner and an independent snapshot", async () => {
    const { plugin, utils, writes, setAccount, ready } = fixture();
    await ready();
    const pending = utils.saveSessionsToDataStore();
    const write = writes.at(-1);
    assert.ok(write);
    utils.savedSessionsCache.get("known").name = "Changed later";
    setAccount("account-b");
    assert.equal(write.key, "BetterSessions_savedSessions_account-a");
    assert.equal(write.value.get("known")?.name, "Saved name");
    assert.equal(utils.useSessionNames(), undefined);
    await assert.rejects(utils.saveSessionsToDataStore(), /different or unloaded account/);
    write.result.resolve();
    await pending;
    plugin.stop();
});

test("session names publish loaded and edited values without a copied title state", async () => {
    const { plugin, utils, writes, ready, getChanges, subscriptions } = fixture();
    utils.useSessionNames();
    await ready();
    const render = () => plugin.renderName({ session: { id_hash: "known", client_info: { os: "Fixture", platform: "Fixture" } } });
    assert.equal(render().props.children[0].props.children[0], "Saved name*");
    utils.savedSessionsCache.set("known", { name: "Renamed", isNew: false });
    const pending = utils.saveSessionsToDataStore();
    assert.equal(render().props.children[0].props.children[0], "Renamed*");
    assert.ok(getChanges() >= 3);
    writes.at(-1)?.result.resolve();
    await pending;
    subscriptions.forEach(unsubscribe => unsubscribe());
    const count = getChanges();
    plugin.stop();
    assert.equal(getChanges(), count);
});

test("session rename waits for persistence and retains the modal after a failure", async () => {
    const { plugin, ready, renderModal, hooks, writes, toasts } = fixture();
    await ready();
    let closed = 0;
    renderModal(() => closed++);
    hooks[1] = "Renamed";
    let modal = renderModal(() => closed++);
    const failed = modal.props.actions[1].onClick();
    assert.equal(closed, 0);
    writes.at(-1)?.result.reject(new Error("disk full"));
    await failed;
    assert.equal(closed, 0);
    assert.equal(toasts.length, 1);
    modal = renderModal(() => closed++);
    const retry = modal.props.actions[1].onClick();
    writes.at(-1)?.result.resolve();
    await retry;
    assert.equal(closed, 1);
    plugin.stop();
});

test("a session rename opened for another account cannot change the current cache", async () => {
    const { plugin, ready, renderModal, hooks, setAccount, writes, toasts, utils } = fixture();
    await ready();
    renderModal(() => assert.fail("must not close after a rejected rename"));
    hooks[1] = "A device";
    setAccount("account-b");
    const count = writes.length;
    await renderModal(() => assert.fail()).props.actions[1].onClick();
    assert.equal(writes.length, count);
    assert.equal(utils.savedSessionsCache.get("known").name, "Saved name");
    assert.equal(toasts.length, 1);
    plugin.stop();
});

test("invalid session intervals cannot produce tight polling loops", async () => {
    for (const minutes of [0, -5, Infinity, NaN, 1e12]) {
        const { plugin, reads, intervals, store } = fixture();
        store.checkInterval = minutes;
        assert.equal(plugin.settings.def.checkInterval.isValid(minutes), false);
        plugin.start();
        const pending = plugin.checkNewSessions();
        assert.equal(Array.from(intervals.values())[0].delay, 20 * 60000);
        plugin.stop();
        reads[0].result.resolve(new Map());
        await pending;
    }
});

test("closing unrelated settings does not dismiss unseen session labels", async () => {
    const { plugin, utils, writes, ready } = fixture();
    await ready();
    utils.savedSessionsCache.set("viewed", { name: "", isNew: true });
    utils.savedSessionsCache.set("unseen", { name: "", isNew: true });
    await plugin.flux.USER_SETTINGS_ACCOUNT_RESET_AND_CLOSE_FORM();
    assert.equal(writes.length, 0);
    assert.equal(utils.savedSessionsCache.get("unseen").isNew, true);
    plugin.renderName({ session: { id_hash: "viewed", client_info: { os: "Fixture", platform: "Fixture" } } });
    const pending = plugin.flux.USER_SETTINGS_ACCOUNT_RESET_AND_CLOSE_FORM();
    writes[0].result.resolve();
    await pending;
    assert.equal(utils.savedSessionsCache.get("viewed").isNew, false);
    assert.equal(utils.savedSessionsCache.get("unseen").isNew, true);
    plugin.stop();
});

test("confirmed session responses prune expired names and do not notify already visible sessions", async () => {
    const { plugin, utils, writes, requests, notices, ready } = fixture();
    await ready();
    plugin.renderName({ session: { id_hash: "visible", client_info: { os: "Fixture", platform: "Fixture" } } });
    await plugin.flux.USER_SETTINGS_ACCOUNT_RESET_AND_CLOSE_FORM();
    const pending = plugin.checkNewSessions();
    requests.at(-1)?.resolve({ body: { user_sessions: [{ id_hash: "visible", client_info: { os: "Fixture", platform: "Fixture" } }] } });
    await setImmediate();
    assert.equal(utils.savedSessionsCache.has("known"), false);
    assert.equal(utils.savedSessionsCache.get("visible").isNew, false);
    assert.equal(notices.length, 0);
    writes[0].result.resolve();
    await pending;
    plugin.stop();
});
