/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type NavidromeAlbumArtMode = "none" | "lastfm";

export function normalizeNavidromeAlbumArtMode(value: unknown): NavidromeAlbumArtMode {
    return value === "lastfm" ? "lastfm" : "none";
}
