/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { app } from "electron";
import adguard from "file://adguard.js?minify";

function isYoutubeEmbed(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.port
            && (url.origin === "https://youtube.com" || url.origin === "https://www.youtube.com")
            && url.pathname.startsWith("/embed/");
    } catch {
        return false;
    }
}

app.on("browser-window-created", (_, win) => {
    win.webContents.on("frame-created", (_, { frame }) => {
        frame?.once("dom-ready", () => {
            if (!RendererSettings.store.plugins?.YoutubeAdblock?.enabled) return;

            const target = isYoutubeEmbed(frame.url) ? frame
                : frame.parent && isYoutubeEmbed(frame.parent.url) ? frame.parent : undefined;
            void Promise.resolve(target?.executeJavaScript(adguard)).catch(error => console.error("Could not inject YouTube ad blocker", error));
        });
    });
});
