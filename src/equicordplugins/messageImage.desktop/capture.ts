/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { ContextMenuApi } from "@webpack/common";

import { CapturedMessage, Mask, MAX_PIXELS } from "./image";

export const Native = VencordNative.pluginHelpers.MessageImage as PluginNative<typeof import("./native")>;

function frame(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => { cancelAnimationFrame(id); clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
        const id = requestAnimationFrame(finish);
        const timer = setTimeout(() => { cancelAnimationFrame(id); signal.removeEventListener("abort", abort); reject(new Error("Keep Discord visible while capturing.")); }, 1500);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}

export async function captureMessage(channelId: string, messageId: string, signal: AbortSignal): Promise<CapturedMessage> {
    ContextMenuApi.closeContextMenu();
    await frame(signal); await frame(signal);
    for (let attempts = 0; document.querySelector('[role="menu"]'); attempts++) {
        if (attempts >= 30) throw new Error("Close the open menu and try again.");
        await frame(signal);
    }
    const rowId = `chat-messages-${channelId}-${messageId}`;
    const initial = document.getElementById(rowId);
    if (!initial) throw new Error("Scroll this message into view and try again.");
    let scroller = initial.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) throw new Error("Could not locate Discord's message list.");
    const originalScroll = scroller.scrollTop;
    const originalRect = initial.getBoundingClientRect();
    const { height } = originalRect;
    if (height <= 0 || height > 8000 || originalRect.width * height * devicePixelRatio ** 2 > MAX_PIXELS) throw new Error("This message is too large to capture at the current zoom.");
    const canvas = document.createElement("canvas");
    const result: CapturedMessage = { id: messageId, canvas, names: [], avatars: [], times: [] };
    let offset = 0, scale = 0;
    try {
        for (let tile = 0; offset < height - 0.5; tile++) {
            if (tile >= 24 || signal.aborted) throw new Error("Capture cancelled. Try fewer messages or a smaller zoom.");
            let row = document.getElementById(rowId);
            if (!row) throw new Error("The message moved out of Discord's rendered history. Try again.");
            const viewport = scroller.getBoundingClientRect();
            const top = Math.max(0, viewport.top + scroller.clientTop);
            const bottom = Math.min(innerHeight, viewport.top + scroller.clientTop + scroller.clientHeight);
            const before = row.getBoundingClientRect();
            const wantedTop = before.top + offset;
            if (wantedTop < top || before.bottom > bottom) scroller.scrollTop += wantedTop - top;
            await frame(signal); await frame(signal);
            row = document.getElementById(rowId);
            if (!row) throw new Error("The message is no longer visible.");
            const rect = row.getBoundingClientRect();
            if (Math.abs(rect.height - height) > 1 || Math.abs(rect.width - originalRect.width) > 1) throw new Error("The message layout changed during capture. Wait for its media to load and try again.");
            const y = rect.top + offset;
            const tileHeight = Math.min(height - offset, bottom - y);
            if (y < top - 1 || tileHeight < 1 || rect.left < 0 || rect.right > innerWidth + 1) throw new Error("The message is clipped. Make Discord's window wider or zoom out and try again.");
            const bytes = await Native.capture({ x: rect.left, y: Math.max(0, y), width: rect.width, height: tileHeight });
            if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
            const current = document.getElementById(rowId)?.getBoundingClientRect();
            if (!current || Math.abs(current.top - rect.top) > 1 || current.width !== rect.width || current.height !== rect.height) throw new Error("Discord moved the message during capture. Please try again.");
            const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
            try {
                if (!scale) {
                    scale = image.width / rect.width;
                    canvas.width = image.width; canvas.height = Math.round(height * scale);
                    if (canvas.width * canvas.height > MAX_PIXELS) throw new Error("The image is too large.");
                    for (const [selector, target] of [
                        ['[id^="message-username-"],[class*="username_"],[class*="embedAuthorName_"]', result.names],
                        ['img[class*="avatar_"],[class*="avatarDecoration_"]', result.avatars],
                        ["time", result.times]
                    ] as const) for (const element of row.querySelectorAll(selector)) {
                        const box = element.getBoundingClientRect();
                        if (box.width && box.height) target.push({ x: (box.left - rect.left) * scale, y: (box.top - rect.top) * scale, width: box.width * scale, height: box.height * scale } satisfies Mask);
                    }
                }
                if (image.width !== canvas.width) throw new Error("Discord's scale changed during capture.");
                const ctx = canvas.getContext("2d");
                if (!ctx) throw new Error("Image rendering is unavailable.");
                ctx.drawImage(image, 0, Math.round(offset * scale));
            } finally { image.close(); }
            offset += tileHeight;
        }
        return result;
    } finally {
        if (scroller.isConnected && !signal.aborted) scroller.scrollTop = originalScroll;
    }
}
