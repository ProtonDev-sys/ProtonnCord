/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationAssetUtils } from "@webpack/common";

const MAX_APPLICATION_ASSET_CACHE_SIZE = 150;
const applicationAssetCache = new Map<string, Promise<string>>();

function pruneOldestAsset() {
    const oldestKey = applicationAssetCache.keys().next().value;
    if (oldestKey !== undefined) applicationAssetCache.delete(oldestKey);
}

export function getCachedApplicationAsset(applicationId: string, key: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const cacheKey = `${applicationId}:${key}`;
    let assetPromise = applicationAssetCache.get(cacheKey);
    if (!assetPromise) {
        if (applicationAssetCache.size >= MAX_APPLICATION_ASSET_CACHE_SIZE) pruneOldestAsset();

        const pending: Promise<string> = ApplicationAssetUtils.fetchAssetIds(applicationId, [key])
            .then(assetIds => {
                const asset = assetIds[0];
                if (!asset) throw new Error("Application asset is unavailable");
                return asset;
            })
            .catch(error => {
                if (applicationAssetCache.get(cacheKey) === pending) applicationAssetCache.delete(cacheKey);
                throw error;
            });

        applicationAssetCache.set(cacheKey, pending);
        assetPromise = pending;
    }
    if (!signal) return assetPromise;

    // The host asset resolver has no cancellation API. A cancelled waiter must
    // evict its pending entry so the next poll can retry without reusing a stall.
    const evict = () => {
        if (applicationAssetCache.get(cacheKey) === assetPromise) applicationAssetCache.delete(cacheKey);
    };
    signal.addEventListener("abort", evict, { once: true });
    return assetPromise.finally(() => signal.removeEventListener("abort", evict));
}
