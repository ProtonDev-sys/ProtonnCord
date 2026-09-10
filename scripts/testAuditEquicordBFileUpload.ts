/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as constants from "../src/equicordplugins/fileUpload/constants";
import * as types from "../src/equicordplugins/fileUpload/types";
import * as media from "../src/equicordplugins/fileUpload/utils/getMediaUrl";
import * as sharex from "../src/equicordplugins/fileUpload/utils/sharex";

const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };

function load(file: string, overrides: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const mocks: Record<string, unknown> = {
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        ...overrides
    };
    const code = transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, URL, File, Blob, TextEncoder, TextDecoder, AbortController, Headers, Response, ReadableStream, Buffer,
        console: { error() {} },
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        },
        ...globals
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function uploadHarness(settings: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
    let account = "account";
    let selected = "channel";
    let serial = 0;
    let copies = 0;
    let inserted = 0;
    const requests: ReturnType<typeof deferred<{ success: boolean; url?: string; error?: string; }>>[] = [];
    const timers = new Map<number, { callback: () => void; delay: number; }>();
    const store = { serviceType: types.ServiceType.CATBOX, disableFallbacks: true, autoCopy: true, autoSend: true, preserveOriginalFilename: true, corsProxyUrl: "none", ...settings };
    const api = load("src/equicordplugins/fileUpload/utils/upload.ts", {
        "@equicordplugins/fileUpload/constants": constants,
        "@equicordplugins/fileUpload/settings": { settings: { store } },
        "@equicordplugins/fileUpload/types": types,
        "@utils/clipboard": { copyToClipboard: async () => { copies++; } },
        "@utils/discord": { insertTextIntoChatInputBox: () => inserted++ },
        "@utils/web": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) }, SelectedChannelStore: { getChannelId: () => selected }, showToast() {}, Toasts: { Type: {} } },
        "./apngToGif": { stopApngConversion() {} }, "./getMediaUrl": media, "./sharex": sharex, "./s3": {}
    }, {
        IS_DISCORD_DESKTOP: true,
        VencordNative: { pluginHelpers: { FileUpload: { uploadToCatbox: () => { const request = deferred<{ success: boolean; url?: string; error?: string; }>(); requests.push(request); return request.promise; } } } },
        setTimeout: (callback: () => void, delay: number) => { timers.set(++serial, { callback, delay }); return serial; },
        clearTimeout: (id: number) => timers.delete(id),
        ...globals
    });
    return { api, requests, timers, store, account: (value: string) => { account = value; }, selected: (value: string) => { selected = value; }, copies: () => copies, inserted: () => inserted };
}

const file = () => new File(["body"], "kept.txt", { type: "text/plain" });

test("cancelled, stopped and switched-account uploads cannot copy or insert a late native result", async () => {
    for (const scenario of ["cancel", "stop", "account"]) {
        const harness = uploadHarness();
        const upload = harness.api.uploadProvidedFiles([file()]);
        await tick();
        assert.equal(harness.requests.length, 1);
        if (scenario === "cancel") harness.api.cancelCurrentUpload();
        if (scenario === "stop") harness.api.stopUploads();
        if (scenario === "account") harness.account("different");
        harness.requests[0].resolve({ success: true, url: "https://example.invalid/file" });
        assert.equal(await upload, false);
        assert.equal(harness.copies(), 0);
        assert.equal(harness.inserted(), 0);
        assert.equal(harness.api.isUploadBusy(), false);
        if (scenario === "stop") assert.equal(harness.api.getUploadState().phase, "idle");
    }
});

test("completed uploads retain their URL but do not insert into a different channel", async () => {
    const harness = uploadHarness();
    const upload = harness.api.uploadProvidedFiles([file()], true);
    await tick();
    harness.selected("different");
    harness.requests[0].resolve({ success: true, url: "https://example.invalid/file" });
    assert.equal(await upload, true);
    assert.equal(harness.copies(), 1);
    assert.equal(harness.inserted(), 0);
});

test("obsolete progress resets cannot clear a newer upload and failing observers do not block state", async () => {
    const harness = uploadHarness();
    let observed = 0;
    harness.api.subscribeUploadState(() => { throw new Error("observer failed"); });
    harness.api.subscribeUploadState(() => observed++);
    const first = harness.api.uploadProvidedFiles([file()]);
    await tick();
    harness.requests[0].resolve({ success: true, url: "https://example.invalid/first" });
    await first;
    const reset = [...harness.timers.values()].find(timer => timer.delay === 1800)!.callback;
    const second = harness.api.uploadProvidedFiles([file()]);
    await tick();
    reset();
    assert.equal(harness.api.getUploadState().phase, "uploading");
    harness.requests[1].resolve({ success: true, url: "https://example.invalid/second" });
    await second;
    assert.ok(observed > 0);
});

test("XHR setup and response parsing failures release upload state and request timers", async () => {
    for (const failure of ["open", "headers"]) {
        const harness = uploadHarness({}, {
            IS_DISCORD_DESKTOP: false,
            FormData,
            XMLHttpRequest: class {
                upload = { onprogress: null };
                status = 200;
                statusText = "OK";
                responseURL = "https://example.invalid/result";
                onload!: () => void;
                onloadend!: () => void;
                open() { if (failure === "open") throw new Error("cannot open"); }
                setRequestHeader() {}
                getAllResponseHeaders() { throw new Error("cannot read headers"); }
                send() { Promise.resolve().then(() => { this.onload(); this.onloadend(); }); }
                abort() {}
            }
        });
        assert.equal(await harness.api.uploadProvidedFiles([file()]), false);
        assert.equal(harness.api.isUploadBusy(), false);
        assert.deepEqual([...harness.timers.values()].map(timer => timer.delay), [1800], "only the final progress reset remains");
    }
});

test("ShareX imports preserve unknown fields but reject invalid field types and treat response substitutions literally", () => {
    const base = { RequestURL: "https://example.invalid/upload", DestinationType: "FileUploader", future: { retained: true } };
    assert.equal((sharex.parseShareXConfig(JSON.stringify(base)) as any).future.retained, true);
    for (const patch of [{ DestinationType: 1 }, { Headers: [] }, { Headers: { token: null } }, { ErrorMessage: {} }]) {
        assert.throws(() => sharex.parseShareXConfig(JSON.stringify({ ...base, ...patch })));
    }
    const literal = "$& $` $' $$";
    assert.equal(sharex.resolveShareXTemplate("prefix:$response$:suffix", literal, {}), `prefix:${literal}:suffix`);
    assert.equal(sharex.resolveShareXTemplate("{json:constructor}", "", {}), "");
    assert.equal(media.getExtensionFromMime("image/apng"), "apng");
    assert.equal(media.getMimeFromExtension("m4v"), "video/mp4");
    assert.equal(media.getMimeFromExtension("constructor"), "application/octet-stream");
});

test("malformed or unreadable endpoint approval stores are preserved before any new consent or write", async () => {
    for (const content of ["invalid json", '[{"futureFormat":true}]']) {
        const data = Buffer.from(content);
        let writes = 0;
        let prompts = 0;
        const api = load("src/equicordplugins/fileUpload/nativeApprovals.ts", {
            "node:crypto": { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
            "node:fs/promises": { __esModule: true, default: {
                open: async () => ({ stat: async () => ({ isFile: () => true, size: data.length }), read: async (buffer: Buffer) => { data.copy(buffer); return { bytesRead: data.length }; }, close: async () => {} }),
                writeFile: async () => { writes++; }
            } },
            "node:net": { isIP }, "node:path": { __esModule: true, default: path },
            "@main/utils/constants": { DATA_DIR: "D:/unused-test-data" },
            "electron": { dialog: { showMessageBox: async () => { prompts++; return { response: 1 }; } } },
            "./nativeNetwork": { assertTrustedFileUploadEvent() {}, MAX_NATIVE_URL_LENGTH: 4096, parseNetworkUrl: (value: string) => new URL(value) }
        });
        await assert.rejects(api.approveEndpoint({}, { kind: "webdav", baseUrl: "https://example.invalid/dav" }));
        assert.equal(writes, 0);
        assert.equal(prompts, 0);
    }
});

test("stopping APNG conversion terminates a pending worker and failed input cleanup still attempts output cleanup", async () => {
    const pending = deferred<void>();
    const instances: any[] = [];
    let loads = 0;
    const api = load("src/equicordplugins/fileUpload/utils/apngToGif.ts", {
        "@ffmpeg/ffmpeg": { FFmpeg: class {
            loaded = true;
            terminations = 0;
            writes = 0;
            deleted: string[] = [];
            constructor() { instances.push(this); }
            terminate() { this.terminations++; }
            async writeFile() { this.writes++; }
            async exec() { return 0; }
            async readFile() { return new Uint8Array([71, 73, 70]); }
            async deleteFile(name: string) { this.deleted.push(name); if (name.startsWith("input")) throw new Error("already removed"); }
        } },
        "@utils/ffmpeg": { loadFFmpeg: () => ++loads === 1 ? pending.promise : Promise.resolve() }
    });
    const first = api.convertApngToGif(new Blob(["image"]));
    api.stopApngConversion();
    pending.resolve();
    assert.equal(await first, null);
    assert.ok(instances[0].terminations > 0);
    assert.equal(instances[0].writes, 0);
    assert.equal((await api.convertApngToGif(new Blob(["image"]))).type, "image/gif");
    assert.equal(instances[1].deleted.length, 2);
    api.stopApngConversion();
});

test("draft upload failures and mixed or busy interception retain original attachments", async () => {
    let successful = false;
    let busy = false;
    let removed = 0;
    let intercepted!: (event: unknown) => void;
    const upload = { id: "draft", filename: "kept.txt", item: { file: file() }, removeFromMsgDraft: () => removed++ };
    const plugin = load("src/equicordplugins/fileUpload/index.tsx", {
        "@api/ContextMenu": {}, "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Icons": {}, "@webpack": { findByPropsLazy: () => ({ getUserMaxFileSize: () => 10 }) },
        "@webpack/common": {
            React, Menu: { MenuItem: "MenuItem" }, DraftType: { ChannelMessage: 0 },
            UserStore: { getCurrentUser: () => ({ id: "account" }) }, SelectedChannelStore: { getChannelId: () => "channel" },
            UploadAttachmentStore: { getUploads: () => [upload] }, FluxDispatcher: { addInterceptor: (handler: typeof intercepted) => { intercepted = handler; } }
        },
        "./settings": { settings: { store: { bypassDiscordUpload: true, bypassDiscordUploadOnlyOverLimit: false } } },
        "./types": types, "./utils/getMediaUrl": {},
        "./utils/upload": { isConfigured: () => true, isFileTypeAllowed: (value: File) => value.name.endsWith(".txt"), isUploadBusy: () => busy, uploadProvidedFiles: async () => successful, logger: { warn() {} } }
    }, { document: { addEventListener() {} } }).default;
    const items: any[] = [];
    plugin.contextMenus["channel-attach"](items, { channel: { id: "channel" } });
    const draftAction = items[0].props.children[0][0].props.action;
    await draftAction();
    assert.equal(removed, 0);
    successful = true;
    await draftAction();
    assert.equal(removed, 1);
    plugin.start();
    const mixed = { type: "UPLOAD_ATTACHMENT_ADD_FILES", draftType: 0, files: [file(), new File(["body"], "keep.bin")] };
    intercepted(mixed);
    assert.equal(mixed.files.length, 2);
    busy = true;
    const incoming = { type: "UPLOAD_ATTACHMENT_ADD_FILES", draftType: 0, files: [file()] };
    intercepted(incoming);
    assert.equal(incoming.files.length, 1);
});
