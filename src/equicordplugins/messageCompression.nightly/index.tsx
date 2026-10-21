/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    _handlePreSend,
    addMessageLengthBypassListener,
    addMessagePreEditListener,
    addMessagePreSendListener,
    type MessageEditListener,
    type MessageObject,
    type MessageSendListener,
    removeMessageLengthBypassListener,
    removeMessagePreEditListener,
    removeMessagePreSendListener,
} from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { EquicordDevs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, MessageStore, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

import { COMPRESSED_MESSAGE_PREFIX, decodeCompressedMessage, encodeCompressedMessage, MAX_WIRE_LENGTH } from "./codec";
import { CompressionSession, CONTROL_MESSAGE_PREFIX, type PeerContext } from "./session";

// Runs after existing security and text-formatting hooks.
const SEND_PRIORITY = -100;
const HANDSHAKE_WAIT_MS = 2500;
const MAX_PENDING_CONTROLS = 16;
const MAX_DECODE_CACHE_BYTES = 1024 * 1024;
const logger = new Logger("MessageCompression");
const session = new CompressionSession();
const decodeCache = new Map<string, string | null>();
let decodedBytes = 0;
let active = false;
let generation = 0;
let ownerId: string | undefined;
let controls = { pending: 0, queue: Promise.resolve() };
const readinessWaiters = new Set<(force?: boolean) => void>();

const settings = definePluginSettings({
    showSavings: {
        type: OptionType.BOOLEAN,
        description: "Show how many message-body bytes were saved when a message is compressed.",
        default: false,
    },
});

function resetSession() {
    generation++;
    controls = { pending: 0, queue: Promise.resolve() };
    session.clear();
    decodeCache.clear();
    decodedBytes = 0;
    for (const finish of readinessWaiters) finish(true);
    readinessWaiters.clear();
}

function getPeer(channelId: string): PeerContext | null {
    if (!active) return null;
    const currentId = UserStore.getCurrentUser()?.id;
    if (currentId !== ownerId) {
        resetSession();
        ownerId = currentId;
    }
    if (!currentId) return null;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isDM()) return null;
    const peerId = channel.getRecipientId();
    if (!peerId || peerId === currentId || UserStore.getUser(peerId)?.bot) return null;
    return { channelId, localId: currentId, peerId };
}

function isCurrent(peer: PeerContext, expectedGeneration: number) {
    if (!active || generation !== expectedGeneration) return false;
    const current = getPeer(peer.channelId);
    return current?.localId === peer.localId && current.peerId === peer.peerId;
}

function nativeMessageLimit() {
    return UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;
}

function tooLong() {
    Toasts.show({
        id: "pc-message-compression-too-long",
        message: "This message cannot fit yet. Both clients need MessageCompression, and the encoded message must fit in 2,000 characters. Your draft has been kept.",
        type: Toasts.Type.FAILURE,
    });
    return { cancel: true } as const;
}

// Discord must still process these as ordinary text for pings, emoji and link previews.
function isPlainText(content: string) {
    return !!content
        && !/^(?:PCMC1:|PCMCAP1:|PCEM[123]:|PCEK1:)/u.test(content)
        && !/(?:<[@#]|<a?:[\w]+:\d+>|@(?:everyone|here)\b|https?:\/\/)/iu.test(content);
}

/** Control frames use the same send policies as the composer, without a plugin dependency. */
function queueControl(peer: PeerContext, content: string): Promise<boolean> {
    const queue = controls;
    if (queue.pending >= MAX_PENDING_CONTROLS) return Promise.resolve(false);
    const expectedGeneration = generation;
    queue.pending++;
    const task = queue.queue.then(async () => {
        if (!isCurrent(peer, expectedGeneration)) return false;
        const channel = ChannelStore.getChannel(peer.channelId);
        const message: MessageObject = { content, invalidEmojis: [], validNonShortcutEmojis: [], tts: false };
        const options = { channelId: peer.channelId, content, command: null, location: "MessageCompression" };
        const cancelled = await _handlePreSend(peer.channelId, message, options, {
            channel, content, hasAttachments: false, hasStickers: false,
            openWarningPopout: () => undefined,
        }, options);
        if (cancelled || message.content !== content || !isCurrent(peer, expectedGeneration)) return false;
        const result = await sendMessage(peer.channelId, message, true, {
            allowedMentions: { parse: [], replied_user: false },
        });
        return result?.ok !== false && isCurrent(peer, expectedGeneration);
    }).catch(error => {
        logger.error("Compatibility message failed.", error);
        return false;
    }).finally(() => { queue.pending--; });
    queue.queue = task.then(() => undefined);
    return task;
}

function waitForPeer(peer: PeerContext, expectedGeneration: number): Promise<boolean> {
    if (readinessWaiters.size >= MAX_PENDING_CONTROLS) return Promise.resolve(false);
    return new Promise(resolve => {
        const finish = (force = false) => {
            if (!force && isCurrent(peer, expectedGeneration) && !session.isReady(peer)) return;
            clearTimeout(timer);
            readinessWaiters.delete(finish);
            resolve(isCurrent(peer, expectedGeneration) && session.isReady(peer));
        };
        const timer = setTimeout(() => finish(true), HANDSHAKE_WAIT_MS);
        readinessWaiters.add(finish);
        if (session.isReady(peer)) finish();
    });
}

async function prepareContent(channelId: string, message: MessageObject, canCompress: boolean) {
    if (!active) return;
    if (message.content.startsWith(CONTROL_MESSAGE_PREFIX)) return message.content.length > nativeMessageLimit() ? tooLong() : undefined;
    const peer = getPeer(channelId);
    if (!peer) return;
    const expectedGeneration = generation;
    const original = message.content;
    const oversized = original.length > nativeMessageLimit();
    const candidate = canCompress && isPlainText(original) ? encodeCompressedMessage(original) : null;

    if (!candidate || candidate.content.length > MAX_WIRE_LENGTH) return oversized ? tooLong() : undefined;

    if (!session.isReady(peer)) {
        const probe = session.prepareProbe(peer);
        if (probe) void queueControl(peer, probe);
        // A normal first message is never held up by peer discovery.
        if (!oversized) return;
        await waitForPeer(peer, expectedGeneration);
    }
    if (!isCurrent(peer, expectedGeneration)) return { cancel: true };
    if (!session.isReady(peer)) return oversized ? tooLong() : undefined;

    message.content = candidate.content;
    if (settings.store.showSavings) {
        Toasts.show({
            id: "pc-message-compression-savings",
            message: `Compressed message body: ${candidate.originalBytes.toLocaleString()} → ${candidate.encodedBytes.toLocaleString()} bytes (${candidate.codec}).`,
            type: Toasts.Type.SUCCESS,
        });
    }
    return { stop: true };
}

const outgoingListener: MessageSendListener = (channelId, message, options, props) => prepareContent(
    channelId,
    message,
    !message.tts
        && !message.validNonShortcutEmojis?.length
        && !props.hasAttachments
        && !props.hasStickers
        && !options.attachmentsToUpload?.length
        && !options.uploads?.length
        && !options.stickerIds?.length
        && !options.stickers?.length
        && !options.command
        && !options.messageReference
        && !options.alsoForwardToChannelId
        && !options.scheduledTimestamp
        && !options.mediaMention
        && !options.isGif,
);

const editListener: MessageEditListener = (channelId, messageId, message) => {
    const existing = MessageStore.getMessage(channelId, messageId);
    return prepareContent(channelId, message, !!existing
        && existing.author?.id === UserStore.getCurrentUser()?.id
        && !existing.attachments?.length
        && !existing.stickerItems?.length
        && !existing.messageReference
        && !message.tts);
};

function canBypassMessageLength(channelId = SelectedChannelStore.getChannelId()) {
    return !!channelId && !!getPeer(channelId);
}

const bypassMessageLengthLimit = () => canBypassMessageLength();

function decodeContent(content: string): string {
    if (!active || typeof content !== "string" || !content.startsWith(COMPRESSED_MESSAGE_PREFIX) || content.length > MAX_WIRE_LENGTH) return content;
    if (decodeCache.has(content)) return decodeCache.get(content) ?? content;
    let decoded: string | null;
    try {
        decoded = decodeCompressedMessage(content);
    } catch {
        // Malformed input must never interrupt construction of Discord's message model.
        decoded = null;
    }
    const cost = (content.length + (decoded?.length ?? 0)) * 2;
    while (decodeCache.size && (decodedBytes + cost > MAX_DECODE_CACHE_BYTES || decodeCache.size >= 128)) {
        const [key, value] = decodeCache.entries().next().value!;
        decodedBytes -= (key.length + (value?.length ?? 0)) * 2;
        decodeCache.delete(key);
    }
    decodeCache.set(content, decoded);
    decodedBytes += cost;
    return decoded ?? content;
}

export default definePlugin({
    name: "MessageCompression",
    description: "Automatically compresses text in one-to-one DMs between compatible clients using exact, self-contained recipes.",
    authors: [EquicordDevs.nobody],
    tags: ["Chat", "Utility"],
    dependencies: ["MessageEventsAPI"],
    settings,
    settingsAboutComponent: () => <>
        <BaseText>Enable MessageCompression on every client used to read this DM, then chat normally. Compatibility is checked automatically with a short visible message when compression could help.</BaseText>
        <BaseText>Compressed messages keep their exact text and reopen without earlier chat history. Other clients and Discord search see the encoded message. Links, mentions, attachments, stickers and replies keep normal sending.</BaseText>
    </>,
    patches: [{
        // Decode at the message model boundary, so history, copy, edits and replies agree.
        find: "}addReaction(",
        replacement: {
            match: /this\.content=(\i)\.content/,
            replace: "this.content=$self.decodeContent($1.content)",
        },
    }, {
        // A partial gateway update can set content without constructing a new model.
        find: ".PREMIUM_REFERRAL&&(",
        replacement: {
            match: /\.set\("content",(\i)\.content\)/,
            replace: '.set("content",$self.decodeContent($1.content))',
        },
    }, {
        // Leave the file-conversion condition intact for SplitLargeMessages compatibility.
        find: ".onHideAutocomplete?",
        replacement: {
            match: /(\i)\.uploadLongMessages\?/,
            replace: "($1.uploadLongMessages&&!$self.canBypassMessageLength(this.props.channel?.id))?",
        },
    }],
    decodeContent,
    canBypassMessageLength,
    flux: {
        async MESSAGE_CREATE({ message, optimistic }) {
            if (!active || optimistic || typeof message?.content !== "string" || !message.content.startsWith(CONTROL_MESSAGE_PREFIX)) return;
            const peer = getPeer(message.channel_id);
            if (!peer || message.author?.id !== peer.peerId || message.author?.bot || message.webhook_id || message.webhookId
                || message.message_snapshots?.length || message.messageSnapshots?.length
                || message.message_reference || message.messageReference) return;
            const result = session.handleControl(message.content, peer);
            if (result?.reply) await queueControl(peer, result.reply);
            for (const finish of readinessWaiters) finish();
        },
        CONNECTION_OPEN() { resetSession(); },
        LOGOUT() {
            resetSession();
            ownerId = undefined;
        },
    },
    start() {
        active = true;
        ownerId = UserStore.getCurrentUser()?.id;
        resetSession();
        addMessagePreSendListener(outgoingListener, { priority: SEND_PRIORITY, cancelOnError: true });
        addMessagePreEditListener(editListener, { priority: SEND_PRIORITY, cancelOnError: true });
        addMessageLengthBypassListener(bypassMessageLengthLimit);
    },
    stop() {
        active = false;
        resetSession();
        ownerId = undefined;
        removeMessagePreSendListener(outgoingListener);
        removeMessagePreEditListener(editListener);
        removeMessageLengthBypassListener(bypassMessageLengthLimit);
    },
});
