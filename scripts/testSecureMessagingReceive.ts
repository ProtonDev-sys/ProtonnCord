/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptKind, ScriptTarget, transpileModule } from "typescript";

import type { Message } from "@vencord/discord-types";

import type { DecryptIncomingResult } from "../src/equicordplugins/secureMessaging.desktop/native";

type Exports = Record<string, unknown>;
type DecryptCache = typeof import("../src/equicordplugins/secureMessaging.desktop/decryptCache");
type CaptureStatus = "disabled" | "failed" | "pending" | "ready" | "screenshot";
interface NativeRequest {
    channelId: string;
    content: string;
    discordAuthorId: string;
    discordEditedTimestamp: string | null;
    discordMessageId: string;
    discordNonce: string | null;
}

const localUserId = "100000000000000001";
const channelId = "300000000000000001";
const source = readFileSync("src/equicordplugins/secureMessaging.desktop/index.tsx", "utf8");
const parsed = createSourceFile("index.tsx", source, ScriptTarget.ES2022, true, ScriptKind.TSX);
const receiveSource = [
    "secureOperationIsCurrent",
    "messageFromDispatch",
    "prefetchReceivedEncryptedMessage",
    "handleKeyAnnouncementDispatch",
    "handleLoadedKeyAnnouncements",
].map(name => {
    const declaration = parsed.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, `Missing production function ${name}`);
    return declaration.getText(parsed);
}).join("\n");
const compile = (text: string) => transpileModule(text, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

const decrypted = (): Extract<DecryptIncomingResult, { status: "decrypted"; }> => ({
    status: "decrypted",
    plaintext: "Authenticated private text",
    detachedTextIndex: null,
    attachmentBundle: null,
    counter: 1,
    envelopeId: "test-envelope",
    stickers: [],
});

function message(overrides: Partial<Message> = {}): Message {
    return {
        id: "200000000000000001",
        channel_id: channelId,
        author: { id: "100000000000000002" },
        content: "PCEM3:fixture",
        nonce: "200000000000000002",
        attachments: [],
        embeds: [],
        stickerItems: [],
        ...overrides,
    } as Message;
}

function deferred<T>() {
    let complete: (value: T) => void = () => { throw new Error("Promise not initialized"); };
    const promise = new Promise<T>(resolve => { complete = resolve; });
    return { promise, resolve: (value: T) => complete(value) };
}

function harness(options: { rejectNative?: boolean; } = {}) {
    const records = new Map<string, Message>();
    const calls: Array<{ userId: string; request: NativeRequest; settled: boolean; resolve(result: DecryptIncomingResult): void; }> = [];
    const reviews: Array<Message | undefined> = [];
    const notifications: string[] = [];
    const expansions: Array<{ selection: string; ids: readonly string[] | undefined; }> = [];
    let userId: string | null = localUserId;
    let selectedChannelId = channelId;
    let gate: "locked" | "checking" | "unavailable" | null = null;
    let guild = false;
    let channelAvailable = true;
    const native = {
        decryptIncoming(accountId: string, request: NativeRequest): Promise<DecryptIncomingResult> {
            const pending = deferred<DecryptIncomingResult>();
            const call = {
                userId: accountId,
                request: structuredClone(request),
                settled: options.rejectNative ?? false,
                resolve(result: DecryptIncomingResult) {
                    call.settled = true;
                    pending.resolve(result);
                },
            };
            calls.push(call);
            return options.rejectNative ? Promise.reject(new Error("Native unavailable")) : pending.promise;
        },
    };
    const modules = new Map<string, Exports>();
    const mocks: Record<string, Exports> = {
        "@utils/misc": { sleep: async () => undefined },
        "./attachmentCache": {
            async decryptIncomingAttachmentsCached(_accountId: string, _message: Message, selection: string, ids?: readonly string[]) {
                expansions.push({ selection, ids: ids && Array.from(ids) });
                return { status: "decrypted", plaintext: "Detached private text", attachments: [] };
            },
        },
    };
    function load(name: string): Exports {
        if (mocks[name]) return mocks[name];
        const existing = modules.get(name);
        if (existing) return existing;
        assert.match(name, /^\.\/[a-zA-Z]+$/u);
        const filename = resolve("src/equicordplugins/secureMessaging.desktop", `${name.slice(2)}.ts`);
        const module = { exports: {} as Exports };
        modules.set(name, module.exports);
        runInNewContext(compile(readFileSync(filename, "utf8")), {
            module,
            exports: module.exports,
            require: load,
            VencordNative: { pluginHelpers: { SecureMessaging: native } },
        }, { filename });
        return module.exports;
    }
    const cache = load("./decryptCache") as DecryptCache;
    const context = {
        ...cache,
        secureOperationGeneration: 1,
        secureRuntimeUserId: localUserId,
        screenCaptureProtectionStatus: "ready" as CaptureStatus,
        UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined },
        SelectedChannelStore: { getChannelId: () => selectedChannelId },
        ChannelStore: { getChannel: () => channelAvailable ? { guild_id: guild ? "400000000000000001" : null } : undefined },
        MessageStore: { getMessage: (channel: string, id: string) => records.get(`${channel}:${id}`) },
        chatGateReason: () => gate,
        isEncryptedMessage: (content: string) => content.startsWith("PCEM3:"),
        reviewKeyAnnouncementInBackground: (value: Message | undefined) => reviews.push(value),
        notifySecureMessageGroupingChanged: (channel: string) => notifications.push(channel),
    };
    const handlers = runInNewContext(`${compile(receiveSource)}\n({ handleKeyAnnouncementDispatch, handleLoadedKeyAnnouncements })`, context) as {
        handleKeyAnnouncementDispatch(event: Record<string, unknown>): void;
        handleLoadedKeyAnnouncements(event: Record<string, unknown>): void;
    };
    return {
        cache, calls, reviews, notifications, expansions, context,
        receive: handlers.handleKeyAnnouncementDispatch,
        history: handlers.handleLoadedKeyAnnouncements,
        store(value: Message) { records.set(`${value.channel_id}:${value.id}`, value); },
        setAccount(value: string | null) { userId = value; },
        select(value: string) { selectedChannelId = value; },
        setGate(value: typeof gate) { gate = value; },
        setGuild(value: boolean) { guild = value; },
        setChannelAvailable(value: boolean) { channelAvailable = value; },
        async settle(result: DecryptIncomingResult = decrypted()) {
            for (let round = 0; round < 16; round++) {
                const pending = calls.filter(call => !call.settled);
                if (!pending.length) {
                    await setImmediate();
                    if (calls.every(call => call.settled)) return;
                    continue;
                }
                for (const call of pending) call.resolve(result);
                await setImmediate();
            }
            assert.fail("Decryption queue did not settle");
        },
    };
}

test("receive handlers remain wired to creates, edits and loaded history", () => {
    assert.match(source, /MESSAGE_CREATE:\s*handleKeyAnnouncementDispatch/);
    assert.match(source, /MESSAGE_UPDATE:\s*handleKeyAnnouncementDispatch/);
    assert.match(source, /LOAD_MESSAGES_SUCCESS:\s*handleLoadedKeyAnnouncements/);
});

test("receipt starts native work synchronously without waiting for a render or mutating ciphertext", async () => {
    const h = harness();
    const value = message();
    Object.freeze(value.author);
    Object.freeze(value.attachments);
    Object.freeze(value);
    h.store(value);
    assert.equal(h.receive({ message: value }), undefined);
    assert.equal(h.calls.length, 1);
    assert.equal(h.cache.getCachedDecryption(localUserId, value), null);
    await h.settle();
    assert.equal(h.cache.getCachedDecryption(localUserId, value)?.status, "decrypted");
    assert.equal(value.content, "PCEM3:fixture");
    assert.deepEqual(h.notifications, [channelId]);
    assert.equal(h.expansions.length, 0);
});

test("receive duplicates and a simultaneous renderer share one authenticated request", async () => {
    const h = harness();
    const value = message();
    h.store(value);
    h.receive({ message: value });
    h.receive({ message: value });
    const rendered = h.cache.decryptCachedMessage(localUserId, value);
    assert.equal(h.calls.length, 1);
    await h.settle();
    assert.equal((await rendered).status, "decrypted");
    h.receive({ message: value });
    assert.equal(h.calls.length, 1);
    assert.equal(h.notifications.length, 1);
});

test("partial edits use the current complete store record rather than a partial wire object", async () => {
    const h = harness();
    const before = message();
    h.store(before);
    h.receive({ message: before });
    await h.settle();
    const after = message({ content: "PCEM3:edited", editedTimestamp: new Date("2026-09-05T12:00:00.000Z") } as Partial<Message>);
    h.store(after);
    h.receive({ channelId, message: { id: after.id, content: after.content } });
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].request.content, after.content);
    assert.equal(h.calls[1].request.discordEditedTimestamp, "2026-09-05T12:00:00.000Z");
    assert.equal(h.calls[1].request.discordNonce, after.nonce);
    await h.settle();
    assert.equal(h.cache.getCachedDecryption(localUserId, after)?.status, "decrypted");
});

test("complete-looking dispatch objects do not replace canonical author and attachment metadata", async () => {
    const h = harness();
    const value = message();
    h.store(value);
    h.receive({ message: { id: value.id, channel_id: channelId, content: "PCEM3:stale", author: { id: "wrong-author" } } });
    assert.equal(h.calls[0].request.discordAuthorId, value.author.id);
    assert.equal(h.calls[0].request.content, value.content);
    await h.settle();
    assert.equal(h.cache.getCachedDecryption(localUserId, value)?.status, "decrypted");
});

test("uncached and missing records remain on the existing rendering fallback", () => {
    const h = harness();
    h.receive({ message: message() });
    h.receive({});
    h.receive({ message: null });
    h.receive({ channelId, id: "missing" });
    h.history({});
    h.history({ messages: null });
    assert.equal(h.calls.length, 0);
});

for (const status of ["disabled", "failed", "pending", "screenshot"] as const) {
    test(`capture protection ${status} prevents speculative decryption`, () => {
        const h = harness();
        const value = message();
        h.store(value);
        h.context.screenCaptureProtectionStatus = status;
        h.receive({ message: value });
        assert.equal(h.calls.length, 0);
    });
}

for (const gate of ["locked", "checking", "unavailable"] as const) {
    test(`chat gate ${gate} prevents speculative decryption`, () => {
        const h = harness();
        const value = message();
        h.store(value);
        h.setGate(gate);
        h.history({ messages: [value] });
        assert.equal(h.calls.length, 0);
    });
}

test("inactive channels, guilds, missing channels and account transitions do not prefetch", () => {
    const h = harness();
    const value = message();
    h.store(value);
    h.select("another-channel");
    h.receive({ message: value });
    h.select(channelId);
    h.setGuild(true);
    h.receive({ message: value });
    h.setGuild(false);
    h.setChannelAvailable(false);
    h.receive({ message: value });
    h.setChannelAvailable(true);
    h.setAccount(null);
    h.receive({ message: value });
    h.setAccount("100000000000000003");
    h.receive({ message: value });
    assert.equal(h.calls.length, 0);
});

test("ordinary text, announcements and optimistic messages do not trigger decryption", () => {
    const h = harness();
    for (const value of [message({ content: "Hello" }), message({ content: "PCKA:announcement" }), message({ state: "SENDING" })]) {
        h.store(value);
        h.receive({ message: value });
    }
    const value = message();
    h.store(value);
    h.receive({ message: value, optimistic: true });
    assert.equal(h.calls.length, 0);
    assert.equal(h.reviews.length, 4);
});

test("loaded history starts at most four speculative requests and still reviews every entry", async () => {
    const h = harness();
    const values = Array.from({ length: 100 }, (_, index) => message({ id: String(200000000000000001n + BigInt(index)) }));
    for (const value of values) h.store(value);
    h.history({ channelId, messages: values });
    assert.equal(h.calls.length, 4);
    assert.equal(h.reviews.length, 100);
    const rendered = h.cache.decryptCachedMessage(localUserId, values[99]);
    assert.equal(h.calls.length, 4);
    await h.settle();
    assert.equal((await rendered).status, "decrypted");
    assert.equal(h.calls.length, 5);
    assert.equal(h.cache.getCachedDecryption(localUserId, values[50]), null);
});

test("clearing the cache invalidates old results and frees speculative admission immediately", async () => {
    const h = harness();
    const values = Array.from({ length: 4 }, (_, index) => message({ id: String(200000000000000001n + BigInt(index)) }));
    for (const value of values) {
        h.store(value);
        h.receive({ message: value });
    }
    h.cache.clearEncryptedMessageDecryptCache();
    const after = message({ id: "200000000000000100" });
    h.store(after);
    h.receive({ message: after });
    await h.settle();
    for (const value of values) assert.equal(h.cache.getCachedDecryption(localUserId, value), null);
    assert.equal(h.cache.getCachedDecryption(localUserId, after)?.status, "decrypted");
    assert.deepEqual(h.notifications, [channelId]);
});

for (const change of ["generation", "account", "capture", "gate", "cache"] as const) {
    test(`a ${change} transition suppresses stale receive completion notifications`, async () => {
        const h = harness();
        const value = message();
        h.store(value);
        h.receive({ message: value });
        if (change === "generation") h.context.secureOperationGeneration++;
        if (change === "account") h.setAccount("100000000000000003");
        if (change === "capture") h.context.screenCaptureProtectionStatus = "screenshot";
        if (change === "gate") h.setGate("locked");
        if (change === "cache") h.cache.clearEncryptedMessageDecryptCache();
        await h.settle();
        assert.deepEqual(h.notifications, []);
    });
}

for (const status of ["invalid_message", "untrusted_author", "replay_detected"] as const) {
    test(`${status} remains blocked instead of being converted to plaintext`, async () => {
        const h = harness();
        const value = message();
        h.store(value);
        h.receive({ message: value });
        await h.settle({ status });
        assert.equal(h.cache.getCachedDecryption(localUserId, value)?.status, status);
        assert.equal(h.calls.length, 1);
        assert.equal(h.expansions.length, 0);
        assert.equal(value.content, "PCEM3:fixture");
    });
}

test("native rejections are contained by the existing retry and failure cache", async () => {
    const h = harness({ rejectNative: true });
    const value = message();
    h.store(value);
    h.receive({ message: value });
    await h.settle();
    assert.equal(h.calls.length, 4);
    assert.equal(h.cache.getCachedDecryption(localUserId, value)?.status, "failed");
    h.receive({ message: value });
    assert.equal(h.calls.length, 4);
});

test("receive prefetch preserves detached-text-only expansion", async () => {
    const h = harness();
    const value = message({ attachments: [
        { id: "400000000000000001", size: 100 },
        { id: "400000000000000002", size: 200 },
    ] } as Partial<Message>);
    h.store(value);
    h.receive({ message: value });
    await h.settle({
        ...decrypted(),
        detachedTextIndex: 1,
        attachmentBundle: {
            id: "A".repeat(22), key: "A".repeat(43), root: "A".repeat(43), count: 2,
            manifest: value.attachments.map(() => ({ digest: "A".repeat(43), preview: false, spoiler: false, size: 10, name: null })),
        },
    });
    assert.deepEqual(h.expansions, [{ selection: "text", ids: [value.attachments[1].id] }]);
    const result = h.cache.getCachedDecryption(localUserId, value);
    assert.equal(result?.status === "decrypted" && result.plaintext, "Detached private text");
});
