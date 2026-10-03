/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { Flux as TFlux } from "@vencord/discord-types";
import { ChannelActionCreators, ChannelStore, Flux as FluxWP, FluxDispatcher, PopoutActions, PopoutWindowStore, UserStore } from "@webpack/common";

interface IFlux extends TFlux {
    PersistedStore: TFlux["Store"];
}

export const settings = definePluginSettings({
    persistSidebar: {
        type: OptionType.BOOLEAN,
        description: "Keep the sidebar chat open across Discord restarts",
        default: true,
    },
    persistPopoutWindows: {
        type: OptionType.BOOLEAN,
        description: "Restore open popout chats after Discord restarts.",
        default: true,
        onChange: value => {
            if (!value) {
                settings.store.persistedPopoutWindowIds = [];
                return;
            }

            syncPersistedPopoutWindows();
        }
    },
    persistedPopoutWindowIds: {
        type: OptionType.CUSTOM,
        description: "Persisted popout chat channel IDs.",
        default: [] as string[],
        hidden: true
    },
    persistedPopoutWindowsByUser: {
        type: OptionType.CUSTOM,
        description: "Account-scoped persisted popout chat channel IDs.",
        default: {} as Record<string, string[]>,
        hidden: true
    },
    popoutAlwaysOnTop: {
        type: OptionType.BOOLEAN,
        description: "Keep popout chat windows above all others.",
        default: true,
        onChange: value => {
            setAlwaysOnTopForOpenPopouts(value);
        }
    },
});

let sidebarActive = false;
let selectionGeneration = 0;

export function setSidebarActive(active: boolean) {
    sidebarActive = active;
    selectionGeneration++;
}

export const SidebarStore = proxyLazy(() => {
    const current = {
        userId: "",
        guildId: "",
        channelId: "",
        width: 0
    };

    let previous = { ...current };

    class SidebarStore extends (FluxWP as IFlux).PersistedStore {
        static persistKey = "SidebarStore";

        // @ts-ignore
        initialize(previousState: { userId?: string; guildId?: string; channelId?: string; width?: number; } | undefined) {
            if (!settings.store.persistSidebar || !previousState) return;
            const { guildId, channelId, width } = previousState;
            current.width = width || 0;
            if (!previousState.userId || previousState.userId !== UserStore.getCurrentUser()?.id) return;
            current.userId = previousState.userId;
            current.guildId = guildId || "";
            current.channelId = channelId || "";
        }

        getState() {
            return current.userId === UserStore.getCurrentUser()?.id ? current : { ...current, guildId: "", channelId: "" };
        }
    }

    const store = new SidebarStore(FluxDispatcher, {
        // @ts-ignore
        async VC_SIDEBAR_CHAT_NEW({ guildId: newGId, id }: { guildId: string | null; id: string; }) {
            const userId = UserStore.getCurrentUser()?.id;
            if (!sidebarActive || !userId) return;
            const generation = ++selectionGeneration;
            previous = { ...store.getState() };

            if (newGId) {
                current.userId = userId;
                current.guildId = newGId;
                current.channelId = id;
                store.emitChange();
                return;
            }

            try {
                const channelId = ChannelStore.getChannel(id)?.isPrivate()
                    ? id
                    : await ChannelActionCreators.getOrEnsurePrivateChannel(id);
                if (!channelId || !sidebarActive || generation !== selectionGeneration || userId !== UserStore.getCurrentUser()?.id) return;
                current.userId = userId;
                current.guildId = "";
                current.channelId = channelId;
                store.emitChange();
            } catch (error) {
                new Logger("SidebarChat").error("Could not open private channel", error);
            }
        },

        VC_SIDEBAR_CHAT_PREVIOUS() {
            selectionGeneration++;
            if (sidebarActive && previous.channelId && previous.userId === UserStore.getCurrentUser()?.id) {
                current.userId = previous.userId;
                current.guildId = previous.guildId;
                current.channelId = previous.channelId;
            }
            store.emitChange();
        },

        VC_SIDEBAR_CHAT_CLOSE() {
            selectionGeneration++;
            previous = { ...current };
            current.guildId = "";
            current.channelId = "";
            store.emitChange();
        },
        LOGOUT() {
            selectionGeneration++;
            current.userId = "";
            current.guildId = "";
            current.channelId = "";
            previous = { ...current };
            store.emitChange();
        },
    });

    return store;
});

const WINDOW_PREFIX = "DISCORD_VC_SC-";

export function getPopoutWindowKey(channelId: string) {
    return `${WINDOW_PREFIX}${channelId}`;
}

export function getOpenPopoutWindowKeys() {
    return PopoutWindowStore.getWindowKeys().filter(key => key.startsWith(WINDOW_PREFIX));
}

export function isPopoutWindowOpen(channelId: string) {
    return PopoutWindowStore.getWindowOpen(getPopoutWindowKey(channelId));
}

export function getPersistedPopoutChannelIds() {
    const userId = UserStore.getCurrentUser()?.id;
    return userId ? settings.store.persistedPopoutWindowsByUser?.[userId] ?? [] : [];
}

export function getOpenPopoutChannelIds() {
    return getOpenPopoutWindowKeys().map(key => key.slice(WINDOW_PREFIX.length));
}

export function syncPersistedPopoutWindows(userId = UserStore.getCurrentUser()?.id) {
    if (!userId) return;
    settings.store.persistedPopoutWindowsByUser = {
        ...settings.store.persistedPopoutWindowsByUser,
        [userId]: settings.store.persistPopoutWindows ? getOpenPopoutChannelIds() : []
    };
}

export function setAlwaysOnTopForOpenPopouts(value: boolean) {
    for (const windowKey of getOpenPopoutWindowKeys()) {
        PopoutActions.setAlwaysOnTop(windowKey, value);
    }
}
