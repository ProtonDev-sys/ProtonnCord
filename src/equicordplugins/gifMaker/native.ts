/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const ALLOWED_MEDIA_HOSTS = new Set([
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "media.discordapp.net",
    "media.tenor.com",
    "tenor.com",
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
]);

export async function fetchMedia(_: unknown, url: string) {
    const parsed = typeof url === "string" ? URL.parse(url) : null;
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !ALLOWED_MEDIA_HOSTS.has(parsed.hostname))
        throw new Error("Invalid URL");

    const res = await fetch(parsed, { headers: { Accept: "*/*" }, redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const blob = await res.blob();
    if (blob.size === 0) throw new Error(`Empty media body (${res.status})`);

    return {
        data: await blob.arrayBuffer(),
        type: blob.type || "application/octet-stream"
    };
}
