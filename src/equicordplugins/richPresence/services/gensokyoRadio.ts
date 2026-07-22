/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityFlags, ActivityType } from "@vencord/discord-types/enums";
import { FluxDispatcher } from "@webpack/common";

import { settings } from "../settings";
import { getCachedApplicationAsset } from "./assetCache";

const Native = VencordNative.pluginHelpers.RichPresence as PluginNative<typeof import("../native")>;
const logger = new Logger("RichPresence:GensokyoRadio");

const APPLICATION_ID = "1253772057926303804";
const SOCKET_ID = "RichPresence_GR";
const UPDATE_ERROR_COOLDOWN_MS = 60_000;

let updateInterval: NodeJS.Timeout | undefined;
let isUpdating = false;
let lastUpdateErrorAt = 0;
let updateGeneration = 0;

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

async function getAsset(key: string): Promise<string> {
    return getCachedApplicationAsset(APPLICATION_ID, key);
}

function reportUpdateError(error: unknown) {
    const now = Date.now();
    if (lastUpdateErrorAt && now - lastUpdateErrorAt < UPDATE_ERROR_COOLDOWN_MS) return;

    lastUpdateErrorAt = now;
    logger.error("Failed to update presence", error);
}

async function getActivity(): Promise<Activity | null> {
    const trackData = await Native.fetchTrackData();
    if (!trackData) return null;

    return {
        application_id: APPLICATION_ID,
        name: "Gensokyo Radio",
        details: trackData.title,
        state: trackData.artist,
        timestamps: {
            start: trackData.position * 1000,
            end: trackData.duration * 1000,
        },
        assets: {
            large_image: await getAsset(trackData.artwork),
            large_text: trackData.album,
            small_image: await getAsset("logo"),
            small_text: "Gensokyo Radio",
        },
        type: ActivityType.LISTENING,
        flags: ActivityFlags.INSTANCE,
    };
}

async function updatePresence() {
    if (isUpdating) return;

    const generation = updateGeneration;
    isUpdating = true;
    try {
        const activity = await getActivity();
        lastUpdateErrorAt = 0;
        if (generation === updateGeneration) setActivity(activity);
    } catch (e) {
        reportUpdateError(e);
        if (generation === updateGeneration) setActivity(null);
    } finally {
        if (generation === updateGeneration) isUpdating = false;
    }
}

export function start() {
    if (updateInterval) return;

    updateGeneration++;
    lastUpdateErrorAt = 0;
    void updatePresence();
    updateInterval = setInterval(updatePresence, (settings.store.gr_refreshInterval ?? 15) * 1000);
}

export function stop() {
    updateGeneration++;
    clearInterval(updateInterval);
    updateInterval = undefined;
    isUpdating = false;
    lastUpdateErrorAt = 0;
    setActivity(null);
}
