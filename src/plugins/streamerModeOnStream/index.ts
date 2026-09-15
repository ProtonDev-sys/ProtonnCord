/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
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

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, StreamerModeStore, UserStore } from "@webpack/common";

interface StreamEvent {
    streamKey: string;
}

const streams = new Set<string>();
let previousState: boolean | undefined;
let accountId: string | undefined;

function restoreStreamerMode() {
    if (previousState !== undefined && accountId === UserStore.getCurrentUser()?.id && StreamerModeStore.enabled)
        FluxDispatcher.dispatch({ type: "STREAMER_MODE_UPDATE", key: "enabled", value: previousState });
    streams.clear();
    previousState = undefined;
    accountId = undefined;
}

function toggleStreamerMode({ streamKey }: StreamEvent, value: boolean) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId || typeof streamKey !== "string" || streamKey.split(":").at(-1) !== currentUserId) return;
    if (!value) {
        if (!streams.delete(streamKey)) return;
        if (!streams.size) restoreStreamerMode();
        return;
    }
    if (accountId !== currentUserId) {
        streams.clear();
        previousState = undefined;
    }
    if (!streams.size) {
        previousState = StreamerModeStore.enabled;
        accountId = currentUserId;
    }
    streams.add(streamKey);

    FluxDispatcher.dispatch({
        type: "STREAMER_MODE_UPDATE",
        key: "enabled",
        value
    });
}

export default definePlugin({
    name: "StreamerModeOn",
    description: "Automatically enables streamer mode when you start streaming in Discord",
    tags: ["Privacy", "Utility"],
    authors: [Devs.IcedMarina],
    stop: restoreStreamerMode,
    flux: {
        STREAM_CREATE: d => toggleStreamerMode(d, true),
        STREAM_DELETE: d => toggleStreamerMode(d, false),
        LOGOUT() {
            streams.clear();
            previousState = undefined;
            accountId = undefined;
        }
    }
});
