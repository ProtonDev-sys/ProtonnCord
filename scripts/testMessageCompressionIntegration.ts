/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import * as codec from "../src/equicordplugins/messageCompression.nightly/codec";
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
const LONG = "This longer message should compress on the first send without waiting for the recipient. ".repeat(60);
const indexFile = new URL("../src/equicordplugins/messageCompression.nightly/index.tsx", import.meta.url);
const eventsFile = new URL("../src/api/MessageEvents.ts", import.meta.url);

class TestLogger {
    error() { }
}

// A direct transport call would mean the plugin sent an extra control message.
// Normal sends in this fixture stop at the real MessageEvents composer boundary.
class Network {
    frames: { from: string; channelId: string; content: string; }[] = [];

    send(from: string, channelId: string, message: { content: string; }) {
        this.frames.push({ from, channelId, content: message.content });
        return Promise.resolve({ ok: true });
    }
}

function makeClient(id: string, network: Network) {
    const currentUser = { id, premiumType: 0 };
    const stored = new Map<string, any>();
    const toasts: any[] = [];
    const bots = new Set<string>();
    let selected = AB;
    let loggedIn = true;
    const getChannel = (channelId: string) => ({
        id: channelId,
        isDM: () => channelId === AB || channelId === AC,
        getRecipientId: () => channelId === AB ? (currentUser.id === A ? B : A) : (currentUser.id === A ? C : A),
    });
    const MessageStore = { getMessage: (channelId: string, messageId: string) => stored.get(`${channelId}:${messageId}`) };
    const common = {
        ChannelStore: { getChannel }, MessageStore,
        SelectedChannelStore: { getChannelId: () => selected },
        UserStore: { getCurrentUser: () => loggedIn ? currentUser : undefined, getUser: (userId: string) => ({ id: userId, bot: bots.has(userId) }) },
        Toasts: { show: (toast: any) => toasts.push(toast), Type: { FAILURE: 1, SUCCESS: 2 } },
    };
    const events = loadTestModule<any>(eventsFile, {
        "@utils/Logger": { Logger: TestLogger }, "@webpack/common": common,
    }, {});
    const plugin = loadTestModule<any>(indexFile, {
        "@api/MessageEvents": events,
        "@api/Settings": { definePluginSettings: (definitions: any) => ({ store: Object.fromEntries(Object.entries(definitions).map(([key, value]: any) => [key, value.default])) }) },
        "@components/BaseText": { BaseText: () => undefined },
        "@utils/constants": { EquicordDevs: { nobody: {} } },
        "@utils/discord": { sendMessage: (channelId: string, message: any) => network.send(currentUser.id, channelId, message) },
        "@utils/Logger": { Logger: TestLogger },
        "@utils/types": { __esModule: true, default: (definition: any) => definition, OptionType: { BOOLEAN: 1 } },
        "@webpack/common": common,
        "./codec": codec,
        "./preview": { CompressionPreview: () => null },
    }, {}).default;

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

    plugin.start();
    return { plugin, events, currentUser, toasts, bots, send, edit, select: (channelId: string) => { selected = channelId; }, setLoggedIn: (value: boolean) => { loggedIn = value; } };
}

async function assertNoExtraMessages(network: Network) {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(network.frames, [], "enabling compression must not send handshakes or other extra messages");
}

async function testFirstSendAndEditWithoutPeer() {
    const network = new Network();
    const first = makeClient(A, network);
    assert.equal(first.plugin.settings.store.showSavings, true, "savings are visible by default for this experiment");
    first.plugin.settings.store.showSavings = true;
    let downstreamRan = false;
    first.events.addMessagePreSendListener(() => { downstreamRan = true; }, { priority: -200 });
    const initial = await first.send(SHORT);
    assert.equal(initial.cancelled, false);
    assert.equal(codec.decodeCompressedMessage(initial.message.content), SHORT, "the first message compresses without a recipient client or earlier chat");
    assert.equal(downstreamRan, false, "encoded content must not be transformed by later listeners");
    assert.ok(first.toasts.some(toast => toast.type === 2 && /bytes/u.test(toast.message)), "savings are observable when enabled");

    first.plugin.settings.store.showSavings = false;
    const toastCount = first.toasts.length;
    const sent = await first.send(LONG);
    assert.equal(sent.cancelled, false);
    assert.ok(sent.message.content.length <= codec.MAX_WIRE_LENGTH);
    assert.equal(codec.decodeCompressedMessage(sent.message.content), LONG, "oversized text also compresses immediately");
    assert.equal(first.toasts.length, toastCount, "hiding savings does not disable compression");

    const second = makeClient(B, network);
    assert.equal(second.plugin.decodeContent(sent.message.content), LONG, "a freshly enabled recipient can decode the self-contained packet");
    const edited = await second.edit(LONG + "Edited.");
    assert.equal(edited.cancelled, false);
    assert.equal(codec.decodeCompressedMessage(edited.message.content), LONG + "Edited.", "the first edit does not require a previous send");
    const reverse = await second.send(SHORT);
    assert.equal(codec.decodeCompressedMessage(reverse.message.content), SHORT);
    const foreign = await first.edit(SHORT, { author: { id: B } });
    assert.equal(foreign.message.content, SHORT, "another author's edit must never be transformed");
    await assertNoExtraMessages(network);
    first.plugin.stop();
    second.plugin.stop();
}

async function testOrdinaryContentAndPolicies() {
    const network = new Network();
    const first = makeClient(A, network);
    const scenarios = [
        { content: "hello" },
        { content: `https://example.invalid/ ${SHORT}` },
        { content: `<@${B}> ${SHORT}` },
        { content: `@everyone ${SHORT}` },
        { content: `<:wave:100000000000000004> ${SHORT}` },
        { content: `PCEM3:${SHORT}` },
        { content: `PCEK1:${SHORT}` },
        { content: `PCMCAP1:${SHORT}` },
        { content: SHORT, props: { hasAttachments: true } },
        { content: SHORT, props: { hasStickers: true } },
        { content: SHORT, message: { tts: true } },
        { content: SHORT, message: { validNonShortcutEmojis: [{}] } },
        { content: SHORT, options: { uploads: [{}] } },
        { content: SHORT, options: { attachmentsToUpload: [{}] } },
        { content: SHORT, options: { messageReference: { message_id: "100000000000000009" } } },
        { content: SHORT, options: { command: {} } },
        { content: SHORT, options: { alsoForwardToChannelId: AC } },
        { content: SHORT, options: { scheduledTimestamp: 123 } },
    ];
    for (const scenario of scenarios) {
        const result = await first.send(scenario.content, AB, scenario);
        assert.equal(result.cancelled, false);
        assert.equal(result.message.content, scenario.content, "Discord-visible semantics and unhelpful compression must retain ordinary text");
    }
    const alreadyEncoded = codec.encodeCompressedMessage(SHORT)!;
    assert.equal((await first.send(alreadyEncoded.content)).message.content, alreadyEncoded.content, "packets are never compressed again");
    assert.equal((await first.send(SHORT, GUILD)).message.content, SHORT, "compression is limited to one-to-one DMs");
    first.bots.add(B);
    assert.equal((await first.send(SHORT)).message.content, SHORT, "bot DMs retain ordinary text");
    first.bots.delete(B);
    const blockedEdit = await first.edit(SHORT, { attachments: [{}] });
    assert.equal(blockedEdit.message.content, SHORT);
    first.events.addMessagePreSendListener((_channel: string, message: any) => { message.content += " formatted"; }, { priority: 0 });
    const formatted = await first.send(SHORT);
    assert.equal(codec.decodeCompressedMessage(formatted.message.content), SHORT + " formatted", "compression follows existing text formatters");
    await assertNoExtraMessages(network);
    first.plugin.stop();
}

function randomText(length: number) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let state = 0x3f28b916;
    return Array.from({ length }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return alphabet[(state >>> 0) % alphabet.length];
    }).join("");
}

async function testLengthFallbackAndUnicode() {
    const network = new Network();
    const client = makeClient(A, network);
    const cannotFit = randomText(8000);
    assert.equal(codec.encodeCompressedMessage(cannotFit), null, "the fixture must not fit the wire limit");
    for (const content of [cannotFit, `https://example.invalid/ ${LONG}`, "x".repeat(codec.MAX_DECOMPRESSED_BYTES + 1)]) {
        const result = await client.send(content);
        assert.equal(result.cancelled, true, "an oversized message that cannot be encoded must preserve its draft");
        assert.equal(result.message.content, content);
    }
    assert.ok(client.toasts.some(toast => toast.type === 1));
    client.currentUser.premiumType = 2;
    const premiumText = randomText(3000);
    assert.equal(codec.encodeCompressedMessage(premiumText), null);
    const premium = await client.send(premiumText);
    assert.equal(premium.cancelled, false, "a native-limit message may remain uncompressed");
    assert.equal(premium.message.content, premiumText);

    const unicode = "Résumé — 明日の予定 ☕ 👩🏽‍💻\r\nCafe\u0301\u0000\ufeff ".repeat(80);
    const encoded = await client.send(unicode);
    assert.equal(encoded.cancelled, false);
    assert.equal(codec.decodeCompressedMessage(encoded.message.content), unicode, "message hooks preserve exact Unicode, CRLF and embedded controls");
    await assertNoExtraMessages(network);
    client.plugin.stop();
}

async function testCancellationAndLifecycle() {
    const network = new Network();
    const client = makeClient(A, network);
    const cancel = client.events.addMessagePreSendListener(() => ({ cancel: true }), { priority: 100 });
    const cancelled = await client.send(SHORT);
    assert.equal(cancelled.cancelled, true, "existing send policies can cancel before compression");
    assert.equal(cancelled.message.content, SHORT);
    client.events.removeMessagePreSendListener(cancel);

    assert.equal(client.events._shouldBypassMessageLengthLimit(), true);
    client.select(GUILD);
    assert.equal(client.events._shouldBypassMessageLengthLimit(), false);
    client.select(AB);
    client.plugin.stop();
    assert.equal(client.events._shouldBypassMessageLengthLimit(), false, "stop unregisters length bypass");
    assert.equal((await client.send(SHORT)).message.content, SHORT, "stop unregisters outgoing transforms");
    assert.equal((await client.edit(SHORT)).message.content, SHORT, "stop unregisters edit transforms");
    client.plugin.start();
    assert.equal(codec.decodeCompressedMessage((await client.send(SHORT)).message.content), SHORT, "reenabling needs no discovery");
    client.setLoggedIn(false);
    assert.equal(client.events._shouldBypassMessageLengthLimit(), false);
    assert.equal((await client.send(SHORT)).message.content, SHORT, "a logged-out client cannot transform outgoing text");
    client.currentUser.id = C;
    client.setLoggedIn(true);
    assert.equal(codec.decodeCompressedMessage((await client.send(SHORT, AC)).message.content), SHORT, "changing accounts does not require prior peer state");

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    client.events.addMessagePreSendListener(() => gate, { priority: 100 });
    const pending = client.send(SHORT, AC);
    client.plugin.stop();
    release();
    const afterStop = await pending;
    assert.equal(afterStop.message.content, SHORT, "disabling while an earlier hook waits must not run a removed compression listener");
    await assertNoExtraMessages(network);
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
    assert.equal(stored.content, LONG, "history/copy/reply/edit consumers see the decoded model field without prior chat state");
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
    await testFirstSendAndEditWithoutPeer();
    await testOrdinaryContentAndPolicies();
    await testLengthFallbackAndUnicode();
    await testCancellationAndLifecycle();
    testCapturedDiscordBoundaries();
    console.log("MessageCompression integration and current Discord fixtures passed.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
