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
const parseCodedLinks = findByCodeLazy("inviteHostRemainingPath:", ".slice(0,10)") as (
    content: string,
) => Array<Message["codedLinks"][number] & { url: string; }>;
const MAX_CACHE_ENTRIES = 256;
const MAX_UNFURL_CACHE_ENTRIES = 128;
const LOCAL_CONTENT_SCAN_VERSION = -1;
const EMBED_SUPPRESSED = 1 << 2;
const SUCCESSFUL_UNFURL_TTL = 30 * 60 * 1_000;
const EMPTY_UNFURL_TTL = 30_000;
const TRANSIENT_ENTRY_TTL = 30_000;
const UNFURL_RETRY_DELAYS = [0, 250, 1_000, 3_000] as const;
const UNFURL_REQUEST_TIMEOUT = 10_000;

interface EmbedCacheEntry {
    codedLinks: ReturnType<typeof parseCodedLinks>;
    embeds: Embed[];
    embedsByUrl: Map<string, Embed[]>;
    expiresAt: number;
    lastAccess: number;
    listeners: Set<() => void>;
    status: "loading" | "ready";
    stickers: SecureStickerItem[];
    retryTimer: ReturnType<typeof setTimeout> | null;
    autoRetryRemaining: number;
}

interface UnfurlCacheEntry {
    embeds: Record<string, unknown>[];
    expiresAt: number;
    lastAccess: number;
    promise: Promise<Record<string, unknown>[]>;
    settled: boolean;
    cancelRequest?: () => void;
}

const cache = new Map<string, EmbedCacheEntry>();
const unfurlCache = new Map<string, UnfurlCacheEntry>();
const capacityListeners = new Set<() => void>();
const runUnfurlTask = createTaskQueue(4);
let cacheGeneration = 0;
let externalLinkPreviewsEnabled = false;

export function setExternalLinkPreviewsEnabled(enabled: boolean): void {
    if (externalLinkPreviewsEnabled === enabled) return;
    externalLinkPreviewsEnabled = enabled;
    clearEncryptedEmbedCache();
}

function cacheKey(message: Message): string {
    return `${decryptCacheKey(UserStore.getCurrentUser()?.id ?? "", message)}\0${message.flags & EMBED_SUPPRESSED}`;
}

function cloneWithEmbeds(message: Message, embeds: Embed[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.embeds = embeds;
    return clone;
}

function cloneWithCodedLinks(message: Message, codedLinks: Message["codedLinks"]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.codedLinks = codedLinks;
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

function notify(message: Message, entry: EmbedCacheEntry, clearListeners = true): void {
    const listeners = [...entry.listeners];
    if (clearListeners) entry.listeners.clear();
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

function removeEntry(key: string, entry: EmbedCacheEntry): void {
    cache.delete(key);
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.listeners.clear();
}

function pruneCache(protectedKey: string, maximumEntries = MAX_CACHE_ENTRIES): void {
    while (cache.size > maximumEntries) {
        let oldestReady: [string, EmbedCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].status !== "ready") continue;
            if (!oldestReady || value[1].lastAccess < oldestReady[1].lastAccess) oldestReady = value;
        }
        if (!oldestReady) break;
        removeEntry(...oldestReady);
    }
}

function pruneUnfurlCache(protectedKey: string, now: number, maximumEntries = MAX_UNFURL_CACHE_ENTRIES): void {
    for (const [key, entry] of unfurlCache) {
        if (key !== protectedKey && entry.settled && entry.embeds.length === 0 && entry.expiresAt <= now) unfurlCache.delete(key);
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
    entry: UnfurlCacheEntry,
    generation: number,
    isCurrent: () => boolean,
): Promise<Record<string, unknown>[]> {
    let timedOut = false;
    for (const retryDelay of UNFURL_RETRY_DELAYS) {
        if (!externalLinkPreviewsEnabled || generation !== cacheGeneration || !isCurrent()) break;
        if (retryDelay > 0) await sleep(retryDelay);
        if (!externalLinkPreviewsEnabled || generation !== cacheGeneration || !isCurrent()) break;
        const embeds = await runUnfurlTask(async () => {
            if (!externalLinkPreviewsEnabled || generation !== cacheGeneration || !isCurrent()) return [];
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                // Discord's REST wrapper has no abort API. Bound our queue slot and ignore late responses.
                return await Promise.race([
                    RestAPI.post({
                        url: Constants.Endpoints.UNFURL_EMBED_URLS,
                        body: { urls: [url] },
                        retries: 0,
                    }).then(response => Array.isArray(response?.body?.embeds) ? response.body.embeds as Record<string, unknown>[] : []),
                    new Promise<Record<string, unknown>[]>(resolve => {
                        entry.cancelRequest = () => resolve([]);
                        timeout = setTimeout(() => {
                            timedOut = true;
                            resolve([]);
                        }, UNFURL_REQUEST_TIMEOUT);
                    }),
                ]);
            } catch {
                return [];
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
                entry.cancelRequest = undefined;
            }
        });
        if (generation !== cacheGeneration || !isCurrent()) return [];
        if (embeds.length > 0) return embeds;
        // Retrying a timed-out transport would pile up requests the REST wrapper cannot cancel.
        if (timedOut) break;
    }
    return [];
}

function unfurlUrl(url: string): Promise<Record<string, unknown>[]> {
    if (!externalLinkPreviewsEnabled) return Promise.resolve([]);
    const now = Date.now();
    const existing = unfurlCache.get(url);
    if (existing && (!existing.settled || existing.expiresAt > now)) {
        existing.lastAccess = now;
        return existing.promise;
    }
    pruneUnfurlCache("", now, MAX_UNFURL_CACHE_ENTRIES - 1);
    if (!existing && unfurlCache.size >= MAX_UNFURL_CACHE_ENTRIES) return Promise.resolve([]);

    const entry: UnfurlCacheEntry = {
        embeds: existing?.embeds ?? [],
        expiresAt: Number.POSITIVE_INFINITY,
        lastAccess: now,
        promise: Promise.resolve([]),
        settled: false,
    };
    const generation = cacheGeneration;
    unfurlCache.set(url, entry);
    entry.promise = requestUnfurl(url, entry, generation, () => unfurlCache.get(url) === entry).then(embeds => {
        if (generation === cacheGeneration && unfurlCache.get(url) === entry) {
            const settledAt = Date.now();
            entry.expiresAt = settledAt + (embeds.length > 0 ? SUCCESSFUL_UNFURL_TTL : EMPTY_UNFURL_TTL);
            entry.lastAccess = settledAt;
            entry.settled = true;
            if (embeds.length > 0) entry.embeds = embeds;
            pruneUnfurlCache(url, settledAt);
        }
        return generation === cacheGeneration && unfurlCache.get(url) === entry ? entry.embeds : [];
    });
    return entry.promise;
}

function entryIsCurrent(message: Message, key: string, entry: EmbedCacheEntry): boolean {
    if (cache.get(key) !== entry) return false;
    if (cacheKey(message) === key) return true;
    removeEntry(key, entry);
    return false;
}

function finishEntry(message: Message, key: string, entry: EmbedCacheEntry, expiresAt = Number.POSITIVE_INFINITY, retry = false): void {
    if (!entryIsCurrent(message, key, entry)) return;
    entry.expiresAt = expiresAt;
    entry.lastAccess = Date.now();
    entry.status = "ready";
    for (const listener of capacityListeners) entry.listeners.add(listener);
    capacityListeners.clear();
    const listeners = retry && entry.autoRetryRemaining > 0 ? [...entry.listeners] : [];
    notify(message, entry);
    if (listeners.length > 0 && entryIsCurrent(message, key, entry)) {
        entry.autoRetryRemaining--;
        for (const listener of listeners) entry.listeners.add(listener);
        // Wake mounted consumers once; disposed renderers cannot start another request.
        entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            if (entryIsCurrent(message, key, entry)) notify(message, entry);
        }, Math.max(0, expiresAt - Date.now()));
    }
    pruneCache(key);
}

function convertEmbeds(message: Message, rawEmbeds: Record<string, unknown>[]): Embed[] {
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
    return converted;
}

function eligibleUnfurlUrls(urls: string[], codedLinks: ReturnType<typeof parseCodedLinks>): string[] {
    const inviteUrls = new Set(codedLinks.map(link => link.url));
    return urls.filter(url => !inviteUrls.has(url));
}

function inviteLinks(urls: string[]): ReturnType<typeof parseCodedLinks> {
    try {
        return parseCodedLinks(urls.join("\n")).filter(link => link.type === "INVITE");
    } catch {
        // A changed host parser must not prevent ordinary link or sticker previews.
        return [];
    }
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
        entry.embeds = [];
        entry.embedsByUrl.clear();
        entry.codedLinks = [];
        entry.stickers = [];
        finishEntry(message, key, entry, Date.now() + TRANSIENT_ENTRY_TTL, true);
        return;
    }
    if (!entryIsCurrent(message, key, entry)) return;
    if (decrypted.status !== "decrypted") {
        entry.embeds = [];
        entry.embedsByUrl.clear();
        entry.codedLinks = [];
        entry.stickers = [];
        finishEntry(
            message,
            key,
            entry,
            decrypted.status === "failed" || decrypted.status === "unavailable"
                ? Date.now() + TRANSIENT_ENTRY_TTL
                : Number.POSITIVE_INFINITY,
            decrypted.status === "failed" || decrypted.status === "unavailable",
        );
        return;
    }
    entry.stickers = decrypted.stickers ?? [];
    const urls = !externalLinkPreviewsEnabled || (message.flags & EMBED_SUPPRESSED) !== 0 ? [] : extractSecureEmbedUrls(decrypted.plaintext);
    if (urls.length === 0) {
        finishEntry(message, key, entry);
        return;
    }
    // Invite cards use codedLinks, not the generic unfurl endpoint.
    entry.codedLinks = inviteLinks(urls);
    const unfurlUrls = eligibleUnfurlUrls(urls, entry.codedLinks);
    for (const url of unfurlUrls) {
        if (!entry.embedsByUrl.has(url)) {
            const rawEmbeds = unfurlCache.get(url)?.embeds;
            if (rawEmbeds?.length) entry.embedsByUrl.set(url, convertEmbeds(message, rawEmbeds));
        }
    }
    entry.embeds = unfurlUrls.flatMap(url => entry.embedsByUrl.get(url) ?? []);
    if (entry.embeds.length > 0 || entry.stickers.length > 0 || entry.codedLinks.length > 0) notify(message, entry, false);
    if (!entryIsCurrent(message, key, entry)) return;
    // Matching Discord's native previews requires disclosing only the extracted URLs to its unfurl service.
    let remaining = unfurlUrls.length;
    let expiresAt = Date.now() + SUCCESSFUL_UNFURL_TTL;
    let retry = false;
    await Promise.all(unfurlUrls.map(async url => {
        const rawEmbeds = await unfurlUrl(url);
        if (!entryIsCurrent(message, key, entry)) return;
        const converted = convertEmbeds(message, rawEmbeds);
        if (!entryIsCurrent(message, key, entry)) return;
        const urlExpiresAt = converted.length > 0 ? unfurlCache.get(url)?.expiresAt ?? Date.now() + EMPTY_UNFURL_TTL : Date.now() + EMPTY_UNFURL_TTL;
        expiresAt = Math.min(expiresAt, urlExpiresAt);
        retry ||= urlExpiresAt <= Date.now() + EMPTY_UNFURL_TTL;
        if (converted.length > 0) entry.embedsByUrl.set(url, converted);
        entry.embeds = unfurlUrls.flatMap(value => entry.embedsByUrl.get(value) ?? []);
        // Publish available previews without waiting for an unrelated URL's retries.
        // Indexing by input URL preserves message order even when requests finish out of order.
        if (--remaining > 0 && converted.length > 0) notify(message, entry, false);
    }));
    if (!entryIsCurrent(message, key, entry)) return;
    finishEntry(
        message,
        key,
        entry,
        expiresAt,
        retry,
    );
}

function ensureEntry(message: Message, onReady: () => void): EmbedCacheEntry | null {
    if (!isEncryptedMessage(message.content)) return null;
    const key = cacheKey(message);
    const existing = cache.get(key);
    if (existing && (existing.status === "loading" || existing.expiresAt > Date.now())) {
        existing.lastAccess = Date.now();
        return existing;
    }
    if (existing) {
        if (existing.retryTimer !== null) clearTimeout(existing.retryTimer);
        existing.retryTimer = null;
        existing.status = "loading";
        existing.lastAccess = Date.now();
        void loadEntry(message, key, existing);
        return existing;
    }
    pruneCache("", MAX_CACHE_ENTRIES - 1);
    const entry: EmbedCacheEntry = {
        codedLinks: [],
        embeds: [],
        embedsByUrl: new Map(),
        expiresAt: Number.POSITIVE_INFINITY,
        lastAccess: Date.now(),
        listeners: new Set(),
        status: "loading",
        stickers: [],
        retryTimer: null,
        autoRetryRemaining: 1,
    };
    if (cache.size >= MAX_CACHE_ENTRIES) {
        // Wake denied consumers when an in-flight entry settles and becomes evictable.
        capacityListeners.add(onReady);
        return { ...entry, status: "ready", expiresAt: Date.now() };
    }
    cache.set(key, entry);
    void loadEntry(message, key, entry);
    return entry;
}

export function patchEncryptedMessageEmbeds(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content)) return cloneWithEmbeds(message, []);
    const entry = ensureEntry(message, onReady);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithEmbeds(message, entry.embeds);
}

export function patchEncryptedMessageCodedLinks(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!isEncryptedMessage(message.content)) return message;
    if (!canDecrypt) return cloneWithCodedLinks(message, []);
    const entry = ensureEntry(message, onReady);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithCodedLinks(message, entry.codedLinks);
}

export function encryptedMessageInlineEmbedStatus(message: Message): SecureInlineEmbedStatus {
    if (!externalLinkPreviewsEnabled) return "absent";
    if (!isEncryptedMessage(message.content) || (message.flags & EMBED_SUPPRESSED) !== 0) return "absent";
    const entry = cache.get(cacheKey(message));
    if (!entry) return "pending";
    if (entry.embeds.some(embed => isSecureInlineMediaEmbedType(embed.type))) return "present";
    return entry.status === "loading" || entry.expiresAt <= Date.now() ? "pending" : "absent";
}

export function patchEncryptedMessageStickers(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content)) return cloneWithStickers(message, []);
    const entry = ensureEntry(message, onReady);
    if (!entry) return message;
    if (entry.status === "loading") entry.listeners.add(onReady);
    return cloneWithStickers(message, entry.stickers);
}

export function clearEncryptedEmbedCache(preserveUnfurls = false): void {
    cacheGeneration++;
    capacityListeners.clear();
    for (const [key, entry] of cache) removeEntry(key, entry);
    for (const [url, entry] of unfurlCache) {
        entry.cancelRequest?.();
        if (!preserveUnfurls || entry.embeds.length === 0) unfurlCache.delete(url);
        else {
            unfurlCache.set(url, {
                embeds: entry.embeds,
                expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : Date.now(),
                lastAccess: entry.lastAccess,
                settled: true,
                promise: Promise.resolve(entry.embeds),
            });
        }
    }
}

export function invalidateEncryptedMessageEmbeds(message: Message): void {
    const key = cacheKey(message);
    const entry = cache.get(key);
    if (entry) removeEntry(key, entry);
}

export async function prefetchEncryptedMessageEmbeds(plaintext: string): Promise<void> {
    if (!externalLinkPreviewsEnabled) return;
    const extracted = extractSecureEmbedUrls(plaintext);
    const urls = eligibleUnfurlUrls(extracted, inviteLinks(extracted));
    if (urls.length > 0) await Promise.all(urls.map(unfurlUrl));
}
