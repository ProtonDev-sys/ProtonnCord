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
    fields?: Array<{ name?: unknown; value?: unknown; rawName?: unknown; rawValue?: unknown; }> | null;
    image?: { url?: unknown; proxy_url?: unknown; proxyUrl?: unknown; } | null;
    images?: Array<{ url?: unknown; }> | null;
    provider?: { name?: unknown; url?: unknown; } | null;
    thumbnail?: { url?: unknown; proxy_url?: unknown; proxyUrl?: unknown; } | null;
    title?: unknown;
    rawTitle?: unknown;
    rawDescription?: unknown;
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

export interface SecureForwardMetadata {
    authorLabel: string;
    timestampMs: number | null;
    content: string;
    note?: string;
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
    return value.replace(/[\\`*_~|[\]]/gu, "\\$&");
}

// The readable header stays compatible with older clients. Its attribution is a
// claim authenticated by the forwarding sender, not a signature from the source.
export function parseSecureForwardText(value: string): SecureForwardMetadata | null {
    const prefix = "**Forwarded copy from ";
    const separator = value.indexOf(`\n\n${prefix}`);
    const headerOffset = value.startsWith(prefix) ? 0 : separator < 0 ? -1 : separator + 2;
    if (headerOffset < 0) return null;
    const lineEnd = value.indexOf("\n", headerOffset);
    const header = value.slice(headerOffset, lineEnd < 0 ? undefined : lineEnd);
    if (header.length > 260) return null;
    const match = /^\*\*Forwarded copy from (.+)\*\*(?: • <t:([1-9]\d{0,12}):f>)?$/u.exec(header);
    if (!match) return null;
    const authorLabel = match[1].replace(/\\([\\`*_~|[\]])/gu, "$1");
    if (compactLabel(authorLabel, "") !== authorLabel || escapeInlineMarkdown(authorLabel) !== match[1]) return null;
    const timestampMs = match[2] === undefined ? null : Number(match[2]) * 1_000;
    if (timestampMs !== null && (!Number.isSafeInteger(timestampMs) || Number.isNaN(new Date(timestampMs).getTime()))) return null;
    if (lineEnd >= 0 && value.slice(lineEnd, lineEnd + 2) !== "\n\n") return null;
    const note = headerOffset > 0 ? value.slice(0, headerOffset - 2) : undefined;
    if (note !== undefined && note.trim().length === 0) return null;
    return {
        authorLabel,
        timestampMs,
        content: lineEnd < 0 ? "" : value.slice(lineEnd + 2),
        ...(note === undefined ? {} : { note }),
    };
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

export function secureForwardImageEmbeds(embeds: readonly ForwardEmbed[]): ForwardEmbed[] {
    return embeds.flatMap(embed => embed.images?.length
        ? embed.images.map((image, index) => index === 0
            ? { ...embed, image: undefined, images: [image] }
            : { url: image.url })
        : [embed]);
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
            ...(Array.isArray(embed.images) ? embed.images.map(image => image?.url) : []),
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
            textValue(embed.rawTitle ?? embed.title),
            textValue(embed.rawDescription ?? embed.description),
            ...(Array.isArray(embed.fields)
                ? embed.fields.flatMap(field => [textValue(field?.rawName ?? field?.name), textValue(field?.rawValue ?? field?.value)])
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

    return sanitizeForwardMentions([header, body, additionalEmbedText]
        .filter(part => part.length > 0)
        .join("\n\n"));
}
