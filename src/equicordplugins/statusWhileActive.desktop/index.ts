/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { UserStore, VoiceStateStore } from "@webpack/common";

let savedStatus: string | null = null;
let savedUserId: string | null = null;
let appliedStatus: string | null = null;

const StatusSettings = getUserSettingLazy<string>("status", "status")!;

const settings = definePluginSettings({
    statusToSet: {
        type: OptionType.SELECT,
        description: "Status to set while in a voice channel.",
        options: [
            {
                label: "Online",
                value: "online",
            },
            {
                label: "Idle",
                value: "idle",
            },
            {
                label: "Do Not Disturb",
                value: "dnd",
                default: true
            },
            {
                label: "Invisible",
                value: "invisible",
            }
        ]
    }
});

function restoreStatus() {
    if (savedStatus && savedUserId === UserStore.getCurrentUser()?.id && StatusSettings.getSetting() === appliedStatus) {
        StatusSettings.updateSetting(savedStatus);
    }
    savedStatus = null;
    savedUserId = null;
    appliedStatus = null;
}

function setStatus(inVoiceChannel: boolean, status: string) {
    const userId = UserStore.getCurrentUser()?.id;
    if (savedUserId !== userId) {
        savedStatus = null;
        savedUserId = null;
        appliedStatus = null;
    }
    if (!userId) return;
    if (inVoiceChannel) {
        if (status !== settings.store.statusToSet) {
            savedStatus = status;
            savedUserId = userId;
            appliedStatus = settings.store.statusToSet;
            StatusSettings?.updateSetting(settings.store.statusToSet);
        }
        return;
    }

    restoreStatus();
}

function updateStatusForCurrentVoiceState() {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    const status = StatusSettings.getSetting();
    const inVoiceChannel = !!VoiceStateStore.getVoiceStateForUser(userId)?.channelId;

    setStatus(inVoiceChannel, status);
}

export default definePlugin({
    name: "StatusWhileActive",
    description: "Automatically updates your online status when in a voice channel.",
    tags: ["Activity", "Customisation", "Voice"],
    authors: [EquicordDevs.smuki],
    settings,
    dependencies: ["UserSettingsAPI"],
    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const userId = UserStore.getCurrentUser()?.id;
            if (!userId) return;

            const myState = voiceStates.find(state => state.userId === userId);
            if (!myState) return;

            updateStatusForCurrentVoiceState();
        },
        VOICE_CHANNEL_STATUS_UPDATE() {
            updateStatusForCurrentVoiceState();
        }
    },

    stop() {
        restoreStatus();
    }
});
