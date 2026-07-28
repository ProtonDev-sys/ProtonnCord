/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Embed, Message } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Constants, RestAPI, UserStore } from "@webpack/common";

import type { SecureStickerItem } from "./attachments";
import { extractSecureEmbedUrls } from "./embedUrls";
import { discordEditedTimestamp } from "./messageMetadata";
import type { DecryptIncomingResult } from "./native";
import { isEncryptedMessage } from "./protocol";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const convertEmbed = findByCodeLazy(".uniqueId(\"embed_\")") as (
    channelId: string,
    messageId: string,
    embed: Record<string, unknown>,
) => Embed | null;
const MAX_CACHE_ENTRIES = 256;
const LOCAL_CONTENT_SCAN_VERSION = -1;

interface EmbedCacheEntry {
    embeds: Embed[];
    lastAccess: number;
    listeners: Set<() => void>;
    status: "loading" | "ready";
    stickers: SecureStickerItem[];
}

const cache = new Map<string, EmbedCacheEntry>();

function cacheKey(message: Message): string {
    return `${message.channel_id}\0${message.id}\0${message.author?.id ?? ""}\0${discordEditedTimestamp(message) ?? ""}\0${message.content}`;
}

function cloneWithEmbeds(message: Message, embeds: Embed[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.embeds = embeds;
    return clone;
}

function cloneWithStickers(message: Message, stickers: SecureStickerItem[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.stickerItems = stickers.map(sticker => ({
        format_type: sticker.formatType,
        id: sticker.id,
        name: sticker.name,
    }));
    return clone;
}

function notify(entry: EmbedCacheEntry): void {
    for (const listener of entry.listeners) {
        try {
            listener();
        } catch {
            // Discord may dispose a message renderer before an asynchronous unfurl finishes.
        }
    }
    entry.listeners.clear();
}

function pruneCache(protectedKey: string): void {
    while (cache.size > MAX_CACHE_ENTRIES) {
        let oldest: [string, EmbedCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].status === "loading") continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
        if (!oldest) break;
        cache.delete(oldest[0]);
    }
}

function finishEntry(key: string, entry: EmbedCacheEntry): void {
    if (cache.get(key) !== entry) return;
    entry.lastAccess = Date.now();
    entry.status = "ready";
    notify(entry);
    pruneCache(key);
}

async function loadEntry(message: Message, key: string, entry: EmbedCacheEntry): Promise<void> {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId || !message.author?.id) {
        finishEntry(key, entry);
        return;
    }
    let decrypted: DecryptIncomingResult;
    try {
        decrypted = await Native.decryptIncoming(localUserId, {
            channelId: message.channel_id,
            content: message.content,
            discordAuthorId: message.author.id,
            discordEditedTimestamp: discordEditedTimestamp(message),
            discordMessageId: message.id,
        });
    } catch {
        finishEntry(key, entry);
        return;
    }
    if (decrypted.status !== "decrypted") {
        finishEntry(key, entry);
        return;
    }
    entry.stickers = decrypted.stickers ?? [];
    const urls = extractSecureEmbedUrls(decrypted.plaintext);
    if (urls.length === 0) {
        finishEntry(key, entry);
        return;
    }
    let rawEmbeds: Record<string, unknown>[];
    try {
        // Matching Discord's native previews requires disclosing only the extracted URLs to its unfurl service.
        const response = await RestAPI.post({
            url: Constants.Endpoints.UNFURL_EMBED_URLS,
            body: { urls },
            retries: 2,
        });
        rawEmbeds = Array.isArray(response?.body?.embeds) ? response.body.embeds : [];
    } catch {
        rawEmbeds = [];
    }
    const converted: Embed[] = [];
    for (const rawEmbed of rawEmbeds) {
        try {
            const embed = convertEmbed(message.channel_id, message.id, {
                ...rawEmbed,
                // Discord cannot scan a preview that only exists after local authenticated decryption.
                content_scan_version: LOCAL_CONTENT_SCAN_VERSION,
            });
            if (embed) converted.push(embed);
        } catch {
            // One malformed response must not hide other Discord-provided embeds.
        }
    }
    if (cache.get(key) !== entry) return;
    entry.embeds = converted;
    finishEntry(key, entry);
}

function ensureEntry(message: Message): EmbedCacheEntry | null {
    if (!isEncryptedMessage(message.content)) return null;
    const key = cacheKey(message);
    const existing = cache.get(key);
    if (existing) {
        existing.lastAccess = Date.now();
        return existing;
    }
    const entry: EmbedCacheEntry = {
        embeds: [],
        lastAccess: Date.now(),
        listeners: new Set(),
        status: "loading",
        stickers: [],
    };
    cache.set(key, entry);
    void loadEntry(message, key, entry);
    return entry;
}

export function patchEncryptedMessageEmbeds(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content)) return cloneWithEmbeds(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithEmbeds(message, entry.status === "ready" ? entry.embeds : []);
}

export function patchEncryptedMessageStickers(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content)) return cloneWithStickers(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithStickers(message, entry.status === "ready" ? entry.stickers : []);
}

export function clearEncryptedEmbedCache(): void {
    cache.clear();
}
