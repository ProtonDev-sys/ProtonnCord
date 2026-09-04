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
let cacheGeneration = 0;

function isNativeFailure(result: AnnouncementReviewResult): result is NativeFailure {
    return result.status === "invalid_input" || result.status === "unavailable" || result.status === "failed";
}

function cancelledReview(): AnnouncementReviewResult {
    return { status: "failed", error: "cryptographic_operation_failed" };
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
        let oldestSettled: [string, ReviewCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || !value[1].settled) continue;
            if (!oldestSettled || value[1].lastAccess < oldestSettled[1].lastAccess) oldestSettled = value;
        }
        if (!oldestSettled) break;
        cache.delete(oldestSettled[0]);
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
        promise: Promise.resolve(cancelledReview()),
        settled: false,
    };
    const generation = cacheGeneration;
    cache.set(key, entry);
    entry.promise = runReviewTask(() => {
        if (generation !== cacheGeneration || cache.get(key) !== entry || !message.author?.id)
            return Promise.resolve(cancelledReview());
        return Native.reviewAnnouncement(
            localUserId,
            message.author.id,
            message.content,
            message.id,
            discordEditedTimestamp(message),
        );
    }).then(result => {
        if (generation !== cacheGeneration || cache.get(key) !== entry) return cancelledReview();
        if (isNativeFailure(result)) {
            cache.delete(key);
        } else {
            const settledAt = Date.now();
            entry.expiresAt = settledAt + RESULT_TTL_MS;
            entry.lastAccess = settledAt;
            entry.settled = true;
            pruneCache(key);
        }
        return result;
    }, error => {
        if (generation !== cacheGeneration || cache.get(key) !== entry) return cancelledReview();
        cache.delete(key);
        throw error;
    });
    return entry.promise;
}

export function clearAnnouncementReviewCache(): void {
    cacheGeneration++;
    cache.clear();
}
