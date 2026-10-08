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
import { createSourceFile, isFunctionDeclaration, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type { MessageSendListener, SendMessageOptions } from "../src/api/MessageEvents";
import { withTimeout } from "../src/debug/promiseTimeout";
import { DETACHED_TEXT_FILENAME, DETACHED_TEXT_MIME_TYPE, MAX_DETACHED_TEXT_BYTES, parseSecurePlaintext, serializeSecurePlaintext } from "../src/equicordplugins/secureMessaging.desktop/attachments";
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
    }
    fail() { this.status = "ERROR"; this.emit("error", new Error("offline")); }
    cancel() { this.cancellations++; this.status = "CANCELED"; this.emit("complete"); }
}
const cloud = (upload: Upload) => upload as unknown as CloudUpload;
const newUpload = (id = "draft") => new Upload({ file: new File(["private bytes"], "private.txt", { type: "text/plain" }), id, platform: CloudUploadPlatform.WEB });

const source = createSourceFile("index.tsx", readFileSync(new URL("../src/equicordplugins/secureMessaging.desktop/index.tsx", import.meta.url), "utf8"), ScriptTarget.Latest, true);
const declaration = source.statements.flatMap(statement => isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(value => value.name.getText(source) === "outgoingListener");
assert.ok(declaration?.initializer);
const compiled = transpileModule(`(${declaration.initializer.getText(source)});`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
const forwardCompiled = transpileModule([
    "sendEncryptedForward", "appendDetachedTextUpload", "selectedOutgoingStickerIds", "secureStickerItem", "resolveSelectedStickers",
].map(name => {
    const helper = source.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(helper, name);
    return helper.getText(source);
}).join("\n"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

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
    const preparedPlaintexts: string[] = [];
    const forwards: Array<{ message: { content: string; }; options: SendMessageOptions; }> = [];
    const runtime = { accountId: "100000000000000001", capture: "ready", visibilityGeneration: 1, guard: true, scope: "scope", review: false, destination: "enabled", disableDuringPreSend: false };
    const options: any = { uploads: originals, stickerIds: ["sticker"], flags: 8192 };
    let storedDrafts = [...originals];
    let nativeCalls = 0;
    let sentBytes = 0;
    let current = true;
    let protectionGate: Promise<void> | undefined;
    let stickerGate: Promise<void> | undefined;
    let encryptionGate: Promise<void> | undefined;
    let dispatchError = false;
    let protectionLookups = 0;
    const uploadStarted = Promise.withResolvers<Upload>();
    const protectionStarted = Promise.withResolvers<void>();
    const stickersStarted = Promise.withResolvers<void>();
    const encryptionStarted = Promise.withResolvers<void>();
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
        override async upload() {
            const pending = super.upload();
            uploadStarted.resolve(this);
            await pending;
        }
    }
    const context = {
        AbortController, CloudUploader: Shadow, CloudUploadPlatform: { WEB: CloudUploadPlatform.WEB }, createEncryptedUploadDraft, prepareEncryptedAttachments, uploadEncryptedAttachment,
        DraftType: { ChannelMessage: 0 }, UploadAttachmentStore: { getUploads: () => storedDrafts },
        EncryptedAttachmentUploadLimitError, serializeSecurePlaintext, parseSecurePlaintext,
        applicationGuardsBlocked: false,
        secureOperationGeneration: 1, secureOperationIsCurrent: (_generation: number, userId?: string) => current && (userId === undefined || userId === runtime.accountId), currentSnapshot: () => ({ localUserId: "100000000000000001", snapshot: { channelId: originals[0]?.channelId ?? "200000000000000001" } }),
        takePermittedAnnouncement: () => false, resolveConversationProtection: async () => {
            protectionStarted.resolve();
            await protectionGate;
            if (++protectionLookups === 2 && runtime.disableDuringPreSend) runtime.destination = "disabled";
            return { kind: "snapshot", conversation: { status: runtime.destination, scope: runtime.scope } };
        },
        updateMessageLengthBypass() {}, requiresFailClosedSend: (conversation: { status: string; }) => conversation.status !== "disabled", isNativeFailure: () => false, hasSelectedKeyReviewBlock: () => runtime.review,
        selectedOutgoingStickerIds: () => [], blockedOutgoingReason: () => null, resolveSelectedStickers: async () => { stickersStarted.resolve(); await stickerGate; return []; },
        discordUploadLimitBytes: () => 100_000, detachedTextUploadIndex: () => null, encryptedMentionedUserIds: () => [],
        preparedOutgoingMessages: new WeakMap(), approvedAttachmentUploads: approvals, detachedTextUploads: new WeakSet(),
        MAX_DISCORD_MESSAGE_LENGTH: 2_000, MAX_ATTACHMENT_COUNT: 10, VOICE_MESSAGE_FLAG: 8192,
        Native: { encryptOutgoing: async (_user: string, input: { plaintext: string; }) => { nativeCalls++; preparedPlaintexts.push(input.plaintext); encryptionStarted.resolve(); await encryptionGate; return { status: "encrypted", content: "encrypted envelope" }; } },
        prefetchEncryptedMessageEmbeds: async () => {}, conversationAuthorizationScope: (_user: string, conversation: { status: string; scope: string; }) => conversation.status === "enabled" ? conversation.scope : null,
        authorizeScopedAttachmentUploadReservations() {}, authorizeScopedWirePayload: (_channel: string, content: string) => wires.push(content),
        rememberOptimisticOutgoingPlaintext() {}, clearOutgoingStickers: (value: typeof options) => { if (Array.isArray(value.stickerIds)) value.stickerIds.length = 0; },
        showToast() {}, Toasts: { Type: { FAILURE: 1 } }, useEncryptedSendStatus: { setState() {} },
        File, DETACHED_TEXT_FILENAME, DETACHED_TEXT_MIME_TYPE, MAX_DETACHED_TEXT_BYTES, MAX_STICKER_COUNT: 3,
        formatUploadBytes: (bytes: number) => String(bytes),
        secureRuntimeUserId: "100000000000000001",
        get screenCaptureProtectionGeneration() { return runtime.visibilityGeneration; },
        get screenCaptureProtectionStatus() { return runtime.capture; },
        get networkGuardEnabled() { return runtime.guard; },
        UserStore: { getCurrentUser: () => ({ id: runtime.accountId }) },
        ChannelStore: { getChannel: () => ({ id: "200000000000000001" }) },
        StickersStore: { getStickerById: (id: string) => ({ id, name: "Forwarded sticker", format_type: 1 }) },
        isEncryptedMessage: (value: string) => value === "encrypted envelope",
        MessageActions: { async sendMessage(_channel: string, message: { content: string; }, _wait: boolean, sendOptions: SendMessageOptions) {
            if (dispatchError) throw new Error("Native forward send failed");
            await nativeUploadWait(sendOptions.attachmentsToUpload as unknown as Upload[] ?? []);
            forwards.push({ message, options: sendOptions });
        } },
    };
    const send = runInNewContext(compiled, context) as (...args: any[]) => Promise<{ cancel?: boolean; stop?: boolean; }>;
    return {
        originals, shadows, wires, options, approvals, nativeCalls: () => nativeCalls, sentBytes: () => sentBytes,
        uploadStarted: uploadStarted.promise, protectionStarted: protectionStarted.promise, stickersStarted: stickersStarted.promise, encryptionStarted: encryptionStarted.promise,
        runtime, preparedPlaintexts, forwards,
        forward(content = "Forwarded caption", stickerIds: string[] = []) {
            const forward = runInNewContext(`${forwardCompiled}\nsendEncryptedForward`, Object.assign(context, { outgoingListener: send })) as (
                channelId: string, content: string, uploads: CloudUpload[], stickerIds: string[],
            ) => Promise<void>;
            return forward("200000000000000001", content, originals.map(cloud), stickerIds);
        },
        delayEncryption: (gate: Promise<void>) => { encryptionGate = gate; },
        failDispatch: () => { dispatchError = true; },
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

test("a repeated send cannot reuse in-flight drafts and a changed draft cancels the pending send", async testContext => {
    const gate = Promise.withResolvers<void>();
    const h = fixture(async upload => { await gate.promise; upload.complete(); });
    let pending: ReturnType<typeof h.send> | undefined;
    testContext.after(async () => {
        gate.resolve();
        try { if (pending) await withTimeout(pending, 5_000, "Fixture watchdog: pending encrypted send did not drain"); }
        finally { h.shadows.forEach(upload => { upload.cancel(); upload.removeAllListeners(); }); }
    });
    pending = h.send();
    const upload = await withTimeout(h.uploadStarted, 5_000, "Fixture watchdog: encrypted upload did not start");
    assert.equal(upload.status, "STARTED", "the pending send must reach the encrypted upload");
    assert.equal((await h.send()).cancel, true);
    assert.equal(h.nativeCalls(), 1);
    h.originals[0].description = "edited description";
    gate.resolve();
    assert.equal((await pending).cancel, true);
    assert.ok(h.sentBytes() > 0);
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

for (const stage of ["protection", "stickers"] as const) test(`draft replacement during ${stage} lookup cannot become a programmatic upload`, async testContext => {
    const gate = Promise.withResolvers<void>();
    const h = fixture();
    if (stage === "protection") h.delayProtection(gate.promise);
    else h.delayStickers(gate.promise);
    const pending = h.send();
    testContext.after(async () => {
        gate.resolve();
        await withTimeout(pending, 5_000, "Fixture watchdog: draft replacement send did not drain");
    });
    await withTimeout(stage === "protection" ? h.protectionStarted : h.stickersStarted, 5_000, `Fixture watchdog: ${stage} lookup did not start`);
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

test("encrypted forwards use the outgoing pipeline for files and authenticated stickers before native send", async () => {
    const h = fixture();
    h.withoutStoredDrafts();
    const stickerIds = ["300000000000000001"];
    await h.forward("Forwarded private caption", stickerIds);
    h.assertDraft();
    assert.equal(h.forwards.length, 1);
    assert.equal(h.forwards[0].message.content, "encrypted envelope");
    assert.equal(h.forwards[0].options.content, "encrypted envelope");
    assert.deepEqual(Array.from(h.forwards[0].options.attachmentsToUpload ?? []), h.shadows);
    assert.deepEqual(Array.from(h.forwards[0].options.stickerIds ?? []), [], "sticker IDs stay inside the authenticated encrypted payload");
    const plaintext = parseSecurePlaintext(h.preparedPlaintexts[0]);
    assert.equal(plaintext.text, "Forwarded private caption");
    assert.equal(plaintext.attachments?.count, 2);
    assert.equal(plaintext.stickers[0]?.id, stickerIds[0]);
    assert.deepEqual(stickerIds, ["300000000000000001"], "the source selection stays intact");
    assert.equal(h.wires.length, 1, "the encrypted wire payload is authorized before entering native send");
    assert.equal(h.forwards[0].options.messageReference, undefined);
    assert.equal(h.forwards[0].options.alsoForwardToChannelId, undefined);
});

test("large encrypted forwards use detached encrypted text before native send", async () => {
    const h = fixture(undefined, 0);
    const content = "Private forwarded history. ".repeat(160);
    await h.forward(content);
    assert.equal(h.forwards.length, 1);
    const plaintext = parseSecurePlaintext(h.preparedPlaintexts[0]);
    assert.equal(plaintext.text, "");
    assert.equal(plaintext.detachedTextIndex, 0);
    assert.equal(plaintext.attachments?.count, 1);
    const upload = h.forwards[0].options.attachmentsToUpload?.[0];
    assert.ok(upload);
    assert.equal(upload.item.file.type, "application/octet-stream");
    assert.notEqual(await upload.item.file.text(), content);
    assert.equal(upload.status, "COMPLETED");
});

test("encrypted forward preparation and native send failures reject without a plaintext fallback", async () => {
    const failedUpload = fixture(upload => upload.fail());
    await assert.rejects(failedUpload.forward(), /could not prepare/);
    assert.equal(failedUpload.forwards.length, 0);
    assert.equal(failedUpload.wires.length, 0);
    failedUpload.assertDraft();
    const failedSend = fixture(undefined, 0);
    failedSend.failDispatch();
    await assert.rejects(failedSend.forward(), /Native forward send failed/);
    assert.equal(failedSend.forwards.length, 0);
});

test("a destination disabled before outgoing preparation cannot forward unchanged plaintext", async () => {
    const h = fixture(undefined, 0);
    h.runtime.disableDuringPreSend = true;
    await assert.rejects(h.forward("Protected source plaintext"), /could not prepare/);
    assert.equal(h.nativeCalls(), 0, "the outgoing hook correctly leaves newly unprotected sends unencrypted");
    assert.equal(h.forwards.length, 0, "the forward bridge must reject that plaintext handoff");
});

for (const change of ["account", "capture", "visibility", "guard", "scope", "review", "disabled"] as const) {
    test(`encrypted forward revalidation cancels a ${change} change during preparation`, async testContext => {
        const h = fixture(undefined, 0);
        const gate = Promise.withResolvers<void>();
        h.delayEncryption(gate.promise);
        const pending = h.forward();
        const rejected = assert.rejects(pending, /no longer ready|recipients changed|could not prepare/);
        testContext.after(async () => {
            gate.resolve();
            await withTimeout(rejected, 5_000, "Fixture watchdog: rejected forward did not drain");
        });
        await withTimeout(h.encryptionStarted, 5_000, "Fixture watchdog: forward encryption did not start");
        assert.equal(h.nativeCalls(), 1);
        if (change === "account") h.runtime.accountId = "100000000000000002";
        if (change === "capture") h.runtime.capture = "screenshot";
        if (change === "visibility") h.runtime.visibilityGeneration++;
        if (change === "guard") h.runtime.guard = false;
        if (change === "scope") h.runtime.scope = "changed recipients";
        if (change === "review") h.runtime.review = true;
        if (change === "disabled") h.runtime.destination = "disabled";
        gate.resolve();
        await rejected;
        assert.equal(h.forwards.length, 0);
    });
}

test("account or guard invalidation after upload leaves the original draft retryable", async () => {
    const h = fixture(upload => { upload.complete(); h.invalidate(); });
    assert.equal((await h.send()).cancel, true);
    h.assertDraft();
    assert.equal(h.wires.length, 0);
    assert.ok(h.shadows.every(upload => !h.approvals.has(upload)));
});

test("terminal upload events are awaited even when upload() resolves early", async () => {
    const upload = newUpload();
    const unrelated = () => {};
    upload.on("fixture", unrelated);
    upload.behavior = () => {};
    let settled = false;
    const pending = uploadEncryptedAttachment(cloud(upload)).then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false);
    upload.complete();
    await pending;
    assert.equal(settled, true);
    assert.deepEqual(upload.eventNames(), ["fixture"], "production cleanup must remove only its own terminal listeners");
    upload.removeListener("fixture", unrelated);
    assert.equal(upload.eventNames().length, 0);
});

test("rejection and cancellation release every upload listener", async () => {
    for (const mode of ["reject", "cancel", "abort"] as const) {
        const upload = newUpload();
        const unrelated = () => {};
        upload.on("fixture", unrelated);
        const controller = new AbortController();
        upload.behavior = () => { if (mode === "reject") throw new Error("upload rejection"); };
        const pending = uploadEncryptedAttachment(cloud(upload), controller.signal);
        const failed = assert.rejects(pending);
        await setImmediate();
        if (mode === "cancel") upload.cancel();
        if (mode === "abort") controller.abort();
        await failed;
        assert.deepEqual(upload.eventNames(), ["fixture"], "production cleanup must retain unrelated listeners");
        upload.removeListener("fixture", unrelated);
        assert.equal(upload.eventNames().length, 0);
    }
});
