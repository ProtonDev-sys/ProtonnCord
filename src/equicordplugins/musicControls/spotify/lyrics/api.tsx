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

interface NullLyricCacheEntry {
    [Provider.Lrclib]?: boolean;
    [Provider.Spotify]?: boolean;
}

const nullLyricCache = new Map<string, NullLyricCacheEntry>();
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

    const nullCacheEntry = nullLyricCache.get(cacheKey);

    if (nullCacheEntry) {
        const provider = settings.store.lyricsProvider;
        if (!settings.store.fallbackProvider && nullCacheEntry[provider]) {
            return null;
        }

        if (providers.every(p => nullCacheEntry[p])) {
            return null;
        }
    }

    const preferred = settings.store.lyricsProvider;
    const providersToTry = settings.store.fallbackProvider ? [preferred, ...providers.filter(p => p !== preferred)] : [preferred];

    for (const provider of providersToTry) {
        let lyricsInfo: LyricsData | null;
        try {
            lyricsInfo = await lyricFetchers[provider](track);
        } catch {
            lyricsInfo = null;
        }
        if (generation !== cacheGeneration) return null;

        if (lyricsInfo) {
            await DataStore.update<LyricsCache>(LyricsCacheKey, current => generation === cacheGeneration ? { ...current, [cacheKey]: lyricsInfo } : current ?? {});
            if (generation !== cacheGeneration) return null;
            return lyricsInfo;
        }

        const updatedNullCacheEntry = nullLyricCache.get(cacheKey) || {};
        if (!nullLyricCache.has(cacheKey) && nullLyricCache.size >= 1000) nullLyricCache.delete(nullLyricCache.keys().next().value!);
        nullLyricCache.set(cacheKey, { ...updatedNullCacheEntry, [provider]: true });
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
