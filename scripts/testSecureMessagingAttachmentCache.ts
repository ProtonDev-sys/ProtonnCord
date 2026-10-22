/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import type { Message } from "@vencord/discord-types";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { isPreviewableAttachmentMimeType } from "../src/equicordplugins/secureMessaging.desktop/attachments";
import { exactArrayBuffer } from "../src/equicordplugins/secureMessaging.desktop/exactArrayBuffer";
import { discordEditedTimestamp, discordMessageNonce } from "../src/equicordplugins/secureMessaging.desktop/messageMetadata";
import type { DecryptIncomingAttachmentsInput, DecryptIncomingAttachmentsResult, DecryptIncomingResult, DownloadIncomingAttachmentResult } from "../src/equicordplugins/secureMessaging.desktop/native";
import { createTaskQueue } from "../src/equicordplugins/secureMessaging.desktop/taskQueue";

type AttachmentCache = typeof import("../src/equicordplugins/secureMessaging.desktop/attachmentCache");
type AttachmentSelection = NonNullable<Parameters<AttachmentCache["decryptIncomingAttachmentsCached"]>[2]>;
const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", import.meta.url), "utf8");
const userId = "100000000000000001";

test("native image metadata is limited to registered media in the current account", async t => {
    const h = fixture();
    t.after(h.api.clearEncryptedAttachmentCache);
    h.api.encryptedAttachmentStatus(h.message);
    await setImmediate();
    const [file, image] = h.api.patchEncryptedMessageAttachments(h.message, { forceUpdate() {} }).attachments;
    const info = h.api.encryptedAttachmentMediaInfo(image.url);
    assert.equal(info?.contentType, "image/png");
    assert.equal(info?.filename, "image.png");
    assert.equal(h.api.encryptedAttachmentMediaInfo(image.proxy_url)?.filename, "image.png");
    assert.equal(h.api.encryptedAttachmentMediaInfo(file.url), null);
    assert.equal(h.api.encryptedAttachmentMediaInfo("blob:https://discord.com/spoof#image.png"), null);
    assert.equal(h.api.encryptedAttachmentMediaInfo({ url: image.url }), null);
    h.switchAccount();
    assert.equal(h.api.encryptedAttachmentMediaInfo(image.url), null);
    assert.equal(h.blobs.size, 0, "account changes revoke the previous account's blob resources");
});

function fixture(options: {
    legacy?: boolean;
    filesOnly?: boolean;
    expiredUrls?: boolean;
    inspect?: () => Promise<DecryptIncomingResult>;
    load?: (selection: AttachmentSelection, input: DecryptIncomingAttachmentsInput) => Promise<DecryptIncomingAttachmentsResult>;
    download?: (input: DecryptIncomingAttachmentsInput) => Promise<DownloadIncomingAttachmentResult>;
    refresh?: (urls: string[]) => Promise<object>;
    updateMessage?: () => void;
    document?: unknown;
    maxCacheBytes?: number;
    createObjectUrl?: (blob: Blob) => void;
} = {}) {
    let currentUserId = userId;
    const metrics = { inspections: 0, loads: 0, downloads: 0, refreshes: 0, selections: [] as AttachmentSelection[], refreshRequests: [] as string[][], inputs: [] as DecryptIncomingAttachmentsInput[] };
    const blobs = new Map<string, Blob>();
    let nextUrl = 0;
    class LocalURL extends URL {
        static createObjectURL(blob: Blob) {
            options.createObjectUrl?.(blob);
            const url = `blob:https://discord.com/fixture-${++nextUrl}`;
            blobs.set(url, blob);
            return url;
        }
        static revokeObjectURL(url: string) { blobs.delete(url); }
    }
    const message = {
        id: "200000000000000001", channel_id: "300000000000000001",
        author: { id: "100000000000000002" }, content: "PCEM3:fixture", flags: 0 as Message["flags"],
        attachments: [300 * 1024 * 1024, 100].map((size, index) => ({
            id: `40000000000000000${index + 1}`, size, filename: "encrypted.pcaf", content_type: "application/octet-stream", spoiler: false,
            url: `https://cdn.discordapp.com/attachments/300000000000000001/40000000000000000${index + 1}/encrypted.pcaf${options.expiredUrls ? "?ex=1" : ""}`,
            proxy_url: `https://media.discordapp.net/attachments/300000000000000001/40000000000000000${index + 1}/encrypted.pcaf${options.expiredUrls ? "?ex=1" : ""}`
        }))
    } as Message;
    const native = {
        async decryptIncoming(): Promise<DecryptIncomingResult> {
            metrics.inspections++;
            return options.inspect ? options.inspect() : {
                status: "decrypted", plaintext: "", counter: 1, envelopeId: "fixture", detachedTextIndex: null, stickers: [],
                attachmentBundle: {
                    id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43), count: 2,
                    ...(!options.legacy && { manifest: [
                        { digest: "A".repeat(43), preview: false, spoiler: true, size: message.attachments[0].size - 100, name: "archive.zip" },
                        { digest: "A".repeat(43), preview: !options.filesOnly, spoiler: false, size: 4, name: "image.png" }
                    ] })
                }
            };
        },
        async decryptIncomingAttachments(_userId: string, input: DecryptIncomingAttachmentsInput, selection: AttachmentSelection): Promise<DecryptIncomingAttachmentsResult> {
            metrics.loads++;
            metrics.selections.push(selection);
            metrics.inputs.push(input);
            return options.load ? options.load(selection, input) : {
                status: "decrypted", plaintext: "",
                attachments: options.legacy || options.filesOnly ? [] : [{
                    id: message.attachments[1].id, data: new Uint8Array([1, 2, 3, 4]),
                    metadata: { name: "image.png", mimeType: "image/png", size: 4, spoiler: false,
                        description: null, duration: null, height: 1, width: 1, waveform: null }
                }],
                deferredAttachments: message.attachments.slice(0, options.legacy || options.filesOnly ? 2 : 1).map(attachment => ({
                    id: attachment.id, name: options.legacy ? null : "archive.zip", size: attachment.size - 100,
                    ...(!options.legacy && { spoiler: true })
                }))
            };
        },
        async downloadIncomingAttachment(_userId: string, input: DecryptIncomingAttachmentsInput, attachmentId: string): Promise<DownloadIncomingAttachmentResult> {
            assert.equal(attachmentId, message.attachments[0].id);
            metrics.downloads++;
            metrics.inputs.push(input);
            return options.download ? options.download(input) : { status: "saved", filename: "archive.zip" };
        }
    };
    const mocks: Record<string, object> = {
        "@api/MessageUpdater": { updateMessage: (channelId: string, messageId: string) => {
            assert.equal(channelId, message.channel_id);
            assert.equal(messageId, message.id);
            options.updateMessage?.();
        } },
        "@webpack/common": {
            Constants: { Endpoints: { ATTACHMENTS_REFRESH_URLS: "/fixture-refresh" } },
            RestAPI: { async post({ body }: { body: { attachment_urls: string[]; }; }) {
                metrics.refreshes++;
                const urls = Array.from(body.attachment_urls);
                metrics.refreshRequests.push(urls);
                return options.refresh ? options.refresh(urls) : {
                    body: { refreshed_urls: urls.map(original => ({ original, refreshed: original.replace("ex=1", "ex=ffffffff") })) }
                };
            } },
            UserStore: { getCurrentUser: () => ({ id: currentUserId }) }
        },
        "./attachments": { isPreviewableAttachmentMimeType },
        "./exactArrayBuffer": { exactArrayBuffer },
        "./layoutStability": { preserveEncryptedMessageScroll: (_message: Message, update: () => void) => update() },
        "./messageMetadata": { discordEditedTimestamp, discordMessageNonce },
        "./protocol": { isEncryptedMessage: () => true },
        "./taskQueue": { createTaskQueue }
    };
    const exports = {} as AttachmentCache;
    const implementation = options.maxCacheBytes === undefined ? source
        : source.replace(/const MAX_CACHE_BYTES = [^;]+;/, `const MAX_CACHE_BYTES = ${options.maxCacheBytes};`);
    runInNewContext(transpileModule(implementation, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText, {
        exports, URL: LocalURL, Blob, setTimeout, clearTimeout, AbortController, document: options.document,
        VencordNative: { pluginHelpers: { SecureMessaging: native } },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { api: exports, message, metrics, blobs, switchAccount: () => { currentUserId = "100000000000000003"; } };
}

function videoFixture(videoCount = 2, maxCacheBytes?: number) {
    const videos: Array<{
        src: string; videoWidth: number; videoHeight: number;
        listeners: Map<string, () => void>;
        addEventListener(name: string, listener: () => void): void;
        removeEventListener(name: string): void;
        removeAttribute(): void; load(): void;
    }> = [];
    const encoders: Array<(blob: Blob | null) => void> = [];
    let refreshes = 0;
    const ids = Array.from({ length: videoCount + 1 }, (_, index) => String(400000000000000001n + BigInt(index)));
    const h = fixture({
        maxCacheBytes, updateMessage: () => { refreshes++; },
        document: {
            createElement(type: string) {
                if (type === "canvas") return { getContext: () => ({ drawImage() {} }), toBlob: (complete: (blob: Blob | null) => void) => encoders.push(complete) };
                assert.equal(type, "video");
                const video = {
                    src: "", videoWidth: 640, videoHeight: 480, listeners: new Map<string, () => void>(),
                    addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); },
                    removeEventListener(name: string) { this.listeners.delete(name); },
                    removeAttribute() { this.src = ""; }, load() {},
                };
                videos.push(video);
                return video;
            },
        },
        inspect: async () => ({ status: "decrypted", plaintext: "", stickers: [], detachedTextIndex: null, counter: 1, envelopeId: "fixture",
            attachmentBundle: { id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43), count: ids.length,
                manifest: ids.map(() => ({ digest: "A".repeat(43), preview: true, spoiler: false, size: 4, name: null })) } }),
        load: async selection => ({ status: "decrypted", plaintext: "", attachments: ids.map((id, index) => ({
            id, data: new Uint8Array([1, 2, 3, 4]), metadata: {
                name: index === 1 ? "photo.png" : "clip.mp4", mimeType: index === 1 ? "image/png" : "video/mp4", size: 4,
                width: 640, height: 480, duration: index === 1 ? null : 1, description: null, waveform: null, spoiler: false,
            },
        })).filter(file => typeof selection !== "object" || file.id === selection.attachmentId),
        deferredAttachments: ids.filter(id => typeof selection === "object" && id !== selection.attachmentId)
            .map(id => ({ id, size: 4, name: null, spoiler: false })) }),
    });
    h.message.attachments = ids.map(id => ({ ...h.message.attachments[1], id, size: 100,
        url: `https://cdn.discordapp.com/attachments/${h.message.channel_id}/${id}/encrypted.pcaf`,
        proxy_url: `https://media.discordapp.net/attachments/${h.message.channel_id}/${id}/encrypted.pcaf` }));
    const owner = { forceUpdate() {} };
    return { ...h, videos, encoders, owner, refreshes: () => refreshes,
        render: () => h.api.patchEncryptedMessageAttachments(h.message, owner),
        decode(index: number) { videos[index].listeners.get("loadeddata")?.(); },
    };
}

test("mixed authenticated images and playable videos display before either poster decoder finishes", async t => {
    const h = videoFixture();
    t.after(() => h.api.clearEncryptedAttachmentCache());
    h.render();
    await setImmediate();
    const attachments = h.render().attachments;
    assert.equal(attachments.length, 3, "a slow video poster must not withhold the neighboring image");
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "ready");
    assert.equal(h.videos.length, 2, "poster decoding has its own bounded queue");
    assert.equal(attachments[0].content_type, "video/mp4");
    const sourceUrl = attachments[0].url.split("#")[0];
    const placeholderUrl = attachments[0].proxy_url.split("#")[0];
    assert.equal(h.blobs.get(placeholderUrl)?.type, "image/png");
    assert.notEqual(sourceUrl, placeholderUrl);
    assert.deepEqual({ ...h.api.encryptedAttachmentMediaInfo(attachments[0].proxy_url) }, { contentType: "video/mp4", filename: "clip.mp4" });
    h.decode(0);
    h.encoders[0](new Blob(["poster"], { type: "image/webp" }));
    await setImmediate();
    const enhanced = h.render().attachments[0];
    assert.equal(enhanced.url, attachments[0].url, "the playable authenticated video source stays unchanged");
    assert.notEqual(enhanced.proxy_url, attachments[0].proxy_url);
    assert.deepEqual({ ...h.api.encryptedAttachmentMediaInfo(enhanced.proxy_url) }, { contentType: "video/mp4", filename: "clip.mp4" });
    assert.equal(h.refreshes(), 1);
    h.api.clearEncryptedAttachmentCache();
    assert.equal(h.blobs.size, 0);
    assert.ok(h.videos.every(video => video.listeners.size === 0 && video.src === ""));
});

test("cache disposal aborts active posters and skips queued videos without leaking URLs", async t => {
    const h = videoFixture(3);
    t.after(() => h.api.clearEncryptedAttachmentCache());
    h.render();
    await setImmediate();
    assert.equal(h.videos.length, 2);
    h.decode(0);
    h.api.clearEncryptedAttachmentCache();
    h.encoders[0](new Blob(["late poster"], { type: "image/webp" }));
    await setImmediate();
    assert.equal(h.videos.length, 2, "the queued third decoder must never start after disposal");
    assert.equal(h.blobs.size, 0);
    assert.equal(h.refreshes(), 0);
    assert.ok(h.videos.every(video => video.listeners.size === 0));
});

test("an account transition cannot publish a poster for the previous account", async t => {
    const h = videoFixture(1);
    t.after(() => h.api.clearEncryptedAttachmentCache());
    h.render();
    await setImmediate();
    h.decode(0);
    const urls = h.blobs.size;
    h.switchAccount();
    h.encoders[0](new Blob(["late poster"], { type: "image/webp" }));
    await setImmediate();
    assert.equal(h.blobs.size, urls, "no new plaintext URL is created after the account changes");
    assert.equal(h.refreshes(), 0);
    h.api.clearEncryptedAttachmentCache();
    assert.equal(h.blobs.size, 0);
});

test("a full cache skips optional posters while retaining playable media", async t => {
    const h = videoFixture(1, 200);
    t.after(() => h.api.clearEncryptedAttachmentCache());
    h.render();
    await setImmediate();
    const initial = h.render().attachments[0];
    const urls = h.blobs.size;
    h.decode(0);
    h.encoders[0](new Blob([new Uint8Array(200)], { type: "image/webp" }));
    await setImmediate();
    assert.equal(h.render().attachments[0].proxy_url, initial.proxy_url);
    assert.equal(h.blobs.size, urls);
    assert.equal(h.refreshes(), 0);
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "ready");
    h.api.clearEncryptedAttachmentCache();
});

test("poster timeouts clean up decoding without hiding authenticated attachments", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = videoFixture();
    t.after(() => h.api.clearEncryptedAttachmentCache());
    h.render();
    await setImmediate();
    const initialUrls = h.blobs.size;
    t.mock.timers.tick(5_000);
    await setImmediate();
    assert.equal(h.render().attachments.length, 3);
    assert.equal(h.blobs.size, initialUrls);
    assert.equal(h.refreshes(), 0);
    assert.ok(h.videos.every(video => video.listeners.size === 0 && video.src === ""));
});

test("manual retry after a terminal failure restores the native media renderer without reopening chat", async t => {
    let failed = true;
    let render = () => {};
    const { api, message, blobs } = fixture({
        updateMessage: () => render(),
        load: async () => failed ? { status: "invalid_message" } : {
            status: "decrypted", plaintext: "",
            attachments: [{
                id: "400000000000000002", data: new Uint8Array([1, 2, 3, 4]),
                metadata: { name: "image.png", mimeType: "image/png", size: 4, spoiler: false,
                    description: null, duration: null, height: 1, width: 1, waveform: null }
            }],
        },
    });
    t.after(api.clearEncryptedAttachmentCache);
    let rendered: Message;
    const owner = { forceUpdate: () => render() };
    render = () => { rendered = api.patchEncryptedMessageAttachments(message, owner); };
    render();
    await setImmediate();
    assert.equal(api.encryptedAttachmentStatus(message).status, "failed");
    assert.equal(blobs.size, 0);
    failed = false;
    api.retryEncryptedAttachmentLoad(message);
    await setImmediate();
    assert.equal(api.encryptedAttachmentStatus(message).status, "ready");
    assert.equal(rendered!.attachments[0]?.filename, "image.png");
});

test("attachment rendering loads previews beside a 300 MiB ZIP without fetching the file", async t => {
    const { api, message, metrics, blobs } = fixture();
    t.after(api.clearEncryptedAttachmentCache);
    const owner = { forceUpdate: t.mock.fn() };
    api.patchEncryptedMessageAttachments(message, owner);
    await setImmediate();
    assert.equal(api.encryptedAttachmentStatus(message).status, "ready");
    const rendered = api.patchEncryptedMessageAttachments(message, owner);
    assert.deepEqual(Array.from(rendered.attachments, attachment => attachment.id), message.attachments.map(attachment => attachment.id));
    const [file, image] = rendered.attachments;
    assert.equal(file.filename, "archive.zip");
    assert.equal(file.size, message.attachments[0].size - 100);
    assert.equal(file.content_type, "application/octet-stream");
    assert.ok(file.url.endsWith("#pc-secure-deferred=archive.zip"));
    assert.equal(file.proxy_url, file.url);
    assert.ok(!image.url.includes("#pc-secure-deferred="));
    assert.equal(file.spoiler, true);
    assert.equal((file as { flags?: number; }).flags, 8);
    assert.equal(blobs.get(file.url.split("#")[0])?.size, 0);
    assert.equal(blobs.get(image.url.split("#")[0])?.size, 4);
    assert.equal(api.isEncryptedAttachmentMediaUrl(file.url), false);
    assert.equal(api.isEncryptedAttachmentMediaUrl(image.url), true);
    assert.equal(api.isEncryptedAttachmentDownloadUrl(file.url), true);
    for (let i = 0; i < 100; i++) api.patchEncryptedMessageAttachments(message, owner);
    assert.equal(metrics.inspections, 1);
    assert.equal(metrics.loads, 1);
    assert.deepEqual(metrics.selections, ["previews"]);
    assert.equal(metrics.downloads, 0);
    assert.equal(metrics.refreshes, 0);
    assert.equal(owner.forceUpdate.mock.callCount(), 1);
});

test("legacy attachments remain opaque and all blob references are revoked on clear", async () => {
    const { api, message, blobs } = fixture({ legacy: true });
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    const rendered = api.patchEncryptedMessageAttachments(message, { forceUpdate() {} });
    assert.deepEqual(Array.from(rendered.attachments, attachment => attachment.filename), ["Encrypted file 1", "Encrypted file 2"]);
    assert.ok(rendered.attachments.every(attachment => !attachment.spoiler));
    assert.ok([...blobs.values()].every(blob => blob.size === 0));
    const url = rendered.attachments[0].url;
    api.clearEncryptedAttachmentCache();
    assert.equal(blobs.size, 0);
    assert.equal(api.isEncryptedAttachmentDownloadUrl(url), false);
    assert.equal(await api.downloadEncryptedAttachmentUrl(url), null);
});

test("concurrent explicit file clicks share one native save and allow later retries", async t => {
    const gate = Promise.withResolvers<DownloadIncomingAttachmentResult>();
    const { api, message, metrics } = fixture({ download: () => gate.promise });
    t.after(api.clearEncryptedAttachmentCache);
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    const url = api.patchEncryptedMessageAttachments(message, { forceUpdate() {} }).attachments[0].url;
    const first = api.downloadEncryptedAttachmentUrl(url);
    const duplicate = api.downloadEncryptedAttachmentUrl(url);
    await setImmediate();
    assert.equal(metrics.downloads, 1);
    gate.resolve({ status: "saved", filename: "archive.zip" });
    assert.deepEqual(await first, await duplicate);
    await api.downloadEncryptedAttachmentUrl(url);
    assert.equal(metrics.downloads, 2);
});

test("attachment singleflight keeps text expansion separate from previews", async () => {
    const gate = Promise.withResolvers<DecryptIncomingAttachmentsResult>();
    const { api, message, metrics } = fixture({ load: () => gate.promise });
    const previews = api.decryptIncomingAttachmentsCached(userId, message);
    assert.equal(api.decryptIncomingAttachmentsCached(userId, message), previews);
    const text = api.decryptIncomingAttachmentsCached(userId, message, "text");
    await setImmediate();
    assert.deepEqual(metrics.selections, ["previews", "text"]);
    gate.resolve({ status: "decrypted", plaintext: "text", attachments: [] });
    await Promise.all([previews, text]);
    api.clearEncryptedAttachmentCache();
});

test("switching accounts prevents an old deferred download from starting", async () => {
    const { api, message, metrics, switchAccount } = fixture();
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    const url = api.patchEncryptedMessageAttachments(message, { forceUpdate() {} }).attachments[0].url;
    switchAccount();
    assert.equal(await api.downloadEncryptedAttachmentUrl(url), null);
    assert.equal(metrics.downloads, 0);
    api.clearEncryptedAttachmentCache();
});

test("failed message authentication cannot create file rows or request attachment bytes", async () => {
    const { api, message, metrics, blobs } = fixture({ inspect: async () => ({ status: "untrusted_author" }) });
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    assert.equal(api.encryptedAttachmentStatus(message).status, "failed");
    assert.equal(api.patchEncryptedMessageAttachments(message, { forceUpdate() {} }).attachments.length, 0);
    assert.equal(metrics.loads, 0);
    assert.equal(blobs.size, 0);
    api.clearEncryptedAttachmentCache();
});

for (const invalidation of ["cache clear", "account change"] as const) {
    test(`${invalidation} while inspecting a valid manifest cannot start a stale attachment load`, async t => {
        const gate = Promise.withResolvers<DecryptIncomingResult>();
        const { api, message, metrics, blobs, switchAccount } = fixture({ inspect: () => gate.promise });
        t.after(api.clearEncryptedAttachmentCache);
        api.encryptedAttachmentStatus(message);
        assert.equal(metrics.inspections, 1);
        if (invalidation === "cache clear") api.clearEncryptedAttachmentCache();
        else switchAccount();
        gate.resolve({
            status: "decrypted", plaintext: "", counter: 1, envelopeId: "fixture", detachedTextIndex: null, stickers: [],
            attachmentBundle: {
                id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43), count: 2,
                manifest: [
                    { digest: "A".repeat(43), preview: false, spoiler: true, size: message.attachments[0].size - 100, name: "archive.zip" },
                    { digest: "A".repeat(43), preview: true, spoiler: false, size: 4, name: "image.png" }
                ]
            }
        });
        await setImmediate();
        assert.equal(metrics.loads, 0);
        assert.equal(blobs.size, 0);
    });
}

for (const legacy of [false, true]) {
    test(`${legacy ? "legacy" : "manifest"} file rows skip expired URL refreshes while another refresh is pending`, async t => {
        const gate = Promise.withResolvers<object>();
        const { api, message, metrics } = fixture({ legacy, filesOnly: true, expiredUrls: true, refresh: () => gate.promise });
        t.after(api.clearEncryptedAttachmentCache);
        const unrelated = api.encryptedAttachmentInput(message);
        assert.equal(metrics.refreshes, 1);
        api.encryptedAttachmentStatus(message);
        await setImmediate();
        assert.equal(api.encryptedAttachmentStatus(message).status, "ready");
        assert.equal(metrics.refreshes, 1, "Rendering must add no refresh request");
        assert.equal(metrics.loads, 1);
        assert.deepEqual(Array.from(metrics.inputs[0].attachments, attachment => attachment.url), message.attachments.map(attachment => attachment.url));
        gate.resolve({ body: { refreshed_urls: [] } });
        await unrelated;
    });
}

test("a cold expired preview refreshes only selected media after the native cache miss", async t => {
    const { api, message, metrics } = fixture({ expiredUrls: true, load: async (_selection, input) =>
        input.attachments[1].url.includes("ex=1") ? { status: "failed", error: "attachment_download_failed" }
            : { status: "decrypted", plaintext: "", attachments: [] } });
    t.after(api.clearEncryptedAttachmentCache);
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    assert.equal(api.encryptedAttachmentStatus(message).status, "ready");
    const [file, preview] = message.attachments;
    assert.deepEqual(metrics.refreshRequests, [[preview.url, preview.proxy_url]]);
    assert.equal(metrics.loads, 2);
    assert.equal(metrics.inputs[0].attachments[1].url, preview.url, "native gets the opportunity to serve its authenticated cache first");
    const input = metrics.inputs[1];
    assert.deepEqual(Array.from(input.attachments, attachment => attachment.id), message.attachments.map(attachment => attachment.id));
    assert.equal(input.attachments[0].url, file.url);
    assert.equal(input.attachments[0].proxyUrl, file.proxy_url);
    assert.equal(input.attachments[1].url, preview.url.replace("ex=1", "ex=ffffffff"));
    assert.equal(input.attachments[1].proxyUrl, preview.proxy_url.replace("ex=1", "ex=ffffffff"));
});

for (const legacy of [false, true]) {
    test(`${legacy ? "legacy" : "manifest"} cold downloads refresh ${legacy ? "all authenticated bundle references" : "only the clicked file"}`, async t => {
        const { api, message, metrics } = fixture({ legacy, filesOnly: true, expiredUrls: true, download: async input =>
            input.attachments[0].url.includes("ex=1") ? { status: "failed", error: "attachment_download_failed" }
                : { status: "saved", filename: "archive.zip" } });
        t.after(api.clearEncryptedAttachmentCache);
        api.encryptedAttachmentStatus(message);
        await setImmediate();
        assert.equal(metrics.refreshes, 0);
        const url = api.patchEncryptedMessageAttachments(message, { forceUpdate() {} }).attachments[0].url;
        assert.equal((await api.downloadEncryptedAttachmentUrl(url))?.status, "saved");
        assert.equal(metrics.downloads, 2);
        const refreshed = legacy ? message.attachments : message.attachments.slice(0, 1);
        assert.deepEqual(metrics.refreshRequests, [refreshed.flatMap(attachment => [attachment.url, attachment.proxy_url])]);
        const input = metrics.inputs.at(-1);
        assert.ok(input);
        assert.deepEqual(Array.from(input.attachments, attachment => attachment.id), message.attachments.map(attachment => attachment.id));
    });
}

function documentFixture(options: {
    name?: string | null;
    spoiler?: boolean;
    totalBytes?: number;
    companion?: string;
    load?: () => Promise<DecryptIncomingAttachmentsResult>;
} = {}) {
    const name = options.name === undefined ? "notes.txt" : options.name;
    const files = [name ?? "notes.txt", options.companion ?? "image.png"].map((filename, index) => ({
        id: `40000000000000000${index + 1}`,
        data: new TextEncoder().encode(index === 0 ? "<script>inert document</script>" : "data"),
        metadata: {
            name: filename, mimeType: index === 0 ? "text/html" : filename === "image.png" ? "image/png" : "application/octet-stream",
            size: index === 0 ? 30 : 4, spoiler: options.spoiler ?? false,
            description: null, duration: null, height: null, width: null, waveform: null
        }
    }));
    const manifest = files.map((file, index) => ({
        digest: "A".repeat(43), name: index === 0 ? name : file.metadata.name,
        preview: isPreviewableAttachmentMimeType(file.metadata.mimeType),
        size: file.data.length, spoiler: file.metadata.spoiler
    }));
    const result = fixture({
        expiredUrls: true,
        inspect: async () => ({
            status: "decrypted", plaintext: "", counter: 1, envelopeId: "fixture", detachedTextIndex: null, stickers: [],
            attachmentBundle: { id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43), count: 2, manifest }
        }),
        load: selection => options.load ? options.load() : Promise.resolve({
            status: "decrypted", plaintext: "",
            attachments: files.filter((_, index) => selection === "all" || manifest[index].preview),
            deferredAttachments: files.flatMap((file, index) => selection !== "all" && !manifest[index].preview
                ? [{ id: file.id, ...manifest[index] }]
                : [])
        })
    });
    result.message.attachments[0].size = (options.totalBytes ?? 1_024) - 100;
    return { ...result, files };
}

for (const name of ["notes.txt", "README.MD", "settings.json", "data.csv", "config.yaml"]) {
    test(`${name} previews authenticated document bytes as inert text without changing wire flags`, async t => {
        const { api, message, metrics, blobs } = documentFixture({ name });
        t.after(api.clearEncryptedAttachmentCache);
        const owner = { forceUpdate() {} };
        api.patchEncryptedMessageAttachments(message, owner);
        await setImmediate();
        const file = api.patchEncryptedMessageAttachments(message, owner).attachments[0];
        assert.deepEqual(metrics.selections, ["all"]);
        assert.equal(file.filename, name);
        assert.equal(file.content_type, "text/plain");
        assert.equal(await blobs.get(file.url.split("#")[0])?.text(), "<script>inert document</script>");
        assert.equal(api.isEncryptedAttachmentMediaUrl(file.url), false);
        assert.equal(api.isEncryptedAttachmentDownloadUrl(file.url), true);
        assert.deepEqual(metrics.refreshRequests, [], "authenticated native cache hits need no signed-URL refresh");
        for (let i = 0; i < 100; i++) api.patchEncryptedMessageAttachments(message, owner);
        assert.equal(metrics.loads, 1);
        assert.equal(metrics.downloads, 0);
        api.clearEncryptedAttachmentCache();
        assert.equal(blobs.size, 0);
    });
}

for (const options of [
    { name: null }, { name: "page.html" }, { name: "image.svg" }, { name: "archive.zip" },
    { name: "notes.txt.exe" }, { spoiler: true }, { companion: "archive.zip" }, { totalBytes: 256 * 1024 + 1 }
]) {
    test(`unsafe or oversized document bundle remains deferred: ${JSON.stringify(options)}`, async t => {
        const { api, message, metrics } = documentFixture(options);
        t.after(api.clearEncryptedAttachmentCache);
        message.attachments[0].filename = "public-untrusted-name.txt";
        api.encryptedAttachmentStatus(message);
        await setImmediate();
        assert.deepEqual(metrics.selections, ["previews"]);
        const file = api.patchEncryptedMessageAttachments(message, { forceUpdate() {} }).attachments[0];
        assert.equal(file.content_type, "application/octet-stream");
        assert.ok(file.url.includes("#pc-secure-deferred="));
        assert.ok(metrics.refreshRequests.every(urls => !urls.includes(message.attachments[0].url)));
    });
}

test("the document bundle limit includes the 256 KiB boundary", async t => {
    const { api, message, metrics } = documentFixture({ totalBytes: 256 * 1024 });
    t.after(api.clearEncryptedAttachmentCache);
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    assert.deepEqual(metrics.selections, ["all"]);
});

test("failed document authentication never exposes a blob", async t => {
    const { api, message, blobs } = documentFixture({ load: async () => ({ status: "invalid_message" }) });
    t.after(api.clearEncryptedAttachmentCache);
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    assert.equal(api.encryptedAttachmentStatus(message).status, "failed");
    assert.equal(blobs.size, 0);
    assert.equal(api.patchEncryptedMessageAttachments(message, { forceUpdate() {} }).attachments.length, 0);
});

test("clearing a pending document preview prevents late plaintext URLs", async () => {
    const gate = Promise.withResolvers<DecryptIncomingAttachmentsResult>();
    const { api, message, blobs, files, metrics } = documentFixture({ load: () => gate.promise });
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    assert.deepEqual(metrics.selections, ["all"]);
    api.clearEncryptedAttachmentCache();
    gate.resolve({ status: "decrypted", plaintext: "", attachments: files });
    await setImmediate();
    assert.equal(blobs.size, 0);
});

test("an updated optimistic nonce cannot reuse a cached replay failure", async t => {
    const { api, message, metrics } = fixture({ inspect: async () => ({ status: "replay_detected" }) });
    t.after(api.clearEncryptedAttachmentCache);
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    assert.equal(metrics.inspections, 1);
    const key = api.encryptedAttachmentCacheKey(message);
    message.nonce = "500000000000000001";
    assert.notEqual(api.encryptedAttachmentCacheKey(message), key);
    api.encryptedAttachmentStatus(message);
    await setImmediate();
    assert.equal(metrics.inspections, 2, "Changed authentication inputs must be checked again");
});

function independentPreviews(options: {
    count?: number;
    createObjectUrl?: (blob: Blob) => void;
    detached?: boolean;
    download?: () => Promise<DownloadIncomingAttachmentResult>;
} = {}) {
    const files = Array.from({ length: options.count ?? 2 }, (_, index) => ({
        id: String(400000000000000001n + BigInt(index)), data: new Uint8Array([1, 2, 3, 4]),
        metadata: { name: `image-${index}.png`, mimeType: "image/png", size: 4, spoiler: false,
            description: null, duration: null, height: 1, width: 1, waveform: null }
    }));
    const gates = files.map(() => Promise.withResolvers<DecryptIncomingAttachmentsResult>());
    const h = fixture({
        createObjectUrl: options.createObjectUrl,
        download: options.download,
        inspect: async () => ({ status: "decrypted", plaintext: "", stickers: [], counter: 1, envelopeId: "fixture",
            detachedTextIndex: options.detached ? files.length - 1 : null,
            attachmentBundle: { id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43), count: files.length,
                manifest: files.map(file => ({ digest: "A".repeat(43), name: file.metadata.name, preview: true, size: 4, spoiler: false })) } }),
        load: selection => {
            assert.equal(typeof selection, "object");
            const id = (selection as { attachmentId: string; }).attachmentId;
            assert.notEqual(options.detached ? files.at(-1)?.id : null, id, "detached message text is expanded separately");
            return gates[files.findIndex(file => file.id === id)].promise;
        }
    });
    h.message.attachments = files.map((file, index) => ({ ...h.message.attachments[1], id: file.id, size: 100 * (files.length - index),
        url: `https://cdn.discordapp.com/attachments/${h.message.channel_id}/${file.id}/encrypted.pcaf`,
        proxy_url: `https://media.discordapp.net/attachments/${h.message.channel_id}/${file.id}/encrypted.pcaf` }));
    const result = (index: number): DecryptIncomingAttachmentsResult => ({ status: "decrypted", plaintext: "", attachments: [files[index]],
        deferredAttachments: files.filter((file, other) => other !== index && (!options.detached || other !== files.length - 1))
            .map(file => ({ id: file.id, name: file.metadata.name, size: 4, spoiler: false })) });
    const owner = { forceUpdate() {} };
    return { ...h, files, gates, result, render: () => h.api.patchEncryptedMessageAttachments(h.message, owner) };
}

test("small authenticated previews render before a slow sibling, with ordered downloads and no replaced blob leaks", async t => {
    const h = independentPreviews();
    t.after(h.api.clearEncryptedAttachmentCache);
    h.render();
    await setImmediate();
    assert.deepEqual(h.metrics.selections.map(value => typeof value === "object" && value.attachmentId), [h.files[1].id, h.files[0].id]);
    h.gates[1].resolve(h.result(1));
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "loading");
    const [pending, ready] = h.render().attachments;
    assert.ok(pending.url.includes("#pc-secure-deferred="));
    assert.equal(ready.content_type, "image/png");
    assert.equal(h.api.isEncryptedAttachmentDownloadUrl(pending.url), true);
    assert.equal(h.api.isEncryptedAttachmentDownloadUrl(ready.url), true);
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "ready");
    assert.deepEqual(Array.from(h.render().attachments, attachment => attachment.id), h.files.map(file => file.id));
    assert.equal(h.blobs.size, 2, "the zero-byte placeholder is revoked when its authenticated image arrives");
    assert.equal(h.api.isEncryptedAttachmentDownloadUrl(pending.url), false);
    assert.equal(h.render().attachments[1].url, ready.url, "a sibling completion retains the first image's URL");
});

test("a failed sibling keeps healthy previews and retry downloads only the missing file", async t => {
    const h = independentPreviews();
    t.after(h.api.clearEncryptedAttachmentCache);
    h.render();
    h.gates[1].resolve(h.result(1));
    h.gates[0].resolve({ status: "invalid_message" });
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "failed");
    const readyUrl = h.render().attachments[1].url;
    h.gates[0] = Promise.withResolvers<DecryptIncomingAttachmentsResult>();
    assert.equal(h.api.retryEncryptedAttachmentLoad(h.message), true);
    await setImmediate();
    assert.equal(h.metrics.loads, 3, "the authenticated sibling is reused during retry");
    assert.equal(h.render().attachments[1].url, readyUrl);
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "ready");
    assert.equal(h.blobs.size, 2);
});

test("downloads wait for their in-flight preview and keep singleflight across the placeholder upgrade", async t => {
    const save = Promise.withResolvers<DownloadIncomingAttachmentResult>();
    const h = independentPreviews({ download: () => save.promise });
    t.after(h.api.clearEncryptedAttachmentCache);
    h.render();
    h.gates[1].resolve(h.result(1));
    await setImmediate();
    const placeholder = h.render().attachments[0].url;
    const first = h.api.downloadEncryptedAttachmentUrl(placeholder);
    await setImmediate();
    assert.equal(h.metrics.downloads, 0, "the clicked preview is already downloading, so do not start another native transfer");
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    assert.equal(h.metrics.downloads, 1);
    const second = h.api.downloadEncryptedAttachmentUrl(h.render().attachments[0].url);
    await setImmediate();
    assert.equal(h.metrics.downloads, 1, "replacement URLs share the pending save");
    save.resolve({ status: "saved", filename: "image-0.png" });
    assert.deepEqual(await first, await second);
});

test("pending preview downloads do not occupy the save queue or survive cache clear", async t => {
    const h = independentPreviews({ count: 3 });
    t.after(() => {
        h.api.clearEncryptedAttachmentCache();
        h.gates.forEach((gate, index) => gate.resolve(h.result(index)));
    });
    h.render();
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    const [ready, ...loading] = h.render().attachments;
    const pending = loading.map(attachment => h.api.downloadEncryptedAttachmentUrl(attachment.url));
    await setImmediate();
    assert.equal(h.metrics.downloads, 0);
    const saved = h.api.downloadEncryptedAttachmentUrl(ready.url);
    await setImmediate();
    assert.equal(h.metrics.downloads, 1, "an unrelated cached download starts while both previews are pending");
    assert.equal((await saved)?.status, "saved");
    h.api.clearEncryptedAttachmentCache();
    h.gates[1].resolve(h.result(1));
    h.gates[2].resolve(h.result(2));
    assert.deepEqual(await Promise.all(pending), [null, null]);
    assert.equal(h.metrics.downloads, 1, "clearing the cache cancels queued saves before they enter native");
});

test("trust loss hides already rendered previews immediately and blocks a later sibling", async t => {
    const h = independentPreviews({ count: 3 });
    t.after(h.api.clearEncryptedAttachmentCache);
    let rendered: Message;
    const owner = { forceUpdate: () => { rendered = h.api.patchEncryptedMessageAttachments(h.message, owner); } };
    owner.forceUpdate();
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    assert.equal(rendered!.attachments[0].content_type, "image/png");
    h.gates[1].resolve({ status: "untrusted_author" });
    await setImmediate();
    assert.equal(rendered!.attachments.length, 0, "the renderer is refreshed before the third transfer finishes");
    assert.equal(h.blobs.size, 0);
    h.gates[2].resolve(h.result(2));
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "failed");
    assert.equal(h.blobs.size, 0, "late authenticated bytes cannot undo trust invalidation");
});

test("a blob allocation failure waits for outstanding siblings before allowing retry", async t => {
    let fail = true;
    const h = independentPreviews({ createObjectUrl: blob => {
        if (blob.size > 0 && fail) { fail = false; throw new Error("allocation failed"); }
    } });
    t.after(h.api.clearEncryptedAttachmentCache);
    h.render();
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "loading");
    assert.equal(h.api.retryEncryptedAttachmentLoad(h.message), false);
    h.gates[1].resolve(h.result(1));
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "failed");
    assert.equal(h.render().attachments[1].content_type, "image/png");
});

test("detached text does not hold a manifest image preview behind message expansion", async t => {
    const h = independentPreviews({ detached: true });
    t.after(h.api.clearEncryptedAttachmentCache);
    h.render();
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    assert.equal(h.metrics.loads, 1);
    assert.equal(h.render().attachments.length, 1);
    assert.equal(h.render().attachments[0].content_type, "image/png");
});

test("clearing partially loaded previews suppresses late plaintext and restores cache capacity", async () => {
    const h = independentPreviews();
    h.render();
    h.gates[0].resolve(h.result(0));
    await setImmediate();
    h.api.clearEncryptedAttachmentCache();
    h.gates[1].resolve(h.result(1));
    await setImmediate();
    assert.equal(h.blobs.size, 0);
    h.render();
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "ready");
    assert.equal(h.blobs.size, 2);
    h.api.clearEncryptedAttachmentCache();
});

test("legacy media and small inert text appear only after whole-bundle authentication while downloads remain available", async t => {
    const gate = Promise.withResolvers<DecryptIncomingAttachmentsResult>();
    const h = fixture({ legacy: true, load: async selection => selection === "previews"
        ? { status: "decrypted", plaintext: "", attachments: [], deferredAttachments: h.message.attachments.map(file => ({ id: file.id, name: null, size: file.size })) }
        : gate.promise });
    t.after(h.api.clearEncryptedAttachmentCache);
    h.message.attachments[0].size = 100;
    h.api.encryptedAttachmentStatus(h.message);
    await setImmediate();
    const before = h.api.patchEncryptedMessageAttachments(h.message, { forceUpdate() {} }).attachments;
    assert.equal(before.length, 2);
    assert.ok([...h.blobs.values()].every(blob => blob.size === 0));
    assert.equal(h.api.isEncryptedAttachmentDownloadUrl(before[0].url), true);
    assert.deepEqual(h.metrics.selections, ["previews", "all"]);
    const metadata = { size: 4, spoiler: false, description: null, duration: null, height: null, width: null, waveform: null };
    gate.resolve({ status: "decrypted", plaintext: "", attachments: [
        { id: before[0].id, data: new Uint8Array([1, 2, 3, 4]), metadata: { ...metadata, name: "photo.png", mimeType: "image/png" } },
        { id: before[1].id, data: new TextEncoder().encode("<script>inert</script>"), metadata: { ...metadata, name: "notes.txt", mimeType: "text/html" } }
    ] });
    await setImmediate();
    const after = h.api.patchEncryptedMessageAttachments(h.message, { forceUpdate() {} }).attachments;
    assert.equal(after[0].content_type, "image/png");
    assert.equal(after[1].content_type, "text/plain");
    assert.equal(h.blobs.size, 2);
    assert.equal((await h.api.downloadEncryptedAttachmentUrl(after[0].url))?.status, "saved");
});

test("warm previews and downloads bypass a pending expired-URL refresh", async t => {
    const refresh = Promise.withResolvers<object>();
    const h = fixture({ expiredUrls: true, refresh: () => refresh.promise });
    t.after(h.api.clearEncryptedAttachmentCache);
    const unrelated = h.api.encryptedAttachmentInput(h.message);
    h.api.encryptedAttachmentStatus(h.message);
    await setImmediate();
    assert.equal(h.api.encryptedAttachmentStatus(h.message).status, "ready");
    const file = h.api.patchEncryptedMessageAttachments(h.message, { forceUpdate() {} }).attachments[0];
    assert.equal((await h.api.downloadEncryptedAttachmentUrl(file.url))?.status, "saved");
    assert.equal(h.metrics.refreshes, 1, "the cache hits make no additional refresh request");
    refresh.resolve({});
    await unrelated;
});

for (const failure of [{ status: "invalid_message" }, { status: "failed", error: "attachment_download_failed" }] as const) {
    test(`${failure.status} never repeats native work with unchanged or unvalidated refreshed URLs`, async t => {
        const h = fixture({ expiredUrls: true, load: async () => failure, refresh: async urls => ({
            body: { refreshed_urls: urls.map(original => ({ original, refreshed: "https://untrusted.example/file" })) }
        }) });
        t.after(h.api.clearEncryptedAttachmentCache);
        h.api.encryptedAttachmentStatus(h.message);
        await setImmediate();
        assert.equal(h.metrics.loads, 1);
        assert.equal(h.metrics.refreshes, failure.status === "invalid_message" ? 0 : 1);
        assert.equal(h.blobs.size, 0);
    });
}
