/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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
import { classNameFactory } from "@utils/css";
import { React, UserStore, useStateFromStores } from "@webpack/common";

import { ChromeIcon, DiscordIcon, EdgeIcon, FirefoxIcon, IEIcon, MobileIcon, OperaIcon, SafariIcon, UnknownIcon } from "./components/icons";
import { SessionInfo } from "./types";

export const getDataKey = () => {
    const currentUserId = UserStore.getCurrentUser()?.id;
    return currentUserId ? `BetterSessions_savedSessions_${currentUserId}` : undefined;
};

export const cl = classNameFactory("vc-betterSessions-");
export const savedSessionsCache: Map<string, { name: string, isNew: boolean; }> = new Map();
let cacheDataKey: string | undefined;
let cacheVersion = 0;
const listeners = new Set<() => void>();

function notifySessionNames() {
    cacheVersion++;
    listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useSessionNames() {
    useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    React.useSyncExternalStore(subscribe, () => cacheVersion);
    return isSessionCacheCurrent() ? savedSessionsCache : undefined;
}

export function isSessionCacheCurrent() {
    return cacheDataKey !== undefined && cacheDataKey === getDataKey();
}

export function resetSessionCache() {
    cacheDataKey = undefined;
    savedSessionsCache.clear();
    notifySessionNames();
}

export function getDefaultName(clientInfo: SessionInfo["session"]["client_info"]) {
    return `${clientInfo.os} · ${clientInfo.platform}`;
}

export function saveSessionsToDataStore() {
    const dataKey = cacheDataKey;
    if (!dataKey || dataKey !== getDataKey()) return Promise.reject(new Error("Session names belong to a different or unloaded account"));

    const snapshot = new Map(Array.from(savedSessionsCache, ([id, data]) => [id, { ...data }]));
    notifySessionNames();
    return DataStore.set(dataKey, snapshot);
}

export async function fetchNamesFromDataStore(shouldApply = () => true) {
    resetSessionCache();

    const dataKey = getDataKey();
    if (!dataKey) return false;

    const savedSessions = await DataStore.get<Map<string, { name: string, isNew: boolean; }>>(dataKey) || new Map();
    if (!shouldApply() || dataKey !== getDataKey()) return false;

    savedSessionsCache.clear();
    savedSessions.forEach((data, idHash) => {
        savedSessionsCache.set(idHash, data);
    });
    cacheDataKey = dataKey;
    notifySessionNames();
    return true;
}

export function GetOsColor(os: string) {
    switch (os) {
        case "Windows Mobile":
        case "Windows":
            return "#55a6ef"; // Light blue
        case "Linux":
            return "#cdcd31"; // Yellow
        case "Android":
            return "#7bc958"; // Green
        case "Mac OS X":
        case "iOS":
            return ""; // Default to white/black (theme-dependent)
        default:
            return "#f3799a"; // Pink
    }
}

export function GetPlatformIcon(platform: string) {
    switch (platform) {
        case "Discord Android":
        case "Discord iOS":
        case "Discord Client":
            return DiscordIcon;
        case "Android Chrome":
        case "Chrome iOS":
        case "Chrome":
            return ChromeIcon;
        case "Edge":
            return EdgeIcon;
        case "Firefox":
            return FirefoxIcon;
        case "Internet Explorer":
            return IEIcon;
        case "Opera Mini":
        case "Opera":
            return OperaIcon;
        case "Mobile Safari":
        case "Safari":
            return SafariIcon;
        case "BlackBerry":
        case "Facebook Mobile":
        case "Android Mobile":
            return MobileIcon;
        default:
            return UnknownIcon;
    }
}
