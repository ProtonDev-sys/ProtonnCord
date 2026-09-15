/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as fflate from "fflate";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as polyfills from "../src/equicordplugins/favouriteAnything/polyfills";
import * as types from "../src/equicordplugins/favouriteAnything/types";

const React = { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };

function load(file: string, overrides: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const mocks: Record<string, unknown> = {
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        ...overrides
    };
    const code = transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, React, Promise, URL, File, Blob, TextEncoder, TextDecoder, AbortSignal,
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

function utilityModule(common: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
    return load("src/equicordplugins/favouriteAnything/utils.ts", {
        "@utils/discord": {}, "@utils/lazy": { proxyLazy: () => () => true }, "@utils/Queue": { Queue: class { push(task: () => unknown) { void task(); } } },
        "@utils/react": {}, "@webpack": { findByCodeLazy: () => undefined, findByPropsLazy: () => undefined },
        "@webpack/common": common, "fflate": fflate, "./polyfills": polyfills, "./types": types,
        ...overrides
    }, {
        IS_WEB: false, VencordNative: { pluginHelpers: { FavouriteAnything: {} } },
        window: { GLOBAL_ENV: { CDN_HOST: "cdn.discordapp.com", MEDIA_PROXY_ENDPOINT: "media.discordapp.net" } },
        ...globals
    });
}

test("favorite attachment metadata still round-trips and thumbnails do not disclose filenames", async () => {
    const api = utilityModule();
    const attachment = { id: "123", filename: "private project.txt", size: 12, url: "https://cdn.discordapp.com/attachments/channel/id/private.txt", content_type: "text/plain", title: "Private title", description: "Retained description" };
    const encoded = api.defs.encode(types.CustomItemFormat.ATTACHMENT, attachment);
    const decoded = api.defs.decode(encoded);
    assert.equal(decoded.data.filename, attachment.filename);
    assert.equal(decoded.data.description, attachment.description);
    assert.equal(decoded.data.url, attachment.url);
    const first = await api.getThumbnailUrl(encoded, 600, 400);
    assert.equal(first.search, "");
    first.hash = "changed";
    const second = await api.getThumbnailUrl(encoded, 600, 400);
    assert.equal(second.hash, "", "callers receive independent fallback URL objects");
    assert.equal(await api.getThumbnailUrl("invalid", 600, 400), null);
});

test("base64url fallback handles byte-array tails, whitespace and invalid padding consistently", () => {
    class LegacyBytes extends Uint8Array {}
    Object.defineProperty(LegacyBytes, "fromBase64", { value: undefined });
    Object.defineProperty(LegacyBytes.prototype, "toBase64", { value: undefined });
    const api = load("src/equicordplugins/favouriteAnything/polyfills.ts", {}, { Uint8Array: LegacyBytes });
    for (let size = 0; size < 20; size++) {
        const bytes = new LegacyBytes(Array.from({ length: size }, (_, i) => (i * 47) % 256));
        const encoded = api.uint8ArrayToBase64(bytes);
        assert.equal(encoded, Buffer.from(bytes).toString("base64url"));
        assert.deepEqual(Array.from(api.base64ToUint8Array(` ${encoded}\n`)), Array.from(bytes));
    }
    for (const invalid of ["A", "=", "AA=", "AA===", "A$AA"]) assert.throws(() => api.base64ToUint8Array(invalid));
});

test("sending one favourite leaves every other draft attachment in place and cancels after an account switch", async () => {
    let account = "one";
    const fetched = deferred<{ data: ArrayBuffer; filename: string; type: string; }>();
    let uploads: any[] = [{ id: "before", item: {} }];
    let sent: any;
    const api = utilityModule({
        UserStore: { getCurrentUser: () => ({ id: account }) }, DraftType: { ChannelMessage: 0 },
        Toasts: { show() {}, genId: () => "toast", Type: {} },
        UploadHandler: { promptToUpload: async ([file]: File[]) => { uploads.push({ id: "selected", item: { file } }, { id: "after", item: {} }); } },
        UploadAttachmentStore: { getUploads: () => uploads }, UploadManager: { setUploads: (next: { uploads: any[]; }) => { uploads = next.uploads; } },
        PendingReplyStore: { getPendingReply: () => null }, FluxDispatcher: { dispatch() {} }, MessageActions: { getSendMessageOptionsForReply: () => ({}) }
    }, { "@utils/discord": { sendMessage: async (_channel: string, _message: unknown, _ready: unknown, options: unknown) => { sent = options; } } }, {
        VencordNative: { pluginHelpers: { FavouriteAnything: { fetchAttachment: () => fetched.promise } } }
    });
    const attachment = { filename: "selected.txt", url: "mock" };
    const send = api.sendAttachment(attachment, { id: "channel" });
    fetched.resolve({ data: new ArrayBuffer(1), filename: "selected.txt", type: "text/plain" });
    assert.equal(await send, true);
    assert.deepEqual(Array.from(uploads, upload => upload.id), ["before", "after"]);
    assert.equal(sent.attachmentsToUpload.length, 1);
    assert.equal(sent.attachmentsToUpload[0].id, "selected");
    sent = undefined;
    const switched = api.sendAttachment(attachment, { id: "channel" });
    account = "two";
    assert.equal(await switched, false);
    assert.equal(sent, undefined);
});

test("native favorite downloads require an approved HTTPS origin and prevent redirect following", async () => {
    let calls = 0;
    const api = load("src/equicordplugins/favouriteAnything/native.ts", {}, {
        fetch: async (_url: URL, options: RequestInit) => {
            calls++;
            assert.equal(options.redirect, "error");
            assert.ok(options.signal);
            return { ok: true, blob: async () => new Blob(["saved"]) };
        }
    });
    for (const url of ["http://cdn.discordapp.com/file", "https://user@cdn.discordapp.com/file", "https://cdn.discordapp.com:444/file", "https://example.invalid/file"]) {
        await assert.rejects(api.fetchAttachment(null, { url, filename: "file" }), /Invalid URL/);
    }
    const file = await api.fetchAttachment(null, { url: "https://cdn.discordapp.com/attachments/file", filename: "file", content_type: "text/plain" });
    assert.equal(file.filename, "file");
    assert.equal(calls, 1);
});

test("batched favorite requests use the configured batch size and clear queued or failed work", async () => {
    const queued: (() => Promise<void>)[] = [];
    const timers = new Map<number, () => void>();
    let serial = 0;
    const api = utilityModule({}, { "@utils/Queue": { Queue: class { push(task: () => Promise<void>) { queued.push(task); } } } }, {
        setTimeout: (task: () => void) => { timers.set(++serial, task); return serial; }, clearTimeout: (id: number) => timers.delete(id)
    });
    const batches: string[][] = [];
    const queue = new api.BatchedRequestQueue(async (batch: string[]) => { batches.push(Array.from(batch)); }, { maxCount: 2, timeout: 50 });
    queue.add("a"); queue.add("b"); queue.add("c"); queue.add("d");
    await queued.shift()!();
    assert.deepEqual(batches, [["a", "b"]]);
    queue.clear();
    await queued.shift()!();
    assert.equal(batches.length, 1);
    queue.add("e");
    queue.clear();
    assert.equal(timers.size, 0);
});

test("favorite signed-URL responses cannot repopulate cleared or switched-account caches", async () => {
    let account = "one";
    const pending = deferred<{ body: { refreshed_urls: { original: string; refreshed: string; }[]; }; }>();
    const api = load("src/equicordplugins/favouriteAnything/stores.ts", {
        "@webpack": { proxyLazyWebpack: (factory: () => unknown) => factory() },
        "@webpack/common": {
            Flux: { Store: class { emitChange() {} } }, FluxDispatcher: {}, Constants: { Endpoints: {} },
            UserStore: { getCurrentUser: () => ({ id: account }) }, RestAPI: { post: () => pending.promise }
        },
        "./utils": { isAllowedHost: (host: string) => host === "cdn.discordapp.com", BatchedRequestQueue: class { add() {} clear() {} } }
    });
    const url = "https://cdn.discordapp.com/attachments/file";
    api.SignedUrlsStore.get(url);
    const response = api.SignedUrlsStore._handleBatch([url]);
    api.clearSignedUrlsStore();
    pending.resolve({ body: { refreshed_urls: [{ original: url, refreshed: `${url}?ex=ffffffff` }] } });
    await response;
    assert.equal(api.SignedUrlsStore.get(url), null);
    api.SignedUrlsStore.addSigned(`${url}?ex=ffffffff`);
    assert.equal(api.SignedUrlsStore.get(url), `${url}?ex=ffffffff`);
    account = "two";
    assert.equal(api.SignedUrlsStore.get(url), null);
});

test("toolbox theme actions preserve changes made since their menu rendered", () => {
    const settings = { useQuickCss: false, enabledThemes: ["old.css"] };
    const menu = new Proxy({}, { get: (_target, key) => key });
    const api = load("src/equicordplugins/equicordToolbox/menu.tsx", {
        "@api/Notifications/notificationLog": {}, "@api/PluginManager": {},
        "@api/Settings": { Settings: settings, useSettings: () => settings }, "@components/settings": {},
        "@utils/react": { useAwaiter: () => [[{ fileName: "new.css" }]] }, "@utils/text": {},
        "@webpack/common": { Menu: menu }, "~plugins": {}, ".": {}
    }, { VencordNative: { themes: { getThemesList() {} } } });
    const view = api.buildThemeMenuEntries();
    const flatten = (node: any): any[] => Array.isArray(node) ? node.flatMap(flatten) : node?.props ? [node, ...flatten(node.props.children)] : [];
    const items = flatten(view);
    settings.enabledThemes.push("concurrent.css");
    items.find(node => node.props.id === "theme-new.css").props.action();
    assert.deepEqual(Array.from(settings.enabledThemes), ["old.css", "concurrent.css", "new.css"]);
    const toggle = items.find(node => node.props.id === "toggle-quickcss").props.action;
    toggle(); toggle();
    assert.equal(settings.useQuickCss, false);
});

test("message export cancellation does not report success and contact copies observe errors and account changes", async () => {
    const notifications: unknown[] = [];
    const toasts: any[] = [];
    let account = "one";
    let copies = 0;
    const plugin = load("src/equicordplugins/exportMessages/index.tsx", {
        "@api/Notifications": { showNotification: (value: unknown) => notifications.push(value) },
        "@api/Settings": { definePluginSettings: () => ({ store: {} }) }, "@components/ErrorBoundary": {},
        "@utils/clipboard": { copyToClipboard: async () => { copies++; throw new Error("unavailable"); } },
        "@utils/native": {}, "@utils/web": {},
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: account }) }, Menu: { MenuItem: "MenuItem" }, Toasts: { show: (value: unknown) => toasts.push(value), genId: () => "toast", Type: { FAILURE: "failure" }, Position: {} } }
    }, { IS_DISCORD_DESKTOP: true, DiscordNative: { fileManager: { saveWithDialog: async () => null } } }).default;
    const items: any[] = [];
    plugin.contextMenus.message(items, { message: { id: "message", timestamp: new Date(), content: "text", author: { username: "user", discriminator: "0" } } });
    await items[0].props.action();
    assert.equal(notifications.length, 0);
    plugin.getContacts([{ type: 1, user: { username: "friend", discriminator: "0" } }]);
    await plugin.copyContactToClipboard();
    assert.equal(toasts[0].type, "failure");
    account = "two";
    await plugin.copyContactToClipboard();
    assert.equal(copies, 1);
    plugin.stop();
    assert.equal(plugin.contactList, undefined);
});
