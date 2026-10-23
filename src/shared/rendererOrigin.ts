/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const DISCORD_ORIGINS = new Set([
    "https://discord.com",
    "https://ptb.discord.com",
    "https://canary.discord.com",
    "https://discordapp.com",
    "https://ptb.discordapp.com",
    "https://canary.discordapp.com",
]);

/** Accept a serialized security origin, not a document URL. */
export function isDiscordRendererOrigin(origin: unknown): boolean {
    return typeof origin === "string" && DISCORD_ORIGINS.has(origin);
}
