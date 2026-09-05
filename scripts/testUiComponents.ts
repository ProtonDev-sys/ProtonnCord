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

function loadComponent(path: string, hooks: Record<string, unknown> = {}, additionalMocks: Record<string, object> = {}) {
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
        exports: {}, React,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

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
