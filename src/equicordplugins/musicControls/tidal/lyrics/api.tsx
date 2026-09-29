/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseSyncedLyrics } from "@equicordplugins/musicControls/parseSyncedLyrics";
import { Track } from "@equicordplugins/musicControls/tidal/TidalStore";

import { EnhancedLyric } from "./types";

function waitForRetry(delay: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve(!signal?.aborted);
        };
        const timer = setTimeout(finish, delay);
        signal?.addEventListener("abort", finish, { once: true });
    });
}

function retryDelay(response: Response, attempt: number) {
    const backoff = 1000 * 2 ** attempt;
    const header = response.headers.get("Retry-After")?.trim();
    if (!header) return backoff;
    const deadline = /^\d+(?:\.\d+)?$/.test(header)
        ? Date.now() + Number(header) * 1000
        : Date.parse(header);
    return Number.isFinite(deadline) ? Math.max(backoff, deadline - Date.now()) : backoff;
}

export async function getLyrics(track: Track | null, retries = 3, signal?: AbortSignal): Promise<EnhancedLyric[] | null> {
    if (!track?.name || !track?.artist) return null;

    const fetchUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track.name)}&artist_name=${encodeURIComponent(track.artist)}`;

    const attempts = Number.isFinite(retries) ? Math.max(1, Math.min(3, Math.floor(retries))) : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (signal?.aborted) return null;
        let delay = 1000 * 2 ** attempt;
        try {
            const timeout = AbortSignal.timeout(15_000);
            const res = await fetch(fetchUrl, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            if (!res.ok) {
                void res.body?.cancel().catch(() => {});
                if (![408, 429, 500, 502, 503, 504].includes(res.status)) return null;
                delay = retryDelay(res, attempt);
            } else {
                const data = await res.json();
                const synced = data?.syncedLyrics;
                if (typeof synced !== "string") return null;

                const parsed: EnhancedLyric[] = parseSyncedLyrics(synced).map(line => ({ ...line, text: line.text ?? "" }));
                return signal?.aborted ? null : parsed.length ? parsed : null;
            }
        } catch (err) {
            if (signal?.aborted || err instanceof SyntaxError) return null;
            if (attempt === attempts - 1) console.error("Error fetching lyrics:", err);
        }

        // A distant server deadline ends this lookup instead of retrying before it.
        if (attempt === attempts - 1 || delay > 60_000 || !await waitForRetry(delay, signal)) return null;
    }
    return null;
}
