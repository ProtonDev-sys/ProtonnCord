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
    decryptAttachmentBytes,
    DETACHED_TEXT_FILENAME,
    DETACHED_TEXT_MIME_TYPE,
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
