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

function loadSource(path: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}, result = "exports") {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + `\n${result};`, {
        exports: {}, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

const boundary = { __esModule: true, default: { wrap: (component: (props: object) => unknown) => (props: object) => component(props) } };

function loadBadges() {
    const requests: { url: string; resolve(response: Response): void; reject(error: Error): void; }[] = [];
    const intervals = new Map<number, () => Promise<void>>();
    const errors: unknown[][] = [];
    const toasts: { type: string; }[] = [];
    let nextInterval = 0;
    const { plugin, refresh } = loadSource("src/plugins/_api/badges/index.tsx", {
        "@api/Badges": { BadgePosition: { START: 0 } },
        "@components/ErrorBoundary": boundary,
        "@components/settings/tabs": {},
        "@utils/constants": { Devs: {} },
        "@utils/discord": {},
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { Toasts: { genId: () => "toast", show: (toast: { type: string; }) => toasts.push(toast), Type: { SUCCESS: "success", FAILURE: "failure" } } },
        "~plugins": {},
        "./modals": {}
    }, {
        fetch: (url: string) => new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject })),
        setInterval: (callback: () => Promise<void>) => { intervals.set(++nextInterval, callback); return nextInterval; },
        clearInterval: (id: number) => intervals.delete(id)
    }, "({ plugin: exports.default, refresh: refreshBadges })");
    return { plugin, refresh, requests, intervals, errors, toasts };
}

function response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status });
}

test("badge registration preserves caller objects and dynamic component identity", () => {
    const api = loadSource("src/api/Badges.ts", {
        "@components/ErrorBoundary": boundary,
        "@equicordplugins/globalBadges": { __esModule: true, default: { name: "GlobalBadges" } },
        "@plugins/_api/badges": { __esModule: true, default: { getDonorBadges() {}, getEquicordDonorBadges() {} } },
        "./PluginManager": { isPluginEnabled: () => false }
    });
    const component = () => null;
    const badge = Object.freeze({ id: "static", component });
    api.addProfileBadge(badge);
    api.addProfileBadge({ id: "dynamic", getBadges: () => [{ id: "child", component }] });
    for (let i = 0; i < 3; i++) {
        const rendered = api._getBadges({ userId: "fixture", guildId: "fixture" });
        assert.equal(rendered.length, 2);
        assert.equal(rendered[0].component, component);
        assert.equal(rendered[1].component, component);
        assert.equal(api.removeProfileBadge(badge), true);
        api.addProfileBadge(badge);
    }
});

test("badge refresh retries after initial failure and installs independent successful services", async () => {
    const { plugin, requests, intervals, errors } = loadBadges();
    plugin.start();
    assert.equal(intervals.size, 1);
    requests[0].reject(new Error("offline"));
    requests[1].resolve(response({ fixture: [{ tooltip: "Equicord", badge: "equicord.png" }] }));
    await setImmediate();
    assert.equal(plugin.getEquicordDonorBadges("fixture")[0].iconSrc, "equicord.png");
    assert.equal(errors.length, 1);
    const retry = Array.from(intervals.values())[0]();
    requests[2].resolve(response({ fixture: [{ tooltip: "Vencord", badge: "vencord.png" }] }));
    requests[3].resolve(response({}));
    await retry;
    assert.equal(plugin.getDonorBadges("fixture")[0].iconSrc, "vencord.png");
    plugin.stop();
    assert.equal(intervals.size, 0);
});

test("malformed and HTTP error responses retain previously validated badges", async () => {
    const { plugin, refresh, requests } = loadBadges();
    let pending = refresh();
    requests[0].resolve(response({ fixture: [{ tooltip: "Good", badge: "good.png" }] }));
    requests[1].resolve(response({ fixture: [{ tooltip: "Good", badge: "good.png" }] }));
    await pending;
    for (const invalid of [null, [], { fixture: {} }, { fixture: [null] }, { fixture: [{ tooltip: 4, badge: "bad.png" }] }]) {
        const offset = requests.length;
        pending = refresh();
        requests[offset].resolve(response(invalid));
        requests[offset + 1].resolve(response({}, 503));
        await pending;
        assert.equal(plugin.getDonorBadges("fixture")[0].iconSrc, "good.png");
        assert.equal(plugin.getEquicordDonorBadges("fixture")[0].iconSrc, "good.png");
    }
});

test("stopped badge loads cannot overwrite a restarted plugin or clear its pending request", async () => {
    const { plugin, refresh, requests, intervals } = loadBadges();
    plugin.start();
    plugin.stop();
    plugin.start();
    assert.equal(requests.length, 4);
    assert.equal(intervals.size, 1);
    requests[0].resolve(response({ stale: [] }));
    requests[1].resolve(response({ stale: [] }));
    await setImmediate();
    const pending = refresh();
    assert.equal(requests.length, 4);
    assert.equal("stale" in plugin.DonorBadges, false);
    requests[2].resolve(response({ current: [] }));
    requests[3].resolve(response({ current: [] }));
    await pending;
    assert.equal("current" in plugin.DonorBadges, true);
    plugin.stop();
});

test("manual badge refresh shares in-flight work and reports failure without rejecting the action", async () => {
    const { plugin, requests, toasts } = loadBadges();
    const first = plugin.toolboxActions["Refetch Badges"]();
    const second = plugin.toolboxActions["Refetch Badges"]();
    assert.equal(requests.length, 2);
    requests[0].resolve(response({}, 500));
    requests[1].resolve(response({}));
    await Promise.all([first, second]);
    assert.deepEqual(toasts.map(toast => toast.type), ["failure", "failure"]);
    const retry = plugin.toolboxActions["Refetch Badges"]();
    requests[2].resolve(response({}));
    requests[3].resolve(response({}));
    await retry;
    assert.equal(toasts.at(-1)?.type, "success");
});

function loadGlobalBadges() {
    const store: Record<string, string | boolean> = { apiUrl: "https://fixture.invalid", showModStyle: "none", showAero: true };
    const requests: { url: string; resolve(response: Response): void; reject(error: Error): void; }[] = [];
    const errors: unknown[][] = [];
    const intervals = new Map<number, () => Promise<void>>();
    const toasts: { type: string; }[] = [];
    const mocks = {
        "./settings": { settings: { store } },
        "@utils/css": { classNameFactory: () => () => "fixture" },
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    };
    const utils = loadSource("src/equicordplugins/globalBadges/utils.ts", mocks, {
        fetch: (url: string) => new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }))
    });
    const { default: plugin } = loadSource("src/equicordplugins/globalBadges/index.tsx", {
        ...mocks,
        "./utils": utils,
        "@api/Badges": { BadgePosition: { START: 0 } },
        "@components/Button": {},
        "@plugins/_api/badges": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/discord": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack/common": { Toasts: { genId: () => "toast", show: (toast: { type: string; }) => toasts.push(toast), Type: { SUCCESS: "success", FAILURE: "failure" } } }
    }, {
        setInterval: (callback: () => Promise<void>) => { intervals.set(1, callback); return 1; },
        clearInterval: (id: number) => intervals.delete(id)
    });
    return { utils, plugin, store, requests, errors, intervals, toasts };
}

test("global badge display settings use existing data and unknown service names remain readable", async () => {
    const { utils, plugin, requests, store } = loadGlobalBadges();
    const pending = utils.loadBadges();
    requests[0].resolve(response({ users: { fixture: [
        { mod: "aero", badge: "aero.png", tooltip: "Contributor" },
        { mod: "newmod", badge: "new.png", tooltip: "Developer" },
        { mod: "vencord", badge: "vencord.png", tooltip: "Donor" },
        { mod: "", badge: "empty.png", tooltip: "Empty" }
    ] } }));
    await pending;
    assert.equal(plugin.getGlobalBadges("fixture").length, 2);
    store.showAero = false;
    store.showModStyle = "prefix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "newmod - Developer");
    assert.equal(plugin.getGlobalBadges("fixture").length, 1);
    store.showAero = true;
    store.showModStyle = "suffix";
    assert.equal(plugin.getGlobalBadges("fixture")[0].description, "Contributor - Aero");
    assert.equal(requests.length, 1);
});

test("global badge loads discard stale responses and stop invalidates pending data", async () => {
    const { utils, plugin, requests, store, intervals } = loadGlobalBadges();
    const first = utils.loadBadges();
    store.apiUrl = "https://new-fixture.invalid/";
    const second = utils.loadBadges();
    assert.equal(requests[1].url, "https://new-fixture.invalid/users");
    requests[1].resolve(response({ users: { current: [] } }));
    await second;
    requests[0].resolve(response({ users: { stale: [] } }));
    await first;
    assert.equal(plugin.getGlobalBadges("current")?.length, 0);
    assert.equal(plugin.getGlobalBadges("stale"), undefined);
    plugin.start();
    assert.equal(intervals.size, 1);
    plugin.stop();
    requests[2].resolve(response({ users: { stopped: [] } }));
    await setImmediate();
    assert.equal(intervals.size, 0);
    assert.equal(plugin.getGlobalBadges("stopped"), undefined);
});

test("global badge refresh retries failures, rejects malformed data and reports manual errors", async () => {
    const { utils, plugin, requests, intervals, errors, toasts } = loadGlobalBadges();
    plugin.start();
    assert.equal(intervals.size, 1);
    requests[0].reject(new Error("offline"));
    await setImmediate();
    assert.equal(errors.length, 1);
    const retry = Array.from(intervals.values())[0]();
    requests[1].resolve(response({ users: { good: [] } }));
    await retry;
    for (const invalid of [null, {}, { users: [] }, { users: { broken: {} } }, { users: { broken: [null] } }, { users: { broken: [{ mod: "aero", badge: "a.png" }] } }]) {
        const offset = requests.length;
        const pending = utils.refreshBadges();
        requests[offset].resolve(response(invalid));
        await pending;
        assert.equal(plugin.getGlobalBadges("good")?.length, 0);
    }
    const offset = requests.length;
    const manual = plugin.toolboxActions["Refetch Global Badges"]();
    requests[offset].resolve(response({}, 503));
    await manual;
    assert.equal(toasts.at(-1)?.type, "failure");
    plugin.stop();
});

test("friendship badges cover milestone days and unregister the objects that were registered", () => {
    const registered = new Set<object>();
    let days = 0;
    let isFriend = true;
    const { default: plugin } = loadSource("src/equicordplugins/friendshipRanks/index.tsx", {
        "@api/Badges": { BadgePosition: { END: 1 } },
        "@api/index": { Badges: { addProfileBadge: (badge: object) => registered.add(badge), removeProfileBadge: (badge: object) => registered.delete(badge) } },
        "@api/Settings": { definePluginSettings: (settings: object) => settings },
        "@components/ErrorBoundary": boundary,
        "@components/Flex": {},
        "@components/Paragraph": {},
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "fixture" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 0 } },
        "@webpack/common": { RelationshipStore: { isFriend: () => isFriend, getSince: () => new Date(Date.now() - days * 86400000).toISOString() } }
    });
    for (let cycle = 0; cycle < 3; cycle++) {
        plugin.start?.();
        plugin.userProfileBadges?.forEach((badge: object) => registered.add(badge));
        assert.equal(registered.size, 7);
        const badges = Array.from(registered) as { description: string; shouldShow(args: { userId: string; }): boolean; }[];
        for (const [age, title] of [[0, "Sprout"], [29, "Sprout"], [30, "Blooming"], [90, "Burning"], [182, "Burning"], [183, "Fighter"], [365, "Star"], [730, "Royal"], [1827, "Besties"]] as const) {
            days = age;
            assert.deepEqual(badges.filter(badge => badge.shouldShow({ userId: "fixture" })).map(badge => badge.description), [title]);
        }
        isFriend = false;
        assert.equal(badges.some(badge => badge.shouldShow({ userId: "fixture" })), false);
        isFriend = true;
        plugin.stop?.();
        plugin.userProfileBadges?.forEach((badge: object) => registered.delete(badge));
        assert.equal(registered.size, 0);
    }
});

test("chat badge layout reads live settings and handles toggles, keyboard moves and unrelated drops", () => {
    const writes: string[] = [];
    const store: Record<string, unknown> = new Proxy({}, {
        set(target: Record<string, unknown>, key: string, value: unknown) { writes.push(key); target[key] = value; return true; }
    });
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { default: settings } = loadSource("src/equicordplugins/showBadgesInChat/settings.tsx", {
        "@api/Settings": { definePluginSettings(def: Record<string, { default?: unknown; }>) {
            for (const [key, option] of Object.entries(def)) store[key] = option.default;
            return { def, store, use: () => store };
        } },
        "@components/BaseText": { BaseText: "span" },
        "@components/Button": { Button: "button" },
        "@utils/types": { OptionType: { BOOLEAN: 0, NUMBER: 1, COMPONENT: 2 } },
        "@webpack/common": { UserStore: { getCurrentUser: () => null } }
    }, { React });
    function render() {
        const element = settings.def.badgeSettings.component();
        return element.type().props.children[1].props.children[1];
    }
    writes.length = 0;
    let controls = render();
    assert.equal(writes.length, 0);
    assert.equal(controls[0].props["aria-pressed"], true);
    controls[0].props.onClick();
    assert.equal(store.showEquicordDonor, false);
    assert.deepEqual(writes, ["showEquicordDonor"]);
    store.showEquicordDonor = true;
    controls = render();
    assert.equal(controls[0].props["aria-pressed"], true);
    writes.length = 0;
    controls[0].props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => "" } });
    assert.equal(writes.length, 0);
    let prevented = 0;
    controls[0].props.onKeyDown({ altKey: true, key: "ArrowRight", preventDefault: () => prevented++ });
    assert.equal(prevented, 1);
    controls = render();
    assert.equal(controls[0].props.key, "EquicordContributor");
    assert.equal(controls[1].props.key, "EquicordDonor");
    controls[0].props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => "DiscordNitro" } });
    assert.equal(render()[0].props.key, "DiscordNitro");
});

test("chat badge classes stay lazy until rendering and sibling badge keys are unique", () => {
    let ready = false;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { CheckBadge } = loadSource("src/equicordplugins/showBadgesInChat/index.tsx", {
        "@plugins/_api/badges": { __esModule: true, default: {
            getDonorBadges: () => [{ id: "one" }, { id: "two" }], getEquicordDonorBadges: () => [{ id: "one" }, { id: "two" }]
        } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": {
            findComponentByCodeLazy: () => "role-icon",
            findCssClassesLazy: () => new Proxy({}, { get() { assert.equal(ready, true, "Discord classes are unavailable during module initialization"); return "role-icon"; } })
        },
        "./settings": { __esModule: true, default: { store: {} } }
    }, { React }, "({ CheckBadge })");
    ready = true;
    for (const badge of ["EquicordDonor", "VencordDonor", "DiscordProfile"]) {
        const rendered = CheckBadge({ badge, author: { id: "fixture", flags: 3 } });
        const keys = rendered.props.children[0].map((child: { props: { key: string; }; }) => child.props.key);
        assert.equal(keys.length, 2);
        assert.equal(new Set(keys).size, 2);
    }
});

test("account profile actions preserve server/global context without a prefetch or cancelled launch", () => {
    const store = { prioritizeServerProfile: true };
    const opened: object[] = [];
    const effects: (() => void)[] = [];
    let closed = 0;
    const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
    const { plugin, menu } = loadSource("src/plugins/accountPanelServerProfile/index.tsx", {
        "@api/PluginManager": { isPluginEnabled: () => true },
        "@api/Settings": { definePluginSettings: () => ({ store, use: () => store }) },
        "@components/ErrorBoundary": boundary,
        "@equicordplugins/alwaysExpandProfiles": { __esModule: true, default: { name: "AlwaysExpandProfiles" } },
        "@utils/constants": { Devs: {} },
        "@utils/discord": { getCurrentChannel: () => ({ id: "channel", getGuildId: () => "guild" }) },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 0 } },
        "@webpack": { findComponentByCodeLazy: () => ({ $$vencordGetWrappedComponent() { throw new Error("The full modal does not require loading the popout component"); } }) },
        "@webpack/common": {
            ContextMenuApi: {}, Menu: { Menu: "menu", MenuItem: "item", MenuCheckboxItem: "checkbox" },
            useEffect: (effect: () => void) => effects.push(effect),
            UserStore: { getCurrentUser: () => ({ id: "user" }) },
            UserProfileActions: { openUserProfileModal: (options: object) => opened.push(options) }
        }
    }, { React }, "({ plugin: exports.default, menu: AccountPanelContextMenu })");
    menu().props.children[0].props.action();
    assert.equal(opened.length, 1);
    assert.equal(Reflect.get(opened[0], "guildId"), undefined);
    store.prioritizeServerProfile = false;
    menu().props.children[0].props.action();
    assert.equal(Reflect.get(opened[1], "guildId"), "guild");
    store.prioritizeServerProfile = true;
    const launcher = plugin.UserProfile({
        popoutProps: { closePopout: () => closed++, onRequestClose() { throw new Error("Only one close callback should be invoked"); } },
        currentUser: { id: "user" }, originalRenderPopout: () => "original"
    });
    launcher.type(launcher.props);
    assert.equal(opened.length, 2);
    effects[0]();
    assert.equal(closed, 1);
    assert.equal(opened.length, 3);
    assert.equal(Reflect.get(opened[2], "guildId"), "guild");
    assert.equal(Reflect.get(opened[2], "channelId"), "channel");
});

test("animation preferences gate every patch and expose their restart requirement", () => {
    const store: Record<string, boolean> = {};
    const { default: plugin } = loadSource("src/plugins/alwaysAnimate/index.ts", {
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, store }) },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin, OptionType: { BOOLEAN: 0 } }
    });
    for (const [key, option] of Object.entries(plugin.settings.def) as [string, { restartNeeded?: boolean; }][]) {
        store[key] = false;
        assert.equal(option.restartNeeded, true, key);
    }
    const active = () => plugin.patches.filter((patch: { predicate?(): boolean; }) => !patch.predicate || patch.predicate());
    assert.equal(active().length, 0);
    store.roleGradients = true;
    assert.equal(active().length, 3);
});
