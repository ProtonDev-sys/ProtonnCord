/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { formatDurationMs } from "@utils/text";
import { Activity } from "@vencord/discord-types";
import { FluxDispatcher, showToast } from "@webpack/common";

import type { SettingsStore } from "../settings";
import { JfMediaData, JfSession } from "../types/jellyfin";
import { getCachedApplicationAsset } from "./assetCache";
import { createPresencePolling, PresenceUpdate } from "./polling";

const APPLICATION_ID = "1381368130164625469";
const SOCKET_ID = "RichPresence_JF";
const API_ERROR_COOLDOWN_MS = 60_000;
const logger = new Logger("RichPresence:Jellyfin");

let hasShownConfigError = false;
let lastApiErrorAt = 0;

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

function reportApiError(logMessage: string, toastMessage?: string) {
    const now = Date.now();
    if (lastApiErrorAt && now - lastApiErrorAt < API_ERROR_COOLDOWN_MS) return;

    lastApiErrorAt = now;
    logger.error(logMessage);

    if (toastMessage) showToast(toastMessage, "failure", { duration: 15000 });
}

async function fetchMediaData(store: SettingsStore, update: PresenceUpdate): Promise<JfMediaData | null> {
    const { jf_serverUrl, jf_apiKey, jf_userId } = store;
    if (!jf_serverUrl || !jf_apiKey || !jf_userId) {
        if (!hasShownConfigError) {
            logger.warn("Jellyfin server URL, API key, or user ID is not set.");
            showToast("Jellyfin RPC is not configured.", "failure", { duration: 15000 });
            hasShownConfigError = true;
        }
        return null;
    }

    try {
        const baseUrl = (jf_serverUrl.startsWith("http") ? jf_serverUrl : `https://${jf_serverUrl}`).replace(/\/$/, "");
        const res = await update.wait(fetch(`${baseUrl}/Sessions?api_key=${jf_apiKey}`, { signal: update.signal }));
        if (!update.isCurrent()) return null;
        if (!res.ok) throw `${res.status} ${res.statusText}`;

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
            reportApiError(
                "Jellyfin returned non-JSON response. Check your server URL and API key.",
                "Jellyfin returned an invalid response. Your API key may be wrong.",
            );
            return null;
        }

        const sessions: JfSession[] = await update.wait(res.json());
        if (!update.isCurrent()) return null;
        hasShownConfigError = false;
        lastApiErrorAt = 0;

        const userSession = sessions.find(s => s.UserId === jf_userId && s.NowPlayingItem);
        if (!userSession?.NowPlayingItem) return null;

        const item = userSession.NowPlayingItem;
        const playState = userSession.PlayState;

        if (playState?.IsPaused && !store.jf_showPausedState) return null;

        const imageUrl = item.ImageTags?.Primary
            ? `${baseUrl}/Items/${item.Type === "Episode" && item.SeriesId && store.jf_coverType === "series"
                ? item.SeriesId : item.Id}/Images/Primary`
            : undefined;

        return {
            name: item.Name || "Unknown",
            type: item.Type || "Unknown",
            artist: item.Artists?.[0] || item.AlbumArtist,
            album: item.Album,
            seriesName: item.SeriesName,
            seasonNumber: item.ParentIndexNumber,
            episodeNumber: item.IndexNumber,
            year: item.ProductionYear,
            url: `${baseUrl}/web/#!/details?id=${item.Id}`,
            imageUrl,
            duration: item.RunTimeTicks ? Math.floor(item.RunTimeTicks / 10000000) : undefined,
            position: playState?.PositionTicks != null ? Math.floor(playState.PositionTicks / 10000000) : undefined,
            isPaused: !!playState?.IsPaused,
        };
    } catch {
        if (update.isCurrent()) reportApiError("Failed to query Jellyfin API");
        return null;
    }
}

async function getActivity(store: SettingsStore, update: PresenceUpdate): Promise<Activity | null> {
    const mediaData = await fetchMediaData(store, update);
    if (!mediaData || !update.isCurrent()) return null;

    let richPresenceType: number;
    if (store.jf_overrideType !== "off") {
        richPresenceType = parseInt(store.jf_overrideType as string, 10);
    } else {
        richPresenceType = mediaData.type === "Audio" ? 2 : 3;
    }

    const templateValues = {
        name: mediaData.name || "",
        series: mediaData.seriesName || "",
        season: mediaData.seasonNumber?.toString() || "",
        episode: mediaData.episodeNumber?.toString() || "",
        artist: mediaData.artist || "",
        album: mediaData.album || "",
        year: mediaData.year?.toString() || "",
    };
    const templateReplace = (template: string) => template.replace(
        /\{(name|series|season|episode|artist|album|year)\}/g,
        (_, field: keyof typeof templateValues) => templateValues[field]
    );

    let appName: string;
    const nameSetting = store.jf_nameDisplay || "default";

    switch (nameSetting) {
        case "full":
            if (mediaData.type === "Episode" && mediaData.seriesName) {
                appName = store.jf_privacyMode
                    ? `${mediaData.seriesName} - [Episode Hidden]`
                    : `${mediaData.seriesName} - ${mediaData.name}`;
            } else if (mediaData.type === "Audio") {
                appName = store.jf_privacyMode
                    ? "[Track Hidden]"
                    : `${mediaData.artist || "Unknown Artist"} - ${mediaData.name}`;
            } else {
                appName = store.jf_privacyMode ? "[Movie Hidden]" : mediaData.name || "Jellyfin";
            }
            break;
        case "custom":
            appName = templateReplace(store.jf_customName || "{name} on Jellyfin");
            if (store.jf_privacyMode) {
                appName = appName
                    .replace(mediaData.name || "", "[Title Hidden]")
                    .replace(mediaData.seriesName || "", "[Series Hidden]")
                    .replace(mediaData.artist || "", "[Artist Hidden]")
                    .replace(mediaData.album || "", "[Album Hidden]");
            }
            break;
        default:
            if (mediaData.type === "Episode" && mediaData.seriesName) {
                appName = mediaData.seriesName;
            } else {
                appName = store.jf_privacyMode ? "[Media Hidden]" : mediaData.name || "Jellyfin";
            }
            break;
    }

    if (store.jf_privacyMode) appName = "Jellyfin";

    const assets = {
        large_image: !store.jf_privacyMode && mediaData.imageUrl
            ? await update.wait(getCachedApplicationAsset(APPLICATION_ID, mediaData.imageUrl, update.signal)) : undefined,
        large_text: !store.jf_privacyMode ? mediaData.seriesName || mediaData.album || undefined : undefined,
    };

    const getDetails = () => {
        let details: string;
        if (mediaData.type === "Episode" && mediaData.seriesName)
            details = store.jf_privacyMode ? "Watching a TV Show" : mediaData.seriesName;
        else
            details = store.jf_privacyMode ? "Watching Something" : mediaData.name;
        if (mediaData.isPaused) details += " - Paused";
        return details;
    };

    const getState = () => {
        if (store.jf_privacyMode) return mediaData.isPaused ? "Paused" : mediaData.type === "Audio" ? "Listening to music" : "Watching Something";
        let state: string | undefined;

        if (mediaData.type === "Episode" && mediaData.seriesName) {
            let episodeFormat = "";
            const season = mediaData.seasonNumber;
            const episode = mediaData.episodeNumber;
            const format = store.jf_episodeFormat || "long";

            if (season != null && episode != null) {
                switch (format) {
                    case "long":
                        episodeFormat = `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`;
                        break;
                    case "short":
                        episodeFormat = `${season}x${episode.toString().padStart(2, "0")}`;
                        break;
                    case "fulltext":
                        episodeFormat = `Season ${season} Episode ${episode}`;
                        break;
                }
            } else if (season != null) {
                episodeFormat = format === "fulltext" ? `Season ${season}` : `S${season.toString().padStart(2, "0")}`;
            } else if (episode != null) {
                episodeFormat = format === "fulltext" ? `Episode ${episode}` : `E${episode.toString().padStart(2, "0")}`;
            }

            state = (store.jf_showEpisodeName && mediaData.name && !store.jf_privacyMode)
                ? `${episodeFormat} - ${mediaData.name}`
                : episodeFormat;
        } else if (store.jf_privacyMode) {
            state = mediaData.type === "Audio" ? "Listening to music" : (mediaData.year ? "(????)" : undefined);
        } else {
            state = mediaData.artist || (mediaData.year ? `(${mediaData.year})` : undefined);
        }

        if (mediaData.isPaused) {
            const time = mediaData.position != null && mediaData.duration != null
                ? `${formatDurationMs(mediaData.position * 1000)} / ${formatDurationMs(mediaData.duration * 1000)}`
                : undefined;
            if (state && time) return `${state} - ${time}`;
            return state || time || "Paused";
        }
        return state;
    };

    const timestamps = (!mediaData.isPaused && mediaData.position != null && mediaData.duration != null) ? {
        start: Date.now() - (mediaData.position * 1000),
        end: Date.now() + ((mediaData.duration - mediaData.position) * 1000),
    } : undefined;

    return {
        application_id: APPLICATION_ID,
        name: appName,
        details: getDetails(),
        state: getState() || "something",
        assets,
        timestamps,
        type: richPresenceType,
        flags: 1,
    };
}

const polling = createPresencePolling("jf", 10000, getActivity, setActivity, () => {
    hasShownConfigError = false;
    lastApiErrorAt = 0;
}, () => logger.error("Failed to update presence"));

export const { start, stop } = polling;
