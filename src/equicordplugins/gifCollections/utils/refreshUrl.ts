/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RestAPI } from "@webpack/common";

import { logger } from "./misc";

export function isCdnUrlExpired(url: string): boolean {
    try {
        if (typeof url !== "string") return false;
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
            || !["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"].includes(parsed.hostname)) return false;
        const expiry = parsed.searchParams.get("ex");
        if (!expiry || !/^[\da-f]+$/i.test(expiry)) return false;
        const expiresAt = Number.parseInt(expiry, 16) * 1000;
        return Number.isFinite(expiresAt) && expiresAt < Date.now();
    } catch (e) {
        logger.warn("Failed to parse CDN URL expiry", e);
        return false;
    }
}

export async function batchRefreshAttachmentUrls(urls: string[]): Promise<Record<string, string>> {
    try {
        const expiredUrls = urls.filter(isCdnUrlExpired);
        if (!expiredUrls.length) return {};
        const response = await RestAPI.post({
            url: "/attachments/refresh-urls",
            body: { attachment_urls: expiredUrls }
        });
        if (!response.ok) return {};
        const map: Record<string, string> = {};
        for (const { original, refreshed } of response.body.refreshed_urls) {
            map[original] = refreshed;
        }
        return map;
    } catch (e) {
        logger.warn("Failed to refresh attachment URLs", e);
        return {};
    }
}
