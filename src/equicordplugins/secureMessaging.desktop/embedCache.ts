/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import type { Embed, Message } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Constants, RestAPI, UserStore } from "@webpack/common";

import type { SecureStickerItem } from "./attachments";
import { decryptCachedMessage, decryptCacheKey } from "./decryptCache";
import {
    extractSecureEmbedUrls,
    isSecureInlineMediaEmbedType,
    type SecureInlineEmbedStatus,
} from "./embedUrls";
import { preserveEncryptedMessageScroll } from "./layoutStability";
import type { DecryptIncomingResult } from "./native";
import { isEncryptedMessage } from "./protocol";
import { createTaskQueue } from "./taskQueue";

const convertEmbed = findByCodeLazy(".uniqueId(\"embed_\")") as (
    channelId: string,
    messageId: string,
    embed: Record<string, unknown>,
) => Embed | null;
const MAX_CACHE_ENTRIES = 256;
const MAX_UNFURL_CACHE_ENTRIES = 128;
const LOCAL_CONTENT_SCAN_VERSION = -1;
const EMBED_SUPPRESSED = 1 << 2;
const SUCCESSFUL_UNFURL_TTL = 30 * 60 * 1_000;
const EMPTY_UNFURL_TTL = 30_000;
const TRANSIENT_ENTRY_TTL = 30_000;
const UNFURL_RETRY_DELAYS = [0, 250, 1_000, 3_000] as const;

interface EmbedCacheEntry {
    embeds: Embed[];
    expiresAt: number;
    lastAccess: number;
    listeners: Set<() => void>;
    status: "loading" | "ready";
    stickers: SecureStickerItem[];
}

interface UnfurlCacheEntry {
    expiresAt: number;
    lastAccess: number;
    promise: Promise<Record<string, unknown>[]>;
    settled: boolean;
}

const cache = new Map<string, EmbedCacheEntry>();
const unfurlCache = new Map<string, UnfurlCacheEntry>();
const runUnfurlTask = createTaskQueue(4);
let cacheGeneration = 0;

function cacheKey(message: Message): string {
    return `${decryptCacheKey(UserStore.getCurrentUser()?.id ?? "", message)}\0${message.flags & EMBED_SUPPRESSED}`;
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

function notify(message: Message, entry: EmbedCacheEntry): void {
    const listeners = [...entry.listeners];
    entry.listeners.clear();
    preserveEncryptedMessageScroll(message, () => {
        for (const listener of listeners) {
            try {
                listener();
            } catch {
                // Discord may dispose a message renderer before an asynchronous unfurl finishes.
            }
        }
    });
}

function pruneCache(protectedKey: string, maximumEntries = MAX_CACHE_ENTRIES): void {
    while (cache.size > maximumEntries) {
        let oldestReady: [string, EmbedCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].status !== "ready") continue;
            if (!oldestReady || value[1].lastAccess < oldestReady[1].lastAccess) oldestReady = value;
        }
        if (!oldestReady) break;
        cache.delete(oldestReady[0]);
    }
}

function pruneUnfurlCache(protectedKey: string, now: number, maximumEntries = MAX_UNFURL_CACHE_ENTRIES): void {
    for (const [key, entry] of unfurlCache) {
        if (key !== protectedKey && entry.settled && entry.expiresAt <= now) unfurlCache.delete(key);
    }
    while (unfurlCache.size > maximumEntries) {
        let oldest: [string, UnfurlCacheEntry] | null = null;
        for (const value of unfurlCache) {
            if (value[0] === protectedKey || !value[1].settled) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
        if (!oldest) break;
        unfurlCache.delete(oldest[0]);
    }
}

async function requestUnfurl(
    url: string,
    generation: number,
    isCurrent: () => boolean,
): Promise<Record<string, unknown>[]> {
    for (const retryDelay of UNFURL_RETRY_DELAYS) {
        if (generation !== cacheGeneration || !isCurrent()) break;
        if (retryDelay > 0) await sleep(retryDelay);
        if (generation !== cacheGeneration || !isCurrent()) break;
        const embeds = await runUnfurlTask(async () => {
            if (generation !== cacheGeneration || !isCurrent()) return [];
            try {
                const response = await RestAPI.post({
                    url: Constants.Endpoints.UNFURL_EMBED_URLS,
                    body: { urls: [url] },
                    retries: 0,
                });
                return Array.isArray(response?.body?.embeds) ? response.body.embeds : [];
            } catch {
                return [];
            }
        });
        if (generation !== cacheGeneration || !isCurrent()) return [];
        if (embeds.length > 0) return embeds;
    }
    return [];
}

function unfurlUrl(url: string): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    const existing = unfurlCache.get(url);
    if (existing && (!existing.settled || existing.expiresAt > now)) {
        existing.lastAccess = now;
        return existing.promise;
    }
    if (existing) unfurlCache.delete(url);
    pruneUnfurlCache("", now, MAX_UNFURL_CACHE_ENTRIES - 1);
    if (unfurlCache.size >= MAX_UNFURL_CACHE_ENTRIES) return Promise.resolve([]);

    const entry: UnfurlCacheEntry = {
        expiresAt: Number.POSITIVE_INFINITY,
        lastAccess: now,
        promise: Promise.resolve([]),
        settled: false,
    };
    const generation = cacheGeneration;
    unfurlCache.set(url, entry);
    entry.promise = requestUnfurl(url, generation, () => unfurlCache.get(url) === entry).then(embeds => {
        if (unfurlCache.get(url) === entry) {
            const settledAt = Date.now();
            entry.expiresAt = settledAt + (embeds.length > 0 ? SUCCESSFUL_UNFURL_TTL : EMPTY_UNFURL_TTL);
            entry.lastAccess = settledAt;
            entry.settled = true;
            pruneUnfurlCache(url, settledAt);
        }
        return embeds;
    });
    return entry.promise;
}

async function unfurlEmbeds(urls: string[]): Promise<Record<string, unknown>[]> {
    return (await Promise.all(urls.map(unfurlUrl))).flat();
}

function entryIsCurrent(message: Message, key: string, entry: EmbedCacheEntry): boolean {
    if (cache.get(key) !== entry) return false;
    if (cacheKey(message) === key) return true;
    cache.delete(key);
    return false;
}

function finishEntry(message: Message, key: string, entry: EmbedCacheEntry, expiresAt = Number.POSITIVE_INFINITY): void {
    if (!entryIsCurrent(message, key, entry)) return;
    entry.expiresAt = expiresAt;
    entry.lastAccess = Date.now();
    entry.status = "ready";
    notify(message, entry);
    pruneCache(key);
}

async function loadEntry(message: Message, key: string, entry: EmbedCacheEntry): Promise<void> {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId || !message.author?.id) {
        finishEntry(message, key, entry);
        return;
    }
    let decrypted: DecryptIncomingResult;
    try {
        decrypted = await decryptCachedMessage(localUserId, message);
    } catch {
        finishEntry(message, key, entry, Date.now() + TRANSIENT_ENTRY_TTL);
        return;
    }
    if (!entryIsCurrent(message, key, entry)) return;
    if (decrypted.status !== "decrypted") {
        finishEntry(
            message,
            key,
            entry,
            decrypted.status === "failed" || decrypted.status === "unavailable"
                ? Date.now() + TRANSIENT_ENTRY_TTL
                : Number.POSITIVE_INFINITY,
        );
        return;
    }
    entry.stickers = decrypted.stickers ?? [];
    const urls = (message.flags & EMBED_SUPPRESSED) !== 0 ? [] : extractSecureEmbedUrls(decrypted.plaintext);
    if (urls.length === 0) {
        finishEntry(message, key, entry);
        return;
    }
    if (entry.stickers.length > 0) notify(message, entry);
    if (!entryIsCurrent(message, key, entry)) return;
    // Matching Discord's native previews requires disclosing only the extracted URLs to its unfurl service.
    const rawEmbeds = await unfurlEmbeds(urls);
    if (!entryIsCurrent(message, key, entry)) return;
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
    if (!entryIsCurrent(message, key, entry)) return;
    entry.embeds = converted;
    finishEntry(
        message,
        key,
        entry,
        converted.length > 0 ? Date.now() + SUCCESSFUL_UNFURL_TTL : Date.now() + EMPTY_UNFURL_TTL,
    );
}

function ensureEntry(message: Message): EmbedCacheEntry | null {
    if (!isEncryptedMessage(message.content)) return null;
    const key = cacheKey(message);
    const existing = cache.get(key);
    if (existing && (existing.status === "loading" || existing.expiresAt > Date.now())) {
        existing.lastAccess = Date.now();
        return existing;
    }
    if (existing) cache.delete(key);
    pruneCache("", MAX_CACHE_ENTRIES - 1);
    const entry: EmbedCacheEntry = {
        embeds: [],
        expiresAt: Number.POSITIVE_INFINITY,
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

export function encryptedMessageInlineEmbedStatus(message: Message): SecureInlineEmbedStatus {
    if (!isEncryptedMessage(message.content) || (message.flags & EMBED_SUPPRESSED) !== 0) return "absent";
    const entry = cache.get(cacheKey(message));
    if (!entry || entry.status === "loading" || entry.expiresAt <= Date.now()) return "pending";
    return entry.embeds.some(embed => isSecureInlineMediaEmbedType(embed.type))
        ? "present"
        : "absent";
}

export function patchEncryptedMessageStickers(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content)) return cloneWithStickers(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithStickers(message, entry.stickers);
}

export function clearEncryptedEmbedCache(): void {
    cacheGeneration++;
    cache.clear();
    unfurlCache.clear();
}

export async function prefetchEncryptedMessageEmbeds(plaintext: string): Promise<void> {
    const urls = extractSecureEmbedUrls(plaintext);
    if (urls.length > 0) await unfurlEmbeds(urls);
}
