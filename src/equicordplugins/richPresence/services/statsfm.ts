/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { Activity, ActivityButton } from "@vencord/discord-types";
import { ActivityFlags, ActivityType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import type { SettingsStore } from "../settings";
import { NameFormat } from "../types";
import { SfmResponse, SfmTrackData } from "../types/statsfm";
import { getCachedApplicationAsset } from "./assetCache";
import { createPresencePolling, PresenceUpdate } from "./polling";

const APPLICATION_ID = "1325126169179197500";
const PLACEHOLDER_ID = "2a96cbd8b46e442fc41c2b86b821562f";
const SOCKET_ID = "RichPresence_SFM";
const API_ERROR_COOLDOWN_MS = 60_000;
const logger = new Logger("RichPresence:StatsFm");
const PresenceStore = findByPropsLazy("getLocalPresence");

let lastApiErrorAt = 0;

async function getAsset(key: string, update: PresenceUpdate): Promise<string> {
    return update.wait(getCachedApplicationAsset(APPLICATION_ID, key, update.signal));
}

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

function reportApiError(message: string) {
    const now = Date.now();
    if (lastApiErrorAt && now - lastApiErrorAt < API_ERROR_COOLDOWN_MS) return;

    lastApiErrorAt = now;
    logger.error(message);
}

async function fetchTrackData(store: SettingsStore, update: PresenceUpdate): Promise<SfmTrackData | null> {
    const username = store.sfm_username?.trim();
    if (!username) {
        lastApiErrorAt = 0;
        return null;
    }

    try {
        const res = await update.wait(fetch(`https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/streams/current`, { signal: update.signal }));
        if (!update.isCurrent()) return null;
        if (!res.ok) throw `${res.status} ${res.statusText}`;

        const json = await update.wait(res.json()) as Partial<SfmResponse>;
        if (!update.isCurrent()) return null;
        lastApiErrorAt = 0;

        const trackData = json.item?.track;
        if (!trackData) return null;

        const albums = trackData.albums ?? [];
        const artists = trackData.artists ?? [];
        let albumNames = "";
        for (const album of albums) {
            if (albumNames) albumNames += ", ";
            albumNames += album.name;
        }

        return {
            name: trackData.name || "Unknown",
            albums: albumNames || "Unknown",
            artists: artists[0]?.name ?? "Unknown",
            url: `https://stats.fm/track/${trackData.id}`,
            imageUrl: albums[0]?.image,
        };
    } catch {
        if (update.isCurrent()) reportApiError("Failed to query Stats.fm API");
        return null;
    }
}

function getLargeImage(track: SfmTrackData, store: SettingsStore): string | undefined {
    if (!store.sfm_alwaysHideArt && track.imageUrl && !track.imageUrl.includes(PLACEHOLDER_ID))
        return track.imageUrl;
    if (store.sfm_missingArt === "placeholder") return "placeholder";
}

async function getActivity(store: SettingsStore, update: PresenceUpdate): Promise<Activity | null> {
    if (store.sfm_hideWithExternalRPC) {
        if (PresenceStore.getActivities().some(a => a.application_id !== APPLICATION_ID)) return null;
    }

    if (store.sfm_hideWithSpotify) {
        if (PresenceStore.getActivities().some(a => a.type === ActivityType.LISTENING && a.application_id !== APPLICATION_ID))
            return null;
    }

    const trackData = await fetchTrackData(store, update);
    if (!trackData || !update.isCurrent()) return null;

    const largeImage = getLargeImage(trackData, store);
    const assets = largeImage
        ? {
            large_image: await getAsset(largeImage, update),
            large_text: trackData.albums || undefined,
            ...(store.sfm_showLogo && {
                small_image: await getAsset("statsfm-large", update),
                small_text: "Stats.fm",
            }),
        } : {
            large_image: await getAsset("statsfm-large", update),
            large_text: trackData.albums || undefined,
        };

    const buttons: ActivityButton[] = [];
    if (store.sfm_shareUsername)
        buttons.push({ label: "Stats.fm Profile", url: `https://stats.fm/${store.sfm_username}` });
    if (store.sfm_shareSong)
        buttons.push({ label: "View Song", url: trackData.url });

    const statusName = (() => {
        switch (store.sfm_nameFormat) {
            case NameFormat.ArtistFirst: return trackData.artists + " - " + trackData.name;
            case NameFormat.SongFirst: return trackData.name + " - " + trackData.artists;
            case NameFormat.ArtistOnly: return trackData.artists;
            case NameFormat.SongOnly: return trackData.name;
            case NameFormat.AlbumName: return trackData.albums || store.sfm_statusName;
            default: return store.sfm_statusName;
        }
    })();

    return {
        application_id: APPLICATION_ID,
        name: statusName,
        details: trackData.name,
        state: trackData.artists,
        assets,
        buttons: buttons.length ? buttons.map(v => v.label) : undefined,
        metadata: buttons.length ? { button_urls: buttons.map(v => v.url) } : undefined,
        type: store.sfm_useListeningStatus ? ActivityType.LISTENING : ActivityType.PLAYING,
        flags: ActivityFlags.INSTANCE,
    };
}

const polling = createPresencePolling("sfm", 16000, getActivity, setActivity, () => {
    lastApiErrorAt = 0;
}, () => logger.error("Failed to update presence"));

export const { start, stop } = polling;
