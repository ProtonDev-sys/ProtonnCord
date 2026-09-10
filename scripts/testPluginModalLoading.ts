/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function compile(path: string) {
    return transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
}

function loadPluginModal() {
    const timers: (() => void)[] = [];
    let timersRun = 0;
    const lazy = runInNewContext(`${compile("src/utils/lazy.ts")}\nexports;`, {
        exports: {}, console,
        setTimeout(callback: () => void) {
            timers.push(() => { timersRun++; callback(); });
            return timers.length;
        }
    });
    const lookups: string[][] = [];
    let currentUserReads = 0;
    const effects: (() => void | (() => void))[] = [];
    const settingTimers = new Map<number, () => void>();
    let settingTimerId = 0;
    const scheduler = runInNewContext(`${compile("src/components/settings/tabs/plugins/settingUpdates.ts")}\nexports;`, {
        exports: {},
        setTimeout(callback: () => void) { settingTimers.set(++settingTimerId, callback); return settingTimerId; },
        clearTimeout(id: number) { settingTimers.delete(id); }
    });
    const hooks: { value: any; dependencies?: unknown[]; }[] = [];
    let cursor = 0;
    const sameDependencies = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    function useMemo(factory: () => unknown, dependencies: unknown[]) {
        const index = cursor++;
        if (!hooks[index] || !sameDependencies(hooks[index].dependencies, dependencies)) hooks[index] = { value: factory(), dependencies };
        return hooks[index].value;
    }
    const dispatched: any[] = [];
    const contributorOpens: unknown[] = [];
    const restartKeys: string[] = [];
    const subscriptions: string[][] = [];
    const modalOpeners: ((props: object) => any)[] = [];
    const optionType = { CUSTOM: 0, BOOLEAN: 1, STRING: 2, SELECT: 3 };
    const settings = { plugins: { Example: { enabled: false, sound: false, isFavorite: false } } };
    const plugin = {
        name: "Example", description: "Example description",
        authors: Array.from({ length: 7 }, (_, index) => ({ name: `Author ${index}`, id: String(index + 1) })),
        settings: { store: settings.plugins.Example, def: {
            sound: { type: optionType.BOOLEAN, default: false, restartNeeded: true },
            hidden: { type: optionType.STRING, hidden: true },
            custom: { type: optionType.CUSTOM },
        } }
    };
    class UserRecord {
        id: string;
        username: string;
        bot?: boolean;
        constructor(data: { id: string; username: string; bot?: boolean; }) {
            this.id = data.id;
            this.username = data.username;
            this.bot = data.bot;
        }
        getAvatarURL() { return `avatar:${this.id}`; }
    }
    const currentUser = new UserRecord({ id: "current", username: "Current user" });
    const React = {
        createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
        Fragment: "fragment"
    };
    const findCssClasses = (...keys: string[]) => {
        lookups.push(keys);
        return { clickableAvatar: "clickable-avatar", avatar: "avatar-image", moreUsers: "more-users" };
    };
    const mocks: Record<string, unknown> = {
        "./PluginModal.css": {},
        "@api/Commands": { generateId: () => "generated-user" },
        "@api/PluginManager": { hasAnyVisibleSettings: () => true, isSettingHidden: (_settings: unknown, option: { hidden?: boolean; }) => !!option.hidden },
        "@api/Settings": { useSettings: (paths: string[]) => { subscriptions.push([...paths]); return settings; } },
        "@components/BaseText": { BaseText: "text" },
        "@components/Button": { Button: "button" },
        "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@components/Flex": { Flex: "flex" },
        "@components/Paragraph": { Paragraph: "paragraph" },
        "@shared/vencordUserAgent": { gitRemote: "ProtonDev-sys/ProtonnCord" },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/lazy": lazy,
        "@utils/margins": { Margins: {} },
        "@utils/misc": { classes: (...names: unknown[]) => names.filter(Boolean).join(" "), isObjectEmpty: (value: object) => !Object.keys(value).length },
        "@utils/types": { OptionType: optionType },
        "@webpack": {
            findCssClasses,
            findCssClassesLazy: (...keys: string[]) => lazy.proxyLazy(() => findCssClasses(...keys)),
            findComponentByCodeLazy: () => "lazy-component"
        },
        "@webpack/common": {
            React, Clickable: "clickable", Modal: "modal", Text: "text", Tooltip: "tooltip", UserSummaryItem: "user-summary",
            FluxDispatcher: { dispatch: (event: unknown) => dispatched.push(event) },
            openModal: (opener: (props: object) => any) => modalOpeners.push(opener),
            useEffect: (effect: () => void, dependencies: unknown[]) => useMemo(() => { effects.push(effect); }, dependencies),
            useMemo,
            useRef: (initial: unknown) => useMemo(() => ({ current: initial }), []),
            useState: (initial: unknown) => {
                const index = cursor++;
                hooks[index] ??= { value: initial };
                return [hooks[index].value, (value: any) => { hooks[index].value = typeof value === "function" ? value(hooks[index].value) : value; }];
            },
            Toasts: { show() {}, genId: () => "toast", Type: { SUCCESS: "success" }, Position: { TOP: "top" } },
            UserStore: { getCurrentUser: () => { currentUserReads++; return currentUser; } },
            UserUtils: { getUser: () => { throw new Error("Author requests must wait for the effect"); } },
        },
        "~plugins": { PluginMeta: { Example: { folderName: "src/plugins/example", userPlugin: false } } },
        "./components": { OptionComponentMap: { [optionType.BOOLEAN]: "boolean-setting", [optionType.STRING]: "string-setting" } },
        "./ContributorModal": { openContributorModal: (user: unknown) => contributorOpens.push(user) },
        "./PluginModalButtons": { FavoriteButton: "favorite", GithubButton: "github", WebsiteButton: "website" },
        "./settingUpdates": scheduler,
    };
    const module = runInNewContext(`${compile("src/components/settings/tabs/plugins/PluginModal.tsx")}\nexports;`, {
        exports: {}, structuredClone,
        require(name: string) {
            assert.ok(name in mocks, `Unexpected plugin modal import: ${name}`);
            return mocks[name];
        }
    });
    const onClose = () => {};
    const render = () => { cursor = 0; return module.default({ plugin, onClose, transitionState: "opening", onRestartNeeded: (key: string) => restartKeys.push(key) }); };
    const flushSettingTimers = () => { const work = [...settingTimers.values()]; settingTimers.clear(); for (const callback of work) callback(); };
    return {
        module, render, plugin, settings, onClose, UserRecord, lookups, effects, timers, dispatched, subscriptions,
        contributorOpens, restartKeys, modalOpeners, optionType, settingTimers, flushSettingTimers, currentUserReads: () => currentUserReads, timersRun: () => timersRun,
    };
}

function find(tree: any, type: string): any[] {
    if (Array.isArray(tree)) return tree.flatMap(child => find(child, type));
    if (!tree || typeof tree !== "object") return [];
    return [...(tree.type === type ? [tree] : []), ...find(tree.props?.children, type)];
}

test("plugin modal lookups wait for rendering and first-tick avatar classes are strings", () => {
    const fixture = loadPluginModal();
    assert.equal(fixture.lookups.length, 0);
    assert.equal(fixture.currentUserReads(), 0);
    assert.equal(fixture.effects.length, 0);
    const modal = fixture.render();
    assert.deepEqual(fixture.lookups, [["moreUsers", "avatar", "clickableAvatar"]]);
    assert.equal(modal.props.onClose, fixture.onClose);
    assert.equal(modal.props.transitionState, "opening");
    const summary = find(modal, "user-summary")[0];
    const placeholder = summary.props.users[0];
    assert.equal(placeholder.username, "Loading...");
    assert.equal(placeholder.bot, true);
    const avatar = summary.props.renderUser(placeholder);
    assert.equal(avatar.props.className, "clickable-avatar");
    assert.equal(find(avatar, "img")[0].props.className, "avatar-image");
    avatar.props.onClick();
    assert.equal(fixture.contributorOpens[0], placeholder);
    const more = summary.props.renderMoreUsers("");
    assert.equal(more.props.children[0]({}).props.className, "more-users");
    fixture.render();
    assert.equal(fixture.lookups.length, 1, "repeat renders reuse the CSS lookup");
    assert.equal(fixture.timersRun(), 0, "all assertions run before any lazy-helper timer");
});

test("plugin modal first-tick fallback users retain the Discord record prototype", () => {
    const fixture = loadPluginModal();
    fixture.render();
    const record = fixture.dispatched[0].user;
    assert.equal(fixture.dispatched[0].type, "USER_UPDATE");
    assert.equal(Object.getPrototypeOf(record), fixture.UserRecord.prototype);
    assert.equal(record instanceof fixture.UserRecord, true);
    assert.equal(record.getAvatarURL(), `avatar:${record.id}`);
    assert.equal(fixture.timersRun(), 0);
});

test("lazy modal rendering preserves settings, favorites, and restart callback behavior", () => {
    const fixture = loadPluginModal();
    fixture.module.openPluginModal(fixture.plugin, (name: string, key: string) => fixture.restartKeys.push(`${name}:${key}`));
    const opened = fixture.modalOpeners[0]({ onClose: fixture.onClose, transitionState: "opening" });
    assert.equal(opened.props.plugin, fixture.plugin);
    const modal = opened.type(opened.props);
    assert.deepEqual(fixture.subscriptions, [["plugins.Example.*"]]);
    const options = find(modal, "boolean-setting");
    assert.equal(options.length, 1);
    assert.equal(find(modal, "string-setting").length, 0, "hidden settings stay hidden");
    assert.equal(options[0].props.closePluginSettings, fixture.onClose);
    options[0].props.onChange(true);
    fixture.flushSettingTimers();
    assert.equal(fixture.settings.plugins.Example.sound, true);
    assert.deepEqual(fixture.restartKeys, ["Example:sound"]);
    find(modal, "favorite")[0].props.onClick();
    assert.equal(fixture.settings.plugins.Example.isFavorite, true);
});

test("modal rerenders share pending option changes and closing flushes the latest edit once", () => {
    const f = loadPluginModal();
    let modal = f.render();
    const cleanup = f.effects[0]();
    find(modal, "boolean-setting")[0].props.onChange(true);
    modal = f.render();
    find(modal, "boolean-setting")[0].props.onChange(false);
    assert.equal(f.settingTimers.size, 1);
    assert.equal(typeof cleanup, "function");
    cleanup!();
    assert.equal(f.settings.plugins.Example.sound, false);
    assert.deepEqual(f.restartKeys, ["sound"]);
    f.flushSettingTimers();
    cleanup!();
    assert.deepEqual(f.restartKeys, ["sound"]);
});

test("reset cancels pending saves, restores selected defaults and isolates mutable definitions", () => {
    const f = loadPluginModal();
    const selected = { type: f.optionType.SELECT, options: [{ value: "default", default: true }, { value: "edited" }] };
    const defaults = { list: ["original"] };
    Object.assign(f.plugin.settings.def, { selected, custom: { type: f.optionType.CUSTOM, default: defaults } });
    Object.assign(f.settings.plugins.Example, { selected: "edited", custom: { list: ["edited"] }, enabled: true, isFavorite: true });
    const modal = f.render();
    find(modal, "boolean-setting")[0].props.onChange(true);
    find(modal, "tooltip").map(tooltip => tooltip.props.children[0]({})).find(node => node.type === "button").props.onClick();
    f.modalOpeners[0]({ onClose() {} }).props.onConfirm();
    f.flushSettingTimers();
    const values = f.settings.plugins.Example as typeof f.settings.plugins.Example & { selected: string; custom: typeof defaults; };
    assert.equal(values.sound, false);
    assert.equal(values.selected, "default");
    assert.equal(values.enabled, true);
    assert.equal(values.isFavorite, true);
    values.custom.list.push("new edit");
    assert.deepEqual(defaults.list, ["original"]);
    assert.equal(find(f.render(), "boundary").some(boundary => boundary.props.key === "1:sound"), true, "reset remounts local input drafts");
});
