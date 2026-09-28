/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { settings } from "@equicordplugins/musicControls/settings";
import { Track } from "@equicordplugins/musicControls/spotify/SpotifyStore";

import { getLyricsLrclib } from "./providers/lrclibAPI";
import { getLyricsSpotify } from "./providers/SpotifyAPI";
import { LyricsData, Provider, SyncedLyric } from "./providers/types";

const LyricsCacheKey = "SpotifyLyricsCacheNew";

type RetryEntry = { retryAt: number; failures: number; };
const nullLyricCache = new Map<string, Partial<Record<Provider, RetryEntry>>>();
const MISS_TTL = 24 * 60 * 60_000;
let cacheGeneration = 0;
type LyricsCache = Record<string, LyricsData | null>;

export const lyricFetchers = {
    [Provider.Spotify]: async (track: Track) => await getLyricsSpotify(track.id, settings.store.spotifyLyricsApiUrl),
    [Provider.Lrclib]: getLyricsLrclib,
};

export const providers = Object.keys(lyricFetchers) as Provider[];

export async function getLyrics(track: Track | null): Promise<LyricsData | null> {
    if (!track || !track.id) return null;

    const generation = cacheGeneration;
    const cacheKey = track.id;
    const cached = await DataStore.get<LyricsCache>(LyricsCacheKey);
    if (generation !== cacheGeneration) return null;

    if (cached?.[cacheKey]) {
        return cached[cacheKey];
    }

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
        if (generation !== cacheGeneration) return null;

        if (lyricsInfo) {
            await DataStore.update<LyricsCache>(LyricsCacheKey, current => generation === cacheGeneration ? { ...current, [cacheKey]: lyricsInfo } : current ?? {});
            if (generation !== cacheGeneration) return null;
            return lyricsInfo;
        }

        const failures = failed ? Math.min((previous?.failures ?? 0) + 1, 5) : 0;
        const retryAfter = Number((failure as { retryAfterMs?: number; })?.retryAfterMs) || 0;
        const delay = failed ? Math.max(Math.min(30_000 * 2 ** (failures - 1), 300_000), Math.min(Math.max(retryAfter, 0), 3_600_000)) : MISS_TTL;
        const updatedNullCacheEntry = nullLyricCache.get(retryKey) || {};
        if (!nullLyricCache.has(retryKey) && nullLyricCache.size >= 1000) nullLyricCache.delete(nullLyricCache.keys().next().value!);
        nullLyricCache.set(retryKey, { ...updatedNullCacheEntry, [provider]: { failures, retryAt: Date.now() + delay } });
    }

    return null;
}

export async function clearLyricsCache() {
    cacheGeneration++;
    nullLyricCache.clear();
    await DataStore.set(LyricsCacheKey, {});
}

export async function updateLyrics(trackId: string, newLyrics: SyncedLyric[], provider: Provider) {
    const generation = cacheGeneration;
    await DataStore.update<LyricsCache>(LyricsCacheKey, cache => {
        if (generation !== cacheGeneration) return cache ?? {};
        const current = cache?.[trackId];
        return {
            ...cache, [trackId]: {
                ...current,
                useLyric: provider,
                lyricsVersions: {
                    ...current?.lyricsVersions,
                    [provider]: newLyrics
                }
            }
        };
    });
}

export async function removeTranslations() {
    cacheGeneration++;
    await DataStore.update<LyricsCache>(LyricsCacheKey, cache => {
    const newCache = {} as Record<string, LyricsData | null>;

    for (const [trackId, trackData] of Object.entries(cache ?? {})) {
        const { Translated, ...lyricsVersions } = trackData?.lyricsVersions || {};
        const newUseLyric = !!lyricsVersions[Provider.Spotify] ? Provider.Spotify : Provider.Lrclib;

        newCache[trackId] = { lyricsVersions, useLyric: newUseLyric };
    }

    return newCache;
    });
}

export async function migrateOldLyrics() {
    const oldCache = await DataStore.get("SpotifyLyricsCache");
    if (!oldCache || !Object.entries(oldCache).length) return;

    const filteredCache = Object.entries(oldCache).filter(lrc => lrc[1]);
    const result = {};

    filteredCache.forEach(([trackId, lyrics]) => {
        result[trackId] = {
            lyricsVersions: {
                // @ts-ignore
                LRCLIB: lyrics.map(({ time, text }) => ({ time, text }))
            },
            useLyric: "LRCLIB"
        };
    });

    await DataStore.update<LyricsCache>(LyricsCacheKey, current => ({ ...result, ...current }));
    await DataStore.set("SpotifyLyricsCache", {});
}
