/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";

type SongLinkResult = {
    info?: {
        title: string;
        artist: string;
    };
    links: {
        [platform: string]: {
            url: string;
            nativeUri?: string;
        };
    };
};

export async function getTrackData(_, trackURL: string, country?: string): Promise<SongLinkResult> {
    if (typeof trackURL !== "string" || !/^https?:$/u.test(new URL(trackURL).protocol))
        throw new Error("SongLink requires an HTTP or HTTPS music link");
    const url = new URL("https://api.song.link/v1-alpha.1/links");
    url.searchParams.set("url", trackURL);
    url.searchParams.set("userCountry", country || RendererSettings.store.plugins?.SongLink?.userCountry || "US");
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`SongLink lookup failed (${response.status})`);
    const raw = await response.json();
    if (!raw || typeof raw !== "object" || !raw.linksByPlatform || typeof raw.linksByPlatform !== "object")
        throw new Error("SongLink returned an invalid response");
    const [, entry]: any = Object.entries(raw.entitiesByUniqueId ?? {})
        .find(([key]) => !key.includes("YOUTUBE")) || [];
    const possibleTrackInfo = entry
        && typeof entry.title === "string" && typeof entry.artistName === "string"
        ? { title: entry.title, artist: entry.artistName }
        : undefined;
    return {
        info: possibleTrackInfo,
        links: Object.fromEntries(Object.entries<any>(raw.linksByPlatform).flatMap(([name, data]) => {
            if (!data || typeof data.url !== "string") return [];
            try {
                if (!/^https?:$/u.test(new URL(data.url).protocol)) return [];
            } catch { return []; }
            const nativeUri = typeof data.nativeAppUriDesktop === "string" && /^(?:spotify|itunes|itms|itmss|music|musics):/iu.test(data.nativeAppUriDesktop)
                ? data.nativeAppUriDesktop : undefined;
            return [[name, { url: data.url, nativeUri }]];
        }))
    };
}
