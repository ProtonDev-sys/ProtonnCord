/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { ChannelStore, FluxDispatcher, UserStore, VoiceStateStore } from "@webpack/common";

const DATASTORE_KEY = "VCLastVoiceChannel";
const DATASTORE_SESSION_KEY = "VCLastVoiceChannelSession";
const PERSIST_THROTTLE_MS = 15_000;
const logger = new Logger("VoiceRejoin");

type SavedVoiceChannel = {
    userId: string;
    guildId: string | null;
    channelId: string;
    timestamp: number;
};

let reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;
let reconnectGeneration = 0;
let lastPersistedChannelId: string | null = null;
let lastPersistedGuildId: string | null = null;
let lastPersistedSessionState: boolean | null = null;
let lastPersistedAt = 0;
let persistOwnerId: string | null = null;
let persistTail = Promise.resolve();
let heartbeatIntervalId: ReturnType<typeof setInterval> | undefined;
let disconnectedAt: number | undefined;
let disconnectedOwnerId: string | undefined;

const settings = definePluginSettings({
    rejoinDelay: {
        type: OptionType.SLIDER,
        description: "Set Delay before rejoining voice channel.",
        markers: makeRange(1, 10, 1),
        default: 2,
        stickToMarkers: true,
    },
    rejoinTimeout: {
        type: OptionType.SLIDER,
        description: "Don't attempt to rejoin after this many seconds have passed since disconnecting.",
        markers: makeRange(5, 120, 5),
        default: 30,
        stickToMarkers: true,
    },
    preventReconnectIfCallEnded: {
        type: OptionType.SELECT,
        description: "Do not reconnect if the call has ended or the voice channel is empty or does not exist.",
        options: [
            { label: "None", value: "none", default: false },
            { label: "DMs only", value: "dms", default: false },
            { label: "Servers only", value: "servers", default: false },
            { label: "DMs and Servers", value: "both", default: true },
        ],
    },
    applyOnlyToDms: {
        type: OptionType.BOOLEAN,
        description: "Only apply to DMs.",
        default: false,
    }
});

function cancelReconnectAttempt() {
    reconnectGeneration++;
    if (!reconnectTimeoutId) return;

    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = undefined;
}

function resetPersistCache() {
    persistOwnerId = null;
    lastPersistedChannelId = null;
    lastPersistedGuildId = null;
    lastPersistedSessionState = null;
    lastPersistedAt = 0;
}

function cachePersistedState(saved: SavedVoiceChannel | null, sessionState: boolean) {
    lastPersistedChannelId = saved?.channelId ?? null;
    lastPersistedGuildId = saved?.guildId ?? null;
    lastPersistedSessionState = sessionState;
    lastPersistedAt = saved?.timestamp ?? Date.now();
}

function shouldPersistActiveState(saved: SavedVoiceChannel) {
    return persistOwnerId !== saved.userId
        || lastPersistedSessionState !== true
        || lastPersistedChannelId !== saved.channelId
        || lastPersistedGuildId !== saved.guildId
        || saved.timestamp - lastPersistedAt >= Math.min(PERSIST_THROTTLE_MS, settings.store.rejoinTimeout * 500);
}

async function persistActiveState(state: VoiceState, force = false) {
    const { channelId } = state;
    const userId = UserStore.getCurrentUser()?.id;
    if (!channelId || !userId || state.userId !== userId) return;

    const saved: SavedVoiceChannel = {
        userId,
        guildId: state.guildId ?? null,
        channelId,
        timestamp: Date.now(),
    };

    if (!force && !shouldPersistActiveState(saved)) return;

    const generation = reconnectGeneration;
    const pending = persistTail.then(() => DataStore.setMany([
        [`${DATASTORE_KEY}:${userId}`, saved],
        [`${DATASTORE_SESSION_KEY}:${userId}`, true]
    ]));
    persistTail = pending.catch(() => {});
    await pending;
    if (generation === reconnectGeneration && UserStore.getCurrentUser()?.id === userId) {
        persistOwnerId = userId;
        cachePersistedState(saved, true);
    }
}

async function persistInactiveState() {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId || (persistOwnerId === userId && lastPersistedSessionState === false)) return;

    const generation = reconnectGeneration;
    const pending = persistTail.then(() => DataStore.set(`${DATASTORE_SESSION_KEY}:${userId}`, false));
    persistTail = pending.catch(() => {});
    await pending;
    if (generation === reconnectGeneration && UserStore.getCurrentUser()?.id === userId) {
        persistOwnerId = userId;
        cachePersistedState(null, false);
    }
}

async function waitForChannel(channelId: string, isCurrent: () => boolean) {
    let channel = ChannelStore.getChannel(channelId);
    for (let attempt = 0; attempt < 20 && !channel && isCurrent(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        channel = ChannelStore.getChannel(channelId);
    }
    return channel;
}

function hasOtherUsersInChannel(channelId: string, myUserId: string) {
    const connectedUsers = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceState> | undefined;
    if (!connectedUsers) return false;

    for (const voiceState of Object.values(connectedUsers)) {
        if (voiceState.userId !== myUserId) return true;
    }

    return false;
}

export default definePlugin({
    name: "VoiceRejoin",
    description: "Rejoins DM/Server call automatically when restarting Discord.",
    tags: ["Servers", "Utility", "Voice"],
    authors: [EquicordDevs.omaw, EquicordDevs.keircn],
    settings,

    flux: {
        LOGOUT() {
            cancelReconnectAttempt();
            resetPersistCache();
            disconnectedAt = undefined;
            disconnectedOwnerId = undefined;
        },
        CONNECTION_CLOSED() {
            cancelReconnectAttempt();
            disconnectedAt = Date.now();
            const userId = UserStore.getCurrentUser()?.id;
            disconnectedOwnerId = userId;
            const state = userId ? VoiceStateStore.getVoiceStateForUser(userId) : undefined;
            if (state?.channelId) void persistActiveState(state, true).catch(error => logger.error("Failed to persist disconnect time", error));
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const currentUser = UserStore.getCurrentUser();
            if (!currentUser) return;

            const myUserId = currentUser.id;
            let myState: VoiceState | undefined;
            for (const voiceState of voiceStates) {
                if (voiceState.userId !== myUserId) continue;
                myState = voiceState;
                break;
            }
            if (!myState) return;

            cancelReconnectAttempt();
            if (myState.channelId) {
                void persistActiveState(myState)
                    .catch(err => logger.error("Failed to persist last voice channel", err));
            } else {
                void persistInactiveState()
                    .catch(err => logger.error("Failed to persist voice session state", err));
            }
        },

        async CONNECTION_OPEN() {
            cancelReconnectAttempt();
            const scheduledGeneration = reconnectGeneration;
            const userId = UserStore.getCurrentUser()?.id;
            if (!userId) return;
            const reconnectDisconnectedAt = disconnectedOwnerId === userId ? disconnectedAt : undefined;
            disconnectedAt = undefined;
            disconnectedOwnerId = undefined;
            const isCurrent = () => scheduledGeneration === reconnectGeneration && UserStore.getCurrentUser()?.id === userId;

            const currentVoiceState = VoiceStateStore.getVoiceStateForUser(userId);
            if (currentVoiceState?.channelId) {
                await persistActiveState(currentVoiceState, true);
                return;
            }

            await persistTail;
            const wasInVC = await DataStore.get(`${DATASTORE_SESSION_KEY}:${userId}`);
            if (!isCurrent()) return;

            if (wasInVC !== true) return;

            reconnectTimeoutId = setTimeout(async () => {
                reconnectTimeoutId = undefined;
                if (!isCurrent()) return;

                try {
                    const saved = await DataStore.get<SavedVoiceChannel>(`${DATASTORE_KEY}:${userId}`);
                    if (!isCurrent() || !saved?.channelId || saved.userId !== userId) return;

                    const channel = await waitForChannel(saved.channelId, isCurrent);
                    if (!isCurrent()) return;

                    if (!channel) {
                        await persistInactiveState();
                        return;
                    }

                    const currentUser = UserStore.getCurrentUser();
                    if (!currentUser) return;

                    const isDM = channel.isDM() || channel.isGroupDM() || channel.isMultiUserDM();
                    const myUserId = currentUser.id;
                    const myVoiceState = VoiceStateStore.getVoiceStateForUser(myUserId);
                    if (myVoiceState?.channelId) {
                        await persistActiveState(myVoiceState);
                        return;
                    }
                    const preventionMode = settings.store.preventReconnectIfCallEnded;
                    const timeoutMs = settings.store.rejoinTimeout * 1000;

                    const lastConnectedAt = reconnectDisconnectedAt ?? saved.timestamp;
                    if (!Number.isFinite(lastConnectedAt) || Date.now() - lastConnectedAt > timeoutMs) {
                        await persistInactiveState();
                        return;
                    }

                    if (settings.store.applyOnlyToDms && !isDM) {
                        await persistInactiveState();
                        return;
                    }

                    if (preventionMode !== "none") {
                        const shouldPrevent =
                            preventionMode === "both" ||
                            (preventionMode === "dms" && isDM) ||
                            (preventionMode === "servers" && !isDM);

                        if (shouldPrevent) {
                            if (!hasOtherUsersInChannel(saved.channelId, myUserId)) {
                                await persistInactiveState();
                                return;
                            }
                        }
                    }

                    FluxDispatcher.dispatch({
                        type: "VOICE_CHANNEL_SELECT",
                        guildId: saved.guildId,
                        channelId: saved.channelId,
                    });
                } catch (err) {
                    logger.error("Failed to run voice rejoin", err);
                }
            }, settings.store.rejoinDelay * 1000);
        },
    },

    start() {
        if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = setInterval(() => {
            if (disconnectedAt !== undefined) return;
            const userId = UserStore.getCurrentUser()?.id;
            const state = userId ? VoiceStateStore.getVoiceStateForUser(userId) : undefined;
            if (state?.channelId) void persistActiveState(state).catch(error => logger.error("Failed to refresh voice session", error));
        }, 2500);
    },

    stop() {
        if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = undefined;
        disconnectedAt = undefined;
        disconnectedOwnerId = undefined;
        cancelReconnectAttempt();
        resetPersistCache();
    },
});
