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

function hasSamePreviousChannel(previous: PreviousChannel | undefined, next: PreviousChannel) {
    return previous?.guildId === next.guildId && previous.channelId === next.channelId;
}

function clearPreviousSaveTimeout() {
    if (previousSaveTimeout === undefined) return;

    clearTimeout(previousSaveTimeout);
    previousSaveTimeout = undefined;
}

async function savePreviousChannelNow() {
    clearPreviousSaveTimeout();
    if (!previousCache) return;

    await DataStore.set("KeepCurrentChannel_previousData", previousCache);
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
        previousCache = await DataStore.get<PreviousChannel>("KeepCurrentChannel_previousData");
        if (!previousCache) {
            previousCache = {
                guildId: SelectedGuildStore.getGuildId(),
                channelId: SelectedChannelStore.getChannelId() ?? null
            };

            await DataStore.set("KeepCurrentChannel_previousData", previousCache);
        } else if (previousCache.channelId) {
            ChannelRouter.transitionToChannel(previousCache.channelId);
        }
    },

    stop() {
        void savePreviousChannelNow();
    }
});
