/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { GrTrackData } from "./types/gensokyoRadio";

export async function fetchTrackData(): Promise<GrTrackData | null> {
    const response = await fetch("https://gensokyoradio.net/api/station/playing/", {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
        credentials: "omit"
    });
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Gensokyo Radio lookup failed (${response.status})`);
    }

    const song = await response.json();
    const songInfo = song?.SONGINFO;
    const songTimes = song?.SONGTIMES;
    if (!songInfo || !songTimes) return null;

    const position = Number(songTimes.SONGSTART);
    const duration = Number(songTimes.SONGEND);
    if (!Number.isFinite(position) || !Number.isFinite(duration)) return null;

    const artwork = song?.MISC?.ALBUMART;
    return {
        title: songInfo.TITLE || "Unknown",
        album: songInfo.ALBUM || "Unknown",
        artist: songInfo.ARTIST || "Unknown",
        position,
        duration,
        artwork: artwork ? `https://gensokyoradio.net/images/albums/500/${artwork}` : "",
    };
}
