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

function fixture() {
    let account = "first";
    let stored: any = { first: { token: "fixture-first" }, second: { token: "fixture-second" } };
    const reads: ((value: unknown) => void)[] = [];
    const writes: { update(value: any): any; resolve(): void; reject(error: Error): void; }[] = [];
    const requests: { url: string; options: RequestInit; }[] = [];
    const timers = new Map<number, () => void>();
    const toasts: string[] = [];
    let timerId = 0;
    const modules: Record<string, any> = {
        "@api/DataStore": {
            get: () => new Promise(resolve => reads.push(resolve)),
            update: (_key: string, update: (value: any) => any) => new Promise<void>((resolve, reject) => writes.push({ update, resolve, reject }))
        },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/constants": { Devs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@utils/misc": {}, "@utils/react": {},
        "@components/Icons": {}, "@components/Paragraph": {}, "@components/Span": {},
        "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) }, Toasts: { Type: { FAILURE: 1, SUCCESS: 2 } } },
        "./settings": { settings: { store: { showWarning: true, notifyReviews: true } } },
        "./entities": { ReviewType: { System: 3 }, NotificationType: { Ban: 1 } },
        "./utils": { showToast: (value: string) => toasts.push(value) },
        "./style.css": {}, "./components/ReviewModal": {},
        "react/jsx-runtime": { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
    };
    let fetchImpl = async (_url: string, _options: RequestInit): Promise<any> => ({ ok: true, json: async () => ({}) });
    function load(path: string) {
        const code = transpileModule(readFileSync(path, "utf8"), { fileName: path, compilerOptions: {
            module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX
        } }).outputText;
        return runInNewContext(code + "\nexports;", { exports: {}, require: (name: string) => {
            if (!(name in modules)) throw new Error(`Missing fixture module: ${name}`);
            return modules[name];
        }, AbortSignal, URL, URLSearchParams, fetch: (url: string, options: RequestInit) => {
            requests.push({ url: String(url), options });
            return fetchImpl(url, options);
        }, setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id: number) => timers.delete(id) });
    }
    const auth = load("src/plugins/reviewDB/auth.tsx");
    modules["./auth"] = auth;
    const api = load("src/plugins/reviewDB/reviewDbApi.ts");
    modules["./reviewDbApi"] = api;
    return { auth, api, load, modules, reads, writes, requests, toasts, timers,
        setAccount: (value: string) => account = value,
        setFetch: (value: typeof fetchImpl) => fetchImpl = value,
        read: () => reads.shift()!(stored),
        save: () => { const write = writes.shift()!; stored = write.update(stored); write.resolve(); },
        stored: () => stored };
}

test("ReviewDB binds storage reads to their starting account and invalidates stopped initialization", async () => {
    const f = fixture();
    const token = f.auth.getToken();
    f.setAccount("second");
    f.read();
    assert.equal(await token, undefined);
    const init = f.auth.initAuth();
    f.auth.clearAuth();
    f.read();
    await init;
    assert.equal(f.auth.Auth.token, undefined);
});

test("ReviewDB persists captured account copies before publishing authorization", async () => {
    const f = fixture();
    const failed = f.auth.updateAuth({ token: "replacement" });
    f.writes.shift()!.reject(new Error("Store unavailable"));
    await assert.rejects(failed, /Store unavailable/);
    assert.equal(f.auth.Auth.token, undefined);
    assert.equal(f.stored().first.token, "fixture-first");
    const saved = f.auth.updateAuth({ token: "replacement" });
    f.setAccount("second");
    f.save();
    await saved;
    assert.equal(f.stored().first.token, "replacement");
    assert.equal(f.stored().second.token, "fixture-second");
    assert.equal(f.auth.Auth.token, undefined);
});

test("ReviewDB contains unavailable or malformed review responses and uses a deadline", async () => {
    for (const response of [null, { ok: true, json: async () => ({ reviews: [{}] }) }]) {
        const f = fixture();
        f.setFetch(async () => { if (response === null) throw new Error("Offline"); return response; });
        const result = await f.api.getReviews("fixture-user");
        assert.equal(result.reviews.length, 1);
        assert.equal(result.reviews[0].type, 3);
        assert.equal(result.reviewCount, 0);
        assert.equal(f.requests[0].options.signal instanceof AbortSignal, true);
    }
});

test("ReviewDB failed unblock reports failure and account changes prevent authenticated requests", async () => {
    const f = fixture();
    f.setFetch(async () => ({ ok: false, status: 503, json: async () => ({ message: "Unavailable" }) }));
    const failed = f.api.unblockUser("blocked-fixture");
    f.read();
    assert.equal(await failed, false);
    assert.equal(f.writes.length, 0);
    const stale = f.api.getCurrentUserInfo();
    f.setAccount("second");
    f.read();
    assert.equal(await stale, null);
    assert.equal(f.requests.length, 1);
});

test("ReviewDB stop clears pending notification timers and rejects delayed initialization", async () => {
    const f = fixture();
    const plugin = f.load("src/plugins/reviewDB/index.tsx").default;
    const firstStart = plugin.start();
    f.read();
    await firstStart;
    assert.equal(f.timers.size, 1);
    plugin.stop();
    assert.equal(f.timers.size, 0);
    const secondStart = plugin.start();
    plugin.stop();
    f.read();
    await secondStart;
    await setImmediate();
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests.length, 0);
});
