/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DISCORD_MCP_TOOL_NAMES = [
    "connection_status",
    "list_servers",
    "list_server_channels",
    "list_dms",
    "read_messages",
    "bulk_read_messages",
    "search_messages",
    "get_message",
    "download_attachment",
    "send_message",
    "delete_own_message",
    "subscribe_channel",
    "wait_for_message",
    "list_subscriptions",
    "unsubscribe_channel",
] as const;

export type DiscordMcpToolName = typeof DISCORD_MCP_TOOL_NAMES[number];

export const DISCORD_SEARCH_HAS_VALUES = [
    "link",
    "embed",
    "file",
    "video",
    "image",
    "sound",
    "sticker",
    "snapshot",
    "poll",
] as const;

export type DiscordSearchHas = typeof DISCORD_SEARCH_HAS_VALUES[number];

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export function isDiscordSnowflake(value: unknown): value is string {
    return typeof value === "string" && DISCORD_SNOWFLAKE.test(value);
}

export function requireSnowflake(value: unknown, fieldName: string): string {
    if (!isDiscordSnowflake(value)) throw new Error(`${fieldName} must be a Discord snowflake ID`);
    return value;
}

export function normalizeMessageLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100)
        throw new Error("limit must be an integer from 1 to 100");
    return value as number;
}

export function normalizeSearchQuery(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error("query must be a non-empty string when provided");
    if (value.length > 1_024) throw new Error("query exceeds the 1,024 character search limit");
    return value.trim();
}

export function normalizeSearchOffset(value: unknown): number {
    if (value === undefined) return 0;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 5_000)
        throw new Error("offset must be an integer from 0 to 5,000");
    return value as number;
}

export function normalizeSearchHas(value: unknown): DiscordSearchHas[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length < 1 || value.length > DISCORD_SEARCH_HAS_VALUES.length)
        throw new Error(`has must contain 1 to ${DISCORD_SEARCH_HAS_VALUES.length} supported media filters`);

    const allowed = new Set<string>(DISCORD_SEARCH_HAS_VALUES);
    const normalized = [...new Set(value)];
    if (normalized.some(item => typeof item !== "string" || !allowed.has(item)))
        throw new Error(`has contains an unsupported filter; use: ${DISCORD_SEARCH_HAS_VALUES.join(", ")}`);
    return normalized as DiscordSearchHas[];
}

export function normalizeSearchSortOrder(value: unknown): "asc" | "desc" {
    if (value === undefined) return "desc";
    if (value !== "asc" && value !== "desc") throw new Error("sort_order must be asc or desc");
    return value;
}

export function normalizeMessageContent(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error("content must be a non-empty string");
    if (value.length > 2_000) throw new Error("content exceeds Discord's 2,000 character limit");
    return value;
}

export function sentMessageKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
}

export function canDeleteRecordedMessage(
    sentMessages: ReadonlySet<string>,
    channelId: string,
    messageId: string
): boolean {
    return sentMessages.has(sentMessageKey(channelId, messageId));
}
