/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";

import {
    attachmentBundleRoot,
    attachmentBundleRootFromDigests,
    attachmentCiphertextDigest,
    type AttachmentBundleDescriptor,
    type AttachmentMetadata,
    createAttachmentManifest,
    isPreviewableAttachmentMimeType,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_MANIFEST_BYTES,
    parseSecurePlaintext,
    serializeSecurePlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/attachments";
import { decryptMessage, encryptMessage, generateIdentity, publicIdentity } from "../src/equicordplugins/secureMessaging.desktop/crypto";
import { decodeBase64Url, encodeBase64Url } from "../src/equicordplugins/secureMessaging.desktop/protocol";

const bundleId = encodeBase64Url(new Uint8Array(16));
const key = encodeBase64Url(new Uint8Array(32));
const ciphertexts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
const metadata: AttachmentMetadata = {
    description: null, duration: null, height: null, mimeType: "application/octet-stream",
    name: "private.bin", size: 1, spoiler: false, waveform: null, width: null,
};

async function bundle(): Promise<AttachmentBundleDescriptor> {
    const manifest = await createAttachmentManifest(ciphertexts, [metadata, { ...metadata, name: "image.png", mimeType: "image/png" }]);
    return { count: 2, id: bundleId, key, manifest, root: await attachmentBundleRootFromDigests(bundleId, manifest.map(entry => entry.digest)) };
}

test("per-file digests retain the original ordered bundle-root definition", async () => {
    const digests = await Promise.all(ciphertexts.map(attachmentCiphertextDigest));
    const count = Buffer.alloc(4);
    count.writeUInt32BE(ciphertexts.length);
    const expected = createHash("sha256").update(Buffer.concat([
        Buffer.from("ProtonnCord/SecureMessaging/v1/attachment-root\0"),
        Buffer.from(decodeBase64Url(bundleId, 16)),
        count,
        ...ciphertexts.map(bytes => createHash("sha256").update(bytes).digest()),
    ])).digest("base64url");
    assert.equal(await attachmentBundleRoot(bundleId, ciphertexts), expected);
    assert.equal(await attachmentBundleRootFromDigests(bundleId, digests), expected);
    assert.notEqual(await attachmentBundleRootFromDigests(bundleId, [...digests].reverse()), expected);
    assert.notEqual(await attachmentBundleRootFromDigests(bundleId, [digests[0], key]), expected);
    await assert.rejects(attachmentBundleRootFromDigests(bundleId, ["invalid"]));
    await assert.rejects(attachmentBundleRootFromDigests(bundleId, []));
});

test("manifest payloads round-trip attachments, stickers, and detached text while retaining legacy support", async () => {
    const descriptor = await bundle();
    const sticker = { id: "300000000000000001", name: "wave", formatType: 1 };
    for (const [text, stickers, detachedTextIndex, prefix] of [
        ["files", [], null, "PCEA3:"],
        ["files", [sticker], null, "PCER3:"],
        ["", [], 0, "PCET2:"],
        ["", [sticker], 0, "PCET2:"],
    ] as const) {
        const serialized = serializeSecurePlaintext(text, descriptor, [...stickers], detachedTextIndex);
        assert.ok(serialized.startsWith(prefix));
        assert.deepEqual(parseSecurePlaintext(serialized), { text, attachments: descriptor, stickers: [...stickers], detachedTextIndex });
        assert.throws(() => parseSecurePlaintext(serialized.replace(prefix, prefix.replace(/3:/, "2:").replace("PCET2:", "PCET1:"))));
    }
    const { manifest: _manifest, ...legacy } = descriptor;
    for (const prefix of ["PCEA3:", "PCER3:", "PCET2:"]) {
        const literal = `${prefix}literal text`;
        assert.equal(parseSecurePlaintext(serializeSecurePlaintext(literal)).text, literal);
    }
    assert.ok(serializeSecurePlaintext("files", legacy).startsWith("PCEA2:"));
    assert.deepEqual(parseSecurePlaintext(serializeSecurePlaintext("files", legacy)).attachments, legacy);
});

test("manifest parsing rejects altered shapes, invalid metadata, excess bytes, and noncanonical JSON", async () => {
    const serialized = serializeSecurePlaintext("", await bundle());
    const invalid = (change: (payload: unknown[]) => void) => {
        const payload = JSON.parse(serialized.slice(6)) as unknown[];
        change(payload);
        assert.throws(() => parseSecurePlaintext(`PCEA3:${JSON.stringify(payload)}`));
    };
    const editEntry = (change: (entry: unknown[]) => void) => invalid(payload => change((payload[1] as unknown[][])[4][0] as unknown[]));
    editEntry(entry => { entry[0] = "invalid"; });
    editEntry(entry => { entry[1] = true; });
    editEntry(entry => { entry[1] = 4; });
    editEntry(entry => { entry[1] = -1; });
    editEntry(entry => { entry[1] = 1.5; });
    editEntry(entry => { entry[2] = 0; });
    editEntry(entry => { entry[2] = MAX_ATTACHMENT_BYTES + 1; });
    editEntry(entry => { entry[3] = "../unsafe"; });
    editEntry(entry => { entry[3] = null; });
    editEntry(entry => { entry.push("extra"); });
    invalid(payload => { (payload[1] as unknown[])[4] = []; });
    invalid(payload => { payload[1] = null; });
    invalid(payload => { (payload[1] as unknown[][])[4].forEach(entry => { (entry as unknown[])[3] = "😀".repeat(127); }); });
    assert.throws(() => parseSecurePlaintext(serialized.replace("[[", "[ [")));
});

test("manifest flags preserve all preview and spoiler combinations without increasing the wire size", async () => {
    const manifest = await createAttachmentManifest(
        Array.from({ length: 4 }, () => ciphertexts[0]),
        Array.from({ length: 4 }, (_, flags) => ({
            ...metadata, mimeType: (flags & 1) !== 0 ? "image/png" : metadata.mimeType, spoiler: (flags & 2) !== 0,
        })),
    );
    const descriptor = { count: 4, id: bundleId, key, root: key, manifest };
    const serialized = serializeSecurePlaintext("", descriptor);
    assert.deepEqual(JSON.parse(serialized.slice(6))[1][4].map((entry: unknown[]) => entry[1]), [0, 1, 2, 3]);
    assert.deepEqual(parseSecurePlaintext(serialized).attachments, descriptor);
});

test("long Unicode names are omitted deterministically within the manifest byte budget", async () => {
    const files = Array.from({ length: 10 }, () => new Uint8Array([1]));
    const details = files.map((_, index) => ({ ...metadata, name: `${index}-${"😀".repeat(120)}.bin`, spoiler: index % 2 === 0 }));
    const manifest = await createAttachmentManifest(files, details);
    assert.deepEqual(await createAttachmentManifest(files, details), manifest);
    assert.ok(manifest.some(entry => entry.name === null));
    assert.deepEqual(manifest.map(entry => entry.size), details.map(entry => entry.size));
    assert.deepEqual(manifest.map(entry => entry.spoiler), details.map(entry => entry.spoiler));
    assert.ok(manifest.every(entry => entry.preview === false));
    const descriptor = { count: 10, id: bundleId, key, root: key, manifest };
    const serialized = serializeSecurePlaintext("", descriptor);
    const compact = JSON.parse(serialized.slice(6))[1][4];
    assert.ok(Buffer.byteLength(JSON.stringify(compact), "utf8") <= MAX_ATTACHMENT_MANIFEST_BYTES);
    assert.deepEqual(parseSecurePlaintext(serialized).attachments, descriptor);
});

test("preview classification shares the strict media allowlist and MIME normalization", () => {
    for (const value of ["IMAGE/PNG; charset=binary", " audio/ogg ", "video/webm", "image/webp"])
        assert.equal(isPreviewableAttachmentMimeType(value), true);
    for (const value of [null, "", "text/plain", "application/pdf", "image/svg+xml", "video/unknown", "application/octet-stream"])
        assert.equal(isPreviewableAttachmentMimeType(value), false);
});

test("manifest envelopes respect Discord's actual cap for one, two, and nine selected recipients", async () => {
    const now = 1_800_000_000_000;
    const identity = await generateIdentity(now);
    const peers = await Promise.all(Array.from({ length: 9 }, async (_, index) =>
        publicIdentity(await generateIdentity(now), String(100000000000000002n + BigInt(index)))));
    const descriptor = await bundle();
    const plaintext = serializeSecurePlaintext("", descriptor);
    const lengths: Record<number, number | "too long"> = {};
    for (const count of [1, 2, 9]) {
        try {
            const content = await encryptMessage({
                channelId: "200000000000000001", identity, plaintext, recipients: peers.slice(0, count),
                senderUserId: "100000000000000001", now, counter: 1,
            });
            assert.ok(content.length <= 2_000);
            lengths[count] = content.length;
        } catch (error) {
            assert.match(error instanceof Error ? error.message : String(error), /2,000 character limit/);
            lengths[count] = "too long";
        }
    }
    assert.deepEqual(lengths, { 1: 854, 2: 990, 9: 1_942 });
    console.log("Attachment manifest envelope lengths:", lengths);
    const tenManifest = await createAttachmentManifest(
        Array.from({ length: 10 }, () => ciphertexts[0]),
        Array.from({ length: 10 }, () => metadata),
    );
    const tenFileDescriptor = {
        ...descriptor, count: 10, manifest: tenManifest,
        root: await attachmentBundleRootFromDigests(bundleId, tenManifest.map(entry => entry.digest)),
    };
    const tenFilePlaintext = serializeSecurePlaintext("", tenFileDescriptor);
    await assert.rejects(encryptMessage({
        channelId: "200000000000000001", identity, plaintext: tenFilePlaintext, recipients: peers,
        senderUserId: "100000000000000001", now, counter: 1,
    }), /2,000 character limit/);

    const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const encryptPlaintext = async");
    const fallback = source.indexOf('if (encrypted.status === "failed" && encrypted.error === "message_too_long" && preparedAttachments)', start);
    const end = source.indexOf("\n        if (!secureOperationIsCurrent", fallback);
    assert.ok(start > 0 && fallback > start && end > fallback);
    const { outputText } = transpileModule(`async function run() {
        ${source.slice(start, end)}
        return { encrypted, detachedTextIndex };
    }`, { compilerOptions: { target: ScriptTarget.ESNext } });
    for (const scenario of [
        { caption: "", descriptor: tenFileDescriptor, recipients: peers, detached: null, legacy: true },
        { caption: "x".repeat(60), descriptor, recipients: peers, detached: null, legacy: false },
        { caption: "x".repeat(1_800), descriptor, recipients: peers.slice(0, 1), detached: 2, legacy: false },
    ]) {
        const uploads = Array.from({ length: scenario.descriptor.count }, () => ({ size: 1 }));
        const attempted: string[] = [];
        const preparedPlaintext = serializeSecurePlaintext(scenario.caption, scenario.descriptor);
        if (scenario.caption.length > 1_000) assert.ok(preparedPlaintext.length > 2_000);
        const result = await runInNewContext(`${outputText}\nrun()`, {
            generation: 0, context: { localUserId: "100000000000000001", snapshot: {} }, conversation: {},
            channelId: "200000000000000001", MAX_DISCORD_MESSAGE_LENGTH: 2_000, MAX_ATTACHMENT_COUNT: 10,
            plaintext: scenario.caption, uploads, detachedTextIndex: null, generatedDetachedUpload: null,
            preparedAttachments: { plaintext: preparedPlaintext }, stickers: [], uploadLimitBytes: 100_000,
            secureOperationIsCurrent: () => true, encryptedMentionedUserIds: () => [],
            parseSecurePlaintext, serializeSecurePlaintext,
            Native: { encryptOutgoing: async (_userId: string, input: { plaintext: string; }) => {
                assert.ok(input.plaintext.length <= 2_000, "oversized prepared text must not hit native invalid_input validation");
                attempted.push(input.plaintext);
                try {
                    const content = await encryptMessage({
                        channelId: "200000000000000001", identity, plaintext: input.plaintext, recipients: scenario.recipients,
                        senderUserId: "100000000000000001", now, counter: 1,
                    });
                    return { status: "encrypted", content };
                } catch (error) {
                    assert.match(error instanceof Error ? error.message : String(error), /2,000 character limit/);
                    return { status: "failed", error: "message_too_long" };
                }
            } },
            appendDetachedTextUpload: (values: typeof uploads, text: string) => {
                assert.equal(text, scenario.caption);
                values.push({ size: Buffer.byteLength(text) });
                return values.length - 1;
            },
            prepareEncryptedAttachments: async (values: typeof uploads, text: string, _channel: string, _sender: string, _stickers: unknown[], detached: number) => {
                assert.equal(text, "");
                const manifest = await createAttachmentManifest(values.map(() => ciphertexts[0]), values.map(value => ({ ...metadata, size: value.size })));
                const bundle = { ...descriptor, count: values.length, manifest, root: await attachmentBundleRootFromDigests(bundleId, manifest.map(entry => entry.digest)) };
                return { plaintext: serializeSecurePlaintext(text, bundle, [], detached) };
            },
        }) as { encrypted: { status: string; content: string; }; detachedTextIndex: number | null; };
        assert.equal(result.encrypted.status, "encrypted");
        assert.equal(result.detachedTextIndex, scenario.detached);
        assert.ok(result.encrypted.content.length <= 2_000);
        const opened = await decryptMessage({
            channelId: "200000000000000001", content: result.encrypted.content, discordAuthorId: "100000000000000001",
            localUserId: "100000000000000001", identity, senderIdentity: await publicIdentity(identity, "100000000000000001"),
        });
        const decoded = parseSecurePlaintext(opened.plaintext);
        assert.equal(decoded.attachments?.count, uploads.length);
        assert.equal(decoded.detachedTextIndex, scenario.detached);
        assert.equal(decoded.attachments?.manifest === undefined, scenario.legacy);
        if (scenario.detached === null) assert.equal(decoded.text, scenario.caption);
        if (scenario.caption.length === 60) assert.ok(decoded.attachments?.manifest?.every(entry => entry.name === null));
        assert.equal(attempted.at(-1), opened.plaintext);
        console.log("Attachment envelope fallback:", { files: scenario.descriptor.count, recipients: scenario.recipients.length, content: result.encrypted.content.length, detached: scenario.detached, legacy: scenario.legacy });
    }
});
