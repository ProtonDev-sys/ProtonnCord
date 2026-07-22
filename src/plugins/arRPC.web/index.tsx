/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 OpenAsar
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

import { popNotice, showNotice } from "@api/Notices";
import { migratePluginSettings } from "@api/Settings";
import { HeadingSecondary } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import definePlugin, { ReporterTestable } from "@utils/types";
import { ApplicationAssetUtils, fetchApplicationsRPC, FluxDispatcher, Toasts } from "@webpack/common";

const MAX_CACHE_SIZE = 100;
const assetCache = new Map<string, Promise<string>>();
const applicationCache = new Map<string, Promise<{ name?: string; } | undefined>>();

function pruneOldestCacheEntry(cache: Pick<Map<string, unknown>, "delete" | "keys">) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
}

async function lookupAsset(applicationId: string, key: string): Promise<string> {
    const cacheKey = `${applicationId}:${key}`;
    const cachedAsset = assetCache.get(cacheKey);
    if (cachedAsset) return cachedAsset;

    if (assetCache.size >= MAX_CACHE_SIZE) pruneOldestCacheEntry(assetCache);

    const assetPromise = ApplicationAssetUtils.fetchAssetIds(applicationId, [key])
        .then(assetIds => assetIds[0]!)
        .catch(error => {
            assetCache.delete(cacheKey);
            throw error;
        });

    assetCache.set(cacheKey, assetPromise);
    return assetPromise;
}

async function lookupApp(applicationId: string): Promise<{ name?: string; } | undefined> {
    const cachedApplication = applicationCache.get(applicationId);
    if (cachedApplication) return cachedApplication;

    if (applicationCache.size >= MAX_CACHE_SIZE) pruneOldestCacheEntry(applicationCache);

    const socket: any = {};
    const applicationPromise = fetchApplicationsRPC(socket, applicationId)
        .then(() => socket.application as { name?: string; } | undefined)
        .catch(error => {
            applicationCache.delete(applicationId);
            throw error;
        });

    applicationCache.set(applicationId, applicationPromise);
    return applicationPromise;
}

function resolveOptional<T>(promise: Promise<T> | undefined): Promise<T | undefined> {
    return promise?.catch(() => undefined) ?? Promise.resolve(undefined);
}

let ws: WebSocket | undefined;
let connectionGeneration = 0;

migratePluginSettings("WebRichPresence", "WebRichPresence (arRPC)");
export default definePlugin({
    name: "WebRichPresence",
    description: "Client plugin for arRPC to enable RPC on Discord Web (experimental)",
    tags: ["Activity", "Utility"],
    authors: [Devs.Ducko],
    reporterTestable: ReporterTestable.None,
    hidden: !IS_EQUIBOP && !IS_VESKTOP && !("legcord" in window),

    settingsAboutComponent: () => (
        <>
            <HeadingSecondary>How to use arRPC</HeadingSecondary>
            <Paragraph>
                <Link href="https://github.com/OpenAsar/arrpc/tree/main#server">Follow the instructions in the GitHub repo</Link> to get the server running, and then enable the plugin.
            </Paragraph>
        </>
    ),

    async handleEvent(e: MessageEvent<any>, generation = connectionGeneration) {
        if (generation !== connectionGeneration) return;

        let data;
        try {
            data = JSON.parse(e.data);
        } catch {
            return;
        }

        const { activity } = data;
        const assets = activity?.assets;
        const appId = activity?.application_id;

        const [largeImage, smallImage] = await Promise.all([
            resolveOptional(appId && assets?.large_image ? lookupAsset(appId, assets.large_image) : undefined),
            resolveOptional(appId && assets?.small_image ? lookupAsset(appId, assets.small_image) : undefined),
        ]);
        if (generation !== connectionGeneration) return;

        if (largeImage) assets.large_image = largeImage;
        if (smallImage) assets.small_image = smallImage;

        if (activity) {
            const app = await resolveOptional(appId ? lookupApp(appId) : undefined);
            if (generation !== connectionGeneration) return;

            activity.name ||= app?.name;
        }

        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", ...data });
    },

    async start() {
        const generation = ++connectionGeneration;
        if (ws) ws.close();
        const socket = new WebSocket("ws://127.0.0.1:1337"); // try to open WebSocket
        ws = socket;

        socket.onmessage = event => void this.handleEvent(event, generation);

        const connectionSuccessful = await new Promise(res => setTimeout(() => res(socket.readyState === WebSocket.OPEN), 5000)); // check if open after 5s
        if (generation !== connectionGeneration || socket !== ws) return;

        if (!connectionSuccessful) {
            showNotice("Failed to connect to arRPC, is it running?", "Retry", () => {
                // show notice about failure to connect, with retry/ignore
                popNotice();
                this.start();
            });
            return;
        }

        Toasts.show({
            // show toast on success
            message: "Connected to arRPC",
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: {
                duration: 1000,
                position: Toasts.Position.BOTTOM
            }
        });
    },

    stop() {
        connectionGeneration++;
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null }); // clear status
        ws?.close(); // close WebSocket
        ws = undefined;
        assetCache.clear();
        applicationCache.clear();
    }
});
