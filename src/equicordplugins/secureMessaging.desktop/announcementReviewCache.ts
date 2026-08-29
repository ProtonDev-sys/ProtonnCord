/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Message } from "@vencord/discord-types";

import { discordEditedTimestamp } from "./messageMetadata";
import type { AnnouncementReviewResult, NativeFailure } from "./native";
import { createTaskQueue } from "./taskQueue";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const MAX_CACHE_ENTRIES = 256;
const RESULT_TTL_MS = 30_000;
const runReviewTask = createTaskQueue(4);

interface ReviewCacheEntry {
    expiresAt: number;
    lastAccess: number;
    promise: Promise<AnnouncementReviewResult>;
    settled: boolean;
}

const cache = new Map<string, ReviewCacheEntry>();

function isNativeFailure(result: AnnouncementReviewResult): result is NativeFailure {
    return result.status === "invalid_input" || result.status === "unavailable" || result.status === "failed";
}

export function announcementReviewCacheKey(localUserId: string, message: Message): string {
    return [
        localUserId,
        message.channel_id,
        message.id,
        message.author?.id ?? "",
        discordEditedTimestamp(message) ?? "",
        message.content,
    ].join("\0");
}

function pruneCache(protectedKey: string, maximumEntries = MAX_CACHE_ENTRIES): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (key !== protectedKey && entry.settled && entry.expiresAt <= now) cache.delete(key);
    }
    while (cache.size > maximumEntries) {
        let oldest: [string, ReviewCacheEntry] | null = null;
        let oldestSettled: [string, ReviewCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
            if (value[1].settled && (!oldestSettled || value[1].lastAccess < oldestSettled[1].lastAccess))
                oldestSettled = value;
        }
        const candidate = oldestSettled ?? oldest;
        if (!candidate) break;
        cache.delete(candidate[0]);
    }
}

export function reviewAnnouncementCached(localUserId: string, message: Message): Promise<AnnouncementReviewResult> {
    const key = announcementReviewCacheKey(localUserId, message);
    const now = Date.now();
    const existing = cache.get(key);
    if (existing && (!existing.settled || existing.expiresAt > now)) {
        existing.lastAccess = now;
        return existing.promise;
    }
    if (existing) cache.delete(key);

    pruneCache("", MAX_CACHE_ENTRIES - 1);
    const entry: ReviewCacheEntry = {
        expiresAt: Number.POSITIVE_INFINITY,
        lastAccess: now,
        promise: Promise.resolve({ status: "failed", error: "cryptographic_operation_failed" }),
        settled: false,
    };
    cache.set(key, entry);
    entry.promise = runReviewTask(() => Native.reviewAnnouncement(
        localUserId,
        message.author.id,
        message.content,
        message.id,
        discordEditedTimestamp(message),
    )).then(result => {
        if (cache.get(key) === entry) {
            if (isNativeFailure(result)) {
                cache.delete(key);
            } else {
                entry.expiresAt = Date.now() + RESULT_TTL_MS;
                entry.lastAccess = Date.now();
                entry.settled = true;
                pruneCache(key);
            }
        }
        return result;
    }, error => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
    });
    return entry.promise;
}

export function clearAnnouncementReviewCache(): void {
    cache.clear();
}
