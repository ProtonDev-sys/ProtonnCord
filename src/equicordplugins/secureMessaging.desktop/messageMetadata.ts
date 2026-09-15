/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface DiscordMessageMetadata {
    edited_timestamp?: unknown;
    editedTimestamp?: unknown;
    nonce?: unknown;
}

function normalizeTimestamp(value: unknown): string | null {
    if (value == null) return null;
    let raw: unknown = value;
    if (typeof value !== "string") {
        try {
            if (typeof value !== "object" || !("toISOString" in value) || typeof value.toISOString !== "function")
                return "invalid-edited-timestamp";
            raw = value.toISOString();
        } catch {
            return "invalid-edited-timestamp";
        }
    }
    if (typeof raw !== "string") return "invalid-edited-timestamp";
    const milliseconds = Date.parse(raw);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : raw;
}

export function discordEditedTimestamp(message: DiscordMessageMetadata): string | null {
    if (Object.prototype.hasOwnProperty.call(message, "edited_timestamp"))
        return normalizeTimestamp(message.edited_timestamp);
    return normalizeTimestamp(message.editedTimestamp);
}

export function discordMessageNonce(message: DiscordMessageMetadata): string | null {
    return typeof message.nonce === "string" && /^\d{17,20}$/u.test(message.nonce)
        ? message.nonce
        : null;
}
