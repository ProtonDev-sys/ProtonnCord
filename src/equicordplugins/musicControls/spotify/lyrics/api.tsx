/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "@equicordplugins/musicControls/settings";
import { Track } from "@equicordplugins/musicControls/spotify/SpotifyStore";

import { LyricsCache } from "./cache";
import { getLyricsLrclib } from "./providers/lrclibAPI";
import { getLyricsSpotify } from "./providers/SpotifyAPI";
import { LyricsData, Provider, SyncedLyric } from "./providers/types";

type RetryEntry = { retryAt: number; failures: number; };
const nullLyricCache = new Map<string, Partial<Record<Provider, RetryEntry>>>();
const MISS_TTL = 24 * 60 * 60_000;
function trackCacheKey(trackId: string) {
    return JSON.stringify([trackId, settings.store.lyricsProvider, !!settings.store.fallbackProvider,
        settings.store.spotifyLyricsApiUrl?.trim() || "", settings.store.translateTo]);
}
const cache = new LyricsCache(trackCacheKey);

export const lyricFetchers = {
    [Provider.Spotify]: async (track: Track) => await getLyricsSpotify(track.id, settings.store.spotifyLyricsApiUrl),
    [Provider.Lrclib]: getLyricsLrclib,
};

export const providers = Object.keys(lyricFetchers) as Provider[];

export async function getLyrics(track: Track | null): Promise<LyricsData | null> {
    if (!track || !track.id) return null;

    const { generation } = cache;
    const cacheKey = trackCacheKey(track.id);
    const cached = await cache.get(cacheKey, generation);
    if (generation !== cache.generation || cacheKey !== trackCacheKey(track.id)) return null;

    if (cached) return cached;

    const retryKey = JSON.stringify([track.id, settings.store.spotifyLyricsApiUrl]);

    const preferred = settings.store.lyricsProvider;
    const providersToTry = settings.store.fallbackProvider ? [preferred, ...providers.filter(p => p !== preferred)] : [preferred];

    for (const provider of providersToTry) {
        const previous = nullLyricCache.get(retryKey)?.[provider];
        if (previous && previous.retryAt > Date.now()) continue;
        let lyricsInfo: LyricsData | null;
        let failed = false;
        let failure: unknown;
        try {
            lyricsInfo = await lyricFetchers[provider](track);
        } catch (error) {
            lyricsInfo = null;
            failed = true;
            failure = error;
        }
        if (generation !== cache.generation || cacheKey !== trackCacheKey(track.id)) return null;

        if (lyricsInfo) {
            await cache.update(cacheKey, current => current
                ? { ...lyricsInfo, ...current, lyricsVersions: { ...lyricsInfo.lyricsVersions, ...current.lyricsVersions } }
                : lyricsInfo, generation);
            if (generation !== cache.generation) return null;
            const saved = await cache.get(cacheKey, generation);
            return generation === cache.generation && cacheKey === trackCacheKey(track.id) ? saved ?? lyricsInfo : null;
        }

        const failures = failed ? Math.min((previous?.failures ?? 0) + 1, 5) : 0;
        const retryAfter = Number((failure as { retryAfterMs?: number; })?.retryAfterMs) || 0;
        const delay = failed ? Math.max(Math.min(30_000 * 2 ** (failures - 1), 300_000), Math.max(retryAfter, 0)) : MISS_TTL;
        const updatedNullCacheEntry = nullLyricCache.get(retryKey) || {};
        if (!nullLyricCache.has(retryKey) && nullLyricCache.size >= 1000) nullLyricCache.delete(nullLyricCache.keys().next().value!);
        nullLyricCache.set(retryKey, { ...updatedNullCacheEntry, [provider]: { failures, retryAt: Date.now() + delay } });
    }

    return null;
}

export async function clearLyricsCache() {
    nullLyricCache.clear();
    await cache.clear();
}

export async function updateLyrics(trackId: string, newLyrics: SyncedLyric[], provider: Provider) {
    await cache.update(trackCacheKey(trackId), current => ({
        ...current, useLyric: provider,
        lyricsVersions: { ...current?.lyricsVersions, [provider]: newLyrics }
    }));
}

export async function removeTranslations() {
    await cache.removeTranslations();
}

export async function migrateOldLyrics() {
    await cache.migrate();
}
