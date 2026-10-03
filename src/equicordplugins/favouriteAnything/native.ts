/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageAttachment } from "@vencord/discord-types";
import type { IpcMainInvokeEvent } from "electron";

import { fetchNativeMedia } from "../fileUpload/nativeNetwork";

const allowedHosts = new Set([
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "media.discordapp.net"
]);

// Discord has very strict CORS rules for which types of assets can be fetched from where (CDN/Media proxy),
// and most binary file types are prohibited by both. This function serves as a simple bypass.
export async function fetchAttachment(event: IpcMainInvokeEvent, attachment: MessageAttachment) {
    if (!attachment || typeof attachment.filename !== "string" || attachment.filename.length > 255
        || (attachment.content_type != null && typeof attachment.content_type !== "string"))
        throw new Error("Invalid attachment");
    const { content_type, filename } = attachment;
    const { data, type: mediaType } = await fetchNativeMedia(event, attachment.url, allowedHosts, 128 * 1024 * 1024);
    const type = mediaType || content_type || "application/octet-stream";

    return { type, data, filename };
}
