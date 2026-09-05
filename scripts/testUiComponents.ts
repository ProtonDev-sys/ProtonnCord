/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import moment from "moment";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { proxyLazy, SYM_LAZY_GET } from "../src/utils/lazy";

function loadComponent(path: string, hooks: Record<string, unknown> = {}, additionalMocks: Record<string, object> = {}, globals: Record<string, unknown> = {}) {
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const mocks: Record<string, object> = {
        "@webpack/common": { React, TextInput: "input", ...hooks },
        "@components/BaseText": { BaseText: "div" },
        "@api/PluginManager": { isSettingDisabled: () => false },
        "@utils/types": { OptionType: { NUMBER: 1, BIGINT: 2 } },
        "./Common": { SettingsSection: "section", resolveError: (result: boolean | string) => result === true ? null : result || "Invalid input provided" },
        "@utils/css": { classNameFactory: (prefix: string) => (...names: string[]) => names.map(name => prefix + name).join(" ") },
        "@utils/misc": { classes: (...names: unknown[]) => names.filter(Boolean).join(" ") },
        ...additionalMocks
    };
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, React, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

function decorFixture() {
    const scheduled = new Set<() => Promise<void>>();
    const requests: { ids: string[]; signal?: AbortSignal; resolve: (result: Record<string, string | null>) => void; reject: (error: Error) => void; }[] = [];
    const errors: unknown[] = [];
    const clock = { now: 1_000 };
    function debounce(callback: () => Promise<void>) {
        const trigger = () => { scheduled.add(callback); };
        trigger.cancel = () => scheduled.delete(callback);
        return trigger;
    }
    const module = loadComponent("src/plugins/decor/lib/stores/UsersDecorationsStore.ts", {
        lodash: { debounce },
        zustandCreate<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
            let state: T;
            state = initializer(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        }
    }, {
        "@plugins/decor/lib/api": { getUsersDecorations: (ids: string[], signal?: AbortSignal) => new Promise<Record<string, string | null>>((resolve, reject) => requests.push({ ids, signal, resolve, reject })) },
        "@plugins/decor/lib/constants": { DECORATION_FETCH_COOLDOWN: 10_000, SKU_ID: "decor" },
        "@shared/debounce": { debounce },
        "@utils/lazy": { proxyLazy },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    }, { AbortController, Date: class extends Date { static now() { return clock.now; } } });
    const store = module.useUsersDecorationsStore;
    function flush() {
        const callback = scheduled.values().next().value;
        assert.ok(callback);
        scheduled.delete(callback);
        return callback();
    }
    return { store, requests, scheduled, flush, errors, clock };
}

test("Decor lookups preserve newer local and unrelated decoration updates", async () => {
    const { store, requests, flush } = decorFixture();
    store.getState().start?.();
    store.getState().fetch("a");
    const first = flush();
    store.getState().set("a", "local");
    store.getState().fetch("b");
    const second = flush();
    requests[1].resolve({ b: "remote-b" }); await second;
    requests[0].resolve({ a: "old-a" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "local");
    assert.equal(store.getState().usersDecorations.get("b").asset, "remote-b");
});

test("Decor lookups deduplicate pending IDs and prefer the latest forced request", async () => {
    const { store, requests, scheduled, flush } = decorFixture();
    store.getState().start();
    store.getState().fetch("a"); store.getState().fetch("a");
    const first = flush();
    assert.deepEqual([...requests[0].ids], ["a"]);
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0);
    store.getState().fetch("a", true);
    const second = flush();
    requests[1].resolve({ a: "new" }); await second;
    requests[0].resolve({ a: "old" }); await first;
    assert.equal(store.getState().usersDecorations.get("a").asset, "new");
});

test("Decor stop cancels queued requests and old failures cannot erase restarted work", async () => {
    const { store, requests, scheduled, flush, errors } = decorFixture();
    store.getState().fetch("inactive");
    assert.equal(scheduled.size, 0);
    store.getState().start(); store.getState().fetch("a");
    const old = flush();
    store.getState().fetch("queued"); store.getState().stop();
    assert.equal(scheduled.size, 0);
    assert.equal(requests[0].signal?.aborted, true);
    store.getState().start(); store.getState().fetch("a");
    const current = flush();
    requests[0].reject(new Error("Old failure")); await old;
    store.getState().fetch("a");
    assert.equal(scheduled.size, 0, "the old cleanup must preserve the new in-flight marker");
    requests[1].resolve({ a: "current" }); await current;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    store.getState().fetch("a", true); const failed = flush();
    requests[2].reject(new Error("Retryable failure")); await failed;
    assert.equal(store.getState().usersDecorations.get("a").asset, "current");
    assert.equal(errors.length, 1);
    store.getState().fetch("a", true); const retry = flush();
    store.getState().stop(); requests[3].resolve({ a: "late" }); await retry;
    assert.equal(store.getState().usersDecorations.size, 0);
});

test("Decor cached absence expires and expired entries are released", async () => {
    const { store, requests, scheduled, flush, clock } = decorFixture();
    store.getState().start(); store.getState().fetch("a");
    const first = flush(); requests[0].resolve({ a: null }); await first;
    store.getState().fetch("a"); assert.equal(scheduled.size, 0);
    clock.now += 10_000;
    store.getState().fetch("b"); const second = flush(); requests[1].resolve({ b: "b" }); await second;
    assert.equal(store.getState().usersDecorations.has("a"), false);
    store.getState().fetch("a"); assert.equal(scheduled.size, 1);
    store.getState().stop();
});

test("Decor public lookups check HTTP and response shapes and never request the entire user list", async () => {
    const requests: { url: string; signal?: AbortSignal; }[] = [];
    const response: { ok: boolean; body: unknown; } = { ok: true, body: { a: "asset", b: null, unrelated: "ignored" } };
    const api = loadComponent("src/plugins/decor/lib/api.ts", {}, {
        "./constants": { API_URL: "https://decor.invalid/api" },
        "./stores/AuthorizationStore": {},
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) }
    }, { URL, fetch: async (url: URL, options: { signal?: AbortSignal; }) => {
        requests.push({ url: String(url), signal: options.signal });
        return { ok: response.ok, json: async () => response.body };
    } });
    assert.deepEqual(structuredClone(await api.getUsersDecorations([])), {});
    assert.equal(requests.length, 0);
    const controller = new AbortController();
    assert.deepEqual(structuredClone(await api.getUsersDecorations(["a", "b", "missing"], controller.signal)), { a: "asset", b: null, missing: null });
    assert.equal(requests[0].signal, controller.signal);
    assert.deepEqual(JSON.parse(new URL(requests[0].url).searchParams.get("ids") ?? "null"), ["a", "b", "missing"]);
    response.ok = false; await assert.rejects(api.getUsersDecorations(["a"]), /Could not load/);
    response.ok = true;
    for (const body of [null, [], { a: 123 }, { a: {} }]) {
        response.body = body; await assert.rejects(api.getUsersDecorations(["a"]), /Invalid decoration response/);
    }
});

test("Decor lifecycle keeps initialization and connection work obsolete after logout or stop", async () => {
    const { store, scheduled } = decorFixture();
    const pending: (() => void)[] = [];
    const account = { id: "first", clears: 0, authInits: 0 };
    const plugin = loadComponent("src/plugins/decor/index.tsx", { UserStore: { getCurrentUser: () => account.id ? { id: account.id } : undefined } }, {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./lib/constants": { setBaseUrl: () => new Promise<void>(resolve => pending.push(resolve)) },
        "./lib/stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ init: () => account.authInits++ }) } },
        "./lib/stores/CurrentUserDecorationsStore": { useCurrentUserDecorationsStore: { getState: () => ({ clear: () => account.clears++ }) } },
        "./lib/stores/UsersDecorationsStore": { useUsersDecorationsStore: store },
        "./settings": { settings: { store: { baseUrl: "https://decor.invalid" } } },
        "./ui/components": {}, "./ui/components/DecorSection": {}
    }).default;
    const first = plugin.start();
    plugin.stop(); pending.shift()?.(); await first;
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    const second = plugin.start();
    const connection = plugin.flux.CONNECTION_OPEN();
    account.id = ""; plugin.flux.LOGOUT(); pending.shift()?.(); await Promise.all([second, connection]);
    assert.equal(store.getState().session, null);
    account.id = "second"; await plugin.flux.CONNECTION_OPEN();
    assert.equal(typeof store.getState().session, "symbol");
    assert.equal(scheduled.size, 1);
    plugin.stop(); await plugin.flux.CONNECTION_OPEN();
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.ok(account.clears >= 4);
    assert.equal(account.authInits, 2);
});

function loadFolders() {
    type Element = { key: string; props: { children?: unknown; renderTreeNode?: unknown; }; };
    const settings = { closeOthers: true, forceOpen: false, closeServerFolder: false, closeAllFolders: false };
    const expanded = new Set<number>();
    const pending: (() => void)[] = [];
    const toggles: number[] = [];
    const errors: unknown[] = [];
    const controls = { failNext: false };
    const plugin = loadComponent("src/plugins/betterFolders/index.tsx", {
        React: {
            isValidElement: (node: Element | null) => !!node && typeof node === "object" && "props" in node,
            cloneElement: (node: Element, _props: undefined, children: unknown) => ({ ...node, props: { ...node.props, children } })
        },
        ExpandedGuildFolderStore: { getExpandedFolders: () => expanded, isFolderExpanded: (id: number) => expanded.has(id) },
        SortedGuildStore: { getGuildFolders: () => [{ folderId: 0, guildIds: ["guild-zero"] }, { folderId: 1, guildIds: ["guild-one"] }] },
        FluxDispatcher: { wait: (callback: () => void) => pending.push(callback) }
    }, {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@utils/constants": { Devs: {} }, "@utils/discord": {},
        "@utils/Logger": { Logger: class { error(error: unknown) { errors.push(error); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findByPropsLazy: () => ({ toggleGuildFolderExpand(id: number) {
            if (controls.failNext) { controls.failNext = false; throw new Error("toggle failed"); }
            toggles.push(id);
            if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
            plugin.flux.TOGGLE_GUILD_FOLDER_EXPAND({ folderId: id });
        } }) }, "./FolderSideBar": {}
    }).default;
    function flush() { while (pending.length) pending.shift()?.(); }
    return { plugin, settings, expanded, pending, toggles, errors, controls, flush };
}

test("folder sidebar filtering preserves frozen source trees, keys and guild-list identity", () => {
    const { plugin } = loadFolders();
    const guildList = Object.freeze({ key: "guild-list", props: Object.freeze({ renderTreeNode() {} }) });
    const unrelated = Object.freeze({ key: "other", props: Object.freeze({ children: "Button" }) });
    const nested = Object.freeze([unrelated, guildList]);
    const children = Object.freeze([unrelated, nested, [null, false, []]]);
    const wrapper = Object.freeze({ key: "wrapper", props: Object.freeze({ children }) });
    const filter = plugin.makeGuildsBarSidebarFilter(true);
    const filtered = filter(wrapper);
    assert.equal(filtered.key, "wrapper");
    assert.equal(filtered.props.children.length, 1);
    assert.equal(filtered.props.children[0].length, 1);
    assert.equal(filtered.props.children[0][0], guildList);
    assert.equal(wrapper.props.children, children);
    assert.equal(children.length, 3);
    assert.equal(nested.length, 2);
    assert.equal(filter(unrelated), null);
    assert.equal(plugin.makeGuildsBarSidebarFilter(false)(wrapper), wrapper);
});

test("deferred folder closing is cancelled by stop, logout and reconnect", () => {
    for (const reset of ["stop", "LOGOUT", "CONNECTION_OPEN"]) {
        const { plugin, expanded, toggles, flush } = loadFolders();
        expanded.add(1).add(2);
        plugin.flux.TOGGLE_GUILD_FOLDER_EXPAND({ folderId: 1 });
        if (reset === "stop") plugin.stop(); else plugin.flux[reset]();
        flush();
        assert.deepEqual(toggles, [], reset);
        assert.equal(expanded.size, 2);
        plugin.flux.TOGGLE_GUILD_FOLDER_EXPAND({ folderId: 2 });
        flush();
        assert.deepEqual(toggles, [1]);
    }
});

test("folder closing recovers from a failed toggle and ignores closed targets or disabled preferences", () => {
    const { plugin, settings, expanded, toggles, controls, errors, flush } = loadFolders();
    expanded.add(1).add(2).add(3);
    controls.failNext = true;
    plugin.flux.TOGGLE_GUILD_FOLDER_EXPAND({ folderId: 1 });
    flush();
    assert.equal(errors.length, 1);
    plugin.flux.TOGGLE_GUILD_FOLDER_EXPAND({ folderId: 1 });
    flush();
    assert.deepEqual(toggles, [2, 3]);
    expanded.add(2).add(3);
    plugin.flux.TOGGLE_GUILD_FOLDER_EXPAND({ folderId: 4 });
    flush();
    assert.deepEqual(toggles, [2, 3]);
    plugin.flux.TOGGLE_GUILD_FOLDER_EXPAND({ folderId: 1 });
    settings.closeOthers = false;
    flush();
    assert.deepEqual(toggles, [2, 3]);
});

test("folder selection toggles once with conflicting preferences and resets across accounts", () => {
    const { plugin, settings, expanded, toggles } = loadFolders();
    settings.forceOpen = true;
    settings.closeServerFolder = true;
    plugin.flux.CHANNEL_SELECT({ guildId: "guild-one" });
    assert.deepEqual(toggles, []);
    expanded.add(1);
    plugin.flux.CONNECTION_OPEN();
    plugin.flux.CHANNEL_SELECT({ guildId: "guild-one" });
    assert.deepEqual(toggles, [1]);
    settings.closeServerFolder = false;
    plugin.flux.LOGOUT();
    plugin.flux.CHANNEL_SELECT({ guildId: "guild-one" });
    assert.deepEqual(toggles, [1, 1]);
    plugin.flux.CHANNEL_SELECT({ guildId: "guild-zero" });
    assert.deepEqual(toggles, [1, 1, 0]);
});

test("numeric settings validate parsed values and retain invalid drafts without committing them", () => {
    const states: unknown[] = [];
    let cursor = 0;
    const { NumberSetting } = loadComponent("src/components/settings/tabs/plugins/components/NumberSetting.tsx", {
        useState(initial: unknown) {
            const index = cursor++;
            if (!(index in states)) states[index] = initial;
            return [states[index], (value: unknown) => { states[index] = value; }];
        }
    });
    const committed: (number | bigint)[] = [];
    const receiver = {};
    let type = 1;
    let validate = (value: number | bigint) => true;
    function render() {
        cursor = 0;
        return NumberSetting({
            setting: { type, isValid(this: object, value: number | bigint) { assert.equal(this, receiver); return validate(value); } },
            pluginSettings: {}, definedSettings: receiver, id: "value", onChange: (value: number | bigint) => committed.push(value)
        });
    }
    function enter(value: string) { render().props.children[0].props.onChange(value); }
    enter("1.5");
    enter("1e3");
    validate = value => typeof value === "number" && Number.isInteger(value);
    enter("42");
    const count = committed.length;
    for (const draft of ["", "-", "1e", "Infinity", "1e999", "1.5"]) {
        enter(draft);
        assert.equal(render().props.children[0].props.value, draft);
        assert.ok(render().props.error);
        assert.equal(committed.length, count);
    }
    type = 2;
    validate = value => typeof value === "bigint";
    enter("900719925474099312345");
    enter("-2");
    const bigIntCount = committed.length;
    for (const draft of ["", "-", "1.5", "1e3"]) {
        enter(draft);
        assert.ok(render().props.error);
        assert.equal(committed.length, bigIntCount);
    }
    assert.deepEqual(committed, [1.5, 1000, 42, 900719925474099312345n, -2n]);
});

test("call timers discard join times on logout and stop, then accept a fresh initial voice batch", () => {
    let user: { id: string; } | undefined = { id: "self" };
    const plugin = loadComponent("src/plugins/callTimer/index.tsx", {
        UserStore: { getCurrentUser: () => user }
    }, {
        "@api/Settings": { definePluginSettings: () => ({ store: { watchLargeGuilds: false, trackSelf: true } }) },
        "@components/ErrorBoundary": { __esModule: true, default: Object.assign(() => null, { wrap: (component: unknown) => component }) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/react": { useFixedTimer: () => 0 },
        "@utils/text": { formatDurationMs: () => "00:00" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "./alignedChatInputFix.css?managed": {}, "./Timer": { Timer: "timer" }
    }).default;
    const update = () => plugin.flux.VOICE_STATE_UPDATES({ voiceStates: [{ userId: "self", channelId: "voice", guildId: "guild" }] });
    for (const reset of [() => plugin.flux.LOGOUT?.(), () => plugin.stop()]) {
        update();
        assert.ok(plugin.renderTimer("self"));
        assert.ok(plugin.ConnectionTimer());
        reset();
        assert.equal(plugin.renderTimer("self"), undefined);
        assert.equal(plugin.ConnectionTimer(), null);
        update();
        assert.ok(plugin.renderTimer("self"));
    }
    user = undefined;
    assert.equal(plugin.ConnectionTimer(), null);
});

test("emoji copy menus keep the real webpack proxy lazy until the Unicode action is used", () => {
    let lookups = 0;
    const copied: string[] = [];
    const plugin = loadComponent("src/plugins/copyEmojiMarkdown/index.tsx", {
        Menu: { MenuGroup: "group", MenuItem: "item" }
    }, {
        "@api/Settings": { definePluginSettings: () => ({ store: { copyUnicode: true } }) },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { copyWithToast: (text: string) => copied.push(text) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} },
        "@webpack": { findByPropsLazy: () => proxyLazy(() => { lookups++; return { convertNameToSurrogate: () => "🛒" }; }) }
    }).default;
    assert.equal(lookups, 0);
    const children: { props: { children: { props: { action: () => void; }; }[]; }; }[] = [];
    plugin.contextMenus["expression-picker"](children, { target: { dataset: { type: "emoji", name: "cart" } } });
    assert.equal(lookups, 0);
    children[0].props.children[0].props.action();
    assert.equal(lookups, 1);
    assert.deepEqual(copied, ["🛒"]);
});

test("file content copying handles failures and prevents copying incomplete previews", async () => {
    const copied: string[] = [];
    const errors: { message: string; }[] = [];
    let fail = false;
    const plugin = loadComponent("src/plugins/copyFileContents/index.tsx", {
        Tooltip: "tooltip", Toasts: { show: (value: typeof errors[number]) => errors.push(value), genId: () => "toast", Type: { FAILURE: "failure" } }
    }, {
        "@components/Button": { Button: "button" },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Icons": { CopyIcon: "copy", NoEntrySignIcon: "unavailable" },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { copyWithToast: async (text: string) => { if (fail) throw new Error("Clipboard unavailable"); copied.push(text); } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }).default;
    const button = (bytesLeft: number) => plugin.addCopyButton({ fileContents: "Fixture", bytesLeft }).props.children[0]({});
    const incomplete = button(1);
    assert.equal(incomplete.props["aria-disabled"], true);
    await incomplete.props.onClick();
    assert.equal(copied.length, 0);
    const complete = button(0);
    assert.equal(complete.type, "button");
    assert.equal(complete.props.type, "button");
    assert.equal(complete.props["aria-label"], "Copy File Contents");
    await complete.props.onClick();
    assert.deepEqual(copied, ["Fixture"]);
    fail = true;
    await complete.props.onClick();
    assert.equal(errors.length, 1);
    fail = false;
    await complete.props.onClick();
    assert.deepEqual(copied, ["Fixture", "Fixture"]);
});

test("console logger levels follow settings changed outside their checkbox component", () => {
    const store = { whitelistedLoggers: "Allowed; Other", allowLevel: { error: true, warn: false } };
    const plugin = loadComponent("src/plugins/consoleJanitor/index.tsx", {}, {
        "@api/Settings": { definePluginSettings: () => ({ store }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/settings/tabs/plugins/components/Common": {},
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, defineDefault: (value: unknown) => value, OptionType: {}, StartAt: {} }
    }).default;
    plugin.start();
    assert.equal(plugin.shouldLog("Unlisted", "warn"), false);
    assert.equal(plugin.shouldLog("Allowed", "warn"), true);
    store.allowLevel.warn = true;
    assert.equal(plugin.shouldLog("Unlisted", "warn"), true);
    store.allowLevel = { error: false, warn: false };
    assert.equal(plugin.shouldLog("Unlisted", "error"), false);
    assert.equal(plugin.shouldLog("Other", "error"), true);
});

test("disabled links have no destination and suppress click callbacks", () => {
    const { Link } = loadComponent("src/components/Link.tsx");
    let clicked = 0;
    let prevented = 0;
    const props = { href: "https://example.com", onClick: () => clicked++ };
    const disabled = Link({ ...props, disabled: true });
    assert.equal(disabled.props.href, undefined);
    disabled.props.onClick({ preventDefault: () => prevented++ });
    assert.equal(clicked, 0);
    assert.equal(prevented, 1);
    const enabled = Link(props);
    assert.equal(enabled.props.href, props.href);
    enabled.props.onClick();
    assert.equal(clicked, 1);
});

test("grid layout props stay in styles instead of leaking to the DOM", () => {
    const { Grid } = loadComponent("src/components/Grid.tsx");
    const { props } = Grid({ columns: 3, gap: "8px", inline: true, id: "grid", style: { gap: "12px" } });
    assert.equal(props.id, "grid");
    for (const key of ["columns", "gap", "inline"]) assert.equal(key in props, false);
    assert.equal(props.style.display, "inline-grid");
    assert.equal(props.style.gap, "12px");
    assert.equal(props.style.gridTemplateColumns, "repeat(3, 1fr)");
});

test("legacy text colors do not mutate a shared or frozen style object", () => {
    const { TextCompat } = loadComponent("src/components/BaseText.tsx");
    const style = Object.freeze({ color: "original", margin: 4 });
    const result = TextCompat({ style, color: "text-muted", children: "text" });
    assert.equal(style.color, "original");
    assert.equal(result.props.style.color, "var(--text-muted, var(--text-default))");
    assert.equal(result.props.style.margin, 4);
    assert.notEqual(result.props.style, style);
});

for (const action of ["Enter", "Escape", "blur"]) {
    test(`editable text uses the current value and handles ${action} once`, () => {
        let editing = false;
        const { EditableText } = loadComponent("src/components/settings/EditableText.tsx", {
            useState: () => [editing, (value: boolean) => { editing = value; }]
        });
        const changes: string[] = [];
        const onChange = (value: string) => changes.push(value);
        EditableText({ value: "old", onChange });
        EditableText({ value: "current", onChange }).props.onClick();
        const input = EditableText({ value: "current", onChange });
        assert.equal(input.props.defaultValue, "current");
        assert.equal(input.props.autoFocus, true);
        const target = { value: "edited", blur: () => input.props.onBlur({ currentTarget: target }) };
        if (action === "blur") target.blur();
        else {
            let prevented = false;
            input.props.onKeyDown({ key: action, currentTarget: target, preventDefault() { prevented = true; } });
            assert.equal(prevented, true, "editing keys must not submit a surrounding form");
        }
        assert.deepEqual(changes, action === "Escape" ? [] : ["edited"]);
        assert.equal(editing, false);
    });
}


function loadShortcuts() {
    const state = { resolutions: 0, opens: 0, roots: 0, unmounts: 0, renders: [] as unknown[], blocked: false, failRoot: false };
    const module = Object.freeze({ value: "lazy module", nested: Object.freeze({ value: 1 }) });
    const lazy = proxyLazy(() => { state.resolutions++; return module; });
    const modules: Record<string, unknown>[] = [];
    const fluxStores = new Map<string, object>();
    const popups: ReturnType<typeof makePopup>[] = [];
    function makePopup() {
        let pagehide: (() => void) | undefined;
        return {
            closed: false, closes: 0, focus() {},
            document: {
                head: { append() {} },
                body: { style: {}, appendChild: (element: object) => element },
                createElement: () => ({})
            },
            addEventListener(event: string, callback: () => void) { assert.equal(event, "pagehide"); pagehide = callback; },
            close() { this.closes++; this.closed = true; pagehide?.(); },
            leave() { this.closed = true; pagehide?.(); }
        };
    }
    const window = {
        open() {
            state.opens++;
            if (state.blocked) return null;
            const popup = makePopup();
            popups.push(popup);
            return popup;
        }
    };
    const byProps = (...keys: string[]) => (value: Record<string, unknown>) => keys.every(key => Object.hasOwn(value, key));
    const webpack = {
        fluxStores,
        filters: { byProps, byCode: byProps, componentByCode: byProps, byClassNames: byProps },
        findAll: (filter: (value: object) => boolean) => modules.filter(filter),
        findStore: (name: string) => { const store = fluxStores.get(name); if (!store) throw new Error("Missing store"); return store; },
        findModuleId: (code: string) => code === "present" ? 0 : null,
        extract: (id: number) => { assert.equal(id, 0); return "source"; },
        search() {}
    };
    const plugin = loadComponent("src/plugins/consoleShortcuts/index.ts", {
        LazyModule: lazy,
        createRoot: () => {
            if (state.failRoot) throw new Error("Root unavailable");
            state.roots++;
            return { render: (element: unknown) => state.renders.push(element), unmount: () => state.unmounts++ };
        }
    }, {
        "@debug/loadLazyChunks": { loadLazyChunks() { assert.fail("Automatic chunk loading"); } },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { getCurrentChannel: () => null, getCurrentGuild: () => null },
        "@utils/intlHash": { runtimeHashMessageKey() {} },
        "@utils/lazy": { SYM_LAZY_GET },
        "@utils/native": { relaunch() { assert.fail("Unexpected relaunch"); } },
        "@utils/patches": { canonicalizeMatch() {}, canonicalizeReplace() {}, canonicalizeReplacement() {} },
        "@utils/types": { __esModule: true, default: (value: object) => value, StartAt: {} },
        "@webpack": webpack
    }, {
        window, document: { querySelectorAll: () => [] },
        IS_WEB: false, IS_VESKTOP: false, IS_EQUIBOP: false
    }).default;
    return { plugin, window, state, module, modules, fluxStores, popups };
}

test("console aliases resolve lazies only on access without mutating module exports", async () => {
    const { plugin, window, state, module } = loadShortcuts();
    plugin.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.resolutions, 0);
    const shortcuts = Reflect.get(window, "shortcutList");
    assert.equal(Reflect.get(window, "LazyModule"), module);
    assert.equal(shortcuts.LazyModule, module);
    assert.equal(state.resolutions, 1);
    assert.deepEqual(module.nested, { value: 1 });
    plugin.stop();
    assert.equal(Object.hasOwn(window, "LazyModule"), false);
});

test("console aliases restore owned descriptors and preserve collisions and external replacements", () => {
    const { plugin, window } = loadShortcuts();
    const previous = { value: "previous", writable: false, configurable: true, enumerable: false };
    Object.defineProperty(window, "wp", previous);
    Object.defineProperty(window, "find", { value: "reserved", configurable: false });
    const previousList = { value: "previous list", writable: true, configurable: true, enumerable: false };
    Object.defineProperty(window, "shortcutList", previousList);
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    plugin.start();
    assert.equal(Reflect.get(window, "shortcutList"), shortcuts);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(shortcuts.find(() => true), null);
    Object.defineProperty(window, "reload", { value: "external", configurable: true });
    plugin.stop();
    plugin.stop();
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "wp"), previous);
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "shortcutList"), previousList);
    assert.equal(Reflect.get(window, "find"), "reserved");
    assert.equal(Reflect.get(window, "reload"), "external");
    plugin.start();
    plugin.stop();
    assert.equal(Reflect.get(window, "reload"), "external");
});

test("console searches distinguish identical-looking closures and reflect replaced modules and stores", () => {
    const { plugin, window, modules, fluxStores } = loadShortcuts();
    plugin.start();
    const shortcuts = Reflect.get(window, "shortcutList");
    const first = { id: 1 }, second = { id: 2 };
    modules.push(first, second);
    const byId = (id: number) => (module: { id: number }) => module.id === id;
    assert.equal(String(byId(1)), String(byId(2)));
    assert.equal(shortcuts.find(byId(1)), first);
    assert.equal(shortcuts.find(byId(2)), second);
    const replacement = { id: 1 };
    modules.splice(0, 1, replacement);
    assert.equal(shortcuts.find(byId(1)), replacement);
    assert.equal(shortcuts.findExportedComponent("absent"), undefined);
    assert.equal(shortcuts.wpexs("absent"), null);
    assert.equal(shortcuts.wpexs("present"), "source");
    assert.equal(shortcuts.findStore("Sample"), null);
    assert.equal(shortcuts.Stores.Sample, undefined);
    fluxStores.set("Sample", first);
    assert.equal(shortcuts.Stores.Sample, first);
    assert.equal(shortcuts.findStore("Sample"), first);
    fluxStores.set("Sample", second);
    assert.equal(shortcuts.findStore("Sample"), second);
    assert.equal(shortcuts.Stores.Sample, second);
    plugin.stop();
});

test("console previews report blocked popups and reuse one root until close or stop", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    const component = () => null;
    state.blocked = true;
    assert.throws(() => fakeRender(component), /Could not open/);
    assert.equal(state.roots, 0);
    state.blocked = false;
    fakeRender(component, { value: 1 });
    fakeRender(component, { value: 2 });
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 2);
    popups[0].leave();
    assert.equal(state.unmounts, 1);
    fakeRender(component);
    assert.equal(state.roots, 2);
    plugin.stop();
    plugin.stop();
    assert.equal(state.unmounts, 2);
    assert.equal(popups[1].closed, true);
    assert.equal(popups[1].closes, 1);
});


test("console previews can retry after root creation fails", () => {
    const { plugin, window, state, popups } = loadShortcuts();
    plugin.start();
    const { fakeRender } = Reflect.get(window, "shortcutList");
    state.failRoot = true;
    assert.throws(() => fakeRender(() => null), /Root unavailable/);
    assert.equal(popups[0].closed, true);
    state.failRoot = false;
    fakeRender(() => null);
    assert.equal(state.roots, 1);
    assert.equal(state.renders.length, 1);
    plugin.stop();
    assert.equal(state.unmounts, 1);
});


test("timestamp rounding restores the previous function only while its override is owned", () => {
    const original = moment.relativeTimeRounding();
    const previous = (value: number) => Math.ceil(value);
    const plugin = loadComponent("src/plugins/dontRoundMyTimestamps/index.ts", { moment }, {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }).default;
    try {
        moment.relativeTimeRounding(previous);
        plugin.start();
        plugin.start();
        assert.equal(moment.relativeTimeRounding()(7.6), 7);
        plugin.stop();
        plugin.stop();
        assert.equal(moment.relativeTimeRounding(), previous);
        plugin.start();
        moment.relativeTimeRounding(Math.ceil);
        plugin.stop();
        assert.equal(moment.relativeTimeRounding(), Math.ceil);
    } finally {
        moment.relativeTimeRounding(original);
    }
});

test("image quality overrides stay on Discord attachments and preserve freeze and resize behavior", () => {
    const settings = { originalImagesInChat: false };
    const errors: unknown[] = [];
    const plugin = loadComponent("src/plugins/fixImagesQuality/index.tsx", {}, {
        "@api/Settings": { definePluginSettings: () => ({ store: settings }) },
        "@components/Card": {}, "@components/Flex": {}, "@components/margins": {}, "@components/Paragraph": {},
        "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: {} }
    }, { URL }).default;
    const props = Object.freeze({ src: "https://media.discordapp.net/attachments/1/2/image.gif?ex=expiry&hm=signature", width: 4000, height: 2400, contentType: "image/gif" });
    for (const origin of ["https://example.org", "http://media.discordapp.net", "https://media.discordapp.net:444", "https://user:pass@media.discordapp.net", "https://media.discordapp.net.example.org"]) {
        assert.equal(plugin.getSrc({ ...props, src: `${origin}/attachments/1/2/image.gif`, trigger: "modal" }), undefined);
    }
    assert.equal(plugin.getSrc({ ...props, src: "https://media.discordapp.net/external/image.gif" }), undefined);
    assert.equal(plugin.getSrc({ ...props, contentType: "video/mp4" }), undefined);
    const resized = new URL(plugin.getSrc(props, true));
    assert.equal(resized.origin, "https://media.discordapp.net");
    assert.equal(resized.searchParams.get("width"), "2000");
    assert.equal(resized.searchParams.get("height"), "1200");
    assert.equal(resized.searchParams.get("animated"), "false");
    assert.equal(resized.searchParams.get("format"), "webp");
    assert.equal(resized.searchParams.get("hm"), "signature");
    assert.equal(props.src.includes("width="), false, "the source props remain unchanged");
    const original = new URL(plugin.getSrc({ ...props, trigger: "modal" }));
    assert.equal(original.origin, "https://cdn.discordapp.com");
    assert.equal(original.searchParams.get("animated"), "true");
    assert.equal(original.searchParams.get("ex"), "expiry");
    for (const [width, height] of [[NaN, 20], [Infinity, 20], [0, 20], [-1, -1], [1e308, 1e308], [1e12, 1]])
        assert.equal(plugin.getSrc({ ...props, width, height }), undefined);
    const embed = new URL(plugin.getSrc({ ...props, contentType: undefined, mosaicStyleAlt: false, width: 100, height: 100 }));
    assert.equal(embed.origin, "https://media.discordapp.net");
    assert.equal(embed.searchParams.has("width"), false);
    settings.originalImagesInChat = true;
    assert.equal(new URL(plugin.getSrc(props)).origin, "https://cdn.discordapp.com");
    assert.deepEqual(errors, []);
});

test("owner crowns retain the host result when guild context is unavailable", () => {
    const guilds = new Map<string, { ownerId: string; }>();
    const plugin = loadComponent("src/plugins/forceOwnerCrown/index.ts", { GuildStore: { getGuild: (id: string) => guilds.get(id) } }, {
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin }
    }).default;
    assert.equal(plugin.isGuildOwner({ isOwner: true }), true);
    const props = { user: { id: "owner" }, guildId: "guild", isOwner: true };
    assert.equal(plugin.isGuildOwner(props), true);
    assert.equal(plugin.isGuildOwner({ ...props, isOwner: false }), false);
    assert.equal(plugin.isGuildOwner({ ...props, guildId: undefined }), true);
    guilds.set("guild", { ownerId: "other" });
    assert.equal(plugin.isGuildOwner(props), false);
    assert.equal(plugin.isGuildOwner({ ...props, channel: { type: 3 } }), true);
    guilds.set("guild", { ownerId: "owner" });
    assert.equal(plugin.isGuildOwner({ ...props, isOwner: false }), true);
    assert.equal(plugin.isGuildOwner({ ...props, guildId: undefined, channel: { guild_id: "guild" } }), true);
    assert.equal(plugin.isGuildOwner(), undefined);
});
