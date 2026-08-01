/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";
import type { Message, MessageAttachment } from "@vencord/discord-types";
import { Constants, RestAPI, UserStore } from "@webpack/common";

import { discordEditedTimestamp, discordMessageNonce } from "./messageMetadata";
import type {
    DecryptIncomingAttachmentsInput,
    DecryptIncomingAttachmentsResult,
    DownloadIncomingAttachmentResult,
} from "./native";
import { isEncryptedMessage } from "./protocol";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const MAX_IN_FLIGHT_LOADS = 12;
const FAILED_CACHE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;
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

export interface ExtendedAttachment extends MessageAttachment {
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
    objectUrls: string[];
    renderOwners: Set<{ forceUpdate(): void; }>;
    reservedBytes: number;
    retryAttempt: number;
    retryTimer: ReturnType<typeof setTimeout> | null;
    retryAt: number | null;
    status: AttachmentCacheStatus;
    statusListeners: Set<() => void>;
}

const cache = new Map<string, AttachmentCacheEntry>();
const downloadReferences = new Map<string, { attachmentId: string; localUserId: string; message: Message; }>();
let cachedBytes = 0;
let inFlightBytes = 0;
let inFlightLoads = 0;
let cacheUserId: string | null = null;

export function encryptedAttachmentCacheKey(message: Message): string {
    return `${UserStore.getCurrentUser()?.id ?? ""}\0${message.channel_id}\0${message.id}\0${message.author?.id ?? ""}\0${discordEditedTimestamp(message) ?? ""}\0${message.content}\0${message.attachments.map(attachment =>
        `${attachment.id}:${attachment.size}`).join("\0")}`;
}

function syncCacheAccount(): string | null {
    const localUserId = UserStore.getCurrentUser()?.id ?? null;
    if (cacheUserId !== localUserId) {
        clearEncryptedAttachmentCache();
        cacheUserId = localUserId;
    }
    return localUserId;
}

function cloneWithAttachments(message: Message, attachments: ExtendedAttachment[]): Message {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as Message;
    clone.attachments = attachments;
    return clone;
}

function notifyStatus(entry: AttachmentCacheEntry): void {
    if (entry.disposed) return;
    for (const listener of entry.statusListeners) {
        try {
            listener();
        } catch {
            // Discord may dispose a message renderer before asynchronous decryption finishes.
        }
    }
}

function notifyReady(entry: AttachmentCacheEntry): void {
    notifyStatus(entry);
    const owners = [...entry.renderOwners];
    entry.renderOwners.clear();
    for (const owner of owners) {
        try {
            owner.forceUpdate();
        } catch {
            // Discord may dispose a message renderer before asynchronous decryption finishes.
        }
    }
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

function requiresSecureMediaPlayer(attachment: ExtendedAttachment): boolean {
    return attachment.content_type?.startsWith("audio/") === true || attachment.content_type?.startsWith("video/") === true;
}

function removeEntry(key: string, entry: AttachmentCacheEntry): void {
    cache.delete(key);
    cachedBytes -= entry.bytes;
    if (entry.status.status !== "loading") releaseReservation(entry);
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.disposed = true;
    entry.renderOwners.clear();
    entry.statusListeners.clear();
    for (const url of entry.objectUrls) {
        downloadReferences.delete(url);
        URL.revokeObjectURL(url);
    }
}

function pruneCache(protectedKey: string, requiredBytes = 0, maximumEntries = MAX_CACHE_ENTRIES): void {
    while (cache.size > maximumEntries || cachedBytes + inFlightBytes + requiredBytes > MAX_CACHE_BYTES) {
        let oldest: [string, AttachmentCacheEntry] | null = null;
        let oldestSettled: [string, AttachmentCacheEntry] | null = null;
        for (const value of cache) {
            if (value[0] === protectedKey) continue;
            if (!oldest || value[1].lastAccess < oldest[1].lastAccess) oldest = value;
            if (value[1].status.status !== "loading" &&
                (!oldestSettled || value[1].lastAccess < oldestSettled[1].lastAccess)) oldestSettled = value;
        }
        oldest = oldestSettled ?? oldest;
        if (!oldest) break;
        removeEntry(...oldest);
    }
}

function releaseReservation(entry: AttachmentCacheEntry): void {
    inFlightBytes -= entry.reservedBytes;
    entry.reservedBytes = 0;
}

function scheduleRetry(message: Message, key: string, entry: AttachmentCacheEntry, localUserId: string): void {
    if (entry.retryAt === null || entry.retryTimer !== null || entry.disposed) return;
    entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        if (entry.disposed || cache.get(key) !== entry || entry.status.status !== "failed") return;
        if (UserStore.getCurrentUser()?.id !== localUserId) {
            removeEntry(key, entry);
            return;
        }
        entry.status = { status: "loading" };
        entry.retryAt = null;
        notifyStatus(entry);
        startEntryLoad(message, key, entry, localUserId);
    }, Math.max(0, entry.retryAt - Date.now()));
}

function prepareTransientRetry(entry: AttachmentCacheEntry): void {
    const delay = FAILED_CACHE_RETRY_DELAYS_MS[entry.retryAttempt];
    entry.retryAttempt++;
    entry.retryAt = delay === undefined ? null : Date.now() + delay;
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

async function loadEntry(message: Message, key: string, entry: AttachmentCacheEntry, localUserId: string): Promise<void> {
    const refreshedUrls = await refreshedAttachmentUrls(message);
    if (entry.disposed) return;
    if (UserStore.getCurrentUser()?.id !== localUserId) {
        removeEntry(key, entry);
        return;
    }
    const result = await Native.decryptIncomingAttachments(localUserId, {
        channelId: message.channel_id,
        content: message.content,
        discordAuthorId: message.author.id,
        discordEditedTimestamp: discordEditedTimestamp(message),
        discordMessageId: message.id,
        discordNonce: discordMessageNonce(message),
        attachments: message.attachments.map(attachment => ({
            id: attachment.id,
            proxyUrl: refreshedUrls.get(attachment.proxy_url) ?? attachment.proxy_url,
            size: attachment.size,
            url: refreshedUrls.get(attachment.url) ?? attachment.url,
        })),
    });
    if (entry.disposed) return;
    if (UserStore.getCurrentUser()?.id !== localUserId) {
        removeEntry(key, entry);
        return;
    }
    if (result.status !== "decrypted") {
        entry.status = { status: "failed", reason: failureReason(result) };
        if (result.status === "failed" || result.status === "unavailable") prepareTransientRetry(entry);
        else entry.retryAt = null;
        notifyStatus(entry);
        scheduleRetry(message, key, entry, localUserId);
        return;
    }
    const attachments: ExtendedAttachment[] = [];
    const objectUrls: string[] = [];
    let bytes = 0;
    try {
        for (const attachment of result.attachments) {
            const { metadata } = attachment;
            const contentType = safeInlineMimeType(metadata.mimeType);
            const blob = new Blob([Uint8Array.from(attachment.data).buffer], {
                type: contentType,
            });
            const objectUrl = URL.createObjectURL(blob);
            if (entry.disposed) {
                URL.revokeObjectURL(objectUrl);
                for (const previousUrl of objectUrls) {
                    downloadReferences.delete(previousUrl);
                    URL.revokeObjectURL(previousUrl);
                }
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
                width: contentType.startsWith("image/") || contentType.startsWith("video/")
                    ? metadata.width ?? undefined
                    : undefined,
                height: contentType.startsWith("image/") || contentType.startsWith("video/")
                    ? metadata.height ?? undefined
                    : undefined,
                duration_secs: contentType.startsWith("audio/") || contentType.startsWith("video/")
                    ? metadata.duration ?? undefined
                    : undefined,
                flags: (metadata.spoiler ? SPOILER_FLAG : 0) |
                    (contentType === "image/gif" ? ANIMATED_FLAG : 0),
            });
            downloadReferences.set(objectUrl, { attachmentId: attachment.id, localUserId, message });
        }
    } catch (error) {
        for (const objectUrl of objectUrls) {
            downloadReferences.delete(objectUrl);
            URL.revokeObjectURL(objectUrl);
        }
        throw error;
    }
    releaseReservation(entry);
    entry.attachments = attachments;
    entry.objectUrls = objectUrls;
    entry.bytes = bytes;
    entry.lastAccess = Date.now();
    entry.retryAttempt = 0;
    entry.retryAt = null;
    entry.status = { status: "ready" };
    cachedBytes += bytes;
    notifyReady(entry);
    pruneCache(key);
}

function startEntryLoad(message: Message, key: string, entry: AttachmentCacheEntry, localUserId: string): void {
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    if (inFlightLoads >= MAX_IN_FLIGHT_LOADS) {
        entry.status = { status: "failed", reason: "The encrypted attachment cache is busy. Retry in a moment." };
        prepareTransientRetry(entry);
        notifyStatus(entry);
        scheduleRetry(message, key, entry, localUserId);
        pruneCache(key);
        return;
    }
    const requiredBytes = message.attachments.reduce((total, attachment) => total + attachment.size, 0);
    pruneCache(key, requiredBytes);
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 1 || requiredBytes > MAX_CACHE_BYTES ||
        cachedBytes + inFlightBytes + requiredBytes > MAX_CACHE_BYTES) {
        entry.status = { status: "failed", reason: "The encrypted attachment cache is busy. Retry in a moment." };
        prepareTransientRetry(entry);
        notifyStatus(entry);
        scheduleRetry(message, key, entry, localUserId);
        return;
    }
    entry.reservedBytes = requiredBytes;
    inFlightBytes += requiredBytes;
    inFlightLoads++;
    void loadEntry(message, key, entry, localUserId).catch(() => {
        if (entry.disposed) return;
        entry.status = { status: "failed", reason: "The encrypted attachments could not be loaded." };
        prepareTransientRetry(entry);
        notifyStatus(entry);
        scheduleRetry(message, key, entry, localUserId);
    }).finally(() => {
        inFlightLoads--;
        releaseReservation(entry);
    });
}

function objectUrl(value: string): string {
    const hash = value.indexOf("#");
    return hash === -1 ? value : value.slice(0, hash);
}

export function isEncryptedAttachmentDownloadUrl(value: string): boolean {
    return downloadReferences.has(objectUrl(value));
}

export async function downloadEncryptedAttachmentUrl(value: string): Promise<DownloadIncomingAttachmentResult | null> {
    const reference = downloadReferences.get(objectUrl(value));
    const localUserId = syncCacheAccount();
    if (!reference || !localUserId || reference.localUserId !== localUserId) return null;
    const { message, attachmentId } = reference;
    const refreshedUrls = await refreshedAttachmentUrls(message);
    if (UserStore.getCurrentUser()?.id !== localUserId) return null;
    const input: DecryptIncomingAttachmentsInput = {
        channelId: message.channel_id,
        content: message.content,
        discordAuthorId: message.author.id,
        discordEditedTimestamp: discordEditedTimestamp(message),
        discordMessageId: message.id,
        discordNonce: discordMessageNonce(message),
        attachments: message.attachments.map(attachment => ({
            id: attachment.id,
            proxyUrl: refreshedUrls.get(attachment.proxy_url) ?? attachment.proxy_url,
            size: attachment.size,
            url: refreshedUrls.get(attachment.url) ?? attachment.url,
        })),
    };
    return Native.downloadIncomingAttachment(localUserId, input, attachmentId);
}

function ensureEntry(message: Message): AttachmentCacheEntry | null {
    if (!isEncryptedMessage(message.content) || message.attachments.length === 0) return null;
    const localUserId = syncCacheAccount();
    const key = encryptedAttachmentCacheKey(message);
    const existing = cache.get(key);
    if (existing) {
        existing.lastAccess = Date.now();
        if (existing.status.status === "failed" && existing.retryAt !== null && existing.retryAt <= Date.now() && localUserId) {
            existing.status = { status: "loading" };
            existing.retryAt = null;
            startEntryLoad(message, key, existing, localUserId);
        }
        return existing;
    }
    pruneCache("", 0, MAX_CACHE_ENTRIES - 1);
    const entry: AttachmentCacheEntry = {
        attachments: [],
        bytes: 0,
        disposed: false,
        lastAccess: Date.now(),
        objectUrls: [],
        renderOwners: new Set(),
        reservedBytes: 0,
        retryAttempt: 0,
        retryTimer: null,
        retryAt: null,
        status: localUserId ? { status: "loading" } : { status: "failed", reason: "Discord has no authenticated user." },
        statusListeners: new Set(),
    };
    cache.set(key, entry);
    if (localUserId) startEntryLoad(message, key, entry, localUserId);
    return entry;
}

export function patchEncryptedMessageAttachments(
    message: Message,
    owner: { forceUpdate(): void; },
    canDecrypt = true,
): Message {
    if (!canDecrypt && isEncryptedMessage(message.content) && message.attachments.length > 0)
        return cloneWithAttachments(message, []);
    const entry = ensureEntry(message);
    if (!entry) return message;
    if (entry.status.status !== "ready") entry.renderOwners.add(owner);
    return cloneWithAttachments(
        message,
        entry.status.status === "ready" ? entry.attachments.filter(attachment => !requiresSecureMediaPlayer(attachment)) : [],
    );
}

export function encryptedAttachmentStatus(message: Message): AttachmentCacheStatus {
    return ensureEntry(message)?.status ?? { status: "idle" };
}

export function encryptedAttachmentDownloads(message: Message): Array<{ filename: string; id: string; url: string; }> {
    const entry = ensureEntry(message);
    return entry?.status.status === "ready"
        ? entry.attachments.map(attachment => ({ filename: attachment.filename, id: attachment.id, url: attachment.url }))
        : [];
}

export function encryptedMediaAttachments(message: Message): ExtendedAttachment[] {
    const entry = ensureEntry(message);
    return entry?.status.status === "ready"
        ? entry.attachments.filter(requiresSecureMediaPlayer)
        : [];
}

export function subscribeEncryptedAttachmentStatus(message: Message, listener: () => void): () => void {
    const entry = ensureEntry(message);
    if (!entry) return () => undefined;
    entry.statusListeners.add(listener);
    return () => entry.statusListeners.delete(listener);
}

export function retryEncryptedAttachmentLoad(message: Message): void {
    const localUserId = syncCacheAccount();
    const key = encryptedAttachmentCacheKey(message);
    const entry = cache.get(key);
    if (!localUserId || !entry || entry.disposed || entry.status.status !== "failed") return;
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.retryAttempt = 0;
    entry.retryAt = null;
    entry.status = { status: "loading" };
    notifyStatus(entry);
    startEntryLoad(message, key, entry, localUserId);
}

export function clearEncryptedAttachmentCache(): void {
    for (const [key, entry] of cache) removeEntry(key, entry);
    cachedBytes = 0;
}
