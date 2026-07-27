/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface DiscordMessageMetadata {
    edited_timestamp?: unknown;
    editedTimestamp?: unknown;
}

function normalizeTimestamp(value: unknown): string | null {
    if (value == null) return null;
    const raw = typeof value === "string"
        ? value
        : typeof (value as { toISOString?: unknown; })?.toISOString === "function"
            ? (value as { toISOString(): string; }).toISOString()
            : "invalid-edited-timestamp";
    const milliseconds = Date.parse(raw);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : raw;
}

export function discordEditedTimestamp(message: DiscordMessageMetadata): string | null {
    if (Object.prototype.hasOwnProperty.call(message, "edited_timestamp"))
        return normalizeTimestamp(message.edited_timestamp);
    return normalizeTimestamp(message.editedTimestamp);
}
