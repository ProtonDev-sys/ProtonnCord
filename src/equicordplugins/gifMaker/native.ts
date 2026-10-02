/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

import { fetchNativeMedia } from "../fileUpload/nativeNetwork";

const ALLOWED_MEDIA_HOSTS = new Set([
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "media.discordapp.net",
    "media.tenor.com",
    "tenor.com",
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
]);

export async function fetchMedia(event: IpcMainInvokeEvent, url: string) {
    const { data, type } = await fetchNativeMedia(event, url, ALLOWED_MEDIA_HOSTS, 64 * 1024 * 1024);
    if (data.byteLength === 0) throw new Error("Empty media body");

    return {
        data,
        type: type || "application/octet-stream"
    };
}
