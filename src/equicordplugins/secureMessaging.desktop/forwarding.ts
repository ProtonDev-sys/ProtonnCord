/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const SNOWFLAKE = /^\d{17,20}$/u;

export interface ForwardProtection {
    protected: boolean;
    ready: boolean;
    reason?: string;
}

export type SecureForwardRoute = "blocked" | "native" | "secure";

export interface ForwardMentionResolvers {
    channel?(channelId: string): string | null | undefined;
    role?(roleId: string): string | null | undefined;
    user?(userId: string): string | null | undefined;
}

export interface ForwardEmbed {
    author?: { name?: unknown; url?: unknown; } | null;
    description?: unknown;
    fields?: Array<{ name?: unknown; value?: unknown; }> | null;
    image?: { url?: unknown; proxy_url?: unknown; proxyUrl?: unknown; } | null;
    provider?: { name?: unknown; url?: unknown; } | null;
    thumbnail?: { url?: unknown; proxy_url?: unknown; proxyUrl?: unknown; } | null;
    title?: unknown;
    url?: unknown;
    video?: { url?: unknown; proxy_url?: unknown; proxyUrl?: unknown; } | null;
}

export interface ComposeSecureForwardInput {
    attachmentSelection?: readonly string[];
    authorLabel: string;
    content: string;
    embedSelection?: readonly number[];
    embeds?: readonly ForwardEmbed[];
    mentionResolvers?: ForwardMentionResolvers;
    timestampMs?: number | null;
}

function compactLabel(value: unknown, fallback: string): string {
    if (typeof value !== "string") return fallback;
    const compact = value
        .replace(/[\0-\x1f\x7f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 96);
    return compact || fallback;
}

function escapeInlineMarkdown(value: string): string {
    return value.replace(/[\\`*_~|\[\]]/gu, "\\$&");
}

function safeWebUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return null;
    try {
        const url = new URL(value);
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function textValue(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 4_096) : null;
}

function unique(values: Iterable<string>): string[] {
    return [...new Set(values)];
}

export function secureForwardRoute(source: ForwardProtection, destination: ForwardProtection): SecureForwardRoute {
    if (destination.protected) return destination.ready ? "secure" : "blocked";
    return source.protected ? "blocked" : "native";
}

export function validatedDiscordAttachmentUrl(
    value: unknown,
    channelId: string,
    attachmentId: string,
): URL | null {
    if (typeof value !== "string" || value.length < 1 || value.length > 2_048 ||
        !SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(attachmentId)) return null;

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !DISCORD_ATTACHMENT_HOSTS.has(url.hostname)) return null;
    const match = /^\/attachments\/(\d{17,20})\/(\d{17,20})\/[^/]{1,512}$/u.exec(url.pathname);
    return match?.[1] === channelId && match[2] === attachmentId ? url : null;
}

export function sanitizeForwardMentions(
    content: string,
    resolvers: ForwardMentionResolvers = {},
): string {
    return content
        .replace(/<@!?(\d{17,20})>/gu, (_match, userId: string) => {
            const label = compactLabel(resolvers.user?.(userId), `user-${userId.slice(-4)}`);
            return `@\u200b${label}`;
        })
        .replace(/<@&(\d{17,20})>/gu, (_match, roleId: string) => {
            const label = compactLabel(resolvers.role?.(roleId), `role-${roleId.slice(-4)}`);
            return `@\u200b${label}`;
        })
        .replace(/<#(\d{17,20})>/gu, (_match, channelId: string) => {
            const label = compactLabel(resolvers.channel?.(channelId), `channel-${channelId.slice(-4)}`);
            return `#${label}`;
        })
        .replace(/@(everyone|here)\b/giu, "@\u200b$1");
}

export function secureForwardEmbedText(
    embeds: readonly ForwardEmbed[] = [],
    selection?: readonly number[],
): string {
    const selected = selection === undefined
        ? embeds
        : unique(selection.filter(index => Number.isInteger(index) && index >= 0).map(String))
            .map(index => embeds[Number(index)])
            .filter((embed): embed is ForwardEmbed => Boolean(embed));

    const fragments: string[] = [];
    for (const embed of selected) {
        const urls = unique([
            embed.url,
            embed.video?.url,
            embed.image?.url,
            embed.thumbnail?.url,
            embed.author?.url,
            embed.provider?.url,
        ].map(safeWebUrl).filter((url): url is string => url !== null));
        if (urls.length > 0) {
            fragments.push(...urls);
            continue;
        }

        const lines = [
            textValue(embed.author?.name),
            textValue(embed.title),
            textValue(embed.description),
            ...(Array.isArray(embed.fields)
                ? embed.fields.flatMap(field => [textValue(field?.name), textValue(field?.value)])
                : []),
            textValue(embed.provider?.name),
        ].filter((line): line is string => line !== null);
        if (lines.length > 0) fragments.push(lines.join("\n"));
    }
    return unique(fragments).join("\n").slice(0, 16_384);
}

export function composeSecureForwardText({
    attachmentSelection,
    authorLabel,
    content,
    embedSelection,
    embeds = [],
    mentionResolvers,
    timestampMs,
}: ComposeSecureForwardInput): string {
    const selective = attachmentSelection !== undefined || embedSelection !== undefined;
    const safeAuthor = escapeInlineMarkdown(compactLabel(authorLabel, "Unknown sender"));
    const validTimestamp = typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0
        ? Math.floor(timestampMs / 1_000)
        : null;
    const header = `**Forwarded copy from ${safeAuthor}**${validTimestamp === null ? "" : ` • <t:${validTimestamp}:f>`}`;
    const body = selective ? "" : sanitizeForwardMentions(content, mentionResolvers).trim();
    const embedText = secureForwardEmbedText(embeds, embedSelection);
    const additionalEmbedText = embedText
        .split("\n")
        .filter(line => line && !body.includes(line))
        .join("\n");

    return [header, body, additionalEmbedText]
        .filter(part => part.length > 0)
        .join("\n\n");
}
