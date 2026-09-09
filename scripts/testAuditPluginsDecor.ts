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

function load(path: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, URL, Headers, FormData, AbortController, Error, ...globals,
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
}

const logger = { Logger: class { error() {} } };
const misc = {
    isObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
    parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } }
};

function stateStore<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
    let state: T;
    state = initializer(next => { state = { ...state, ...next }; }, () => state);
    return { getState: () => state };
}

function network() {
    const requests: { options: RequestInit; }[] = [];
    const deadlines: { controller: AbortController; delay: number; }[] = [];
    return { requests, deadlines, globals: {
        AbortSignal: {
            any: AbortSignal.any,
            timeout: (delay: number) => {
                const controller = new AbortController();
                deadlines.push({ controller, delay });
                return controller.signal;
            }
        },
        fetch: (_url: string | URL, options: RequestInit) => new Promise((_resolve, reject) => {
            requests.push({ options });
            options.signal!.addEventListener("abort", () => reject(new Error("request timed out or cancelled")), { once: true });
        })
    } };
}

test("Decor public, private and preset requests combine caller cancellation with a deadline", async () => {
    const f = network();
    const owner = { token: "synthetic", apiUrl: "https://decor.invalid/api" };
    const api = load("src/plugins/decor/lib/api.ts", {
        "./constants": { API_URL: owner.apiUrl },
        "./stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ requireAuthorization: () => owner }) } },
        "./utils/decoration": {}, "@utils/misc": misc
    }, f.globals);
    for (const action of [() => api.getUsersDecorations(["one"]), () => api.getPresets(), () => api.getUserDecorations(owner)]) {
        const pending = action();
        const failure = assert.rejects(pending, /timed out/);
        assert.equal(f.deadlines.at(-1)?.delay, 30_000);
        f.deadlines.at(-1)!.controller.abort();
        await failure;
    }
    const controller = new AbortController();
    const pending = api.setUserDecoration(null, owner, controller.signal);
    const failure = assert.rejects(pending, /cancelled/);
    controller.abort();
    assert.equal(f.requests.at(-1)?.options.signal?.aborted, true);
    assert.equal(f.requests.at(-1)?.options.redirect, "error");
    await failure;
});

test("Decor configuration deadlines retain the previously trusted service", async () => {
    const f = network();
    const config = load("src/plugins/decor/lib/constants.ts", { "@utils/Logger": logger, "@utils/misc": misc }, f.globals);
    const original = config.BASE_URL;
    const pending = config.setBaseUrl("https://new.invalid");
    assert.equal(f.deadlines[0].delay, 30_000);
    f.deadlines[0].controller.abort();
    assert.equal(await pending, false);
    assert.equal(config.BASE_URL, original);
});

test("Decor token exchange deadlines clear busy state without saving authorization", async () => {
    const f = network();
    let callback!: (response: object) => Promise<void>;
    let saved = 0;
    const service = { API_URL: "https://decor.invalid/api", AUTHORIZE_URL: "https://decor.invalid/api/authorize", CLIENT_ID: "1096966363416899624" };
    const store = load("src/plugins/decor/lib/stores/AuthorizationStore.tsx", {
        "@api/DataStore": { get: async () => undefined, update: async () => { saved++; } },
        "@plugins/decor/lib/constants": service,
        "@utils/lazy": { proxyLazy: (fn: () => unknown) => fn() },
        "@utils/Logger": logger, "@utils/misc": misc,
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: "self" }) }, zustandCreate: stateStore,
            OAuth2AuthorizeModal: "oauth",
            openModal: (render: (props: object) => { props: { callback: typeof callback; }; }) => {
                callback = render({}).props.callback;
                return "owned-modal";
            }, closeModal() {}
        }
    }, { ...f.globals, React: { createElement: (type: unknown, props: object) => ({ type, props }) } }).useAuthorizationStore;
    await store.getState().init();
    const pending = store.getState().authorize();
    const failed = assert.rejects(pending, /timed out/);
    const exchange = callback({ location: service.AUTHORIZE_URL + "?code=synthetic" });
    assert.equal(f.deadlines[0].delay, 30_000);
    f.deadlines[0].controller.abort();
    await exchange;
    await failed;
    assert.equal(store.getState().busy, false);
    assert.equal(store.getState().authorization, null);
    assert.equal(saved, 0);
});

test("Decor batches 123 user lookups into at most two simultaneous requests of 50 IDs", async () => {
    const timers = new Map<number, () => Promise<void>>();
    const requests: { ids: string[]; signal: AbortSignal; resolve(body: object): void; }[] = [];
    let timerId = 0;
    const store = load("src/plugins/decor/lib/stores/UsersDecorationsStore.ts", {
        "@plugins/decor/lib/api": { getUsersDecorations: (ids: string[], signal: AbortSignal) => new Promise(resolve => requests.push({ ids, signal, resolve })) },
        "@plugins/decor/lib/constants": { DECORATION_FETCH_COOLDOWN: 1_000_000, SKU_ID: "decor" },
        "@utils/lazy": { proxyLazy: (fn: () => unknown) => fn() },
        "@utils/Logger": logger, "@webpack/common": { zustandCreate: stateStore }
    }, {
        setTimeout: (callback: () => Promise<void>) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id: number) => timers.delete(id)
    }).useUsersDecorationsStore;
    function flush() {
        const next = timers.entries().next().value;
        assert.ok(next);
        timers.delete(next[0]);
        return next[1]();
    }
    store.getState().start();
    for (let id = 0; id < 123; id++) store.getState().fetch(String(id));
    const first = flush();
    const second = flush();
    assert.equal(requests.length, 2);
    assert.equal(timers.size, 0);
    assert.deepEqual(requests.map(request => request.ids.length), [50, 50]);
    requests[0].resolve({}); await first;
    const third = flush();
    assert.equal(requests[2].ids.length, 23);
    assert.equal(new Set(requests.flatMap(request => request.ids)).size, 123);
    store.getState().stop();
    assert.ok(requests[1].signal.aborted && requests[2].signal.aborted);
    requests[1].resolve({}); requests[2].resolve({}); await Promise.all([second, third]);
    assert.equal(timers.size, 0);
    assert.equal(store.getState().usersDecorations.size, 0);
});
