/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcEvents } from "@shared/IpcEvents";
import { isDiscordRendererOrigin } from "@shared/rendererOrigin";
import { ipcMain as electronIpcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";

const quickCssEditors = new WeakMap<WebContents, string>();
const quickCssChannels = new Set<string>([
    IpcEvents.GET_QUICK_CSS,
    IpcEvents.SET_QUICK_CSS,
    IpcEvents.GET_MONACO_THEME,
    IpcEvents.MONACO_CLOSE_ACK,
]);

export function registerQuickCssEditor(contents: WebContents, documentUrl: string): void {
    quickCssEditors.set(contents, documentUrl);
}

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
    try {
        const frame = event.senderFrame;
        if (!frame || event.sender.isDestroyed() || frame !== event.sender.mainFrame) return false;
        // URLs alone do not identify opaque or inherited-origin documents.
        if (isDiscordRendererOrigin(frame.origin)) return true;
        const editorUrl = quickCssEditors.get(event.sender);
        return quickCssChannels.has(channel) && editorUrl !== undefined && editorUrl === frame.url;
    } catch {
        // Accessing a frame that has gone away may throw.
        return false;
    }
}

/** Register only this mod's IPC channels; leave the host's IPC untouched. */
export const ipcMain = {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) {
        electronIpcMain.handle(channel, (event, ...args) => {
            if (!isTrustedSender(event, channel)) throw new Error("Untrusted Protonn Cord IPC request");
            return listener(event, ...args);
        });
    },
    on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void) {
        electronIpcMain.on(channel, (event, ...args) => {
            if (!isTrustedSender(event, channel)) {
                // A rejected synchronous call must still reply, without throwing
                // an uncaught exception from Electron's event emitter.
                event.returnValue = null;
                return;
            }
            listener(event, ...args);
        });
    },
};
