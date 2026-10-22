/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
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
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, MessageStore, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

import { COMPRESSED_MESSAGE_PREFIX, decodeCompressedMessage, encodeCompressedMessage, MAX_WIRE_LENGTH } from "./codec";
import { CompressionPreview } from "./preview";

// Runs after existing security and text-formatting hooks.
const SEND_PRIORITY = -100;
const MAX_DECODE_CACHE_BYTES = 1024 * 1024;
const decodeCache = new Map<string, string | null>();
let decodedBytes = 0;
let active = false;
let ownerId: string | undefined;

const settings = definePluginSettings({
    showSavings: {
        type: OptionType.BOOLEAN,
        description: "Show how many message-body bytes were saved when a message is compressed.",
        default: true,
    },
});

function clearDecodeCache() {
    decodeCache.clear();
    decodedBytes = 0;
}

function isEligibleDM(channelId: string): boolean {
    if (!active) return false;
    const currentId = UserStore.getCurrentUser()?.id;
    if (currentId !== ownerId) {
        clearDecodeCache();
        ownerId = currentId;
    }
    if (!currentId) return false;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isDM()) return false;
    const peerId = channel.getRecipientId();
    return !!peerId && peerId !== currentId && !UserStore.getUser(peerId)?.bot;
}

function nativeMessageLimit() {
    return UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;
}

function tooLong() {
    Toasts.show({
        id: "pc-message-compression-too-long",
        message: "This message cannot fit. The compressed message must fit in 2,000 characters, or the original must fit your normal message limit. Your draft has been kept.",
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

function prepareContent(channelId: string, message: MessageObject, canCompress: boolean) {
    if (!isEligibleDM(channelId)) return;
    const original = message.content;
    const oversized = original.length > nativeMessageLimit();
    const candidate = canCompress && isPlainText(original) ? encodeCompressedMessage(original) : null;

    if (!candidate || candidate.content.length > MAX_WIRE_LENGTH) return oversized ? tooLong() : undefined;

    message.content = candidate.content;
    if (settings.store.showSavings) {
        Toasts.show({
            id: "pc-message-compression-savings",
            message: `Compressed message body: ${candidate.originalBytes.toLocaleString()} → ${candidate.encodedBytes.toLocaleString()} bytes (${(100 * (1 - candidate.encodedBytes / candidate.originalBytes)).toFixed(1)}% saved, ${candidate.codec}).`,
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
    return !!channelId && isEligibleDM(channelId);
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
    description: "Automatically compresses text in one-to-one DMs and reconstructs its exact original content.",
    authors: [EquicordDevs.nobody],
    tags: ["Chat", "Utility"],
    dependencies: ["MessageEventsAPI"],
    settings,
    settingsAboutComponent: () => <>
        <BaseText>Enable MessageCompression and chat normally in one-to-one DMs. Compression starts with your first eligible message; there is no handshake or waiting for the recipient.</BaseText>
        <BaseText>Every device used to read compressed messages needs this plugin. Other clients and Discord search see the encoded text. Links, mentions, attachments, stickers and replies keep normal sending.</BaseText>
        <CompressionPreview canCompress={isPlainText} />
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
        CONNECTION_OPEN() { clearDecodeCache(); },
        LOGOUT() {
            clearDecodeCache();
            ownerId = undefined;
        },
    },
    start() {
        active = true;
        ownerId = UserStore.getCurrentUser()?.id;
        clearDecodeCache();
        addMessagePreSendListener(outgoingListener, { priority: SEND_PRIORITY, cancelOnError: true });
        addMessagePreEditListener(editListener, { priority: SEND_PRIORITY, cancelOnError: true });
        addMessageLengthBypassListener(bypassMessageLengthLimit);
    },
    stop() {
        active = false;
        clearDecodeCache();
        ownerId = undefined;
        removeMessagePreSendListener(outgoingListener);
        removeMessagePreEditListener(editListener);
        removeMessageLengthBypassListener(bypassMessageLengthLimit);
    },
});
