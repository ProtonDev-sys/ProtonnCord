/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseSyncedLyrics } from "@equicordplugins/musicControls/parseSyncedLyrics";
import { Track } from "@equicordplugins/musicControls/tidal/TidalStore";

import { EnhancedLyric } from "./types";

export async function getLyrics(track: Track | null, retries = 3): Promise<EnhancedLyric[] | null> {
    if (!track?.name || !track?.artist) return null;

    const fetchUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track.name)}&artist_name=${encodeURIComponent(track.artist)}`;

    try {
        const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
            if (retries > 1) return getLyrics(track, retries - 1);
            console.error("Failed to fetch lyrics:", res.status, res.statusText);
            return null;
        }

        const data = await res.json();
        const synced = data?.syncedLyrics;
        if (typeof synced !== "string") {
            console.error("Invalid lyrics data");
            return null;
        }

        const parsed: EnhancedLyric[] = parseSyncedLyrics(synced).map(line => ({ ...line, text: line.text ?? "" }));

        return parsed.length ? parsed : null;
    } catch (err) {
        if (retries > 1) return getLyrics(track, retries - 1);
        console.error("Error fetching lyrics:", err);
        return null;
    }
}
