/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import type { PluginNative } from "@utils/types";
import type { Message } from "@vencord/discord-types";

import { decryptIncomingAttachmentsCached } from "./attachmentCache";
import { discordEditedTimestamp, discordMessageNonce } from "./messageMetadata";
import type { DecryptIncomingResult } from "./native";
import { createTaskQueue } from "./taskQueue";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const MAX_CACHE_ENTRIES = 512;
const TRANSIENT_FAILURE_TTL_MS = 30_000;
const TRANSIENT_RETRY_DELAYS = [0, 250, 1_000, 3_000] as const;
const runDecryptTask = createTaskQueue(4);

interface DecryptCacheEntry {
    expiresAt: number;
    lastAccess: number;
    promise: Promise<DecryptIncomingResult>;
    result: DecryptIncomingResult | null;
}

const cache = new Map<string, DecryptCacheEntry>();
let cacheGeneration = 0;

function failedDecryption(): DecryptIncomingResult {
    return { status: "failed", error: "cryptographic_operation_failed" };
}

export function decryptCacheKey(localUserId: string, message: Message): string {
    return [
        localUserId,
        cacheGeneration,
        message.channel_id,
        message.id,
        message.author?.id ?? "",
        discordEditedTimestamp(message) ?? "",
        discordMessageNonce(message) ?? "",
        message.content,
        message.attachments.map(attachment => `${attachment.id}:${attachment.size}`).join(","),
    ].join("\0");
}

function isTransientFailure(result: DecryptIncomingResult): boolean {
    return result.status === "failed" || result.status === "unavailable";
}

async function decryptWithRetry(
    localUserId: string,
    message: Message,
    generation: number,
    isCurrent: () => boolean,
): Promise<DecryptIncomingResult> {
    let result: DecryptIncomingResult = failedDecryption();
    for (const retryDelay of TRANSIENT_RETRY_DELAYS) {
        if (generation !== cacheGeneration || !isCurrent()) break;
        if (retryDelay > 0) await sleep(retryDelay);
        if (generation !== cacheGeneration || !isCurrent()) break;
        result = await runDecryptTask(async (): Promise<DecryptIncomingResult> => {
            if (generation !== cacheGeneration || !isCurrent() || !message.author?.id) return failedDecryption();
            try {
                return await Native.decryptIncoming(localUserId, {
                    channelId: message.channel_id,
                    content: message.content,
                    discordAuthorId: message.author.id,
                    discordEditedTimestamp: discordEditedTimestamp(message),
                    discordMessageId: message.id,
                    discordNonce: discordMessageNonce(message),
                });
            } catch {
                return failedDecryption();
            }
        });
        if (result.status === "decrypted" && result.detachedTextIndex !== null) {
            const expanded = await decryptIncomingAttachmentsCached(localUserId, message);
            result = expanded.status === "decrypted"
                ? { ...result, plaintext: expanded.plaintext }
                : expanded;
        }
        if (generation !== cacheGeneration || !isCurrent()) return failedDecryption();
        if (!isTransientFailure(result)) break;
    }
    return result;
}

function pruneCache(protectedKey: string, maximumEntries = MAX_CACHE_ENTRIES): void {
    while (cache.size > maximumEntries) {
        let oldestSettled: [string, DecryptCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].result === null) continue;
            if (!oldestSettled || value[1].lastAccess < oldestSettled[1].lastAccess) oldestSettled = value;
        }
        if (!oldestSettled) break;
        cache.delete(oldestSettled[0]);
    }
}

function ensureEntry(localUserId: string, message: Message): [string, DecryptCacheEntry] {
    const key = decryptCacheKey(localUserId, message);
    const now = Date.now();
    const existing = cache.get(key);
    if (existing && (existing.result === null || existing.expiresAt > now)) {
        existing.lastAccess = now;
        return [key, existing];
    }
    if (existing) cache.delete(key);

    pruneCache("", MAX_CACHE_ENTRIES - 1);
    const entry: DecryptCacheEntry = {
        expiresAt: Number.POSITIVE_INFINITY,
        lastAccess: now,
        promise: Promise.resolve(failedDecryption()),
        result: null,
    };
    cache.set(key, entry);
    const generation = cacheGeneration;
    entry.promise = decryptWithRetry(localUserId, message, generation, () => cache.get(key) === entry).catch(failedDecryption).then(result => {
        if (generation === cacheGeneration && cache.get(key) === entry) {
            const settledAt = Date.now();
            entry.expiresAt = isTransientFailure(result)
                ? settledAt + TRANSIENT_FAILURE_TTL_MS
                : Number.POSITIVE_INFINITY;
            entry.lastAccess = settledAt;
            entry.result = result;
            pruneCache(key);
        }
        return result;
    });
    pruneCache(key);
    return [key, entry];
}

export function getCachedDecryption(localUserId: string, message: Message): DecryptIncomingResult | null {
    const key = decryptCacheKey(localUserId, message);
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.result !== null && entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    entry.lastAccess = Date.now();
    return entry.result;
}

export function decryptCachedMessage(localUserId: string, message: Message): Promise<DecryptIncomingResult> {
    return ensureEntry(localUserId, message)[1].promise;
}

export function clearEncryptedMessageDecryptCache(): void {
    cacheGeneration++;
    cache.clear();
}
