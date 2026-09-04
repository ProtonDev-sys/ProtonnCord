/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isBlock, isIfStatement, isVariableDeclaration, isVariableStatement, ModuleKind, type Node, ScriptTarget, transpileModule, type VariableDeclaration } from "typescript";

import { type AttachmentBundleDescriptor, parseSecurePlaintext, serializeSecurePlaintext } from "../src/equicordplugins/secureMessaging.desktop/attachments";
import { encryptMessage, generateIdentity, publicIdentity } from "../src/equicordplugins/secureMessaging.desktop/crypto";
import type { EncryptOutgoingResult } from "../src/equicordplugins/secureMessaging.desktop/native";
import { encodeBase64Url, MAX_DISCORD_MESSAGE_LENGTH } from "../src/equicordplugins/secureMessaging.desktop/protocol";

const source = readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8");
const parsed = createSourceFile("index.tsx", source, ScriptTarget.Latest, true);
let helper: VariableDeclaration | undefined;
function visit(node: Node): void {
    if (isVariableDeclaration(node) && node.name.getText(parsed) === "encryptPlaintext") helper = node;
    node.forEachChild(visit);
}
visit(parsed);
assert.ok(helper?.initializer, "The outgoing listener must define encryptPlaintext");
const helperStatement = helper.parent.parent;
assert.ok(isVariableStatement(helperStatement) && isBlock(helperStatement.parent));
const statements = helperStatement.parent.statements;
const start = statements.indexOf(helperStatement) + 1;
assert.ok(isVariableStatement(statements[start]) && isIfStatement(statements[start + 1]) && isIfStatement(statements[start + 2]));
const fallbackSource = statements.slice(start, start + 3).map(statement => statement.getText(parsed)).join("\n");
const runtime = transpileModule(`
const encryptPlaintext = ${helper.initializer.getText(parsed)};
({ encrypt: encryptPlaintext, runFlow: async () => { ${fallbackSource}\nreturn encrypted; } });`, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;

const localUserId = "100000000000000001";
const channelId = "200000000000000001";
const success: EncryptOutgoingResult = { status: "encrypted", content: "encrypted fixture", counter: 1 };
const tooLong: EncryptOutgoingResult = { status: "failed", error: "message_too_long" };

function descriptor(count = 1): AttachmentBundleDescriptor {
    const key = encodeBase64Url(new Uint8Array(32));
    return {
        count, id: encodeBase64Url(new Uint8Array(16)), key, root: key,
        manifest: Array.from({ length: count }, (_, index) => ({
            digest: key, preview: false, spoiler: true, size: 16, name: `private-${index}.zip`
        }))
    };
}

function fixture(options: {
    bundle?: AttachmentBundleDescriptor;
    text?: string;
    native?: (value: string) => Promise<EncryptOutgoingResult>;
} = {}) {
    let currentGeneration = 1;
    let currentUserId = localUserId;
    const bundle = options.bundle ?? descriptor();
    const text = options.text ?? "original message";
    const calls: string[] = [];
    const events: string[] = [];
    const context = { localUserId, snapshot: { channelId } };
    const api = runInNewContext(runtime, {
        MAX_DISCORD_MESSAGE_LENGTH, MAX_ATTACHMENT_COUNT: 10,
        generation: 1, context, conversation: {}, plaintext: text, channelId,
        uploads: Array.from({ length: bundle.count }, () => ({})), stickers: [], uploadLimitBytes: 500 * 1024 * 1024,
        detachedTextIndex: null, generatedDetachedUpload: null,
        preparedAttachments: { plaintext: serializeSecurePlaintext(text, bundle) },
        parseSecurePlaintext, serializeSecurePlaintext,
        secureOperationIsCurrent: (generation: number, userId: string) => generation === currentGeneration && userId === currentUserId,
        encryptedMentionedUserIds: (original: string) => { assert.equal(original, text); return [localUserId]; },
        Native: {
            async encryptOutgoing(userId: string, input: { plaintext: string; snapshot: object; mentionedUserIds: string[]; }) {
                assert.equal(userId, localUserId);
                assert.equal(input.snapshot, context.snapshot);
                assert.deepEqual(Array.from(input.mentionedUserIds), [localUserId]);
                calls.push(input.plaintext);
                const manifest = parseSecurePlaintext(input.plaintext).attachments?.manifest;
                events.push(manifest ? manifest.some(file => file.name !== null) ? "named" : "anonymous" : "legacy");
                return options.native ? options.native(input.plaintext) : success;
            }
        },
        appendDetachedTextUpload(uploads: object[]) {
            events.push("detach");
            uploads.push({});
            return uploads.length - 1;
        },
        async prepareEncryptedAttachments(uploads: object[], _text: string, _channelId: string, _userId: string, _stickers: unknown[], detachedTextIndex: number) {
            events.push("prepare");
            const expanded = {
                ...bundle, count: uploads.length,
                manifest: bundle.manifest && [...bundle.manifest, { digest: bundle.key, preview: false, spoiler: false, size: 16, name: "message.txt" }]
            };
            return { plaintext: serializeSecurePlaintext("", expanded, [], detachedTextIndex) };
        }
    }) as { encrypt(value: string): Promise<EncryptOutgoingResult>; runFlow(): Promise<EncryptOutgoingResult>; };
    return {
        ...api, calls, events,
        invalidate(kind: "generation" | "account") {
            if (kind === "generation") currentGeneration++;
            else currentUserId = "100000000000000009";
        }
    };
}

test("optional names are dropped before detaching text or preparing uploads again", async () => {
    const harness = fixture({ native: async value => parseSecurePlaintext(value).attachments?.manifest?.some(file => file.name !== null) ? tooLong : success });
    assert.equal((await harness.runFlow()).status, "encrypted");
    assert.deepEqual(harness.events, ["named", "anonymous"]);
    const [original, shortened] = harness.calls.map(parseSecurePlaintext);
    assert.equal(shortened.text, original.text);
    assert.deepEqual(shortened.attachments?.manifest, original.attachments?.manifest?.map(file => ({ ...file, name: null })));
    assert.equal(shortened.attachments?.root, original.attachments?.root);
});

test("plain messages and manifests with no remaining names are not retried", async () => {
    const bundle = descriptor();
    bundle.manifest = bundle.manifest?.map(file => ({ ...file, name: null }));
    for (const value of ["plain message", serializeSecurePlaintext("", { ...bundle, manifest: undefined }), serializeSecurePlaintext("", bundle)]) {
        const harness = fixture({ native: async () => tooLong });
        assert.equal(await harness.encrypt(value), tooLong);
        assert.equal(harness.calls.length, 1);
    }
});

test("oversized plain text is rejected locally and oversized named payloads can still be shortened", async () => {
    const harness = fixture();
    assert.deepEqual({ ...await harness.encrypt("x".repeat(MAX_DISCORD_MESSAGE_LENGTH + 1)) }, tooLong);
    assert.equal(harness.calls.length, 0);
    const bundle = descriptor();
    const anonymous = { ...bundle, manifest: bundle.manifest?.map(file => ({ ...file, name: null })) };
    const text = "x".repeat(MAX_DISCORD_MESSAGE_LENGTH - serializeSecurePlaintext("", anonymous).length);
    const value = serializeSecurePlaintext(text, bundle);
    assert.ok(value.length > MAX_DISCORD_MESSAGE_LENGTH);
    assert.equal((await harness.encrypt(value)).status, "encrypted");
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].length, MAX_DISCORD_MESSAGE_LENGTH);
});

for (const kind of ["generation", "account"] as const) {
    test(`${kind} invalidation prevents initial encryption and name-removal retries`, async () => {
        const initial = fixture();
        initial.invalidate(kind);
        const blocked = await initial.encrypt("message");
        assert.equal(blocked.status, "failed");
        assert.equal(initial.calls.length, 0);
        const retry = fixture({ native: async () => { retry.invalidate(kind); return tooLong; } });
        assert.deepEqual({ ...await retry.encrypt(serializeSecurePlaintext("message", descriptor())) }, { status: "failed", error: "cryptographic_operation_failed" });
        assert.deepEqual(retry.events, ["named"]);
    });
}

test("native failures other than message-too-long are preserved without fallback", async () => {
    const failure: EncryptOutgoingResult = { status: "failed", error: "storage_error" };
    const harness = fixture({ native: async () => failure });
    assert.equal(await harness.runFlow(), failure);
    assert.deepEqual(harness.events, ["named"]);
});

test("mandatory manifest fallback occurs after name removal and text detachment", async () => {
    const harness = fixture({ native: async value => parseSecurePlaintext(value).attachments?.manifest ? tooLong : success });
    assert.equal((await harness.runFlow()).status, "encrypted");
    assert.deepEqual(harness.events, ["named", "anonymous", "detach", "prepare", "named", "anonymous", "legacy"]);
    const fallback = parseSecurePlaintext(harness.calls[4]);
    assert.equal(fallback.attachments?.count, 2);
    assert.equal(fallback.attachments?.manifest, undefined);
    assert.equal(fallback.detachedTextIndex, 1);
});

test("ten-file messages with nine recipients retain an encrypted legacy fallback within the real protocol cap", async () => {
    const now = 1_800_000_000_000;
    const identity = await generateIdentity(now);
    const recipients = await Promise.all(Array.from({ length: 9 }, async (_, index) =>
        publicIdentity(await generateIdentity(now), String(100000000000000002n + BigInt(index)))));
    const harness = fixture({ bundle: descriptor(10), text: "", native: async plaintext => {
        try {
            const content = await encryptMessage({ channelId, identity, plaintext, recipients, senderUserId: localUserId, now, counter: 1 });
            assert.ok(content.length <= MAX_DISCORD_MESSAGE_LENGTH);
            return { status: "encrypted", content, counter: 1 };
        } catch (error) {
            assert.match(error instanceof Error ? error.message : String(error), /2,000 character limit/);
            return tooLong;
        }
    } });
    assert.equal((await harness.runFlow()).status, "encrypted");
    assert.deepEqual(harness.events, ["named", "anonymous", "legacy"]);
    const fallback = parseSecurePlaintext(harness.calls[2]);
    assert.equal(fallback.attachments?.count, 10);
    assert.equal(fallback.attachments?.manifest, undefined);
});
