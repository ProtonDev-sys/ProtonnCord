/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { test } from "node:test";

import type { CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";

import {
    attachmentBundleRootFromDigests,
    attachmentCiphertextDigest,
    type AttachmentMetadata,
    decryptAttachmentBytes,
    DETACHED_TEXT_FILENAME,
    DETACHED_TEXT_MIME_TYPE,
    encryptAttachmentBytes,
    generateAttachmentBundleMaterial,
    parseSecurePlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/attachments";
import {
    EncryptedAttachmentUploadLimitError,
    prepareEncryptedAttachments,
    type PreparedEncryptedAttachments,
} from "../src/equicordplugins/secureMessaging.desktop/attachmentUploads";
import { decodeBase64Url } from "../src/equicordplugins/secureMessaging.desktop/protocol";

const channelId = "200000000000000001";
const senderUserId = "100000000000000001";
const privateDescription = "Private attachment description α";

function upload(description: string | null = privateDescription, spoiler = true) {
    const file = new File(["private file bytes"], "private-note.txt", { type: "text/plain" });
    return Object.assign(new EventEmitter(), {
        channelId,
        classification: "unknown",
        clip: null,
        contentHash: null,
        currentSize: file.size,
        description,
        durationSecs: undefined,
        etag: undefined,
        error: null,
        filename: file.name,
        id: "0",
        isImage: false,
        status: "NOT_STARTED" as const,
        isThumbnail: false,
        isVideo: false,
        uploadedFilename: "",
        responseUrl: "",
        item: { file, origin: "test", platform: CloudUploadPlatform.WEB },
        loaded: 0,
        mimeType: file.type,
        origin: "test",
        postCompressionSize: undefined,
        preCompressionSize: file.size,
        sensitive: false,
        spoiler,
        startTime: 0,
        uniqueId: "test",
        waveform: undefined,
        async upload() { },
        cancel() { },
        async delete() { },
        getSize() { return this.currentSize; },
        async maybeConvertToWebP() { },
        removeFromMsgDraft() { },
        setFilename(value: string) { this.filename = value; },
    }) satisfies CloudUpload;
}

async function openAttachment(prepared: PreparedEncryptedAttachments, file: File, index = 0) {
    const { attachments } = parseSecurePlaintext(prepared.plaintext);
    assert.ok(attachments);
    return decryptAttachmentBytes({
        bundleId: attachments.id,
        channelId,
        ciphertext: new Uint8Array(await file.arrayBuffer()),
        count: attachments.count,
        index,
        masterKey: decodeBase64Url(attachments.key, 32),
        senderUserId,
    });
}

function assertOpaque(value: ReturnType<typeof upload>): void {
    assert.equal(value.description, null, "Discord's upload object must not retain the private description");
    assert.equal(value.spoiler, false, "spoiler state belongs inside the authenticated private metadata");
    assert.equal(value.mimeType, "application/octet-stream");
    assert.equal(value.filename, value.item.file.name);
    assert.notEqual(value.filename, "private-note.txt");
}

test("applying encrypted uploads removes public metadata while preserving authenticated values", async () => {
    const value = upload();
    const originalFile = value.item.file;
    const prepared = await prepareEncryptedAttachments([value], "caption", channelId, senderUserId);
    assert.equal(value.item.file, originalFile);
    assert.equal(value.description, privateDescription);
    assert.equal(value.spoiler, true);
    prepared.apply();
    assertOpaque(value);
    const opened = await openAttachment(prepared, value.item.file);
    const descriptor = parseSecurePlaintext(prepared.plaintext).attachments;
    assert.ok(descriptor?.manifest);
    assert.deepEqual(descriptor.manifest, [{
        digest: await attachmentCiphertextDigest(new Uint8Array(await value.item.file.arrayBuffer())),
        name: originalFile.name,
        preview: false,
        spoiler: true,
        size: originalFile.size,
    }]);
    assert.equal(await attachmentBundleRootFromDigests(descriptor.id, descriptor.manifest.map(entry => entry.digest)), descriptor.root);
    assert.equal(opened.metadata.description, privateDescription);
    assert.equal(opened.metadata.spoiler, true);
    assert.equal(opened.metadata.name, originalFile.name);
    assert.equal(new TextDecoder().decode(opened.data), await originalFile.text());
});

test("retrying an already prepared upload preserves its original private metadata and bytes", async () => {
    const value = upload();
    const originalText = await value.item.file.text();
    for (let attempt = 0; attempt < 3; attempt++) {
        const prepared = await prepareEncryptedAttachments([value], "caption", channelId, senderUserId);
        prepared.apply();
        assertOpaque(value);
        const opened = await openAttachment(prepared, value.item.file);
        assert.equal(opened.metadata.description, privateDescription);
        assert.equal(opened.metadata.spoiler, true);
        assert.equal(new TextDecoder().decode(opened.data), originalText);
    }
});

test("failed size preflight does not remove metadata from the pending draft", async () => {
    const value = upload();
    const originalFile = value.item.file;
    await assert.rejects(
        prepareEncryptedAttachments([value], "", channelId, senderUserId, [], null, 21),
        EncryptedAttachmentUploadLimitError,
    );
    assert.equal(value.item.file, originalFile);
    assert.equal(value.description, privateDescription);
    assert.equal(value.spoiler, true);
});

test("replacing the source file uses the replacement's metadata instead of a previous retry snapshot", async () => {
    const value = upload();
    const first = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    first.apply();
    value.item.file = new File(["replacement bytes"], "replacement.txt", { type: "text/plain" });
    value.filename = value.item.file.name;
    value.description = "replacement description";
    value.spoiler = false;
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    assertOpaque(value);
    const opened = await openAttachment(prepared, value.item.file);
    assert.equal(opened.metadata.description, "replacement description");
    assert.equal(opened.metadata.spoiler, false);
    assert.equal(opened.metadata.name, "replacement.txt");
    assert.equal(new TextDecoder().decode(opened.data), "replacement bytes");
});

test("null descriptions and non-spoiler files retain their original meaning", async () => {
    const value = upload(null, false);
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    assertOpaque(value);
    const opened = await openAttachment(prepared, value.item.file);
    assert.equal(opened.metadata.description, null);
    assert.equal(opened.metadata.spoiler, false);
});

test("each attachment keeps its own metadata across multi-file retries", async () => {
    const values = [upload("first description", true), upload("second description", false)];
    for (let attempt = 0; attempt < 2; attempt++) {
        const prepared = await prepareEncryptedAttachments(values, "", channelId, senderUserId);
        prepared.apply();
        for (const [index, value] of values.entries()) {
            assertOpaque(value);
            const opened = await openAttachment(prepared, value.item.file, index);
            assert.equal(opened.metadata.description, index === 0 ? "first description" : "second description");
            assert.equal(opened.metadata.spoiler, index === 0);
        }
    }
});

test("detached text uses its reserved private metadata and does not expose draft descriptions", async () => {
    const value = upload();
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId, [], 0);
    prepared.apply();
    assertOpaque(value);
    const opened = await openAttachment(prepared, value.item.file);
    assert.equal(opened.metadata.description, null);
    assert.equal(opened.metadata.spoiler, false);
    assert.equal(opened.metadata.name, DETACHED_TEXT_FILENAME);
    assert.equal(opened.metadata.mimeType, DETACHED_TEXT_MIME_TYPE);
});

test("applying a prepared result twice keeps the same opaque file and private metadata", async () => {
    const value = upload();
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    const encryptedFile = value.item.file;
    prepared.apply();
    assertOpaque(value);
    assert.equal(value.item.file, encryptedFile);
    const opened = await openAttachment(prepared, encryptedFile);
    assert.equal(opened.metadata.description, privateDescription);
    assert.equal(opened.metadata.spoiler, true);
});

test("optional waveforms on non-audio files do not prevent sending", async () => {
    const value: CloudUpload = upload();
    value.waveform = "AQID";
    value.durationSecs = 2;
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    const opened = await openAttachment(prepared, value.item.file);
    assert.equal(opened.metadata.waveform, null);
    assert.equal(opened.metadata.duration, null);
    assert.equal(new TextDecoder().decode(opened.data), "private file bytes");
});

test("audio with unreadable duration omits the waveform and cleans up metadata probing", async t => {
    class Media extends EventTarget {
        duration = Number.NaN;
        src = "";
        preload = "";
        load() { if (this.src) this.dispatchEvent(new Event("error")); }
        removeAttribute() { this.src = ""; }
    }
    const media = new Media();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => media } });
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else Reflect.deleteProperty(globalThis, "document");
    });
    const revoke = t.mock.method(URL, "revokeObjectURL");
    const value: CloudUpload = upload();
    value.item.file = new File(["audio bytes"], "voice.ogg", { type: "audio/ogg" });
    value.waveform = "AQID";
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    const opened = await openAttachment(prepared, value.item.file);
    assert.equal(opened.metadata.waveform, null);
    assert.equal(opened.metadata.duration, null);
    assert.equal(new TextDecoder().decode(opened.data), "audio bytes");
    assert.equal(media.preload, "metadata");
    assert.equal(media.src, "");
    assert.equal(revoke.mock.callCount(), 1);
});

test("fallback audio MIME types use known duration without decoding the file", async () => {
    const value: CloudUpload = upload();
    value.item.file = new File(["audio bytes"], "voice.ogg");
    value.mimeType = " Audio/Ogg; codecs=opus ";
    value.durationSecs = 3;
    value.waveform = "AQID";
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    const { metadata } = await openAttachment(prepared, value.item.file);
    assert.equal(metadata.duration, 3);
    assert.equal(metadata.waveform, "AQID");
    assert.equal(metadata.mimeType, "Audio/Ogg; codecs=opus");
});

test("stale video duration does not override probed metadata", async t => {
    class Media extends EventTarget {
        currentTime = 0;
        duration = 7;
        muted = false;
        playsInline = false;
        preload = "";
        src = "";
        videoHeight = 360;
        videoWidth = 640;
        load() { if (this.src) this.dispatchEvent(new Event("loadedmetadata")); }
        removeAttribute() { this.src = ""; }
    }
    const media = new Media();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => media } });
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else Reflect.deleteProperty(globalThis, "document");
    });
    const value: CloudUpload = upload();
    value.item.file = new File(["video bytes"], "clip.webm", { type: "video/webm" });
    value.durationSecs = 3;
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    const { metadata } = await openAttachment(prepared, value.item.file);
    assert.equal(metadata.duration, 7);
    assert.equal(metadata.width, 640);
    assert.equal(metadata.height, 360);
});

test("fallback image MIME types retain encoded dimensions", async () => {
    const value = upload();
    const pngHeader = new Uint8Array(24);
    pngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(pngHeader.buffer);
    view.setUint32(16, 320);
    view.setUint32(20, 180);
    value.item.file = new File([pngHeader], "image.png");
    value.mimeType = "image/png";
    const prepared = await prepareEncryptedAttachments([value], "", channelId, senderUserId);
    prepared.apply();
    const { metadata } = await openAttachment(prepared, value.item.file);
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 180);
});

for (const change of ["replacement", "upload started"] as const) {
    test(`a late change (${change}) aborts apply before changing any draft`, async () => {
        const values = [upload(), upload()];
        const originals = values.map(value => value.item.file);
        const prepared = await prepareEncryptedAttachments(values, "", channelId, senderUserId);
        if (change === "replacement") values[1].item.file = new File(["new bytes"], "replacement.txt");
        else values[1].uploadedFilename = "already-uploaded.pcaf";
        const secondFile = values[1].item.file;
        assert.throws(prepared.apply);
        assert.equal(values[0].item.file, originals[0]);
        assert.equal(values[1].item.file, secondFile);
        assert.ok(values.every(value => value.description === privateDescription && value.spoiler));
    });
}

test("mutating the caller's upload array cannot replace an in-flight bundle member", async () => {
    const original = upload();
    const replacement = upload("replacement");
    const values = [original];
    const pending = prepareEncryptedAttachments(values, "", channelId, senderUserId);
    values[0] = replacement;
    const prepared = await pending;
    prepared.apply();
    assertOpaque(original);
    assert.equal(replacement.description, "replacement");
    const { metadata } = await openAttachment(prepared, original.item.file);
    assert.equal(metadata.description, privateDescription);
});

function encryptionInput(data: Uint8Array | Blob) {
    const { descriptor, keyBytes } = generateAttachmentBundleMaterial(1);
    const metadata: AttachmentMetadata = {
        name: "private-α.bin", mimeType: "application/octet-stream", size: data instanceof Blob ? data.size : data.byteLength,
        description: privateDescription, spoiler: true, width: null, height: null, duration: null, waveform: null,
    };
    return { bundleId: descriptor.id, channelId, count: 1, data, index: 0, masterKey: keyBytes, metadata, senderUserId };
}

test("Blob framing is wire-identical to byte input and byte callers retain call-time snapshots", async () => {
    const bytes = new TextEncoder().encode("authenticated attachment contents");
    const original = bytes.slice();
    const input = encryptionInput(bytes);
    const pending = encryptAttachmentBytes(input);
    bytes.fill(0);
    const byteCiphertext = await pending;
    const blobCiphertext = await encryptAttachmentBytes({ ...input, data: new Blob([original]) });
    assert.deepEqual(blobCiphertext, byteCiphertext, "the same bundle metadata and plaintext produce identical AES-GCM framing");
    const opened = await decryptAttachmentBytes({ ...input, ciphertext: blobCiphertext });
    assert.deepEqual(opened.data, original);
    assert.deepEqual(opened.metadata, input.metadata);
    blobCiphertext[blobCiphertext.length - 1] ^= 1;
    await assert.rejects(decryptAttachmentBytes({ ...input, ciphertext: blobCiphertext }), /authentication failed/u);
});

test("Blob size and binding failures are rejected before reading a plaintext buffer", async t => {
    const input = encryptionInput(new Blob(["private bytes"]));
    const read = t.mock.method(Blob.prototype, "arrayBuffer", () => { throw new Error("must not read invalid input"); });
    await assert.rejects(encryptAttachmentBytes({ ...input, metadata: { ...input.metadata, size: input.metadata.size + 1 } }), /byte length/u);
    await assert.rejects(encryptAttachmentBytes({ ...input, channelId: "invalid" }), /channel or sender/u);
    await assert.rejects(encryptAttachmentBytes({ ...input, masterKey: new Uint8Array(31) }), /bundle key/u);
    assert.equal(read.mock.callCount(), 0);
});

for (const fail of [false, true]) test(`framed plaintext is wiped after ${fail ? "failed" : "successful"} encryption`, async t => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const framed: Uint8Array[] = [];
    t.mock.method(crypto.subtle, "encrypt", async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
        framed.push(new Uint8Array(args[2] as ArrayBuffer));
        if (fail) throw new Error("injected encryption failure");
        return encrypt(...args);
    });
    for (const data of [new Uint8Array([1, 2, 3]), new Blob([new Uint8Array([1, 2, 3])])]) {
        const pending = encryptAttachmentBytes(encryptionInput(data));
        if (fail) await assert.rejects(pending, /injected encryption failure/u);
        else await pending;
    }
    assert.equal(framed.length, 2);
    assert.ok(framed.every(bytes => bytes.length > 3 && bytes.every(byte => byte === 0)));
});

test("mutable-byte framing is wiped when key derivation fails before encryption", async t => {
    const fill = Uint8Array.prototype.fill;
    const wiped: number[] = [];
    t.mock.method(Uint8Array.prototype, "fill", function (this: Uint8Array, ...args: Parameters<Uint8Array["fill"]>) {
        const result = fill.apply(this, args);
        if (args[0] === 0 && this.length > 32) wiped.push(this.length);
        return result;
    });
    await assert.rejects(encryptAttachmentBytes({ ...encryptionInput(new Uint8Array([1, 2, 3])), masterKey: new Uint8Array(31) }), /bundle key/u);
    assert.equal(wiped.length, 1, "the pre-await byte snapshot must be cleared even if no AES operation starts");
});
