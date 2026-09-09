/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseSyncedLyrics } from "@equicordplugins/musicControls/parseSyncedLyrics";
import { LyricsData, Provider } from "@equicordplugins/musicControls/spotify/lyrics/providers/types";
import { Track } from "@equicordplugins/musicControls/spotify/SpotifyStore";

const baseUrlLrclib = "https://lrclib.net/api/get";

interface LrcLibResponse {
    id: number;
    name: string;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: number;
    instrumental: boolean;
    plainLyrics: string | null;
    syncedLyrics: string | null;
}

export async function getLyricsLrclib(track: Track): Promise<LyricsData | null> {
    const info = {
        track_name: track.name,
        artist_name: track.artists[0]?.name ?? "",
        album_name: track.album.name,
        duration: String(track.duration / 1000)
    };

    const params = new URLSearchParams(info);
    const url = `${baseUrlLrclib}?${params.toString()}`;
    const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: {
            "User-Agent": "SpotifyLyrics for ProtonnCord (https://github.com/Masterjoona/vc-spotifylyrics)"
        }
    });

    if (!response.ok) return null;

    const data = await response.json() as LrcLibResponse;
    if (typeof data?.syncedLyrics !== "string") return null;
    const lines = parseSyncedLyrics(data.syncedLyrics);
    if (!lines.length) return null;

    return {
        useLyric: Provider.Lrclib,
        lyricsVersions: {
            LRCLIB: lines
        }
    };
}
