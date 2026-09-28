/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { Activity } from "@vencord/discord-types";
import { FluxDispatcher, showToast } from "@webpack/common";

import type { SettingsStore } from "../settings";
import { AbsMediaData, AbsSession } from "../types/audiobookshelf";
import { getCachedApplicationAsset } from "./assetCache";
import { createPresencePolling, PresenceUpdate } from "./polling";

const APPLICATION_ID = "1381423044907503636";
const SOCKET_ID = "RichPresence_ABS";
const AUTH_FAILURE_COOLDOWN_MS = 60_000;
const logger = new Logger("RichPresence:AudioBookShelf");

let authToken: string | null = null;
let hasShownConfigError = false;
let lastAuthFailureAt = 0;

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

async function authenticate(store: SettingsStore, update: PresenceUpdate): Promise<boolean> {
    const { abs_serverUrl, abs_username, abs_password } = store;
    if (!abs_serverUrl || !abs_username || !abs_password) {
        if (!hasShownConfigError) {
            logger.warn("AudioBookShelf server URL, username, or password is not set.");
            showToast("AudioBookShelf RPC is not configured.", "failure", { duration: 15000 });
            hasShownConfigError = true;
        }
        lastAuthFailureAt = Date.now();
        return false;
    }

    try {
        const baseUrl = abs_serverUrl.replace(/\/$/, "");
        const res = await update.wait(fetch(`${baseUrl}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: abs_username, password: abs_password }),
            signal: update.signal,
        }));
        if (!update.isCurrent()) return false;

        if (!res.ok) throw `${res.status} ${res.statusText}`;
        const data = await update.wait(res.json());
        if (!update.isCurrent()) return false;
        authToken = typeof data.user?.token === "string" ? data.user.token : null;
        if (authToken) {
            hasShownConfigError = false;
            lastAuthFailureAt = 0;
        }
        return !!authToken;
    } catch {
        if (!update.isCurrent()) return false;
        logger.error("Failed to authenticate with AudioBookShelf");
        authToken = null;
        lastAuthFailureAt = Date.now();
        return false;
    }
}

async function fetchMediaData(store: SettingsStore, update: PresenceUpdate, allowReauthentication = true): Promise<AbsMediaData | null> {
    if (!update.isCurrent()) return null;
    if (!authToken && lastAuthFailureAt && Date.now() - lastAuthFailureAt < AUTH_FAILURE_COOLDOWN_MS) return null;
    if (!authToken && !(await authenticate(store, update))) return null;
    if (!update.isCurrent()) return null;

    try {
        const baseUrl = store.abs_serverUrl!.replace(/\/$/, "");
        const res = await update.wait(fetch(`${baseUrl}/api/me/listening-sessions`, {
            headers: { "Authorization": `Bearer ${authToken}` },
            signal: update.signal,
        }));
        if (!update.isCurrent()) return null;

        if (!res.ok) {
            if (res.status === 401) {
                authToken = null;
                if (allowReauthentication && await authenticate(store, update)) return fetchMediaData(store, update, false);
                if (!update.isCurrent()) return null;
                lastAuthFailureAt = Date.now();
            }
            throw `${res.status} ${res.statusText}`;
        }

        const { sessions }: { sessions: AbsSession[]; } = await update.wait(res.json());
        if (!update.isCurrent()) return null;
        const activeSession = sessions.find(s => s.updatedAt && !s.isFinished);
        if (!activeSession?.updatedAt || (Date.now() - activeSession.updatedAt) / 1000 > 30) return null;

        const { mediaMetadata: media, mediaType, duration, currentTime, libraryItemId } = activeSession;
        if (!media) return null;

        return {
            name: media.title || "Unknown",
            type: mediaType || "book",
            author: media.author || media.publisher,
            series: media.series?.[0]?.name,
            duration,
            currentTime,
            imageUrl: libraryItemId ? `${baseUrl}/api/items/${libraryItemId}/cover` : undefined,
            isFinished: activeSession.isFinished || false,
        };
    } catch {
        if (!update.isCurrent()) return null;
        logger.error("Failed to query AudioBookShelf API");
        return null;
    }
}

async function getActivity(store: SettingsStore, update: PresenceUpdate): Promise<Activity | null> {
    const mediaData = await fetchMediaData(store, update);
    if (!mediaData || mediaData.isFinished || !update.isCurrent()) return null;

    const largeImage = mediaData.imageUrl;
    const assets = {
        large_image: await update.wait(getCachedApplicationAsset(APPLICATION_ID, largeImage || "audiobookshelf", update.signal)),
        large_text: mediaData.series || mediaData.author || undefined,
    };

    const details = mediaData.name;
    const state = mediaData.series && mediaData.author
        ? `${mediaData.series} \u2022 ${mediaData.author}`
        : mediaData.author || "AudioBook";

    const timestamps = mediaData.currentTime != null && mediaData.duration != null ? {
        start: Date.now() - (mediaData.currentTime * 1000),
        end: Date.now() + ((mediaData.duration - mediaData.currentTime) * 1000),
    } : undefined;

    return {
        application_id: APPLICATION_ID,
        name: "AudioBookShelf",
        details,
        state,
        assets,
        timestamps,
        type: 2,
        flags: 1,
    };
}

const polling = createPresencePolling("abs", 10000, getActivity, setActivity, () => {
    authToken = null;
    hasShownConfigError = false;
    lastAuthFailureAt = 0;
}, () => logger.error("Failed to update presence"));

export const { start, stop } = polling;
