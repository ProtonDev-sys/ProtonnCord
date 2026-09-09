/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUserSettingLazy } from "@api/UserSettings";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { ApplicationStreamingSettingsStore, ChannelStore, MediaEngineStore, PermissionsBits, PermissionStore, SelectedChannelStore, showToast, Toasts, UserStore, VoiceActions, WindowStore } from "@webpack/common";

import { getCurrentMedia, settings } from "./utils";

let hasStreamed = false;
let isStreaming = false;
let streamKey: string | null = null;
let active = false;
let generation = 0;
let pendingRequest: symbol | null = null;
let accountId: string | undefined;

function resetStreamState() {
    generation++;
    pendingRequest = null;
    hasStreamed = false;
    isStreaming = false;
    streamKey = null;
}

function checkAccount() {
    const currentId = UserStore.getCurrentUser()?.id;
    if (currentId !== accountId) {
        resetStreamState();
        accountId = currentId;
    }
    return currentId;
}
const startStream = findByCodeLazy('type:"STREAM_START"');
const stopStream = findByCodeLazy('type:"STREAM_STOP"');
const StreamPreviewSettings = getUserSettingLazy("voiceAndVideo", "disableStreamPreviews")!;

async function autoStartStream(instant = true) {
    const currentUserId = checkAccount();
    if (!active || !currentUserId || pendingRequest) return false;

    if (!instant && !WindowStore.isFocused() && settings.store.focusDiscord) return;
    const selected = SelectedChannelStore.getVoiceChannelId();
    if (!selected) return;

    const channel = ChannelStore.getChannel(selected);
    if (!channel) return;

    const isGuildChannel = !channel.isDM() && !channel.isGroupDM();

    if (channel.type === 13 || isGuildChannel && !PermissionStore.can(PermissionsBits.STREAM, channel)) return;

    const request = Symbol();
    const requestGeneration = generation;
    pendingRequest = request;
    const isCurrent = () => active && generation === requestGeneration
        && UserStore.getCurrentUser()?.id === currentUserId
        && SelectedChannelStore.getVoiceChannelId() === selected;
    try {
        if (isStreaming && streamKey?.split(":").at(-1) === currentUserId) {
            if (!instant) await stopStream(streamKey);
            return true;
        }
        const streamMedia = await getCurrentMedia();
        if (!streamMedia || !isCurrent()) return false;
        if (!instant && !WindowStore.isFocused() && settings.store.focusDiscord) return false;
        if (instant && (!settings.store.toolboxManagement || !settings.store.instantScreenshare)) return false;
        if (isGuildChannel && !PermissionStore.can(PermissionsBits.STREAM, channel)) return false;

        if (settings.store.autoDeafen && !MediaEngineStore.isSelfDeaf() && instant) {
            VoiceActions.toggleSelfDeaf();
        } else if (settings.store.autoMute && !MediaEngineStore.isSelfMute() && instant) {
            VoiceActions.toggleSelfMute();
        }

    const preview = StreamPreviewSettings.getSetting();
    const { soundshareEnabled } = ApplicationStreamingSettingsStore.getState();
    let sourceId = streamMedia.id;
    if (streamMedia.type === "video_device") sourceId = `camera:${streamMedia.id}`;

        await startStream(channel.guild_id ?? null, selected, {
            "pid": null,
            "sourceId": sourceId,
            "sourceName": streamMedia.name,
            "audioSourceId": streamMedia.name,
            "sound": soundshareEnabled,
            "previewDisabled": preview
        });
        return true;
    } catch {
        if (isCurrent()) showToast("Could not start screensharing. Check your selected source.", Toasts.Type.FAILURE);
        return false;
    } finally {
        if (pendingRequest === request) pendingRequest = null;
    }
}

export default definePlugin({
    name: "InstantScreenshare",
    description: "Instantly screenshare when joining a voice channel with support for desktop sources, windows, and video input devices (cameras, capture cards)",
    tags: ["Media", "Voice"],
    authors: [Devs.HAHALOSAH, Devs.thororen, EquicordDevs.mart],
    dependencies: ["ProtonnCordToolbox"],
    searchTerms: ["ScreenshareKeybind"],
    autoStartStream,
    settings,
    start() {
        resetStreamState();
        accountId = UserStore.getCurrentUser()?.id;
        active = true;
    },

    settingsAboutComponent: () => (
        <>
            <HeadingSecondary>For Linux</HeadingSecondary>
            <Paragraph>
                For Wayland it only pops up the screenshare select
                <br />
                For X11 it may or may not work :shrug:
            </Paragraph>
            <br />
            <HeadingSecondary>Video Devices</HeadingSecondary>
            <Paragraph>
                Supports cameras and capture cards (like Elgato HD60X) when enabled in settings
            </Paragraph>
            <br />
            <HeadingSecondary>Regarding Sound & Preview Settings</HeadingSecondary>
            <Paragraph>
                We use the settings set and used by discord to decide if stream preview and sound should be enabled or not
            </Paragraph>
        </>
    ),

    patches: [
        {
            find: "DISCONNECT_FROM_VOICE_CHANNEL]",
            predicate: () => settings.store.keybindScreenshare,
            replacement: {
                match: /\[\i\.\i\.DISCONNECT_FROM_VOICE_CHANNEL/,
                replace: '["INSTANT_SCREEN_SHARE"]:{onTrigger(){$self.autoStartStream(false)},keyEvents:{keyUp:!1,keyDown:!0}},$&'
            },
        },
        {
            find: '"push-to-talk-priority"',
            predicate: () => settings.store.keybindScreenshare,
            replacement: {
                match: /=\[(\{id:.{0,25}value:\i\.\i\.UNASSIGNED)/,
                replace: '=[{id:"instant-screen-share",value:"INSTANT_SCREEN_SHARE",label:"Instant Screenshare"},$1'
            }
        }
    ],

    flux: {
        async VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            if (!settings.store.toolboxManagement || !settings.store.instantScreenshare) return;
            const myId = checkAccount();
            if (!myId) return;

            const myState = voiceStates.find(state => state.userId === myId);
            if (!myState) return;

            if (myState.channelId && !hasStreamed) {
                hasStreamed = true;
                const currentGeneration = generation;
                if (!await autoStartStream() && currentGeneration === generation) hasStreamed = false;
            }

            if (!myState.channelId) {
                resetStreamState();
            }
        },
        STREAM_CREATE: ({ streamKey: key }: { streamKey: string; }) => {
            const currentId = checkAccount();
            if (!currentId || typeof key !== "string" || key.split(":").at(-1) !== currentId) return;
            streamKey = key;
            isStreaming = true;
        },
        STREAM_DELETE: ({ streamKey: key }: { streamKey: string; }) => {
            if (key !== streamKey) return;
            streamKey = null;
            isStreaming = false;
        }
    },

    toolboxActions: {
        "Instant Screenshare"() {
            settings.store.toolboxManagement = !settings.store.toolboxManagement;
            showToast(`Instant Screenshare ${settings.store.toolboxManagement ? "Enabled" : "Disabled"}`, Toasts.Type.SUCCESS);
        }
    },

    stop() {
        active = false;
        resetStreamState();
    }
});
