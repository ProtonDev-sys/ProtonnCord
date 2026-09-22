/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

const plugin = runInNewContext(transpileModule(readFileSync(new URL(
    "../src/equicordplugins/_core/cachedImageFix.ts", import.meta.url,
), "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText + "\nexports.default;", {
    exports: {}, queueMicrotask,
    require(name: string) {
        if (name === "@utils/constants") return { EquicordDevs: {} };
        assert.equal(name, "@utils/types");
        return { __esModule: true, default: (value: unknown) => value };
    },
});

// Reduced from Discord's September 2026 ImageLoaderUtils and LazyImage behavior.
// Keep the broken cache-hit branch verbatim so this exercises the production patch.
const hostSource = `
function load(e,t){let n=cache.get(e);if(null!=n&&n.loaded)return null!=t&&online.A.awaitOnline().then(()=>{null!=n&&null!=n.callbacks&&n.callbacks.forEach(t=>{null!=n?t(!1,n):t(!0,{url:e,loaded:!0})})}),constants.noop;
    if (!n) { n = { url: e, loaded: false, callbacks: new Set() }; cache.set(e, n); requests.set(e, n); }
    if (t) n.callbacks.add(t);
    return () => n.callbacks.delete(t);
}
function finish(url, error = false) {
    const pending = requests.get(url);
    const image = { url, loaded: true, width: 640, height: 480 };
    if (error) cache.delete(url); else cache.set(url, image);
    requests.delete(url);
    pending.callbacks.forEach(callback => callback(error, error ? pending : image));
}
function loaded(url) { return !!cache.get(url)?.loaded; }
function preview(url) {
    const image = { state: loaded(url) ? "READY" : "LOADING", cancel() {} };
    image.mount = () => { if (image.state === "LOADING") image.cancel = load(url, error => { image.state = error ? "ERROR" : "READY"; }); };
    return image;
}
({ load, finish, loaded, preview });
`;

interface ImageData { url: string; loaded: boolean; width?: number; height?: number; }
interface Preview { state: string; mount(): void; cancel(): void; }
type ImageCallback = (error: boolean, image: ImageData) => void;

function fixture(patched = true, onlineResult: "resolve" | "reject" | "pending" = "resolve") {
    const cache = new Map<string, ImageData>();
    const requests = new Map<string, ImageData>();
    let onlineCalls = 0;
    const replacement = plugin.patches[0].replacement;
    const match = canonicalizeMatch(replacement.match);
    assert.equal([...hostSource.matchAll(new RegExp(match.source, "g"))].length, 1);
    const source = patched ? hostSource.replace(match, replacement.replace.replaceAll("$self", "plugin")) : hostSource;
    const host = runInNewContext(source, {
        cache, requests, plugin, constants: { noop() {} },
        online: { A: { awaitOnline() {
            onlineCalls++;
            if (onlineResult === "reject") return Promise.reject(new Error("offline"));
            if (onlineResult === "pending") return new Promise(() => {});
            return Promise.resolve();
        } } },
    }) as {
        load(url: string, callback?: ImageCallback): () => void;
        finish(url: string, error?: boolean): void;
        loaded(url: string): boolean;
        preview(url: string): Preview;
    };
    return { ...host, cache, requests, onlineCalls: () => onlineCalls };
}

const url = "https://media.discordapp.net/attachments/1/2/image.png";

test("a cache fill between preview creation and mount reproduces blank media until remount", async () => {
    const host = fixture(false);
    const preview = host.preview(url);
    host.load(url);
    host.finish(url);
    preview.mount();
    await Promise.resolve();
    assert.equal(preview.state, "LOADING");
    assert.equal(host.preview(url).state, "READY");
});

test("the patched cache hit completes a mounted preview without a channel remount", async () => {
    const host = fixture();
    const preview = host.preview(url);
    host.load(url);
    host.finish(url);
    preview.mount();
    assert.equal(preview.state, "LOADING", "completion must remain asynchronous");
    await Promise.resolve();
    assert.equal(preview.state, "READY");
    assert.equal(host.requests.size, 0, "a cache hit must not reload the image");
});

test("cache hits notify each caller once and respect cancellation and cache eviction", async () => {
    const host = fixture();
    host.load(url);
    host.finish(url);
    const cached = host.cache.get(url);
    const results: [boolean, ImageData][] = [];
    host.load(url, (...result) => results.push(result));
    const cancel = host.load(url, () => assert.fail("cancelled image callback"));
    host.load(url, (...result) => results.push(result));
    cancel();
    cancel();
    host.cache.delete(url);
    await Promise.resolve();
    assert.equal(results.length, 2);
    for (const [error, image] of results) {
        assert.equal(error, false);
        assert.equal(image, cached, "use the completed entry even if the cache later evicts it");
    }
    await Promise.resolve();
    assert.equal(results.length, 2);
});

test("loaded media completes without consulting an unavailable online gate", async () => {
    for (const mode of ["reject", "pending"] as const) {
        const host = fixture(true, mode);
        host.load(url);
        host.finish(url);
        let calls = 0;
        host.load(url, () => calls++);
        host.load(url)();
        await Promise.resolve();
        assert.equal(calls, 1);
        assert.equal(host.onlineCalls(), 0);
    }
});

test("pending loads retain shared waiters, cancellation, failure and retry behavior", () => {
    const host = fixture();
    const results: boolean[] = [];
    host.load(url, error => results.push(error));
    const cancel = host.load(url, () => assert.fail("cancelled pending callback"));
    host.load(url, error => results.push(error));
    cancel();
    assert.equal(host.requests.size, 1);
    assert.equal(results.length, 0);
    host.finish(url, true);
    assert.deepEqual(results, [true, true]);
    assert.equal(host.loaded(url), false);
    host.load(url, error => results.push(error));
    host.finish(url);
    assert.deepEqual(results, [true, true, false]);
    assert.equal(host.loaded(url), true);
});
