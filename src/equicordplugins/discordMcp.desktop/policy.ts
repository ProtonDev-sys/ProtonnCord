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
    "get_message",
    "download_attachment",
    "send_message",
    "delete_own_message",
] as const;

export type DiscordMcpToolName = typeof DISCORD_MCP_TOOL_NAMES[number];

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
