/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { clipboard, type IpcMainInvokeEvent, nativeImage } from "electron";

import { MAX_PIXELS } from "./image";

function authorize(event: IpcMainInvokeEvent) {
    if (RendererSettings.store.plugins?.MessageImage?.enabled !== true || event.sender.isDestroyed()
        || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Message image capture is unavailable.");
    const url = new URL(event.senderFrame.url);
    if (url.protocol !== "https:" || url.port || url.username || url.password
        || !["discord.com", "ptb.discord.com", "canary.discord.com"].includes(url.hostname))
        throw new Error("Message images can only be captured from Discord.");
}

export async function capture(event: IpcMainInvokeEvent, rect: { x: number; y: number; width: number; height: number; }) {
    authorize(event);
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
        || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
        || rect.x + rect.width > 16384 || rect.y + rect.height > 16384 || rect.width * rect.height > MAX_PIXELS)
        throw new Error("Invalid message capture area.");
    const zoom = event.sender.getZoomFactor();
    if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) throw new Error("Unsupported Discord zoom.");
    const area = { x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom), width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) };
    if (area.width * area.height > MAX_PIXELS || area.width < 1 || area.height < 1) throw new Error("The capture is too large.");
    const image = await event.sender.capturePage(area, { stayHidden: true, stayAwake: false });
    authorize(event);
    if (image.isEmpty()) throw new Error("Discord returned an empty capture. Keep its window visible and try again.");
    const scale = Math.max(...image.getScaleFactors());
    const size = image.getSize(scale);
    if (size.width * size.height > MAX_PIXELS) throw new Error("The capture is too large.");
    return new Uint8Array(image.toPNG({ scaleFactor: scale }));
}

export function copyImage(event: IpcMainInvokeEvent, data: Uint8Array) {
    authorize(event);
    if (!(data instanceof Uint8Array) || data.byteLength < 33 || data.byteLength > 64_000_000) throw new Error("Invalid PNG.");
    const bytes = Buffer.from(data);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Invalid PNG.");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > MAX_PIXELS || height > 16384) throw new Error("The image is too large.");
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("Could not read the PNG.");
    clipboard.writeImage(image);
}
