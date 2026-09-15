/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";
import { request } from "https";

// These links don't support CORS, so this has to be native
const validRedirectUrls = /^https:\/\/(spotify\.link|s\.team)\/.+$/;
const shortlinkHosts = new Set(["spotify.link", "s.team"]);
const destinationHosts = new Set(["open.spotify.com", "steamcommunity.com", "store.steampowered.com", "help.steampowered.com"]);

function readRedirect(url: URL) {
    return new Promise<string | undefined>((resolve, reject) => {
        const req = request(url, { method: "HEAD" }, res => {
            clearTimeout(timeout);
            res.resume();
            resolve(res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? res.headers.location : undefined);
        });
        const timeout = setTimeout(() => req.destroy(new Error("Short link request timed out")), 10000);
        req.on("error", error => {
            clearTimeout(timeout);
            reject(error);
        });
        req.end();
    });
}

export async function resolveRedirect(_: IpcMainInvokeEvent, url: string) {
    if (!validRedirectUrls.test(url)) return url;

    let current = new URL(url);
    const visited = new Set<string>();

    for (let hop = 0; hop < 5; hop++) {
        if (visited.has(current.href)) throw new Error("Short link redirect loop");
        visited.add(current.href);
        const location = await readRedirect(current);
        if (!location) return current.href;

        const next = new URL(location, current);
        if (next.protocol !== "https:" || next.username || next.password || next.port)
            throw new Error("Unsupported short link destination");
        if (destinationHosts.has(next.hostname)) return next.href;
        if (!shortlinkHosts.has(next.hostname)) throw new Error("Unsupported short link destination");
        current = next;
    }

    throw new Error("Too many short link redirects");
}
