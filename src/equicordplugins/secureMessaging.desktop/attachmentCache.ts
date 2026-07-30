/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Message, MessageAttachment } from "@vencord/discord-types";
import { Constants, RestAPI, UserStore } from "@webpack/common";

import { discordEditedTimestamp } from "./messageMetadata";
import type { DecryptIncomingAttachmentsResult } from "./native";
import { isEncryptedMessage } from "./protocol";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const SPOILER_FLAG = 8;
const ANIMATED_FLAG = 32;
const ATTACHMENT_URL_REFRESH_THRESHOLD_MS = 60 * 60 * 1_000;
const ALLOWED_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const SAFE_INLINE_MIME_TYPES = new Set([
    "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/webm",
    "image/avif", "image/gif", "image/jpeg", "image/png", "image/webp",
    "video/mp4", "video/ogg", "video/quicktime", "video/webm",
]);
// Discord treats a missing scan version as pending and can obscure media from non-friends.
// E2EE plaintext cannot be scanned by Discord, so use its explicit local/unscanned sentinel
// instead of misrepresenting the ciphertext attachment's scan as applying to decrypted bytes.
const LOCAL_CONTENT_SCAN_VERSION = -1;

interface ExtendedAttachment extends MessageAttachment {
    content_scan_version?: number;
    description?: string;
    duration_secs?: number;
    flags?: number;
}

export type AttachmentCacheStatus =
    | { status: "idle" | "loading" | "ready"; }
    | { status: "failed"; reason: string; };

interface AttachmentCacheEntry {
    attachments: ExtendedAttachment[];
    bytes: number;
    disposed: boolean;
    lastAccess: number;
    listeners: Set<() => void>;
    objectUrls: string[];
    status: AttachmentCacheStatus;
}

const cache = new Map<string, AttachmentCacheEntry>();
let cachedBytes = 0;

export function encryptedAttachmentCacheKey(message: Message): string {
    return `${message.channel_id}\0${message.id}\0${message.author?.id ?? ""}\0${message.content}\0${message.attachments.map(attachment =>
        `${attachment.id}:${attachment.size}`).join("\0")}`;
}

function cloneWithAttachments(message: Message, attachments: ExtendedAttachment[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.attachments = attachments;
    return clone;
}

function notify(entry: AttachmentCacheEntry): void {
    if (entry.disposed) return;
    for (const listener of entry.listeners) {
        try {
            listener();
        } catch {
            // Discord may dispose a message renderer before asynchronous decryption finishes.
        }
    }
    entry.listeners.clear();
}

function validatedAttachmentUrl(value: string, channelId: string, attachmentId: string): URL | null {
    if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !ALLOWED_ATTACHMENT_HOSTS.has(url.hostname)) return null;
    const match = /^\/attachments\/(\d{17,20})\/(\d{17,20})\/[^/]{1,512}$/u.exec(url.pathname);
    return match?.[1] === channelId && match[2] === attachmentId ? url : null;
}

function needsUrlRefresh(url: URL): boolean {
    const expiresAt = Number.parseInt(url.searchParams.get("ex") ?? "", 16) * 1_000;
    return Number.isFinite(expiresAt) && expiresAt - ATTACHMENT_URL_REFRESH_THRESHOLD_MS <= Date.now();
}

async function refreshedAttachmentUrls(message: Message): Promise<Map<string, string>> {
    const candidates = new Map<string, string>();
    for (const attachment of message.attachments) {
        for (const value of [attachment.url, attachment.proxy_url]) {
            const url = validatedAttachmentUrl(value, message.channel_id, attachment.id);
            if (url && needsUrlRefresh(url)) candidates.set(value, attachment.id);
        }
    }
    if (candidates.size === 0) return new Map();

    try {
        const response = await RestAPI.post({
            url: Constants.Endpoints.ATTACHMENTS_REFRESH_URLS,
            body: { attachment_urls: [...candidates.keys()] },
            retries: 2,
        });
        const result = new Map<string, string>();
        const refreshed = Array.isArray(response?.body?.refreshed_urls) ? response.body.refreshed_urls : [];
        for (const entry of refreshed) {
            if (!entry || typeof entry.original !== "string" || typeof entry.refreshed !== "string") continue;
            const attachmentId = candidates.get(entry.original);
            if (!attachmentId || !validatedAttachmentUrl(entry.refreshed, message.channel_id, attachmentId)) continue;
            result.set(entry.original, entry.refreshed);
        }
        return result;
    } catch {
        return new Map();
    }
}

function safeInlineMimeType(value: string | null): string {
    const normalized = value?.split(";", 1)[0].trim().toLowerCase() ?? "";
    return SAFE_INLINE_MIME_TYPES.has(normalized) ? normalized : "application/octet-stream";
}

function removeEntry(key: string, entry: AttachmentCacheEntry): void {
    cache.delete(key);
    cachedBytes -= entry.bytes;
    entry.disposed = true;
    entry.listeners.clear();
    for (const url of entry.objectUrls) URL.revokeObjectURL(url);
}

function pruneCache(protectedKey: string): void {
    while (cache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
        let oldest: [string, AttachmentCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey || value[1].status.status === "loading") continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
        }
        if (!oldest) break;
        removeEntry(...oldest);
    }
}

function failureReason(result: DecryptIncomingAttachmentsResult): string {
    if (result.status === "decrypted") return "";
    if (result.status === "untrusted_author") return "Verify the sender's encryption key before opening attachments.";
    if (result.status === "replay_detected") return "The encrypted attachment bundle conflicts with a previously authenticated message.";
    if (result.status === "invalid_message") return "The encrypted attachment bundle failed authentication.";
    if (result.status === "invalid_input") return result.error;
    if (result.status === "unavailable") return "Secure key storage is unavailable.";
    if ("error" in result && result.error === "attachment_download_failed") return "Discord could not provide the encrypted attachment bytes.";
    if ("error" in result && result.error === "attachment_too_large") return "The encrypted attachments exceed the local safety limit.";
    return "The encrypted attachments could not be decrypted.";
}

async function loadEntry(message: Message, key: string, entry: AttachmentCacheEntry): Promise<void> {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId) {
        entry.status = { status: "failed", reason: "Discord has no authenticated user." };
        notify(entry);
        return;
    }
    const refreshedUrls = await refreshedAttachmentUrls(message);
    const result = await Native.decryptIncomingAttachments(localUserId, {
        channelId: message.channel_id,
        content: message.content,
        discordAuthorId: message.author.id,
        discordEditedTimestamp: discordEditedTimestamp(message),
        discordMessageId: message.id,
        attachments: message.attachments.map(attachment => ({
            id: attachment.id,
            proxyUrl: refreshedUrls.get(attachment.proxy_url) ?? attachment.proxy_url,
            size: attachment.size,
            url: refreshedUrls.get(attachment.url) ?? attachment.url,
        })),
    });
    if (entry.disposed) return;
    if (result.status !== "decrypted") {
        entry.status = { status: "failed", reason: failureReason(result) };
        notify(entry);
        return;
    }
    const attachments: ExtendedAttachment[] = [];
    const objectUrls: string[] = [];
    let bytes = 0;
    for (const attachment of result.attachments) {
        const { metadata } = attachment;
        const contentType = safeInlineMimeType(metadata.mimeType);
        const blob = new Blob([Uint8Array.from(attachment.data).buffer], {
            type: contentType,
        });
        const objectUrl = URL.createObjectURL(blob);
        if (entry.disposed) {
            URL.revokeObjectURL(objectUrl);
            for (const previousUrl of objectUrls) URL.revokeObjectURL(previousUrl);
            return;
        }
        objectUrls.push(objectUrl);
        bytes += blob.size;
        attachments.push({
            id: attachment.id,
            filename: metadata.name,
            content_scan_version: LOCAL_CONTENT_SCAN_VERSION,
            content_type: contentType,
            size: metadata.size,
            spoiler: metadata.spoiler,
            url: `${objectUrl}#`,
            proxy_url: `${objectUrl}#`,
            description: metadata.description ?? undefined,
            width: contentType.startsWith("image/") ? metadata.width ?? undefined : undefined,
            height: contentType.startsWith("image/") ? metadata.height ?? undefined : undefined,
            duration_secs: contentType.startsWith("audio/") || contentType.startsWith("video/")
                ? metadata.duration ?? undefined
                : undefined,
            flags: (metadata.spoiler ? SPOILER_FLAG : 0) |
                (contentType === "image/gif" ? ANIMATED_FLAG : 0),
        });
    }
    entry.attachments = attachments;
    entry.objectUrls = objectUrls;
    entry.bytes = bytes;
    entry.lastAccess = Date.now();
    entry.status = { status: "ready" };
    cachedBytes += bytes;
    notify(entry);
    pruneCache(key);
}

function ensureEntry(message: Message): AttachmentCacheEntry | null {
    if (!isEncryptedMessage(message.content) || message.attachments.length === 0) return null;
    const key = encryptedAttachmentCacheKey(message);
    const existing = cache.get(key);
    if (existing) {
        existing.lastAccess = Date.now();
        return existing;
    }
    const entry: AttachmentCacheEntry = {
        attachments: [],
        bytes: 0,
        disposed: false,
        lastAccess: Date.now(),
        listeners: new Set(),
        objectUrls: [],
        status: { status: "loading" },
    };
    cache.set(key, entry);
    void loadEntry(message, key, entry).catch(() => {
        if (entry.disposed) return;
        entry.status = { status: "failed", reason: "The encrypted attachments could not be loaded." };
        notify(entry);
    });
    return entry;
}

export function patchEncryptedMessageAttachments(message: Message, onReady: () => void, canDecrypt = true): Message {
    if (!canDecrypt && isEncryptedMessage(message.content) && message.attachments.length > 0)
        return cloneWithAttachments(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status.status === "loading") entry.listeners.add(onReady);
    return cloneWithAttachments(message, entry.status.status === "ready" ? entry.attachments : []);
}

export function encryptedAttachmentStatus(message: Message): AttachmentCacheStatus {
    return ensureEntry(message)?.status ?? { status: "idle" };
}

export function subscribeEncryptedAttachmentStatus(message: Message, listener: () => void): () => void {
    const entry = ensureEntry(message);
    if (!entry) return () => undefined;
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
}

export function clearEncryptedAttachmentCache(): void {
    for (const [key, entry] of cache) removeEntry(key, entry);
    cachedBytes = 0;
}
