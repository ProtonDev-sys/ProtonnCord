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
import type { DecryptIncomingAttachmentsResult, DecryptIncomingResult, DownloadIncomingAttachmentResult } from "../src/equicordplugins/secureMessaging.desktop/native";
import { createTaskQueue } from "../src/equicordplugins/secureMessaging.desktop/taskQueue";

type AttachmentCache = typeof import("../src/equicordplugins/secureMessaging.desktop/attachmentCache");
const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/attachmentCache.ts", import.meta.url), "utf8");
const userId = "100000000000000001";

function fixture(options: {
    legacy?: boolean;
    inspect?: () => Promise<DecryptIncomingResult>;
    load?: () => Promise<DecryptIncomingAttachmentsResult>;
    download?: () => Promise<DownloadIncomingAttachmentResult>;
} = {}) {
    let currentUserId = userId;
    const metrics = { inspections: 0, loads: 0, downloads: 0, refreshes: 0, selections: [] as string[] };
    const blobs = new Map<string, Blob>();
    let nextUrl = 0;
    class LocalURL extends URL {
        static createObjectURL(blob: Blob) {
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
            url: `https://cdn.discordapp.com/attachments/300000000000000001/40000000000000000${index + 1}/encrypted.pcaf`,
            proxy_url: `https://media.discordapp.net/attachments/300000000000000001/40000000000000000${index + 1}/encrypted.pcaf`
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
                        { digest: "A".repeat(43), preview: true, spoiler: false, size: 4, name: "image.png" }
                    ] })
                }
            };
        },
        async decryptIncomingAttachments(_userId: string, _input: unknown, selection: string): Promise<DecryptIncomingAttachmentsResult> {
            metrics.loads++;
            metrics.selections.push(selection);
            return options.load ? options.load() : {
                status: "decrypted", plaintext: "",
                attachments: options.legacy ? [] : [{
                    id: message.attachments[1].id, data: new Uint8Array([1, 2, 3, 4]),
                    metadata: { name: "image.png", mimeType: "image/png", size: 4, spoiler: false,
                        description: null, duration: null, height: 1, width: 1, waveform: null }
                }],
                deferredAttachments: message.attachments.slice(0, options.legacy ? 2 : 1).map(attachment => ({
                    id: attachment.id, name: options.legacy ? null : "archive.zip", size: attachment.size - 100,
                    ...(!options.legacy && { spoiler: true })
                }))
            };
        },
        async downloadIncomingAttachment(_userId: string, _input: unknown, attachmentId: string): Promise<DownloadIncomingAttachmentResult> {
            assert.equal(attachmentId, message.attachments[0].id);
            metrics.downloads++;
            return options.download ? options.download() : { status: "saved", filename: "archive.zip" };
        }
    };
    const mocks: Record<string, object> = {
        "@webpack/common": {
            Constants: {},
            RestAPI: { post() { metrics.refreshes++; throw new Error("No URL refresh expected"); } },
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
    runInNewContext(transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText, {
        exports, URL: LocalURL, Blob, setTimeout, clearTimeout,
        VencordNative: { pluginHelpers: { SecureMessaging: native } },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { api: exports, message, metrics, blobs, switchAccount: () => { currentUserId = "100000000000000003"; } };
}

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

test("clearing an entry while inspecting its manifest cannot start a stale attachment load", async () => {
    const gate = Promise.withResolvers<DecryptIncomingResult>();
    const { api, message, metrics, blobs } = fixture({ inspect: () => gate.promise });
    api.encryptedAttachmentStatus(message);
    assert.equal(metrics.inspections, 1);
    api.clearEncryptedAttachmentCache();
    gate.resolve({ status: "untrusted_author" });
    await setImmediate();
    assert.equal(metrics.loads, 0);
    assert.equal(blobs.size, 0);
});
