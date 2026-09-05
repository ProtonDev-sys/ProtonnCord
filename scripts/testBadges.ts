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
    assert.equal(plugin.GlobalBadges.fixture.length, 1);
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
    assert.equal("current" in plugin.GlobalBadges, true);
    assert.equal("stale" in plugin.GlobalBadges, false);
    plugin.start();
    assert.equal(intervals.size, 1);
    plugin.stop();
    requests[2].resolve(response({ users: { stopped: [] } }));
    await setImmediate();
    assert.equal(intervals.size, 0);
    assert.equal("stopped" in plugin.GlobalBadges, false);
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
        assert.equal("good" in plugin.GlobalBadges, true);
    }
    const offset = requests.length;
    const manual = plugin.toolboxActions["Refetch Global Badges"]();
    requests[offset].resolve(response({}, 503));
    await manual;
    assert.equal(toasts.at(-1)?.type, "failure");
    plugin.stop();
});
