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
    const scheduled = new Map<() => Promise<void>, number>();
    const requests: { ids: string[]; signal?: AbortSignal; resolve: (result: Record<string, string | null>) => void; reject: (error: Error) => void; }[] = [];
    const errors: unknown[] = [];
    const clock = { now: 1_000 };
    const module = loadComponent("src/plugins/decor/lib/stores/UsersDecorationsStore.ts", {
        zustandCreate<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
            let state: T;
            state = initializer(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        }
    }, {
        "@plugins/decor/lib/api": { getUsersDecorations: (ids: string[], signal?: AbortSignal) => new Promise<Record<string, string | null>>((resolve, reject) => requests.push({ ids, signal, resolve, reject })) },
        "@plugins/decor/lib/constants": { DECORATION_FETCH_COOLDOWN: 10_000, SKU_ID: "decor" },
        "@utils/lazy": { proxyLazy },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } }
    }, {
        AbortController, Date: class extends Date { static now() { return clock.now; } },
        setTimeout(callback: () => Promise<void>, delay: number) {
            scheduled.set(callback, clock.now + delay);
            return callback;
        },
        clearTimeout(callback: () => Promise<void>) { scheduled.delete(callback); }
    });
    const store = module.useUsersDecorationsStore;
    function flush() {
        const callback = scheduled.keys().next().value;
        assert.ok(callback);
        scheduled.delete(callback);
        return callback();
    }
    function advance(milliseconds: number) {
        clock.now += milliseconds;
        const work: Promise<void>[] = [];
        for (const [callback, due] of scheduled) {
            if (due <= clock.now) {
                scheduled.delete(callback);
                work.push(callback());
            }
        }
        return work;
    }
    return { store, requests, scheduled, flush, advance, errors, clock };
}

test("Decor continuous arrivals cannot postpone the first batch and stopped timers cannot fetch", async () => {
    const f = decorFixture();
    f.store.getState().start();
    f.store.getState().fetch("a");
    f.advance(100); f.store.getState().fetch("b");
    f.advance(100); f.store.getState().fetch("c");
    assert.equal(f.requests.length, 0);
    const first = f.advance(100);
    assert.equal(f.requests.length, 1);
    assert.deepEqual([...f.requests[0].ids], ["a", "b", "c"]);
    f.store.getState().fetch("d");
    f.advance(299);
    assert.equal(f.requests.length, 1);
    const second = f.advance(1);
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({ d: "new" }); await Promise.all(second);
    f.requests[0].resolve({ a: null, b: "b", c: null }); await Promise.all(first);
    assert.equal(f.store.getState().usersDecorations.get("d").asset, "new");
    f.store.getState().fetch("cancelled");
    f.store.getState().stop();
    await Promise.all(f.advance(300));
    assert.equal(f.requests.length, 2);
    f.store.getState().start(); f.store.getState().fetch("restarted");
    const restarted = f.advance(300);
    assert.equal(f.requests.length, 3);
    f.requests[2].resolve({ restarted: null }); await Promise.all(restarted);
});

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
        "./utils/decoration": {},
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
    const pending: ((configured: boolean) => void)[] = [];
    const account = { id: "first", clears: 0, authInits: 0 };
    const authorizationListeners = new Set<(state: object, previous: object) => void>();
    const plugin = loadComponent("src/plugins/decor/index.tsx", { UserStore: { getCurrentUser: () => account.id ? { id: account.id } : undefined } }, {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./lib/constants": { setBaseUrl: () => new Promise<boolean>(resolve => pending.push(resolve)), cancelConfiguration: () => undefined },
        "./lib/stores/AuthorizationStore": { useAuthorizationStore: {
            getState: () => ({ init: () => account.authInits++, clear: () => undefined }),
            subscribe(listener: (state: object, previous: object) => void) {
                authorizationListeners.add(listener);
                return () => authorizationListeners.delete(listener);
            }
        } },
        "./lib/stores/CurrentUserDecorationsStore": { useCurrentUserDecorationsStore: { getState: () => ({ clear: () => account.clears++ }) } },
        "./lib/stores/UsersDecorationsStore": { useUsersDecorationsStore: store },
        "./settings": { settings: { store: { baseUrl: "https://decor.invalid" } } },
        "./ui/components": {}, "./ui/components/DecorSection": {}
    }).default;
    const first = plugin.start();
    plugin.stop(); pending.shift()?.(true); await first;
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    const second = plugin.start();
    const connection = plugin.flux.CONNECTION_OPEN();
    account.id = ""; plugin.flux.LOGOUT(); pending.shift()?.(true); await Promise.all([second, connection]);
    assert.equal(store.getState().session, null);
    account.id = "second"; await plugin.flux.CONNECTION_OPEN();
    assert.equal(typeof store.getState().session, "symbol");
    assert.equal(scheduled.size, 1);
    const clears = account.clears;
    for (const listener of authorizationListeners) listener({ authorization: null }, { authorization: {} });
    assert.equal(account.clears, clears + 1);
    plugin.stop(); await plugin.flux.CONNECTION_OPEN();
    assert.equal(store.getState().session, null);
    assert.equal(scheduled.size, 0);
    assert.equal(authorizationListeners.size, 0);
    assert.ok(account.clears >= 4);
    assert.equal(account.authInits, 1);
    const failed = plugin.start(); pending.shift()?.(false); await failed;
    assert.equal(store.getState().session, null);
    assert.equal(account.authInits, 1);
    plugin.stop();
});

function decorAuthorizationFixture() {
    const service = { API_URL: "https://decor.invalid/api", AUTHORIZE_URL: "https://decor.invalid/api/authorize", CLIENT_ID: "1096966363416899624" };
    const account = { id: "first" };
    const storage: { value: unknown; error?: Error; beforeUpdate?: () => Promise<void>; } = { value: undefined };
    const reads: string[] = [];
    const requests: { url: URL; options: RequestInit; resolve: (response: { ok: boolean; text(): Promise<string>; }) => void; }[] = [];
    const modals: { props: { callback(response: unknown): Promise<void>; redirectUri: string; clientId: string; }; close(): void; }[] = [];
    const closed: string[] = [];
    const store = loadComponent("src/plugins/decor/lib/stores/AuthorizationStore.tsx", {
        UserStore: { getCurrentUser: () => account.id ? { id: account.id } : undefined },
        zustandCreate<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
            let state: T;
            state = initializer(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        },
        OAuth2AuthorizeModal: "oauth",
        openModal(render: (props: object) => { props: typeof modals[number]["props"]; }, options: { onCloseCallback(): void; }) {
            modals.push({ props: render({}).props, close: options.onCloseCallback });
            return String(modals.length - 1);
        },
        closeModal(key: string) { closed.push(key); modals[Number(key)].close(); }
    }, {
        "@plugins/decor/lib/constants": service,
        "@api/DataStore": {
            async get(key: string) { reads.push(key); if (storage.error) throw storage.error; return structuredClone(storage.value); },
            async update(key: string, updater: (value: unknown) => unknown) {
                assert.equal(key, "decor-auth-v2");
                await storage.beforeUpdate?.();
                if (storage.error) throw storage.error;
                storage.value = structuredClone(updater(structuredClone(storage.value)));
            }
        },
        "@utils/lazy": { proxyLazy },
        "@utils/Logger": { Logger: class { error() { return undefined; } } },
        "@utils/misc": {
            isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
            parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } }
        }
    }, { URL, AbortController, Error, fetch: (url: URL, options: RequestInit) => new Promise(resolve => requests.push({ url, options, resolve })) }).useAuthorizationStore;
    const key = (id = account.id) => JSON.stringify([service.API_URL, service.AUTHORIZE_URL, service.CLIENT_ID, id]);
    return { store, service, account, storage, reads, requests, modals, closed, key };
}

test("Decor credentials are isolated by account and service and legacy credentials are not reused", async () => {
    const f = decorAuthorizationFixture();
    await f.store.getState().init();
    assert.deepEqual(f.reads, ["decor-auth-v2"]);
    assert.equal(f.store.getState().isAuthorized(), false);
    f.storage.value = { [f.key()]: "first-token", [f.key("second")]: "second-token" };
    await f.store.getState().init();
    assert.equal(f.store.getState().requireAuthorization().token, "first-token");
    f.account.id = "second";
    assert.equal(f.store.getState().isAuthorized(), false);
    assert.throws(() => f.store.getState().requireAuthorization(), /Sign in/);
    await f.store.getState().init();
    assert.equal(f.store.getState().requireAuthorization().token, "second-token");
    f.service.CLIENT_ID = "2096966363416899624";
    assert.throws(() => f.store.getState().requireAuthorization(), /Sign in/);
    await f.store.getState().init();
    assert.equal(f.store.getState().isAuthorized(), false);
    assert.equal(Object.keys(f.storage.value as object).length, 2);
});

test("Decor authorization coalesces clicks and completes after the host closes its OAuth modal", async () => {
    const f = decorAuthorizationFixture();
    await f.store.getState().init();
    const authorized = f.store.getState().authorize();
    assert.equal(f.store.getState().authorize(), authorized);
    assert.equal(f.modals.length, 1);
    assert.equal(f.modals[0].props.redirectUri, f.service.AUTHORIZE_URL);
    assert.equal(f.modals[0].props.clientId, f.service.CLIENT_ID);
    const callback = f.modals[0].props.callback({ location: `${f.service.AUTHORIZE_URL}?code=synthetic` });
    f.modals[0].close();
    assert.equal(f.requests[0].options.signal?.aborted, false);
    assert.equal(f.requests[0].options.redirect, "error");
    assert.equal(f.requests[0].url.searchParams.get("client"), "vencord");
    f.requests[0].resolve({ ok: true, text: async () => " synthetic-token\n" });
    await callback; await authorized;
    assert.equal(f.store.getState().requireAuthorization().token, "synthetic-token");
    assert.deepEqual(f.storage.value, { [f.key()]: "synthetic-token" });
    assert.equal(f.store.getState().busy, false);
    assert.deepEqual(f.closed, [], "the host already closed this modal");
});

test("Decor cancellation and account changes discard late authorization responses", async () => {
    const f = decorAuthorizationFixture();
    await f.store.getState().init();
    const dismissed = f.store.getState().authorize();
    const dismissal = assert.rejects(dismissed, /cancelled/);
    f.modals[0].close(); await dismissal;
    assert.equal(f.store.getState().error, null);
    const first = f.store.getState().authorize();
    const cancellation = assert.rejects(first, /cancelled/);
    const oldCallback = f.modals[1].props.callback({ location: `${f.service.AUTHORIZE_URL}?code=first` });
    f.account.id = "second";
    await f.store.getState().init(); await cancellation;
    assert.equal(f.requests[0].options.signal?.aborted, true);
    const second = f.store.getState().authorize();
    const newCallback = f.modals[2].props.callback({ location: `${f.service.AUTHORIZE_URL}?code=second` });
    f.requests[1].resolve({ ok: true, text: async () => "second-token" });
    await newCallback; await second;
    f.requests[0].resolve({ ok: true, text: async () => "first-token" });
    await oldCallback;
    assert.deepEqual(f.storage.value, { [f.key()]: "second-token" });
    assert.equal(f.store.getState().requireAuthorization().userId, "second");
});

test("Decor validates authorization callbacks and does not publish credentials when persistence fails", async () => {
    for (const location of ["https://other.invalid/api/authorize?code=x", "https://decor.invalid/api/other?code=x", "https://decor.invalid/api/authorize?error=denied", "https://decor.invalid/api/authorize#code=x"]) {
        const f = decorAuthorizationFixture();
        await f.store.getState().init();
        const authorized = f.store.getState().authorize();
        const failure = assert.rejects(authorized, /Invalid Decor authorization response/);
        await f.modals[0].props.callback({ location }); await failure;
        assert.equal(f.requests.length, 0);
        assert.equal(f.store.getState().busy, false);
    }
    const f = decorAuthorizationFixture();
    await f.store.getState().init();
    const authorized = f.store.getState().authorize();
    const failure = assert.rejects(authorized, /Storage unavailable/);
    const callback = f.modals[0].props.callback({ location: `${f.service.AUTHORIZE_URL}?code=x` });
    f.storage.error = new Error("Storage unavailable");
    f.requests[0].resolve({ ok: true, text: async () => "synthetic-token" });
    await callback; await failure;
    assert.equal(f.store.getState().authorization, null);
    assert.match(f.store.getState().error, /Storage unavailable/);
    assert.equal(f.storage.value, undefined);
});

test("Decor preserves malformed storage and only removes the confirmed current credential", async () => {
    const f = decorAuthorizationFixture();
    f.storage.value = { legacy: 123 };
    await f.store.getState().init();
    assert.match(f.store.getState().error, /saved data has been kept/);
    assert.deepEqual(f.storage.value, { legacy: 123 });
    f.storage.value = { [f.key()]: "first-token", [f.key("second")]: "second-token" };
    await f.store.getState().init();
    const expected = f.store.getState().authorization;
    f.account.id = "second";
    await assert.rejects(f.store.getState().remove(expected), /account changed/);
    f.account.id = "first";
    f.storage.error = new Error("Commit failed");
    await assert.rejects(f.store.getState().remove(expected), /Commit failed/);
    assert.equal(f.store.getState().authorization, expected);
    f.storage.error = undefined;
    f.storage.value = { [f.key()]: "newer-token" };
    await assert.rejects(f.store.getState().remove(expected), /Saved Decor authorization changed/);
    assert.deepEqual(f.storage.value, { [f.key()]: "newer-token" });
    await f.store.getState().init();
    f.storage.value = { [f.key()]: "newer-token", [f.key("second")]: "second-token" };
    await f.store.getState().remove(f.store.getState().authorization);
    assert.deepEqual(f.storage.value, { [f.key("second")]: "second-token" });
    assert.equal(f.store.getState().isAuthorized(), false);
});

test("Decor rejects failed exchanges and invalid tokens without storing them", async () => {
    for (const response of [{ ok: false, token: "synthetic-token" }, { ok: true, token: "" }, { ok: true, token: "invalid token" }]) {
        const f = decorAuthorizationFixture();
        await assert.rejects(f.store.getState().authorize(), /not ready/);
        assert.equal(f.modals.length, 0);
        await f.store.getState().init();
        const authorized = f.store.getState().authorize();
        const failure = assert.rejects(authorized, /authorization failed|invalid authorization token/);
        const callback = f.modals[0].props.callback({ location: `${f.service.AUTHORIZE_URL}?code=x` });
        await f.modals[0].props.callback({ location: `${f.service.AUTHORIZE_URL}?code=x` });
        assert.equal(f.requests.length, 1);
        f.requests[0].resolve({ ok: response.ok, text: async () => response.token });
        await callback; await failure;
        assert.equal(f.storage.value, undefined);
        assert.equal(f.store.getState().authorization, null);
        assert.deepEqual(f.closed, ["0"]);
    }
});

test("Decor private requests reject stale credentials before sending and disable redirects", async () => {
    const f = decorAuthorizationFixture();
    const requests: { url: string; options: RequestInit; }[] = [];
    const api = loadComponent("src/plugins/decor/lib/api.ts", {}, {
        "./constants": f.service,
        "./stores/AuthorizationStore": { useAuthorizationStore: f.store },
        "./utils/decoration": {},
        "@utils/misc": {}
    }, { Headers, fetch: async (url: string, options: RequestInit) => {
        requests.push({ url, options });
        return { ok: true, json: async () => [] };
    } });
    await assert.rejects(api.getUserDecorations(), /Sign in/);
    assert.equal(requests.length, 0);
    f.storage.value = { [f.key()]: "synthetic-token" };
    await f.store.getState().init();
    const owner = f.store.getState().requireAuthorization();
    await api.getUserDecorations(owner);
    assert.equal(new Headers(requests[0].options.headers).get("Authorization"), "Bearer synthetic-token");
    assert.equal(requests[0].options.redirect, "error");
    f.account.id = "second";
    await assert.rejects(api.getUserDecorations(owner), /Sign in/);
    f.account.id = "first";
    f.service.API_URL = "https://other.invalid/api";
    await assert.rejects(api.getUserDecorations(owner), /Sign in/);
    assert.equal(requests.length, 1);
});

test("Decor private actions wait for a pending credential removal to finish", async () => {
    const f = decorAuthorizationFixture();
    f.storage.value = { [f.key()]: "synthetic-token" };
    await f.store.getState().init();
    const owner = f.store.getState().requireAuthorization();
    let resume: () => void = () => undefined;
    f.storage.beforeUpdate = () => new Promise<void>(resolve => { resume = resolve; });
    const removed = f.store.getState().remove(owner);
    assert.throws(() => f.store.getState().requireAuthorization(owner), /Wait for/);
    resume(); await removed;
    assert.throws(() => f.store.getState().requireAuthorization(owner), /Sign in/);
});

test("Decor checks authorization ownership again inside an awaited storage transaction", async () => {
    const f = decorAuthorizationFixture();
    await f.store.getState().init();
    let resume: () => void = () => undefined;
    f.storage.beforeUpdate = () => new Promise<void>(resolve => { resume = resolve; });
    const authorized = f.store.getState().authorize();
    const failure = assert.rejects(authorized, /cancelled/);
    const callback = f.modals[0].props.callback({ location: `${f.service.AUTHORIZE_URL}?code=x` });
    f.requests[0].resolve({ ok: true, text: async () => "synthetic-token" });
    await new Promise<void>(resolve => setImmediate(resolve));
    f.store.getState().clear(); resume();
    await callback; await failure;
    assert.equal(f.storage.value, undefined);
    assert.equal(f.store.getState().authorization, null);
});

test("Decor configuration applies validated responses atomically and ignores cancelled requests", async () => {
    const requests: { url: string; options: RequestInit; resolve: (response: { ok: boolean; json(): Promise<unknown>; }) => void; }[] = [];
    const config = loadComponent("src/plugins/decor/lib/constants.ts", {}, {
        "@utils/Logger": { Logger: class { error() { return undefined; } } },
        "@utils/misc": {
            isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
            parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } }
        }
    }, { AbortController, fetch: (url: string, options: RequestInit) => new Promise(resolve => requests.push({ url, options, resolve })) });
    const original = config.BASE_URL;
    for (const invalid of ["http://decor.invalid", "https://user:password@decor.invalid", "https://decor.invalid/?query=x", "https://decor.invalid/#fragment", " https://decor.invalid"]) {
        assert.equal(await config.setBaseUrl(invalid), false);
    }
    assert.equal(requests.length, 0);
    const old = config.setBaseUrl("https://old.invalid");
    const current = config.setBaseUrl("https://new.invalid/base/");
    assert.equal(requests[0].options.signal?.aborted, true);
    assert.equal(requests[1].url, "https://new.invalid/base/api/config");
    assert.equal(requests[1].options.redirect, "error");
    requests[1].resolve({ ok: true, json: async () => ({ CDN_URL: "https://cdn.invalid/content/", CLIENT_ID: "1096966363416899624" }) });
    assert.equal(await current, true);
    requests[0].resolve({ ok: true, json: async () => ({ CDN_URL: "https://old-cdn.invalid", CLIENT_ID: "2096966363416899624" }) });
    assert.equal(await old, false);
    assert.equal(config.BASE_URL, "https://new.invalid/base");
    assert.equal(config.CDN_URL, "https://cdn.invalid/content");
    assert.equal(config.AUTHORIZE_URL, "https://new.invalid/base/api/authorize");
    const invalid = config.setBaseUrl("https://bad.invalid");
    requests[2].resolve({ ok: true, json: async () => ({ CDN_URL: "http://cdn.invalid", CLIENT_ID: "1096966363416899624" }) });
    assert.equal(await invalid, false);
    assert.equal(config.BASE_URL, "https://new.invalid/base");
    const failed = config.setBaseUrl(config.BASE_URL);
    requests[3].resolve({ ok: false, json: async () => null });
    assert.equal(await failed, true, "a temporary same-service failure retains trusted configuration");
    const stopped = config.setBaseUrl(original); config.cancelConfiguration();
    requests[4].resolve({ ok: true, json: async () => ({ CDN_URL: "https://ignored.invalid", CLIENT_ID: "1096966363416899624" }) });
    assert.equal(await stopped, false);
    assert.equal(config.BASE_URL, "https://new.invalid/base");
});

const syntheticDecoration = (hash: string, authorId = "first") => ({ hash, animated: false, alt: hash, authorId, reviewed: true, presetId: null });
const syntheticPng = () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a41sAAAAASUVORK5CYII=", "base64");

async function decorPrivateFixture() {
    const f = decorAuthorizationFixture();
    f.storage.value = { [f.key()]: "synthetic-token" };
    await f.store.getState().init();
    const requests: { url: string; options: RequestInit; resolve(response: Response): void; reject(error: Error): void; }[] = [];
    const waiters = new Set<() => void>();
    const utils = loadComponent("src/plugins/decor/lib/utils/decoration.ts", {}, { "@plugins/decor/lib/constants": { SKU_ID: "decor" } }, { Error });
    const api = loadComponent("src/plugins/decor/lib/api.ts", {}, {
        "./constants": f.service,
        "./stores/AuthorizationStore": { useAuthorizationStore: f.store },
        "./utils/decoration": utils,
        "@utils/misc": { isObject: (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) }
    }, { Headers, FormData, URL, Error, fetch: (url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
        requests.push({ url, options, resolve, reject });
        for (const waiter of waiters) waiter();
    }) });
    const publicStore = decorFixture().store;
    publicStore.getState().start();
    const store = loadComponent("src/plugins/decor/lib/stores/CurrentUserDecorationsStore.ts", {
        zustandCreate<T>(initializer: (set: (next: Partial<T>) => void, get: () => T) => T) {
            let state: T;
            state = initializer(next => { state = { ...state, ...next }; }, () => state);
            return { getState: () => state };
        }
    }, {
        "@plugins/decor/lib/api": api,
        "@plugins/decor/lib/utils/decoration": utils,
        "@utils/lazy": { proxyLazy },
        "./AuthorizationStore": { useAuthorizationStore: f.store },
        "./UsersDecorationsStore": { useUsersDecorationsStore: publicStore }
    }, { AbortController, Error }).useCurrentUserDecorationsStore;
    const respond = (index: number, body: unknown, status = 200) => requests[index].resolve(new Response(JSON.stringify(body), { status }));
    const waitForRequests = (count: number) => new Promise<void>(resolve => {
        const check = () => { if (requests.length >= count) { waiters.delete(check); resolve(); } };
        waiters.add(check); check();
    });
    return { ...f, auth: f.store, store, api, requests, publicStore, respond, waitForRequests, owner: f.store.getState().requireAuthorization() };
}

test("Decor selection commits only after success and preserves failed edits", async () => {
    const f = await decorPrivateFixture();
    const decoration = syntheticDecoration("chosen");
    const first = f.store.getState().select(decoration, f.owner);
    const failure = assert.rejects(first, /Rejected/);
    assert.equal(f.store.getState().selectedDecoration, null);
    assert.equal(f.store.getState().busy, true);
    assert.equal(f.publicStore.getState().usersDecorations.has("first"), false);
    f.respond(0, "Rejected", 400); await failure;
    assert.equal(f.store.getState().selectedDecoration, null);
    assert.match(f.store.getState().error, /Rejected/);
    assert.equal(f.store.getState().busy, false);
    const retry = f.store.getState().select(decoration, f.owner);
    f.respond(1, "ok"); await retry;
    assert.equal(f.store.getState().selectedDecoration, decoration);
    assert.equal(f.publicStore.getState().usersDecorations.get("first").asset, "chosen");
    assert.equal(f.store.getState().error, null);
    const emptyFailure = assert.rejects(f.store.getState().select(null, f.owner), /HTTP 500/);
    f.requests[2].resolve(new Response("", { status: 500 })); await emptyFailure;
    assert.equal(f.store.getState().selectedDecoration, decoration);
});

test("Decor explicitly removing an unloaded decoration still reaches the service", async () => {
    const f = await decorPrivateFixture();
    const removal = f.store.getState().select(null, f.owner);
    assert.equal(f.requests.length, 1);
    assert.equal((f.requests[0].options.body as FormData).get("hash"), "null");
    f.respond(0, "ok"); await removal;
    assert.equal(f.publicStore.getState().usersDecorations.get("first").asset, null);
});

test("Decor private loads coalesce and a confirmed write wins over earlier reads", async () => {
    const f = await decorPrivateFixture();
    const first = f.store.getState().fetch(f.owner);
    const duplicate = f.store.getState().fetch(f.owner);
    assert.equal(f.requests.length, 2);
    const selected = f.store.getState().select(syntheticDecoration("new"), f.owner);
    assert.equal(f.requests[0].options.signal?.aborted, true);
    assert.equal(f.requests[1].options.signal?.aborted, true);
    await assert.rejects(f.store.getState().select(syntheticDecoration("competing"), f.owner), /Wait for/);
    await assert.rejects(f.store.getState().fetch(f.owner), /Wait for/);
    assert.equal(f.requests.length, 3);
    f.respond(2, "ok"); await selected;
    f.respond(0, [syntheticDecoration("old")]); f.respond(1, syntheticDecoration("old"));
    await first; await duplicate;
    assert.equal(f.store.getState().selectedDecoration.hash, "new");
    assert.equal(f.publicStore.getState().usersDecorations.get("first").asset, "new");
});

test("Decor clearing or switching accounts cannot publish late private writes or clear a new busy state", async () => {
    const f = await decorPrivateFixture();
    const old = f.store.getState().select(syntheticDecoration("old"), f.owner);
    const obsolete = assert.rejects(old, /account or service changed/);
    f.account.id = "second";
    f.storage.value = { [f.key()]: "second-token" };
    f.store.getState().clear(); await f.auth.getState().init();
    const owner = f.auth.getState().requireAuthorization();
    const current = f.store.getState().select(syntheticDecoration("new", "second"), owner);
    assert.equal(f.requests[0].options.signal?.aborted, true);
    f.respond(0, "ok"); await obsolete;
    assert.equal(f.store.getState().busy, true);
    assert.equal(f.store.getState().selectedDecoration, null);
    assert.equal(f.publicStore.getState().usersDecorations.has("first"), false);
    await assert.rejects(f.store.getState().select(syntheticDecoration("wrong"), f.owner), /account or service changed/);
    assert.equal(f.requests.length, 2);
    f.respond(1, "ok"); await current;
    assert.equal(f.publicStore.getState().usersDecorations.get("second").asset, "new");
    assert.equal(f.store.getState().busy, false);
});

test("Decor discards cleared private reads and keeps replacement loading and failure state", async () => {
    const f = await decorPrivateFixture();
    const old = f.store.getState().fetch(f.owner);
    f.store.getState().clear();
    const current = f.store.getState().fetch(f.owner);
    f.requests[0].reject(new Error("Obsolete read failed"));
    f.respond(1, syntheticDecoration("old")); await old;
    assert.equal(f.store.getState().loading, true);
    assert.equal(f.store.getState().error, null);
    f.respond(2, [syntheticDecoration("current")]); f.respond(3, syntheticDecoration("current")); await current;
    assert.equal(f.publicStore.getState().usersDecorations.get("first").asset, "current");
    const failed = f.store.getState().fetch(f.owner);
    f.respond(4, { invalid: true }); f.respond(5, null); await failed;
    assert.match(f.store.getState().error, /Invalid decoration response/);
    assert.equal(f.store.getState().selectedDecoration.hash, "current");
    assert.equal(f.store.getState().loading, false);
});

test("Decor deletion preserves failures and reconciles selected and public state after success", async () => {
    const f = await decorPrivateFixture();
    const first = syntheticDecoration("first/hash?value");
    const second = syntheticDecoration("second");
    const loaded = f.store.getState().fetch(f.owner);
    f.respond(0, [first, second]); f.respond(1, first); await loaded;
    f.publicStore.getState().set("first", first.hash); f.publicStore.getState().set("unrelated", "keep");
    const rejected = f.store.getState().delete(first.hash, f.owner);
    const failure = assert.rejects(rejected, /Denied/);
    assert.ok(f.requests[2].url.endsWith("/decorations/first%2Fhash%3Fvalue"));
    f.respond(2, "Denied", 403); await failure;
    assert.equal(f.store.getState().decorations.length, 2);
    assert.equal(f.publicStore.getState().usersDecorations.get("first").asset, first.hash);
    const deleted = f.store.getState().delete(first.hash, f.owner);
    f.respond(3, "ok"); await deleted;
    assert.deepEqual([...f.store.getState().decorations].map(item => item.hash), ["second"]);
    assert.equal(f.store.getState().selectedDecoration, null);
    assert.equal(f.publicStore.getState().usersDecorations.get("first").asset, null);
    assert.equal(f.publicStore.getState().usersDecorations.get("unrelated").asset, "keep");
});

test("Decor uploads validate responses and replace an existing hash without duplicating it", { timeout: 5000 }, async () => {
    const f = await decorPrivateFixture();
    const file = new File([syntheticPng()], "test.png", { type: "image/png" });
    const invalid = f.store.getState().create({ file, alt: "name" }, f.owner);
    const failure = assert.rejects(invalid, /Invalid decoration response/);
    await f.waitForRequests(1);
    f.respond(0, { hash: "incomplete" }); await failure;
    assert.equal(f.store.getState().decorations.length, 0);
    const decoration = syntheticDecoration("created");
    const created = f.store.getState().create({ file, alt: "name" }, f.owner);
    await f.waitForRequests(2);
    f.respond(1, decoration); await created;
    const repeated = f.store.getState().create({ file, alt: "updated" }, f.owner);
    await f.waitForRequests(3);
    f.respond(2, { ...decoration, alt: "updated" }); await repeated;
    assert.equal(f.store.getState().decorations.length, 1);
    assert.equal(f.store.getState().decorations[0].alt, "updated");
    assert.equal(f.store.getState().selectedDecoration, null);
    assert.equal(f.publicStore.getState().usersDecorations.size, 0, "a pending upload is not a selected decoration");
});

test("Decor private lists reject malformed fields and duplicate decoration identities", async () => {
    const f = await decorPrivateFixture();
    const decoration = syntheticDecoration("a");
    const invalid = [null, {}, [{ ...decoration, animated: "yes" }], [{ ...decoration, reviewed: "pending" }], [decoration, decoration]];
    for (const body of invalid) {
        const index = f.requests.length;
        const result = f.api.getUserDecorations(f.owner);
        const failure = assert.rejects(result, /Invalid.*decoration response/);
        f.respond(index, body); await failure;
    }
    const index = f.requests.length;
    const selected = f.api.getUserDecoration(f.owner);
    f.respond(index, null); assert.equal(await selected, null);
});

test("Decor preset requests forward cancellation and validate HTTP, nested records and unique IDs", async () => {
    const f = await decorPrivateFixture();
    const preset = { id: "preset", name: "Preset", description: null, decorations: [syntheticDecoration("a")], authorIds: ["first"] };
    const controller = new AbortController();
    const valid = f.api.getPresets(controller.signal);
    assert.equal(f.requests[0].options.signal, controller.signal);
    assert.equal(f.requests[0].options.headers, undefined);
    f.respond(0, [preset]); assert.deepEqual(structuredClone(await valid), [preset]);
    for (const body of [null, {}, [{ ...preset, authorIds: [123] }], [{ ...preset, decorations: [null] }], [preset, preset]]) {
        const index = f.requests.length;
        const result = f.api.getPresets();
        const failure = assert.rejects(result, /Invalid/);
        f.respond(index, body); await failure;
    }
    const index = f.requests.length;
    const result = f.api.getPresets();
    const failure = assert.rejects(result, /Could not load decoration presets/);
    f.respond(index, [preset], 500); await failure;
});

test("Decor dialog actions cancel replacement, close and unmount work and survive effect replay", () => {
    let setup: () => () => void = () => () => undefined;
    const owner = {};
    let closes = 0;
    const ui = loadComponent("src/plugins/decor/ui/index.ts", {
        useEffect: (effect: () => () => void) => { setup = effect; },
        useRef: <T>(value: T) => ({ current: value })
    }, {
        "@webpack": { findCssClassesLazy: () => ({}), extractAndLoadChunksLazy: () => async () => undefined },
        "../lib/stores/AuthorizationStore": { useAuthorizationStore: { getState: () => ({ requireAuthorization: (expected: object) => { assert.equal(expected, owner); } }) } }
    }, { AbortController });
    const actions = ui.useDialogActions(() => closes++);
    assert.equal(actions.begin().aborted, true);
    let cleanup = setup();
    const first = actions.begin(); ui.requireDialogOwner(owner, first);
    const second = actions.begin(); assert.equal(first.aborted, true);
    assert.throws(() => ui.requireDialogOwner(owner, first), /closed/);
    actions.close(); assert.equal(second.aborted, true); assert.equal(closes, 1);
    assert.equal(actions.begin().aborted, true);
    cleanup(); cleanup = setup();
    const replay = actions.begin(); assert.equal(replay.aborted, false);
    cleanup(); assert.equal(replay.aborted, true);
});

test("Decor checks a bounded PNG header and rejects non-square or invalid files", async () => {
    const utils = loadComponent("src/plugins/decor/lib/utils/decoration.ts", {}, { "@plugins/decor/lib/constants": {} });
    const valid = syntheticPng();
    await utils.validateDecorationFile(new File([valid], "image.bin", { type: "" }));
    for (const offset of [0, 8, 12, 16, 20]) {
        const invalid = Buffer.from(valid);
        invalid.writeUInt32BE(offset === 16 || offset === 20 ? 2 : 0, offset);
        await assert.rejects(utils.validateDecorationFile(new File([invalid], "image.png")), /Choose/);
    }
    await assert.rejects(utils.validateDecorationFile(new File([valid.subarray(0, 24)], "short.png")), /Choose/);
    const slices: number[][] = [];
    await utils.validateDecorationFile({ size: 1_000_000_000, slice(start: number, end: number) {
        slices.push([start, end]); return new Blob([valid.subarray(start, end)]);
    } });
    assert.deepEqual(slices, [[0, 24]], "header validation must not read the whole upload");
});

test("Decor validates uploads at the request boundary and cancels before a deferred file read can send", async () => {
    const f = await decorPrivateFixture();
    await assert.rejects(f.store.getState().create({ file: new File(["text"], "image.png"), alt: "Name" }, f.owner), /Choose a PNG/);
    const file = new File([syntheticPng()], "image.png");
    await assert.rejects(f.store.getState().create({ file, alt: "   " }, f.owner), /Enter a decoration name/);
    assert.equal(f.requests.length, 0);
    let finish: (buffer: ArrayBuffer) => void = () => undefined;
    const bytes = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    const header = file.slice(0, 24);
    Object.defineProperty(header, "arrayBuffer", { value: () => bytes });
    Object.defineProperty(file, "slice", { value: () => header });
    const pending = f.store.getState().create({ file, alt: "Name" }, f.owner);
    const failure = assert.rejects(pending, /cancelled/);
    f.store.getState().clear();
    finish(await new Blob([syntheticPng().subarray(0, 24)]).arrayBuffer()); await failure;
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.getState().decorations.length, 0);
});

test("Decor avatar URLs preserve animation prefixes, encode one asset segment and only pass local Blob previews", () => {
    const plugin = loadComponent("src/plugins/decor/index.tsx", {}, {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {} },
        "@utils/misc": { parseUrl: (value: string) => { try { return new URL(value); } catch { return null; } } },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "./lib/constants": { CDN_URL: "https://cdn.invalid", SKU_ID: "decor", RAW_SKU_ID: "raw" },
        "./lib/stores/AuthorizationStore": {}, "./lib/stores/CurrentUserDecorationsStore": {}, "./lib/stores/UsersDecorationsStore": {},
        "./settings": { settings: {} }, "./ui/components": {}, "./ui/components/DecorSection": {}
    }, { location: { origin: "https://discord.invalid" } }).default;
    const url = (asset: string, canAnimate = false, skuId = "decor") => plugin.getDecorAvatarDecorationURL({ avatarDecoration: Object.freeze({ asset, skuId }), canAnimate });
    assert.equal(url("a_hash_name"), "https://cdn.invalid/hash_name.png");
    assert.equal(url("a_hash_name", true), "https://cdn.invalid/a_hash_name.png");
    assert.equal(url("hash_name", true), "https://cdn.invalid/hash_name.png");
    assert.equal(url("../image?query#fragment"), "https://cdn.invalid/..%2Fimage%3Fquery%23fragment.png");
    assert.equal(url("\ud800"), undefined);
    assert.equal(url("blob:https://discord.invalid/fixture", false, "raw"), "blob:https://discord.invalid/fixture");
    assert.equal(url("blob:https://other.invalid/fixture", false, "raw"), undefined);
    assert.equal(url("https://other.invalid/image.png", false, "raw"), undefined);
    assert.equal(plugin.getDecorAvatarDecorationURL({ avatarDecoration: null }), undefined);
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
