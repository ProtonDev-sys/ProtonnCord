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

import { IpcEvents } from "@shared/IpcEvents";
import { contextBridge, ipcRenderer, webFrame } from "electron/renderer";

import VencordNative, { invoke, sendSync } from "./VencordNative";

// Discord
if (location.protocol !== "data:") {
    contextBridge.exposeInMainWorld("VencordNative", VencordNative);
    invoke(IpcEvents.INIT_FILE_WATCHERS)
        .catch(error => console.error("[Protonn Cord] Failed to initialize file watchers", error));

    if (IS_DISCORD_DESKTOP) {
        webFrame.executeJavaScript(sendSync<string>(IpcEvents.PRELOAD_GET_RENDERER_JS))
            .catch(error => console.error("[Protonn Cord] Failed to initialize renderer", error));
        // Not supported in sandboxed preload scripts but Discord doesn't support it either so who cares
        require(process.env.DISCORD_PRELOAD!);
    }
} // Monaco popout
else {
    let pendingCss: string | undefined;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saves = Promise.resolve();
    let closing = false;
    let onClosing: ((closing: boolean) => void) | undefined;
    const flush = () => {
        clearTimeout(timer);
        const css = pendingCss;
        const savedRevision = revision;
        if (css === undefined) return saves;
        const save = saves.catch(() => undefined).then(() => VencordNative.quickCss.set(css));
        saves = save.then(() => {
            if (revision === savedRevision) pendingCss = undefined;
        });
        return saves;
    };
    ipcRenderer.on(IpcEvents.MONACO_CLOSE, async (_, requestId: number | null) => {
        closing = requestId !== null;
        onClosing?.(closing);
        if (!closing) return;
        let errorMessage: string | undefined;
        try {
            await flush();
        } catch (error) {
            errorMessage = String(error);
        }
        invoke(IpcEvents.MONACO_CLOSE_ACK, requestId, errorMessage)
            .catch(error => console.error("[Protonn Cord] Failed to acknowledge QuickCSS close", error));
    });
    contextBridge.exposeInMainWorld("setCss", (css: string) => {
        if (closing) return;
        pendingCss = css;
        revision++;
        clearTimeout(timer);
        timer = setTimeout(() => {
            flush().catch(error => console.error("[Protonn Cord] Failed to save QuickCSS", error));
        }, 300);
    });
    contextBridge.exposeInMainWorld("onCssClosing", (callback: (closing: boolean) => void) => {
        onClosing = callback;
        callback(closing);
    });
    contextBridge.exposeInMainWorld("getCurrentCss", VencordNative.quickCss.get);
    contextBridge.exposeInMainWorld("getTheme", VencordNative.quickCss.getEditorTheme);
}
