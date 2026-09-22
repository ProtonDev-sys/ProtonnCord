/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import type { CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { createSourceFile, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type { MessageSendListener, SendMessageOptions } from "../src/api/MessageEvents";
import { parseSecurePlaintext, serializeSecurePlaintext } from "../src/equicordplugins/secureMessaging.desktop/attachments";
import { createEncryptedUploadDraft, EncryptedAttachmentUploadLimitError, prepareEncryptedAttachments, uploadEncryptedAttachment } from "../src/equicordplugins/secureMessaging.desktop/attachmentUploads";
import { discordMessageSendSource, patchDiscordMessageSend } from "./fixtures/discordMessageSend";

class Upload extends EventEmitter {
    status = "NOT_STARTED";
    uploadedFilename = "";
    responseUrl = "";
    description: string | null = "private description";
    spoiler = true;
    durationSecs: number | undefined;
    waveform: string | undefined;
    isThumbnail = false;
    filename: string;
    mimeType: string;
    id: string;
    cancellations = 0;
    behavior: (upload: Upload) => void | Promise<void> = upload => upload.complete();
    constructor(public item: { file: File; id?: string; platform: CloudUploadPlatform; }, public channelId = "200000000000000001") {
        super();
        this.id = item.id ?? "draft";
        this.filename = item.file.name;
        this.mimeType = item.file.type;
    }
    setFilename(value: string) { this.filename = value; }
    async upload() { this.status = "STARTED"; await this.behavior(this); }
    complete() {
        this.status = "COMPLETED";
        this.uploadedFilename = `uploaded-${this.filename}`;
        this.responseUrl = "https://upload.invalid/ciphertext";
        this.emit("complete");
        this.removeAllListeners();
    }
    fail() { this.status = "ERROR"; this.emit("error", new Error("offline")); this.removeAllListeners(); }
    cancel() { this.cancellations++; this.status = "CANCELED"; this.emit("complete"); this.removeAllListeners(); }
}
const cloud = (upload: Upload) => upload as unknown as CloudUpload;
const newUpload = (id = "draft") => new Upload({ file: new File(["private bytes"], "private.txt", { type: "text/plain" }), id, platform: CloudUploadPlatform.WEB });

const source = createSourceFile("index.tsx", readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8"), ScriptTarget.Latest, true);
const declaration = source.statements.flatMap(statement => isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(value => value.name.getText(source) === "outgoingListener");
assert.ok(declaration?.initializer);
const compiled = transpileModule(`(${declaration.initializer.getText(source)});`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

function messageEvents() {
    const exports = {} as typeof import("../src/api/MessageEvents");
    const code = transpileModule(readFileSync(new URL("../src/api/MessageEvents.ts", import.meta.url), "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, {
        exports,
        require(name: string) {
            if (name === "@utils/Logger") return { Logger: class { error() {} } };
            assert.equal(name, "@webpack/common");
            return { MessageStore: { getMessage() {} } };
        },
    });
    return exports;
}

function fixture(behavior: (upload: Upload, index: number) => void | Promise<void> = upload => upload.complete(), count = 2) {
    const originals = Array.from({ length: count }, (_, index) => newUpload(String(index)));
    const snapshots = originals.map(upload => ({ file: upload.item.file, filename: upload.filename, description: upload.description, spoiler: upload.spoiler }));
    const shadows: Upload[] = [];
    const approvals = new WeakMap();
    const wires: string[] = [];
    const options: any = { uploads: originals, stickerIds: ["sticker"], flags: 8192 };
    let storedDrafts = [...originals];
    let nativeCalls = 0;
    let sentBytes = 0;
    let current = true;
    let protectionGate: Promise<void> | undefined;
    let stickerGate: Promise<void> | undefined;
    class Shadow extends Upload {
        constructor(item: ConstructorParameters<typeof Upload>[0], channel: string) {
            super(item, channel);
            const index = shadows.length;
            shadows.push(this);
            this.behavior = async upload => {
                assert.equal(approvals.get(upload)?.file, upload.item.file, "only prepared encrypted uploads are approved");
                assert.equal(upload.item.file.type, "application/octet-stream");
                assert.equal(upload.description, null);
                assert.equal(upload.spoiler, false);
                assert.notEqual(await upload.item.file.text(), "private bytes");
                sentBytes += upload.item.file.size;
                await behavior(upload, index);
            };
        }
    }
    const send = runInNewContext(compiled, {
        AbortController, CloudUploader: Shadow, CloudUploadPlatform: { WEB: CloudUploadPlatform.WEB }, createEncryptedUploadDraft, prepareEncryptedAttachments, uploadEncryptedAttachment,
        DraftType: { ChannelMessage: 0 }, UploadAttachmentStore: { getUploads: () => storedDrafts },
        EncryptedAttachmentUploadLimitError, serializeSecurePlaintext, parseSecurePlaintext,
        secureOperationGeneration: 1, secureOperationIsCurrent: () => current, currentSnapshot: () => ({ localUserId: "100000000000000001", snapshot: { channelId: originals[0]?.channelId ?? "200000000000000001" } }),
        takePermittedAnnouncement: () => false, resolveConversationProtection: async () => { await protectionGate; return { kind: "snapshot", conversation: { status: "enabled" } }; },
        updateMessageLengthBypass() {}, requiresFailClosedSend: () => true, isNativeFailure: () => false, hasSelectedKeyReviewBlock: () => false,
        selectedOutgoingStickerIds: () => [], blockedOutgoingReason: () => null, resolveSelectedStickers: async () => { await stickerGate; return []; },
        discordUploadLimitBytes: () => 100_000, detachedTextUploadIndex: () => null, encryptedMentionedUserIds: () => [],
        preparedOutgoingMessages: new WeakMap(), approvedAttachmentUploads: approvals, detachedTextUploads: new WeakSet(),
        MAX_DISCORD_MESSAGE_LENGTH: 2_000, MAX_ATTACHMENT_COUNT: 10, VOICE_MESSAGE_FLAG: 8192,
        Native: { encryptOutgoing: async () => { nativeCalls++; return { status: "encrypted", content: "encrypted envelope" }; } },
        prefetchEncryptedMessageEmbeds: async () => {}, conversationAuthorizationScope: () => "scope",
        authorizeScopedAttachmentUploadReservations() {}, authorizeScopedWirePayload: (_channel: string, content: string) => wires.push(content),
        rememberOptimisticOutgoingPlaintext() {}, clearOutgoingStickers: (value: typeof options) => { if (Array.isArray(value.stickerIds)) value.stickerIds.length = 0; },
        showToast() {}, Toasts: { Type: { FAILURE: 1 } }, useEncryptedSendStatus: { setState() {} },
    }) as (...args: any[]) => Promise<{ cancel?: boolean; stop?: boolean; }>;
    return {
        originals, shadows, wires, options, approvals, nativeCalls: () => nativeCalls, sentBytes: () => sentBytes,
        invalidate: () => { current = false; },
        replaceStoredDraft: () => { storedDrafts = [newUpload("replacement"), ...storedDrafts.slice(1)]; },
        withoutStoredDrafts: () => { storedDrafts = []; },
        storedDrafts: () => storedDrafts,
        setStoredDrafts: (uploads: Upload[]) => { storedDrafts = uploads; },
        delayProtection: (gate: Promise<void>) => { protectionGate = gate; },
        delayStickers: (gate: Promise<void>) => { stickerGate = gate; },
        listener: send as MessageSendListener,
        send: () => send("200000000000000001", { content: "private caption" }, options, { channel: {} }),
        assertDraft() {
            originals.forEach((upload, index) => {
                assert.equal(upload.item.file, snapshots[index].file);
                assert.equal(upload.filename, snapshots[index].filename);
                assert.equal(upload.description, snapshots[index].description);
                assert.equal(upload.spoiler, snapshots[index].spoiler);
                assert.equal(upload.status, "NOT_STARTED");
                assert.equal(upload.uploadedFilename, "");
                assert.equal(upload.responseUrl, "");
            });
        },
    };
}

// Discord module 358579, reduced to its status/event contract. A NOT_STARTED
// upload waits for events even when its upload() call returns a resolved promise;
// COMPLETED objects settle immediately without another upload() call.
async function nativeUploadWait(uploads: Upload[]): Promise<void> {
    await Promise.all(uploads.map(upload => new Promise<void>((resolve, reject) => {
        switch (upload.status) {
            case "NOT_STARTED": void upload.upload(); break;
            case "COMPLETED": resolve(); break;
            default: reject(new Error("Upload is unavailable"));
        }
        upload.on("complete", resolve);
        upload.on("error", reject);
    })));
}

for (const scenario of ["completed", "upload failure", "old handoff", "patch rollback"] as const) {
    test(`composer handoff with actual Secure Messaging and MessageEvents: ${scenario}`, async t => {
        const h = fixture((upload, index) => scenario === "upload failure" && index === 1 ? upload.fail() : upload.complete());
        const events = messageEvents();
        events.addMessagePreSendListener(h.listener, { priority: 100, cancelOnError: true });
        t.after(() => {
            events.removeMessagePreSendListener(h.listener);
            [...h.originals, ...h.shadows].forEach(upload => upload.removeAllListeners());
        });
        let originalUploadCalls = 0;
        for (const original of h.originals) original.upload = async () => {
            // The protected upload guard returns without starting an unapproved
            // plaintext draft. It intentionally emits no upload completion event.
            originalUploadCalls++;
        };
        const handedOff: Upload[][] = [];
        let nativeCompleted = false;
        let content: string | undefined;
        const patched = patchDiscordMessageSend();
        const composer = scenario === "patch rollback" ? discordMessageSendSource
            : scenario === "old handoff" ? patched.replace(".attachmentsToUpload??=", ".attachmentsToUpload=") : patched;
        const outcome = await runInNewContext(`${composer}\nchatInput.props={channel:{id:"200000000000000001",getGuildId:()=>null},chatInputType:{drafts:{type:0}}};chatInput.setState=()=>{};chatInput.handleSendMessage({value:"private caption",uploads:originals,stickers:[]});`, {
            Vencord: { Api: { MessageEvents: events } },
            originals: h.originals,
            nT: { i: async () => ({ valid: true }) }, t$: { S: () => null },
            tq: { Ay: { parse: (_channel: unknown, plaintext: string) => ({ content: plaintext, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }) } },
            nq: { Hx: { CHAT_INPUT: "chat_input" } }, nv: { LJ: () => ({}), fJ: () => false },
            eC: { A: { getDraft: () => "" }, C: { ChannelMessage: 0 } }, C: { A: { saveDraft() {} } },
            eE: { A: { getUploadCount: () => h.storedDrafts().length } },
            S: { A: { clearAll: h.withoutStoredDrafts, setUploads: ({ uploads }: { uploads: Upload[]; }) => h.setStoredDrafts(uploads) } },
            w: { N3: () => ({}) }, nu: { Jx() {} }, nf: { x5() {} },
            x: { A: {
                getSendMessageOptions: () => ({}),
                sendMessage: (_channel: string, message: { content: string; }, unused: unknown, options: SendMessageOptions) => {
                    assert.equal(unused, undefined, "the real composer passes send options as its fourth argument");
                    content = message.content;
                    const uploads = options.attachmentsToUpload as unknown as Upload[];
                    handedOff.push(uploads);
                    return nativeUploadWait(uploads).then(() => { nativeCompleted = true; });
                },
            } },
        }) as { shouldClear: boolean; };
        await setImmediate();
        h.assertDraft();
        if (scenario === "upload failure") {
            assert.equal(outcome.shouldClear, false);
            assert.equal(handedOff.length, 0, "the composer must stop before native send after an encrypted upload fails");
            assert.equal(h.wires.length, 0);
            assert.equal(originalUploadCalls, 0);
            assert.deepEqual(h.storedDrafts(), h.originals, "cancelled encryption must leave the composer draft list intact");
        } else if (scenario === "old handoff" || scenario === "patch rollback") {
            assert.equal(handedOff[0], h.originals);
            assert.equal(originalUploadCalls, h.originals.length);
            assert.equal(nativeCompleted, false, "the previous overwrite reproduces the permanently pending native upload");
            if (scenario === "patch rollback") {
                assert.equal(content, "private caption", "atomic group rollback removes encryption interception completely");
                assert.equal(h.nativeCalls(), 0);
                assert.equal(h.shadows.length, 0);
            }
        } else {
            assert.equal(outcome.shouldClear, true);
            assert.equal(content, "encrypted envelope");
            assert.equal(handedOff.length, 1);
            assert.deepEqual(handedOff[0], h.shadows, "the full native continuation receives the completed encrypted instances");
            assert.ok(handedOff[0].every(upload => upload.status === "COMPLETED" && upload.item.file.type === "application/octet-stream"));
            assert.equal(originalUploadCalls, 0, "the original plaintext drafts must never enter native upload");
            assert.equal(nativeCompleted, true, "native upload completion must settle before the next event-loop turn");
            assert.equal(h.storedDrafts().length, 0, "the real host continuation clears composer drafts after preparation succeeds");
        }
    });
}

test("resolved upload errors preserve mixed drafts and allow a fresh encrypted retry", async () => {
    let failing = true;
    const h = fixture((upload, index) => failing && index === 1 ? upload.fail() : upload.complete());
    assert.equal((await h.send()).cancel, true);
    h.assertDraft();
    assert.equal(h.wires.length, 0);
    assert.deepEqual(h.options.stickerIds, ["sticker"]);
    assert.equal(h.options.flags, 8192);
    assert.equal(h.options.attachmentsToUpload, undefined);
    assert.ok(h.shadows.every(upload => !h.approvals.has(upload) && upload.cancellations === 1 && upload.eventNames().length === 0));
    failing = false;
    assert.equal((await h.send()).stop, true);
    h.assertDraft();
    assert.equal(h.wires.length, 1);
    assert.deepEqual(h.options.attachmentsToUpload.map((upload: Upload) => upload.id), h.originals.map(upload => upload.id), "host can remove drafts by their original upload IDs");
    assert.ok(h.options.attachmentsToUpload.every((upload: Upload) => !h.originals.includes(upload)));
    assert.ok(h.sentBytes() > 0);
});

test("a repeated send cannot reuse in-flight drafts and a changed draft cancels the pending send", async () => {
    const gate = Promise.withResolvers<void>();
    const h = fixture(async upload => { await gate.promise; upload.complete(); });
    const pending = h.send();
    for (let attempt = 0; attempt < 200 && h.sentBytes() === 0; attempt++) await setImmediate();
    assert.ok(h.sentBytes() > 0, "the pending send must reach the encrypted upload");
    assert.equal((await h.send()).cancel, true);
    assert.equal(h.nativeCalls(), 1);
    h.originals[0].description = "edited description";
    gate.resolve();
    assert.equal((await pending).cancel, true);
    assert.equal(h.wires.length, 0);
    assert.equal(h.originals[0].description, "edited description");
    assert.ok(h.originals.every(upload => upload.status === "NOT_STARTED"));
});

test("a host draft replacement without a cancellation event prevents the stale send", async () => {
    const h = fixture(upload => { upload.complete(); h.replaceStoredDraft(); });
    assert.equal((await h.send()).cancel, true);
    h.assertDraft();
    assert.equal(h.wires.length, 0);
});

for (const stage of ["protection", "stickers"] as const) test(`draft replacement during ${stage} lookup cannot become a programmatic upload`, async () => {
    const gate = Promise.withResolvers<void>();
    const h = fixture();
    if (stage === "protection") h.delayProtection(gate.promise);
    else h.delayStickers(gate.promise);
    const pending = h.send();
    await setImmediate();
    h.replaceStoredDraft();
    gate.resolve();
    assert.equal((await pending).cancel, true);
    assert.equal(h.sentBytes(), 0);
    assert.equal(h.nativeCalls(), 0);
    h.assertDraft();
});

test("programmatic uploads that were never in the composer remain supported", async () => {
    const h = fixture();
    h.withoutStoredDrafts();
    assert.equal((await h.send()).stop, true);
    h.assertDraft();
});

test("account or guard invalidation after upload leaves the original draft retryable", async () => {
    const h = fixture(upload => { upload.complete(); h.invalidate(); });
    assert.equal((await h.send()).cancel, true);
    h.assertDraft();
    assert.equal(h.wires.length, 0);
    assert.ok(h.shadows.every(upload => !h.approvals.has(upload)));
});

test("terminal upload events are awaited even when upload() resolves early", async () => {
    const upload = newUpload();
    upload.behavior = () => {};
    let settled = false;
    const pending = uploadEncryptedAttachment(cloud(upload)).then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false);
    upload.complete();
    await pending;
    assert.equal(settled, true);
    assert.equal(upload.eventNames().length, 0);
});

test("rejection and cancellation release every upload listener", async () => {
    for (const mode of ["reject", "cancel", "abort"] as const) {
        const upload = newUpload();
        const controller = new AbortController();
        upload.behavior = () => { if (mode === "reject") throw new Error("upload rejection"); };
        const pending = uploadEncryptedAttachment(cloud(upload), controller.signal);
        const failed = assert.rejects(pending);
        await setImmediate();
        if (mode === "cancel") upload.cancel();
        if (mode === "abort") controller.abort();
        await failed;
        assert.equal(upload.eventNames().length, 0);
    }
});
