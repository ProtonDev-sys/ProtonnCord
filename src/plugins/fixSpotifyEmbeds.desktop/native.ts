/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { app, WebFrameMain, webFrameMain } from "electron";

// TODO: routingID is deprecated and should be replaced with frameToken, but it's too new
const ids = [] as Record<"routingId" | "processId", number>[];

function getVolume(value: unknown) {
    return (typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 10) / 100;
}

async function updateFrame(frame: WebFrameMain, script: string) {
    try {
        if (frame.url.startsWith("https://open.spotify.com/embed/"))
            await frame.executeJavaScript(script);
    } catch (e) {
        console.error("FixSpotifyEmbeds: Failed to update volume", e);
    }
}

function cleanUpAndGetSpotifyFrames() {
    const spotifyFrames = [] as WebFrameMain[];
    for (let i = ids.length - 1; i >= 0; i--) {
        const { processId, routingId } = ids[i];

        const frame = webFrameMain.fromId(processId, routingId);
        if (!frame || !frame.url.startsWith("https://open.spotify.com/embed/")) {
            ids.splice(i, 1);
            continue;
        }

        spotifyFrames.push(frame);
    }

    return spotifyFrames;
}

app.on("browser-window-created", (_, win) => {
    win.webContents.on("frame-created", (_, { frame }) => {
        frame?.once("dom-ready", () => {
            if (frame.url.startsWith("https://open.spotify.com/embed/")) {
                cleanUpAndGetSpotifyFrames(); // clean up stale frames

                const { routingId, processId } = frame;
                ids.push({ routingId, processId });

                const settings = RendererSettings.store.plugins?.FixSpotifyEmbeds;
                if (!settings?.enabled) return;

                void updateFrame(frame, `
                    globalThis._vcVolume = ${getVolume(settings.volume)};
                    const original = Audio.prototype.play;
                    Audio.prototype.play = function() {
                        this.volume = _vcVolume;
                        return original.apply(this, arguments);
                    }
                `);
            }
        });
    });
});

RendererSettings.addChangeListener("plugins.FixSpotifyEmbeds.volume", newVolume => {
    try {
        cleanUpAndGetSpotifyFrames().forEach(frame =>
            void updateFrame(frame, `globalThis._vcVolume = ${getVolume(newVolume)}`)
        );
    } catch (e) {
        console.error("FixSpotifyEmbeds: Failed to update volume", e);
    }
});
