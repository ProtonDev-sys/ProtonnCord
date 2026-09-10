/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as DataStore from "@api/DataStore";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { ChannelRouter, ChannelStore, NavigationRouter, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

export interface LogoutEvent {
    type: "LOGOUT";
    isSwitchingAccount: boolean;
}

interface ChannelSelectEvent {
    type: "CHANNEL_SELECT";
    channelId: string | null;
    guildId: string | null;
}

interface PreviousChannel {
    guildId: string | null;
    channelId: string | null;
}

let isSwitchingAccount = false;
let previousCache: PreviousChannel | undefined;
let previousSaveTimeout: ReturnType<typeof setTimeout> | undefined;
let previousSave = Promise.resolve();
let lifecycleGeneration = 0;
let selectionGeneration = 0;
const logger = new Logger("KeepCurrentChannel");

function hasSamePreviousChannel(previous: PreviousChannel | undefined, next: PreviousChannel) {
    return previous?.guildId === next.guildId && previous.channelId === next.channelId;
}

function clearPreviousSaveTimeout() {
    if (previousSaveTimeout === undefined) return;

    clearTimeout(previousSaveTimeout);
    previousSaveTimeout = undefined;
}

function savePreviousChannelNow() {
    clearPreviousSaveTimeout();
    if (!previousCache) return previousSave;

    const snapshot = previousCache;
    previousSave = previousSave
        .then(() => DataStore.set("KeepCurrentChannel_previousData", snapshot))
        .catch(error => logger.error("Failed to save the current channel", error));
    return previousSave;
}

function schedulePreviousChannelSave() {
    clearPreviousSaveTimeout();
    previousSaveTimeout = setTimeout(() => void savePreviousChannelNow(), 500);
}

export default definePlugin({
    name: "KeepCurrentChannel",
    description: "Attempt to navigate to the channel you were in before switching accounts or loading Discord.",
    tags: ["Utility", "Organisation"],
    authors: [Devs.Nuckyz],

    patches: [
        {
            find: '"Switching accounts"',
            replacement: {
                match: /goHomeAfterSwitching:\i/,
                replace: "goHomeAfterSwitching:!1"
            }
        }
    ],

    flux: {
        LOGOUT(e: LogoutEvent) {
            lifecycleGeneration++;
            ({ isSwitchingAccount } = e);
            void savePreviousChannelNow();
        },

        CONNECTION_OPEN() {
            if (!isSwitchingAccount) return;
            isSwitchingAccount = false;

            if (previousCache?.channelId) {
                if (ChannelStore.hasChannel(previousCache.channelId)) {
                    ChannelRouter.transitionToChannel(previousCache.channelId);
                } else {
                    NavigationRouter.transitionToGuild("@me");
                }
            }
        },

        CHANNEL_SELECT({ guildId, channelId }: ChannelSelectEvent) {
            if (isSwitchingAccount) return;
            selectionGeneration++;

            const nextPrevious: PreviousChannel = {
                guildId,
                channelId
            };

            if (hasSamePreviousChannel(previousCache, nextPrevious)) return;

            previousCache = nextPrevious;
            schedulePreviousChannelSave();
        }
    },

    async start() {
        const generation = ++lifecycleGeneration;
        const selection = selectionGeneration;
        isSwitchingAccount = false;
        let previous: PreviousChannel | undefined;
        try {
            await previousSave;
            if (generation !== lifecycleGeneration || selection !== selectionGeneration) return;
            previous = await DataStore.get<PreviousChannel>("KeepCurrentChannel_previousData");
        } catch (error) {
            logger.error("Failed to load the previous channel", error);
            return;
        }
        if (generation !== lifecycleGeneration || selection !== selectionGeneration) return;
        if (previous != null && (typeof previous !== "object" ||
            (previous.channelId !== null && typeof previous.channelId !== "string") ||
            (previous.guildId !== null && typeof previous.guildId !== "string"))) {
            logger.error("Ignoring invalid previous-channel data");
            return;
        }
        previousCache = previous;
        if (!previousCache) {
            previousCache = {
                guildId: SelectedGuildStore.getGuildId(),
                channelId: SelectedChannelStore.getChannelId() ?? null
            };

            await savePreviousChannelNow();
        } else if (previousCache.channelId) {
            ChannelRouter.transitionToChannel(previousCache.channelId);
        }
    },

    stop() {
        lifecycleGeneration++;
        isSwitchingAccount = false;
        return savePreviousChannelNow();
    }
});
