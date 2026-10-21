/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";

import * as codec from "../src/equicordplugins/messageCompression/codec";
import { discordLongPasteArguments, discordMessageContentConstructor, discordPartialContentUpdate } from "./fixtures/discordMessageCompression";
import { applyPatch } from "./utils/discordClientFixture";
import { loadTestModule } from "./utils/loadTestModule";

const A = "100000000000000001";
const B = "100000000000000002";
const C = "100000000000000003";
const AB = "200000000000000001";
const AC = "200000000000000002";
const GUILD = "200000000000000099";
const SHORT = "This exact message has enough repeated structure to compress. ".repeat(16);
const LONG = "This longer message must remain in the draft until its receiver is confirmed. ".repeat(60);
const PREFIX = "PCMCAP1:";
const indexFile = new URL("../src/equicordplugins/messageCompression/index.tsx", import.meta.url);
const eventsFile = new URL("../src/api/MessageEvents.ts", import.meta.url);
const sessionFile = new URL("../src/equicordplugins/messageCompression/session.ts", import.meta.url);

class TestLogger {
    error() { }
}

class TestTimers {
    private next = 0;
    private tasks = new Map<number, () => void>();
    setTimeout = (callback: () => void) => {
        const id = ++this.next;
        this.tasks.set(id, callback);
        return id;
    };
    clearTimeout = (id: number) => { this.tasks.delete(id); };
    expire() {
        const callbacks = [...this.tasks.values()];
        this.tasks.clear();
        for (const callback of callbacks) callback();
    }
}

interface Frame {
    from: string;
    channelId: string;
    content: string;
    options: any;
}

class Network {
    clients = new Map<string, ReturnType<typeof makeClient>>();
    frames: Frame[] = [];
    failures = new Set<string>();
    private queued: Frame[] = [];
    private handlers = new Set<Promise<unknown>>();
    private errors: unknown[] = [];

    send(from: string, channelId: string, message: { content: string; }, options: any) {
        const frame = { from, channelId, content: message.content, options };
        this.frames.push(frame);
        if (this.failures.has(from)) return Promise.resolve({ ok: false });
        this.queued.push(frame);
        return Promise.resolve({ ok: true });
    }

    async flush() {
        // Transport resolves before delivery, as a real gateway does; awaiting the
        // peer's response inside sendMessage would manufacture a queue deadlock.
        for (let turn = 0; turn < 50; turn++) {
            await new Promise<void>(resolve => setImmediate(resolve));
            for (const frame of this.queued.splice(0)) {
                const recipient = frame.channelId === AB
                    ? (frame.from === A ? B : A)
                    : (frame.from === A ? C : A);
                const client = this.clients.get(recipient);
                if (!client) continue;
                const handler = Promise.resolve(client.plugin.flux.MESSAGE_CREATE({
                    message: { channel_id: frame.channelId, author: { id: frame.from }, content: frame.content },
                    optimistic: false,
                })).catch(error => { this.errors.push(error); });
                this.handlers.add(handler);
                void handler.finally(() => { this.handlers.delete(handler); });
            }
            if (!this.queued.length && !this.handlers.size) {
                await new Promise<void>(resolve => setImmediate(resolve));
                if (!this.queued.length && !this.handlers.size) {
                    assert.deepEqual(this.errors, [], "gateway handlers must not reject");
                    return;
                }
            }
        }
        assert.fail("mock transport did not become idle");
    }
}

function makeClient(id: string, network: Network) {
    const currentUser = { id, premiumType: 0 };
    const timers = new TestTimers();
    const stored = new Map<string, any>();
    const toasts: any[] = [];
    let selected = AB;
    const getChannel = (channelId: string) => ({
        id: channelId,
        isDM: () => channelId === AB || channelId === AC,
        getRecipientId: () => channelId === AB ? (id === A ? B : A) : (id === A ? C : A),
    });
    const MessageStore = { getMessage: (channelId: string, messageId: string) => stored.get(`${channelId}:${messageId}`) };
    const common = {
        ChannelStore: { getChannel }, MessageStore,
        SelectedChannelStore: { getChannelId: () => selected },
        UserStore: { getCurrentUser: () => currentUser, getUser: (userId: string) => ({ id: userId, bot: false }) },
        Toasts: { show: (toast: any) => toasts.push(toast), Type: { FAILURE: 1, SUCCESS: 2 } },
    };
    const events = loadTestModule<any>(eventsFile, {
        "@utils/Logger": { Logger: TestLogger }, "@webpack/common": common,
    }, {});
    const session = loadTestModule<any>(sessionFile, {}, { crypto: webcrypto });
    const plugin = loadTestModule<any>(indexFile, {
        "@api/MessageEvents": events,
        "@api/Settings": { definePluginSettings: (definitions: any) => ({ store: Object.fromEntries(Object.entries(definitions).map(([key, value]: any) => [key, value.default])) }) },
        "@components/BaseText": { BaseText: () => undefined },
        "@utils/constants": { EquicordDevs: { nobody: {} } },
        "@utils/discord": { sendMessage: (channelId: string, message: any, _wait: boolean, options: any) => network.send(currentUser.id, channelId, message, options) },
        "@utils/Logger": { Logger: TestLogger },
        "@utils/types": { __esModule: true, default: (definition: any) => definition, OptionType: { BOOLEAN: 1 } },
        "@webpack/common": common,
        "./codec": codec,
        "./session": session,
    }, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }).default;

    async function send(content: string, channelId = AB, overrides: { message?: any; options?: any; props?: any; } = {}) {
        const message = { content, invalidEmojis: [], validNonShortcutEmojis: [], tts: false, ...overrides.message };
        const contentOptions = { channelId, content, command: null };
        const options = { ...contentOptions, location: "test", ...overrides.options };
        const props = { channel: getChannel(channelId), content, hasAttachments: false, hasStickers: false, openWarningPopout() { }, ...overrides.props };
        const cancelled = await events._handlePreSend(channelId, message, options, props, contentOptions);
        return { message, cancelled };
    }

    async function edit(content: string, existing: any = {}, channelId = AB) {
        stored.set(`${channelId}:message`, { author: { id: currentUser.id }, attachments: [], ...existing });
        const message = { content, invalidEmojis: [], validNonShortcutEmojis: [], tts: false };
        const cancelled = await events._handlePreEdit(channelId, "message", message);
        return { message, cancelled };
    }

    const client = { plugin, events, session, timers, currentUser, toasts, send, edit, select: (channelId: string) => { selected = channelId; } };
    network.clients.set(id, client);
    plugin.start();
    return client;
}

async function readyPair() {
    const network = new Network();
    const first = makeClient(A, network);
    const second = makeClient(B, network);
    const initial = await first.send(SHORT);
    assert.equal(initial.cancelled, false);
    assert.equal(initial.message.content, SHORT, "the first normal message must not wait for discovery");
    await network.flush();
    assert.equal(network.frames.length, 3, "HELLO, ACK and confirmation are automatic");
    for (const frame of network.frames) {
        assert.ok(frame.content.startsWith(PREFIX));
        assert.equal(frame.options.allowedMentions.parse.length, 0, "control traffic cannot ping users");
    }
    return { network, first, second };
}

async function testAutomaticSendAndEdit() {
    const { network, first, second } = await readyPair();
    let downstreamRan = false;
    first.events.addMessagePreSendListener(() => { downstreamRan = true; }, { priority: -200 });
    const sent = await first.send(LONG);
    assert.equal(sent.cancelled, false);
    assert.ok(sent.message.content.startsWith(codec.COMPRESSED_MESSAGE_PREFIX));
    assert.equal(codec.decodeCompressedMessage(sent.message.content), LONG);
    assert.equal(downstreamRan, false, "encoded content must not be transformed by later listeners");
    assert.equal(second.plugin.decodeContent(sent.message.content), LONG);
    assert.equal(network.frames.length, 3, "confirmed peers do not repeat discovery on every message");
    const reverse = await second.send(SHORT);
    assert.equal(codec.decodeCompressedMessage(reverse.message.content), SHORT, "confirmation enables both directions");
    const edited = await first.edit(LONG + "Edited.");
    assert.equal(edited.cancelled, false);
    assert.equal(codec.decodeCompressedMessage(edited.message.content), LONG + "Edited.");
    const foreign = await first.edit(SHORT, { author: { id: B } });
    assert.equal(foreign.message.content, SHORT, "another author's edit must never be transformed");
    first.plugin.stop();
    second.plugin.stop();
}

async function testOrdinaryContentAndPolicies() {
    const { network, first, second } = await readyPair();
    const scenarios = [
        { content: `https://example.invalid/ ${SHORT}` },
        { content: `<@${B}> ${SHORT}` },
        { content: `@everyone ${SHORT}` },
        { content: `<:wave:100000000000000004> ${SHORT}` },
        { content: `PCEM3:${SHORT}` },
        { content: SHORT, props: { hasAttachments: true } },
        { content: SHORT, props: { hasStickers: true } },
        { content: SHORT, message: { tts: true } },
        { content: SHORT, message: { validNonShortcutEmojis: [{}] } },
        { content: SHORT, options: { uploads: [{}] } },
        { content: SHORT, options: { attachmentsToUpload: [{}] } },
        { content: SHORT, options: { messageReference: { message_id: "100000000000000009" } } },
        { content: SHORT, options: { command: {} } },
    ];
    for (const scenario of scenarios) {
        const result = await first.send(scenario.content, AB, scenario);
        assert.equal(result.cancelled, false);
        assert.equal(result.message.content, scenario.content, "Discord-visible semantics must remain ordinary text");
    }
    assert.equal(network.frames.length, 3);
    const guild = await first.send(SHORT, GUILD);
    assert.equal(guild.message.content, SHORT);
    const blockedEdit = await first.edit(SHORT, { attachments: [{}] });
    assert.equal(blockedEdit.message.content, SHORT);
    first.events.addMessagePreSendListener((_channel: string, message: any) => { message.content += " formatted"; }, { priority: 0 });
    const formatted = await first.send(SHORT);
    assert.equal(codec.decodeCompressedMessage(formatted.message.content), SHORT + " formatted", "compression follows existing text formatters");
    first.plugin.stop();
    second.plugin.stop();
}

async function testAbsentPeerAndCancellation() {
    for (const policy of ["stock", "cancel", "change", "failed transport"] as const) {
        const network = new Network();
        const client = makeClient(A, network);
        if (policy === "failed transport") network.failures.add(A);
        if (policy === "cancel" || policy === "change") {
            client.events.addMessagePreSendListener((_channel: string, message: any) => {
                if (!message.content.startsWith(PREFIX)) return;
                if (policy === "cancel") return { cancel: true };
                message.content += " modified by another policy";
            }, { priority: 100 });
        }
        const normal = await client.send(SHORT);
        assert.equal(normal.message.content, SHORT);
        assert.equal(normal.cancelled, false);
        await network.flush();
        if (policy === "cancel" || policy === "change") assert.equal(network.frames.length, 0, "cancelled or modified controls must not be sent");
        const pending = client.send(LONG);
        await network.flush();
        client.timers.expire();
        const oversized = await pending;
        assert.equal(oversized.cancelled, true, `${policy}: oversized unconfirmed message must preserve its draft`);
        assert.equal(oversized.message.content, LONG);
        assert.ok(client.toasts.length > 0);
        client.plugin.stop();
    }
}

async function testPendingIsolationAndLifecycle() {
    const network = new Network();
    const client = makeClient(A, network);
    const third = makeClient(C, network);
    let settled = false;
    const waitingForStockClient = client.send(LONG).then(result => { settled = true; return result; });
    await network.flush();
    await client.send(SHORT, AC);
    await network.flush();
    assert.equal(settled, false, "another DM completing its handshake must not finish this DM's waiter");
    client.timers.expire();
    assert.equal((await waitingForStockClient).cancelled, true);
    client.plugin.stop();
    third.plugin.stop();

    for (const action of ["stop", "account change", "reconnect"] as const) {
        const isolated = new Network();
        const owner = makeClient(A, isolated);
        const pending = owner.send(LONG);
        await isolated.flush();
        if (action === "stop") owner.plugin.stop();
        else if (action === "reconnect") owner.plugin.flux.CONNECTION_OPEN();
        else {
            owner.currentUser.id = "100000000000000004";
            owner.plugin.canBypassMessageLength(AB);
        }
        const result = await pending;
        assert.equal(result.cancelled, true, `${action} must cancel a pending send`);
        assert.equal(result.message.content, LONG);
        owner.plugin.stop();
        assert.equal(owner.events._shouldBypassMessageLengthLimit(), false, "stop unregisters length bypass");
        assert.equal((await owner.send(SHORT)).message.content, SHORT, "stop unregisters outgoing transforms");
    }
}

async function testUnsafeControlSources() {
    const network = new Network();
    const receiver = makeClient(A, network);
    const other = new receiver.session.CompressionSession();
    const content = other.prepareProbe({ channelId: AB, localId: B, peerId: A });
    assert.ok(content);
    const base = { channel_id: AB, author: { id: B }, content };
    for (const event of [
        { message: base, optimistic: true },
        { message: { ...base, author: { id: C } } },
        { message: { ...base, author: { id: B, bot: true } } },
        { message: { ...base, webhook_id: "100000000000000005" } },
        { message: { ...base, message_snapshots: [{}] } },
        { message: { ...base, messageSnapshots: [{}] } },
    ]) await receiver.plugin.flux.MESSAGE_CREATE(event);
    await network.flush();
    assert.equal(network.frames.length, 0, "optimistic, forged, bot, webhook and forwarded controls must be ignored");
    receiver.plugin.stop();
}

function testCapturedDiscordBoundaries() {
    const network = new Network();
    const client = makeClient(A, network);
    const encoded = codec.encodeCompressedMessage(LONG);
    assert.ok(encoded);
    const globals = { MessageCompression: client.plugin };
    const constructorPatch = client.plugin.patches.find((patch: any) => patch.find === "}addReaction(");
    const updatePatch = client.plugin.patches.find((patch: any) => patch.find === ".PREMIUM_REFERRAL&&(");
    const pastePatch = client.plugin.patches.find((patch: any) => patch.find === ".onHideAutocomplete?");
    assert.ok(constructorPatch && updatePatch && pastePatch);
    const constructor = applyPatch(discordMessageContentConstructor, constructorPatch, "MessageCompression");
    const createMessage = runInNewContext(`(input) => { class Message extends class {} { ${constructor} }; return new Message(input); }`, {
        ...globals, d: { lAJ: { DEFAULT: 0 } },
    });
    const stored = createMessage({ content: encoded.content });
    assert.equal(stored.content, LONG, "history/copy/reply/edit consumers see the decoded model field without a live session");
    assert.equal(createMessage({ content: "PCMC1:invalid" }).content, "PCMC1:invalid", "malformed remote content must not break model creation");
    assert.equal(createMessage({}).content, "", "preserve Discord's missing-content default");
    const partial = applyPatch(discordPartialContentUpdate, updatePatch, "MessageCompression");
    const update = runInNewContext(`(t) => { let n={content:"old",set(key,value){this[key]=value;return this;}};${partial};return n.content; }`, globals);
    assert.equal(update({ content: encoded.content }), LONG, "gateway edits must decode partial content updates");
    const pasteArguments = applyPatch(discordLongPasteArguments, pastePatch, "MessageCompression");
    const capture = runInNewContext(`(function(channelId){return (function(){return capture${pasteArguments};}).call({props:{channel:{id:channelId}}});})`, {
        ...globals, capture: (_clipboard: any, conversion: any) => conversion,
        e: { clipboardData: {} }, o: { uploadLongMessages: true }, a: "file-conversion", l: "fallback-conversion",
    });
    assert.equal(capture(AB), null, "eligible DM paste must reach compression instead of becoming a file");
    assert.equal(capture(GUILD), "file-conversion", "ordinary channel paste retains Discord's file conversion");
    client.plugin.stop();
    assert.equal(capture(AB), "file-conversion", "disabled plugin restores native paste handling");
    assert.equal(client.plugin.decodeContent(encoded.content), encoded.content);
    client.plugin.start();
    assert.equal(client.plugin.decodeContent(encoded.content), LONG, "reloading with no chat context still decodes historical data");
    client.plugin.stop();
}

async function main() {
    await testAutomaticSendAndEdit();
    await testOrdinaryContentAndPolicies();
    await testAbsentPeerAndCancellation();
    await testPendingIsolationAndLifecycle();
    await testUnsafeControlSources();
    testCapturedDiscordBoundaries();
    console.log("MessageCompression integration and current Discord fixtures passed.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
