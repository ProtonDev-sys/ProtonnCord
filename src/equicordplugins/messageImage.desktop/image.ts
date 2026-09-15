/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Mask { x: number; y: number; width: number; height: number; }
export interface CapturedMessage {
    id: string;
    canvas: HTMLCanvasElement;
    names: Mask[];
    avatars: Mask[];
    times: Mask[];
}
export const MAX_MESSAGES = 24;
export const MAX_PIXELS = 16_000_000;

export function maskBetween(start: { x: number; y: number; }, end: { x: number; y: number; }, width: number, height: number): Mask {
    const x = Math.max(0, Math.min(width, Math.min(start.x, end.x)));
    const y = Math.max(0, Math.min(height, Math.min(start.y, end.y)));
    return { x, y, width: Math.max(0, Math.min(width, Math.max(start.x, end.x)) - x), height: Math.max(0, Math.min(height, Math.max(start.y, end.y)) - y) };
}

export function captureDimensions(messages: CapturedMessage[]) {
    if (!messages.length || messages.length > MAX_MESSAGES) throw new Error(`Choose 1–${MAX_MESSAGES} messages.`);
    const { width } = messages[0].canvas;
    const height = messages.reduce((sum, message) => sum + message.canvas.height, 0);
    if (messages.some(message => message.canvas.width !== width)) throw new Error("Discord's width or zoom changed between captures. Clear the selection and capture the messages again.");
    if (!width || !height || width * height > MAX_PIXELS || height > 16384) throw new Error("The image is too large. Select fewer messages.");
    return { width, height };
}

export function composeCaptures(messages: CapturedMessage[]) {
    const { width, height } = captureDimensions(messages);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image rendering is unavailable.");
    const names: Mask[] = [], avatars: Mask[] = [], times: Mask[] = [], rows: Mask[] = [];
    let y = 0;
    for (const message of messages) {
        // Integer positions and the original dimensions preserve every captured pixel.
        ctx.drawImage(message.canvas, 0, y);
        for (const [input, output] of [[message.names, names], [message.avatars, avatars], [message.times, times]])
            for (const rect of input) output.push({ ...rect, y: rect.y + y });
        rows.push({ x: 0, y, width, height: message.canvas.height });
        y += message.canvas.height;
    }
    return { canvas, names, avatars, times, rows };
}

export function paintPreview(target: HTMLCanvasElement, source: HTMLCanvasElement, masks: Mask[]) {
    target.width = source.width; target.height = source.height;
    const ctx = target.getContext("2d");
    if (!ctx) throw new Error("Image rendering is unavailable.");
    ctx.drawImage(source, 0, 0);
    ctx.fillStyle = "#000000";
    for (const mask of masks) ctx.fillRect(Math.floor(mask.x), Math.floor(mask.y), Math.ceil(mask.x + mask.width) - Math.floor(mask.x), Math.ceil(mask.y + mask.height) - Math.floor(mask.y));
}

export function png(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not create the PNG.")), "image/png"));
}
