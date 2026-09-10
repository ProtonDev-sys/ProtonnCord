/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildMemberStore, StreamerModeStore, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

import {
    generateOrbolaySharedSecret,
    isValidOrbolaySharedSecret,
    type JsonValue,
    ORBOLAY_HANDSHAKE_TIMEOUT_MS,
    OrbolayAuthenticatedProtocol,
    type OrbolayControlCommand,
    type OrbolayProtocolAction,
} from "./protocol";

interface BridgeConnection {
    socket: WebSocket;
    protocol: OrbolayAuthenticatedProtocol;
    receiveQueue: Promise<void>;
    sendQueue: Promise<void>;
    connectionTimer?: ReturnType<typeof setTimeout>;
    authenticationTimer?: ReturnType<typeof setTimeout>;
}

interface ChannelState {
    userId: string;
    channelId: string | null;
    oldChannelId: string | null;
    guildId: string | null;
    deaf: boolean;
    mute: boolean;
    selfDeaf: boolean;
    selfMute: boolean;
    selfStream: boolean;
}

type ParticipantPayload = {
    userId: string;
    username: string | null;
    avatar: string | null;
    channelId: string | null;
    deaf: boolean;
    mute: boolean;
    streaming: boolean;
    speaking: boolean;
};

const logger = new Logger("OrbolayBridge");
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_VOICE_STATES = 100;

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Loopback port used by the authenticated Orbolay protocol.",
        default: 6888,
        restartNeeded: true,
        isValid(value: number) {
            return Number.isInteger(value) && value >= 1 && value <= 65_535
                ? true
                : "Port must be an integer from 1 to 65535";
        },
    },
    sharedSecret: {
        type: OptionType.STRING,
        description: "Generated 256-bit secret for Orbolay authenticated protocol v1. Copy it into a compatible companion. Legacy unauthenticated companions are rejected.",
        default: "",
        cloudSync: false,
        restartNeeded: true,
        componentProps: { type: "password" },
        isValid(value: string) {
            return value === "" || isValidOrbolaySharedSecret(value)
                ? true
                : "Secret must be a 32-byte base64url value";
        },
    },
});

let bridge: BridgeConnection | null = null;
let currentChannel: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && SNOWFLAKE.test(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
    if (typeof value !== "string") return null;
    return value.slice(0, maxLength);
}

function showToast(message: string, type: (typeof Toasts.Type)[keyof typeof Toasts.Type]): void {
    Toasts.show({ message, type, id: Toasts.genId() });
}

function isActive(connection: BridgeConnection): boolean {
    return bridge === connection && connection.socket.readyState === WebSocket.OPEN;
}

function disposeConnection(connection: BridgeConnection): void {
    if (connection.connectionTimer) clearTimeout(connection.connectionTimer);
    if (connection.authenticationTimer) clearTimeout(connection.authenticationTimer);
    connection.protocol.invalidate();
    if (bridge === connection) {
        bridge = null;
        currentChannel = null;
    }
}

function closeConnection(connection: BridgeConnection, code: number, reason: string): void {
    disposeConnection(connection);
    if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
        try {
            connection.socket.close(code, reason.slice(0, 120));
        } catch (error) {
            logger.warn("Failed to close the Orbolay socket", error);
        }
    }
}

function configuredSecret(): string | null {
    const secret = settings.store.sharedSecret;
    if (secret === "") {
        settings.store.sharedSecret = generateOrbolaySharedSecret();
        showToast(
            "Generated an Orbolay shared secret. Configure it in an authenticated-protocol-v1 companion, then restart.",
            Toasts.Type.MESSAGE,
        );
        return null;
    }
    if (!isValidOrbolaySharedSecret(secret)) {
        showToast("Orbolay is disabled because its shared secret is invalid.", Toasts.Type.FAILURE);
        return null;
    }
    return secret;
}

function configuredPort(): number | null {
    const { port } = settings.store;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        showToast("Orbolay is disabled because its loopback port is invalid.", Toasts.Type.FAILURE);
        return null;
    }
    return port;
}

async function waitForPopulate<T>(getValue: () => T | null | undefined): Promise<T | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
        const value = getValue();
        if (value != null) return value;
        await sleep(250);
    }
    return null;
}

function normalizeChannelState(value: unknown): ChannelState | null {
    if (!isRecord(value) || !isSnowflake(value.userId)) return null;
    return {
        userId: value.userId,
        channelId: isSnowflake(value.channelId) ? value.channelId : null,
        oldChannelId: isSnowflake(value.oldChannelId) ? value.oldChannelId : null,
        guildId: isSnowflake(value.guildId) ? value.guildId : null,
        deaf: value.deaf === true,
        mute: value.mute === true,
        selfDeaf: value.selfDeaf === true,
        selfMute: value.selfMute === true,
        selfStream: value.selfStream === true,
    };
}

function stateToPayload(guildId: string, state: ChannelState): ParticipantPayload {
    const user = UserStore.getUser(state.userId);
    const username = boundedString(GuildMemberStore.getNick(guildId, state.userId), 128)
        ?? boundedString(user?.globalName, 128)
        ?? boundedString(user?.username, 128);
    return {
        userId: state.userId,
        username,
        avatar: boundedString(user?.avatar, 256),
        channelId: state.channelId,
        deaf: state.deaf || state.selfDeaf,
        mute: state.mute || state.selfMute,
        streaming: state.selfStream,
        speaking: false,
    };
}

function sendAuthenticated(payload: JsonValue, expectedConnection = bridge): void {
    const connection = expectedConnection;
    if (!connection || !isActive(connection) || !connection.protocol.authenticated) return;

    connection.sendQueue = connection.sendQueue.then(async () => {
        if (!isActive(connection) || !connection.protocol.authenticated) return;
        const encoded = await connection.protocol.encode(payload);
        if (encoded && isActive(connection)) connection.socket.send(encoded);
    }).catch(error => {
        logger.warn("Failed to send an authenticated Orbolay message", error);
        closeConnection(connection, 1011, "Orbolay protocol error");
    });
}

function incoming(command: OrbolayControlCommand): void {
    switch (command.cmd) {
        case "TOGGLE_MUTE":
            FluxDispatcher.dispatch({
                type: "AUDIO_TOGGLE_SELF_MUTE",
                syncRemote: true,
                playSoundEffect: true,
                context: "default",
            });
            break;
        case "TOGGLE_DEAF":
            FluxDispatcher.dispatch({
                type: "AUDIO_TOGGLE_SELF_DEAF",
                syncRemote: true,
                playSoundEffect: true,
                context: "default",
            });
            break;
        case "DISCONNECT":
            FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId: null });
            break;
        case "STOP_STREAM": {
            const userId = UserStore.getCurrentUser()?.id;
            if (!isSnowflake(userId)) return;
            const voiceState = VoiceStateStore.getVoiceStateForUser(userId);
            if (!isSnowflake(voiceState?.channelId)) return;
            const channel = ChannelStore.getChannel(voiceState.channelId);
            if (!channel || !isSnowflake(channel.guild_id)) return;
            FluxDispatcher.dispatch({
                type: "STREAM_STOP",
                streamKey: `guild:${channel.guild_id}:${voiceState.channelId}:${userId}`,
                appContext: "APP",
            });
            break;
        }
        case "NAVIGATE":
            FluxDispatcher.dispatch({
                type: "CHANNEL_SELECT",
                guildId: command.guildId,
                channelId: command.channelId,
                messageId: command.messageId,
            });
            break;
    }
}

async function sendInitialState(connection: BridgeConnection): Promise<void> {
    const user = await waitForPopulate(() => UserStore.getCurrentUser());
    if (!user || !isSnowflake(user.id) || !isActive(connection) || !connection.protocol.authenticated) return;

    sendAuthenticated({ cmd: "REGISTER_CONFIG", userId: user.id }, connection);
    sendAuthenticated({ cmd: "STREAMER_MODE", enabled: StreamerModeStore.enabled === true }, connection);

    const userVoiceState = VoiceStateStore.getVoiceStateForUser(user.id);
    if (!isSnowflake(userVoiceState?.channelId)) return;
    const channel = ChannelStore.getChannel(userVoiceState.channelId);
    if (!channel || !isSnowflake(channel.guild_id)) return;
    const rawStates = VoiceStateStore.getVoiceStatesForChannel(userVoiceState.channelId);
    if (!rawStates || !isActive(connection)) return;

    const states = Object.values(rawStates)
        .slice(0, MAX_VOICE_STATES)
        .map(normalizeChannelState)
        .filter((state): state is ChannelState => state !== null)
        .map(state => stateToPayload(channel.guild_id, state));
    sendAuthenticated({ cmd: "CHANNEL_JOINED", states }, connection);
    currentChannel = userVoiceState.channelId;
}

async function applyProtocolActions(
    connection: BridgeConnection,
    actions: readonly OrbolayProtocolAction[]
): Promise<void> {
    for (const action of actions) {
        if (bridge !== connection) return;
        switch (action.type) {
            case "send":
                if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(action.data);
                break;
            case "authenticated":
                if (connection.authenticationTimer) clearTimeout(connection.authenticationTimer);
                connection.authenticationTimer = undefined;
                showToast("Authenticated with the Orbolay companion.", Toasts.Type.SUCCESS);
                void sendInitialState(connection);
                break;
            case "command":
                incoming(action.command);
                break;
            case "close":
                logger.warn(action.reason);
                closeConnection(connection, 1008, action.reason);
                return;
        }
    }
}

function createWebsocket(): void {
    const secret = configuredSecret();
    const port = configuredPort();
    if (!secret || !port) return;
    if (bridge) closeConnection(bridge, 1000, "Orbolay reconnecting");

    logger.info("Connecting to the authenticated Orbolay companion");
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const connection: BridgeConnection = {
        socket,
        protocol: new OrbolayAuthenticatedProtocol(secret),
        receiveQueue: Promise.resolve(),
        sendQueue: Promise.resolve(),
    };
    bridge = connection;

    connection.connectionTimer = setTimeout(() => {
        if (bridge !== connection || socket.readyState === WebSocket.OPEN) return;
        showToast("The authenticated Orbolay companion did not accept the connection.", Toasts.Type.FAILURE);
        closeConnection(connection, 1000, "Orbolay connection timed out");
    }, 5_000);

    socket.onerror = () => {
        if (bridge !== connection) return;
        logger.warn("The Orbolay WebSocket connection failed");
        closeConnection(connection, 1000, "Orbolay connection failed");
    };
    socket.onclose = () => disposeConnection(connection);
    socket.onopen = () => {
        if (bridge !== connection) return;
        if (connection.connectionTimer) clearTimeout(connection.connectionTimer);
        connection.connectionTimer = undefined;
        try {
            socket.send(connection.protocol.start());
            connection.authenticationTimer = setTimeout(() => {
                if (bridge !== connection || connection.protocol.authenticated) return;
                closeConnection(connection, 1008, "Orbolay authentication timed out");
            }, ORBOLAY_HANDSHAKE_TIMEOUT_MS);
        } catch (error) {
            logger.warn("Could not start Orbolay authentication", error);
            closeConnection(connection, 1011, "Orbolay protocol error");
        }
    };
    socket.onmessage = event => {
        connection.receiveQueue = connection.receiveQueue.then(async () => {
            if (bridge !== connection) return;
            await applyProtocolActions(connection, await connection.protocol.receive(event.data));
        }).catch(error => {
            logger.warn("Rejected an Orbolay protocol message", error);
            closeConnection(connection, 1008, "Orbolay protocol error");
        });
    };
}

function handleSpeaking(dispatch: unknown): void {
    if (!bridge?.protocol.authenticated || !isRecord(dispatch) || !isSnowflake(dispatch.userId)) return;
    sendAuthenticated({
        cmd: "VOICE_STATE_UPDATE",
        state: {
            userId: dispatch.userId,
            speaking: typeof dispatch.speakingFlags === "number" && (dispatch.speakingFlags & 1) === 1,
        },
    });
}

function handleMessageNotification(dispatch: unknown): void {
    if (!bridge?.protocol.authenticated || !isRecord(dispatch) || !isRecord(dispatch.message)) return;
    const channelId = dispatch.message.channel_id;
    const messageId = dispatch.message.id;
    if (!isSnowflake(channelId) || !isSnowflake(messageId)) return;
    const guildId = isSnowflake(dispatch.message.guild_id) ? dispatch.message.guild_id : null;
    sendAuthenticated({
        cmd: "MESSAGE_NOTIFICATION",
        message: {
            title: boundedString(dispatch.title, 256) ?? "",
            body: boundedString(dispatch.body, 2_048) ?? "",
            icon: boundedString(dispatch.icon, 2_048),
            guildId,
            channelId,
            messageId,
        },
    });
}

async function handleVoiceStateUpdates(dispatch: unknown): Promise<void> {
    if (!bridge?.protocol.authenticated || !isRecord(dispatch) || !Array.isArray(dispatch.voiceStates)) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!isSnowflake(userId)) return;

    for (const rawState of dispatch.voiceStates.slice(0, MAX_VOICE_STATES)) {
        const state = normalizeChannelState(rawState);
        if (!state) continue;
        const ourState = state.userId === userId;

        if (ourState) {
            if (state.channelId && state.channelId !== currentChannel && state.guildId) {
                const connection = bridge;
                const { channelId } = state;
                const { guildId } = state;
                const voiceStates = await waitForPopulate(() =>
                    VoiceStateStore.getVoiceStatesForChannel(channelId)
                );
                if (!connection || bridge !== connection || !connection.protocol.authenticated || !voiceStates) return;
                const states = Object.values(voiceStates)
                    .slice(0, MAX_VOICE_STATES)
                    .map(normalizeChannelState)
                    .filter((item): item is ChannelState => item !== null)
                    .map(item => stateToPayload(guildId, item));
                sendAuthenticated({ cmd: "CHANNEL_JOINED", states }, connection);
                currentChannel = state.channelId;
                break;
            }
            if (!state.channelId) {
                sendAuthenticated({ cmd: "CHANNEL_LEFT" });
                currentChannel = null;
                break;
            }
        }

        if (currentChannel && (state.channelId === currentChannel || state.oldChannelId === currentChannel) && state.guildId) {
            sendAuthenticated({
                cmd: "VOICE_STATE_UPDATE",
                state: stateToPayload(state.guildId, state),
            });
        }
    }
}

function handleStreamerMode(): void {
    if (!bridge?.protocol.authenticated) return;
    sendAuthenticated({ cmd: "STREAMER_MODE", enabled: StreamerModeStore.enabled === true });
}

export default definePlugin({
    name: "OrbolayBridge",
    description: "Bridge plugin to connect Orbolay to Discord",
    tags: ["Utility", "Voice"],
    authors: [EquicordDevs.SpikeHD],
    settings,
    flux: {
        SPEAKING: handleSpeaking,
        VOICE_STATE_UPDATES: handleVoiceStateUpdates,
        RPC_NOTIFICATION_CREATE: handleMessageNotification,
        STREAMER_MODE_UPDATE: handleStreamerMode,
    },

    start() {
        createWebsocket();
    },

    stop() {
        if (bridge) closeConnection(bridge, 1000, "Orbolay bridge stopped");
        bridge = null;
        currentChannel = null;
    },
});
