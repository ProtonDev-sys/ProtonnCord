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

import { getKeybindString, matchesKeybind } from "../src/equicordplugins/channelTabs/util/keybinds";

const base = "src/equicordplugins/channelTabs/";
const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
const logger = { warn() {}, error() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));

function load(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}, extra = "") {
    const code = transpileModule(readFileSync(base + file, "utf8") + extra, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, console, structuredClone,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        },
        ...globals
    });
}

function tabsHarness(renderAllTabs = false) {
    const settings = { store: { renderAllTabs, maxOpenTabs: 0, bookmarksIndependentFromTabs: true } };
    const navigations: string[] = [];
    const delayed: (() => void)[] = [];
    const scroll = { scrollTop: 0 };
    const tabs = load("util/tabs.tsx", {
        "@api/index": { DataStore: {} }, "@api/PluginManager": { isPluginEnabled: () => false },
        "@utils/css": { classNameFactory: () => () => "" },
        "./constants": { settings, logger },
        "@webpack/common": {
            NavigationRouter: { transitionToGuild: (_guild: string, channel: string) => navigations.push(channel), transitionTo: (route: string) => navigations.push(route) },
            SelectedChannelStore: { getChannelId: () => "current" }, SelectedGuildStore: { getGuildId: () => "@me" }
        }
    }, {
        clearTimeout() {},
        setTimeout(callback: () => void, ms: number) { if (ms === 50) delayed.push(callback); },
        requestAnimationFrame: (callback: () => void) => callback(),
        document: { querySelector: () => scroll }
    });
    tabs.setUpdaterFunction(() => {});
    return { tabs, settings, navigations, delayed, scroll };
}

test("tab limits honor the requested navigation flag and close history includes tab zero", () => {
    const { tabs, settings, navigations } = tabsHarness();
    tabs.createTab({ guildId: "@me", channelId: "zero" }, true);
    tabs.createTab({ guildId: "@me", channelId: "one" }, true);
    tabs.createTab({ guildId: "@me", channelId: "two" }, true);
    tabs.moveToTab(0);
    tabs.moveToTab(1);
    tabs.closeTab(1);
    assert.equal(navigations.at(-1), "zero", "closing the current tab returns to tab zero before its right-hand neighbor");
    settings.store.maxOpenTabs = 2;
    navigations.length = 0;
    tabs.createTab({ guildId: "@me", channelId: "background" }, false);
    assert.equal(navigations.length, 0);
    tabs.createTab({ guildId: "@me", channelId: "foreground" }, true);
    assert.deepEqual(navigations, ["foreground"]);
    assert.equal(tabs.openedTabs.length, 2);
});

test("delayed tab scroll restoration cannot move the newly selected chat", () => {
    const { tabs, delayed, scroll } = tabsHarness(true);
    tabs.createTab({ guildId: "@me", channelId: "zero" }, true);
    scroll.scrollTop = 100;
    tabs.createTab({ guildId: "@me", channelId: "one" }, true);
    scroll.scrollTop = 200;
    tabs.moveToTab(0);
    tabs.moveToTab(1);
    scroll.scrollTop = 300;
    delayed[0]();
    assert.equal(scroll.scrollTop, 300, "obsolete tab-zero restore is ignored");
    tabs.navigateToBookmark({ guildId: "@me", channelId: "bookmark" });
    delayed[1]();
    assert.equal(scroll.scrollTop, 300, "a tab restore cannot overwrite an independently viewed bookmark");
});

function bookmarksHarness() {
    let state: object | undefined;
    let options: any;
    let persisted: any = { sibling: [{ channelId: "untouched" }] };
    let writes = 0;
    const api = load("util/bookmarks.ts", {
        "@api/index": { DataStore: { update(_key: string, callback: (old: object) => object) { persisted = callback(persisted); writes++; return Promise.resolve(); } } },
        "@utils/react": { useAwaiter(_factory: unknown, opts: object) { options = opts; } },
        "@webpack/common": {
            useState(initial: object) { state ??= initial; return [state, (next: object) => { state = next; }]; },
            useCallback: (fn: unknown) => fn,
            ChannelStore: { getChannel: () => undefined }, UserStore: {}
        },
        "./constants": { logger, bookmarkFolderColors: { Black: "#000000" } }
    });
    return {
        api,
        render: () => api.useBookmarks("user"),
        hydrate(bookmarks: object[]) { options.onSuccess({ user: bookmarks }); },
        get writes() { return writes; },
        get persisted() { return persisted; }
    };
}

test("pending bookmark hydration and invalid drag indexes cannot corrupt saved bookmarks", () => {
    const harness = bookmarksHarness();
    let [, methods] = harness.render();
    methods.addBookmark({ channelId: "one", guildId: "@me" });
    methods.moveDraggedBookmarks(0, 1);
    methods.deleteBookmark(0);
    assert.equal(methods.addFolder("pending"), -1);
    assert.equal(harness.writes, 0);
    harness.hydrate([{ channelId: "one", guildId: "@me", name: "One" }, { channelId: "two", guildId: "@me", name: "Two" }]);
    [, methods] = harness.render();
    for (const [from, to] of [[2, 0], [0, -1], [0, 2], [0.5, 1], [NaN, 0]]) methods.moveDraggedBookmarks(from, to);
    methods.editBookmark(-1, { name: "invalid" });
    methods.addBookmark({ channelId: "three" }, 99);
    assert.equal(harness.writes, 0, "loading and invalid edits do not write to storage");
    methods.moveDraggedBookmarks(0, 1);
    assert.deepEqual(Array.from(harness.persisted.user, (item: any) => item.channelId), ["two", "one"]);
    assert.deepEqual(harness.persisted.sibling, [{ channelId: "untouched" }]);
});

test("dropping a root bookmark into a later folder preserves both destination and bookmark", () => {
    const harness = bookmarksHarness();
    harness.render();
    const source = { channelId: "one", guildId: "@me", name: "One" };
    const folder = { name: "Folder", iconColor: "#000000", bookmarks: [] as object[] };
    harness.hydrate([source, folder]);
    const [bookmarks, methods] = harness.render();
    const drops: any[] = [];
    const api = load("components/BookmarkContainer.tsx", {
        "@components/BaseText": {}, "@equicordplugins/channelTabs/util": { ...harness.api, settings: { use: () => ({}), store: {} } },
        "@equicordplugins/channelTabs/util/icons": {}, "@utils/css": { classNameFactory: () => () => "" },
        "@utils/discord": {}, "@utils/misc": { classes: () => "" }, "@webpack": { findComponentByCodeLazy: () => "icon" },
        "@webpack/common": {
            React, useState: (initial: unknown) => [initial, () => {}], useRef: () => ({ current: null }), useEffect() {},
            useDrag: () => [{}, (ref: unknown) => ref],
            useDrop(factory: () => unknown) { drops.push(factory()); return [{}, (ref: unknown) => ref]; }
        },
        "./ChannelTab": {}, "./ContextMenus": {}
    }, {}, "\nexport { Bookmark as RenderBookmark };\n");
    api.RenderBookmark({ bookmarks, methods, index: 1 });
    drops[1].drop({ index: 0, bookmark: source, isFromFolder: false }, { getItemType: () => "vc_Bookmark" });
    assert.equal(bookmarks.length, 1);
    assert.equal(bookmarks[0], folder);
    assert.equal(folder.bookmarks.length, 1);
    assert.equal((folder.bookmarks[0] as any).channelId, "one");
});

test("recorded Mac modifiers, Escape, Space and plus keys round-trip while legacy CTRL aliases remain usable", () => {
    const event = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });
    for (const isMac of [false, true]) {
        for (const input of [event("t", { metaKey: true }), event("Escape", { ctrlKey: true }), event(" ", { altKey: true }), event("+", { ctrlKey: true, shiftKey: true }), event("t", { ctrlKey: true, metaKey: true })]) {
            const encoded = getKeybindString(input, isMac);
            assert.equal(matchesKeybind(input, encoded), true, encoded);
            assert.equal(matchesKeybind({ ...input, altKey: !input.altKey }, encoded), false, encoded);
        }
    }
    assert.equal(getKeybindString(event("t", { metaKey: true }), true), "CTRL+T");
    assert.equal(getKeybindString(event("t", { ctrlKey: true }), true), "CONTROL+T");
    assert.equal(matchesKeybind(event("Tab", { ctrlKey: true }), "CTRL+TAB"), true);
    assert.equal(matchesKeybind(event("t", { metaKey: true }), "CONTROL+T"), false);
    assert.equal(matchesKeybind(event("t"), ""), false);
});

test("unread persistence retries failed loads and waits for existing counts before saving updates", async () => {
    let loads = 0;
    let resolveLoad: (value: object) => void;
    const errors: unknown[] = [];
    let persisted: any;
    let rejectSave = false;
    const unreadState = load("util/unreadState.ts", {});
    const api = load("util/unread.ts", {
        "@equicordplugins/channelTabs/util/unreadState": unreadState,
        "./constants": { logger: { error: (...args: unknown[]) => errors.push(args) } },
        "@api/index": { DataStore: {
            get() { loads++; return loads === 1 ? Promise.reject(new Error("load failure")) : new Promise(resolve => { resolveLoad = resolve; }); },
            update(_key: string, callback: (old: object) => object) { persisted = callback(persisted); return rejectSave ? Promise.reject(new Error("save failure")) : Promise.resolve(); }
        } }
    });
    await assert.rejects(api.ensureUnreadFallbackCountsLoaded("user"), /load failure/);
    const pending = api.ensureUnreadFallbackCountsLoaded("user");
    api.updateUnreadFallbackCounts("user", [{ channelId: "updated", hasUnread: true, unreadCount: 3, mentionCount: 0 }]);
    assert.equal(typeof persisted, "undefined");
    assert.equal(loads, 2, "failed reads can be retried and concurrent updates share the next read");
    resolveLoad!({ user: { untouched: 7 } });
    await pending;
    await flush();
    assert.equal(persisted.user.untouched, 7);
    assert.equal(persisted.user.updated, 3);
    rejectSave = true;
    api.updateUnreadFallbackCounts("user", [{ channelId: "updated", hasUnread: false, unreadCount: 0, mentionCount: 0 }]);
    await flush();
    assert.equal(errors.length, 1, "write failures are observed without requiring another write");
});
