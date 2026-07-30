/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Message } from "@vencord/discord-types";

import { discordEditedTimestamp } from "./messageMetadata";
import type { DecryptIncomingResult } from "./native";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const MAX_CACHE_ENTRIES = 512;

interface DecryptCacheEntry {
    lastAccess: number;
    promise: Promise<DecryptIncomingResult>;
    result: DecryptIncomingResult | null;
}

const cache = new Map<string, DecryptCacheEntry>();

export function decryptCacheKey(localUserId: string, message: Message): string {
    return [
        localUserId,
        message.channel_id,
        message.id,
        message.author?.id ?? "",
        discordEditedTimestamp(message) ?? "",
        message.content,
    ].join("\0");
}

function pruneCache(protectedKey: string): void {
    while (cache.size > MAX_CACHE_ENTRIES) {
        let oldest: [string, DecryptCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].result === null) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
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

    const entry: DecryptCacheEntry = {
        lastAccess: Date.now(),
        promise: Promise.resolve({ status: "failed", error: "cryptographic_operation_failed" }),
        result: null,
    };
    entry.promise = Native.decryptIncoming(localUserId, {
        channelId: message.channel_id,
        content: message.content,
        discordAuthorId: message.author.id,
        discordEditedTimestamp: discordEditedTimestamp(message),
        discordMessageId: message.id,
    }).catch((): DecryptIncomingResult => ({ status: "failed", error: "cryptographic_operation_failed" }))
        .then(result => {
            if (cache.get(key) === entry) {
                entry.lastAccess = Date.now();
                entry.result = result;
                pruneCache(key);
            }
            return result;
        });
    cache.set(key, entry);
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
    cache.clear();
}
