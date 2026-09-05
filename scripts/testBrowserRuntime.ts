/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function load(path: string, globals: Record<string, unknown>) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    return runInNewContext(`${outputText}\nexports;`, { exports: {}, ...globals });
}

test("userscript fetch preserves caller options and exposes native blob readers", async () => {
    const blob = new Blob(['{"value":"hello"}']);
    const options = Object.freeze({ method: "POST", body: "request" });
    let headers = "Content-Type: application/json\nX-Fixture: yes";
    const { fetch } = load("browser/GMPolyfill.js", {
        Headers,
        GM_xmlhttpRequest(request: { url: string; data: string; responseType: string; onload: (response: object) => void; }) {
            assert.equal(request.url, "https://example.com/fixture");
            assert.equal(request.data, "request");
            assert.equal(request.responseType, "blob");
            request.onload({ response: blob, responseHeaders: headers, status: 200 });
        }
    });
    const response = await fetch("https://example.com/fixture", options);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("x-fixture"), "yes");
    assert.equal(await response.blob(), blob);
    assert.equal(await response.text(), await blob.text());
    assert.deepEqual(await response.arrayBuffer(), await blob.arrayBuffer());
    assert.equal((await response.json()).value, "hello");
    assert.deepEqual(options, { method: "POST", body: "request" });
    headers = "Invalid Header: value";
    await assert.rejects(fetch("https://example.com/fixture", options), TypeError);
});

test("extension metadata waits for a complete message from its own window", async () => {
    let listener: (event: { source: object; data: unknown; }) => void = () => assert.fail("listener not registered");
    let removed = false;
    const window = {
        addEventListener(_type: string, callback: typeof listener) { listener = callback; },
        removeEventListener(_type: string, callback: typeof listener) { assert.equal(callback, listener); removed = true; }
    };
    const metadata = load("src/utils/web-metadata.ts", { IS_EXTENSION: true, window });
    const meta = { EXTENSION_BASE_URL: "chrome-extension://fixture/", EXTENSION_VERSION: "1.0", RENDERER_CSS_URL: "fixture.css" };
    listener({ source: window, data: null });
    listener({ source: {}, data: { type: "vencord:meta", meta } });
    listener({ source: window, data: { type: "vencord:meta", meta: { EXTENSION_VERSION: "1.0" } } });
    assert.equal(removed, false);
    assert.equal(metadata.EXTENSION_VERSION, undefined);
    listener({ source: window, data: { type: "vencord:meta", meta } });
    await metadata.metaReady;
    assert.equal(removed, true);
    for (const [key, value] of Object.entries(meta)) assert.equal(metadata[key], value);
});

test("extension commands tolerate an absent tab or content script", async () => {
    let command: (name: string) => Promise<void> = async () => assert.fail("listener not registered");
    let tabs: { id: number; }[] = [];
    const sent: number[] = [];
    load("browser/service-worker.js", {
        chrome: {
            commands: { onCommand: { addListener(callback: typeof command) { command = callback; } } },
            runtime: { onMessage: { addListener() { } } },
            tabs: {
                query: async () => tabs,
                async sendMessage(id: number) { sent.push(id); throw new Error("No receiving content script"); }
            }
        }
    });
    await command("fixture");
    assert.deepEqual(sent, []);
    tabs = [{ id: 0 }];
    await command("fixture");
    assert.deepEqual(sent, [0]);
});

test("content script ignores unrelated window messages", () => {
    let listener: (event: { source: object; data: unknown; }) => void = () => assert.fail("listener not registered");
    let sent = 0;
    const window = { postMessage() { }, addEventListener(_type: string, callback: typeof listener) { listener = callback; } };
    load("browser/content.js", {
        window,
        document: { addEventListener(_type: string, callback: () => void) { callback(); } },
        chrome: { runtime: {
            getManifest: () => ({ version: "1.0" }), getURL: (path: string) => path,
            onMessage: { addListener() { } }, sendMessage() { sent++; }
        } }
    });
    listener({ source: window, data: null });
    listener({ source: {}, data: { type: "OPEN_SHORTCUTS" } });
    assert.equal(sent, 0);
    listener({ source: window, data: { type: "OPEN_SHORTCUTS" } });
    assert.equal(sent, 1);
});

test("APNG conversions coalesce loads, retry failures and reuse the loaded worker", async () => {
    const instances: FFmpeg[] = [];
    const loads: { resolve(): void; reject(error: Error): void; }[] = [];
    class FFmpeg {
        loaded = false;
        terminated = false;
        writes: string[] = [];
        deleted: string[] = [];
        constructor() { instances.push(this); }
        terminate() { this.terminated = true; }
        async writeFile(path: string) { this.writes.push(path); }
        async exec() { return 0; }
        async readFile() { return new Uint8Array([1, 2, 3]); }
        async deleteFile(path: string) { this.deleted.push(path); }
    }
    const mocks: Record<string, object> = {
        "@ffmpeg/ffmpeg": { FFmpeg },
        "@utils/ffmpeg": { async loadFFmpeg(instance: FFmpeg) {
            await new Promise<void>((resolve, reject) => loads.push({ resolve, reject }));
            instance.loaded = true;
        } }
    };
    const { convertApngToGif } = load("src/equicordplugins/fileUpload/utils/apngToGif.ts", {
        Blob, Uint8Array, console: { error() { } },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const input = new Blob(["synthetic input"]);
    const first = convertApngToGif(input);
    const duplicate = convertApngToGif(input);
    assert.equal(loads.length, 1);
    loads[0].reject(new Error("load failed"));
    assert.deepEqual(await Promise.all([first, duplicate]), [null, null]);
    const retry = convertApngToGif(input);
    const concurrent = convertApngToGif(input);
    assert.equal(loads.length, 2, "a rejected load must not be cached");
    assert.equal(instances[0].terminated, true);
    loads[1].resolve();
    for (const result of await Promise.all([retry, concurrent])) {
        assert.ok(result instanceof Blob);
        assert.equal(result.type, "image/gif");
        assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([1, 2, 3]));
    }
    assert.ok(await convertApngToGif(input) instanceof Blob);
    assert.equal(loads.length, 2);
    assert.equal(instances.length, 2);
    assert.equal(instances[1].terminated, false);
    assert.equal(new Set(instances[1].writes).size, 3);
    assert.deepEqual(instances[1].deleted.sort(), ["input_2.png", "input_3.png", "input_4.png", "output_2.gif", "output_3.gif", "output_4.gif"]);
});
