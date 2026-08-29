/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import type { PluginNative } from "@utils/types";
import type { Message } from "@vencord/discord-types";

import { encryptedAttachmentInput } from "./attachmentCache";
import { discordEditedTimestamp, discordMessageNonce } from "./messageMetadata";
import type { DecryptIncomingAttachmentsResult, DecryptIncomingResult } from "./native";
import { createTaskQueue } from "./taskQueue";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const MAX_CACHE_ENTRIES = 512;
const TRANSIENT_RETRY_DELAYS = [0, 250, 1_000, 3_000] as const;

interface DecryptCacheEntry {
    lastAccess: number;
    promise: Promise<DecryptIncomingResult>;
    result: DecryptIncomingResult | null;
}

const cache = new Map<string, DecryptCacheEntry>();
const runDecryptTask = createTaskQueue(4);
let cacheGeneration = 0;

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
    let result: DecryptIncomingResult = { status: "failed", error: "cryptographic_operation_failed" };
    for (const retryDelay of TRANSIENT_RETRY_DELAYS) {
        if (generation !== cacheGeneration || !isCurrent()) break;
        if (retryDelay > 0) await sleep(retryDelay);
        if (generation !== cacheGeneration || !isCurrent()) break;
        result = await Native.decryptIncoming(localUserId, {
            channelId: message.channel_id,
            content: message.content,
            discordAuthorId: message.author.id,
            discordEditedTimestamp: discordEditedTimestamp(message),
            discordMessageId: message.id,
            discordNonce: discordMessageNonce(message),
        }).catch((): DecryptIncomingResult => ({ status: "failed", error: "cryptographic_operation_failed" }));
        if (result.status === "decrypted" && result.detachedTextIndex !== null) {
            const expanded = await encryptedAttachmentInput(message)
                .then(input => Native.decryptIncomingAttachments(localUserId, input))
                .catch((): DecryptIncomingAttachmentsResult => ({ status: "failed", error: "attachment_download_failed" }));
            result = expanded.status === "decrypted"
                ? { ...result, plaintext: expanded.plaintext }
                : expanded;
        }
        if (generation !== cacheGeneration || !isCurrent())
            return { status: "failed", error: "cryptographic_operation_failed" };
        if (!isTransientFailure(result)) break;
    }
    return result;
}

function pruneCache(protectedKey: string, maximumEntries = MAX_CACHE_ENTRIES): void {
    while (cache.size > maximumEntries) {
        let oldest: [string, DecryptCacheEntry] | null = null;
        let oldestSettled: [string, DecryptCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
            if (value[1].result !== null && (!oldestSettled || value[1].lastAccess < oldestSettled[1].lastAccess))
                oldestSettled = value;
        }
        oldest = oldestSettled ?? oldest;
        if (!oldest) break;
        cache.delete(oldest[0]);
    }
}

function ensureEntry(localUserId: string, message: Message): [string, DecryptCacheEntry] {
    const key = decryptCacheKey(localUserId, message);
    const existing = cache.get(key);
    if (existing) {
        existing.lastAccess = Date.now();
        return [key, existing];
    }

    pruneCache("", MAX_CACHE_ENTRIES - 1);
    const entry: DecryptCacheEntry = {
        lastAccess: Date.now(),
        promise: Promise.resolve({ status: "failed", error: "cryptographic_operation_failed" }),
        result: null,
    };
    cache.set(key, entry);
    const generation = cacheGeneration;
    entry.promise = runDecryptTask(() =>
        decryptWithRetry(localUserId, message, generation, () => cache.get(key) === entry)
    ).then(result => {
        if (cache.get(key) === entry) {
            entry.lastAccess = Date.now();
            entry.result = result;
            pruneCache(key);
        }
        return result;
    });
    pruneCache(key);
    return [key, entry];
}

export function getCachedDecryption(localUserId: string, message: Message): DecryptIncomingResult | null {
    const entry = cache.get(decryptCacheKey(localUserId, message));
    if (!entry) return null;
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
