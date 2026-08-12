/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

import {
    DEFAULT_ATTACHMENT_SIZE_LIMIT_MEGABYTES,
    MAX_ATTACHMENT_CACHE_BYTES,
    MAX_ATTACHMENT_CACHE_ENTRIES,
    MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES,
    SUPPORTED_ATTACHMENT_FILE_EXTENSIONS
} from "../utils/constants";
import { normalizeAttachmentId } from "./cacheFile";

const ALLOWED_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const ALLOWED_RENDERER_ORIGINS = new Set([
    "https://canary.discord.com",
    "https://discord.com",
    "https://ptb.discord.com"
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_ATTACHMENT_URL_LENGTH = 4_096;
const MAX_ATTACHMENT_FILENAME_LENGTH = 512;

export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_ATTACHMENT_DOWNLOAD_BYTES = MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES * 1024 * 1024;
export const MAX_ATTACHMENT_REDIRECTS = 3;
export const MAX_IMAGE_CACHE_BYTES = MAX_ATTACHMENT_CACHE_BYTES;
export const MAX_IMAGE_CACHE_ENTRIES = MAX_ATTACHMENT_CACHE_ENTRIES;
export const MAX_ALLOWED_EXTENSIONS_LENGTH = 128;

export type SupportedAttachmentExtension = typeof SUPPORTED_ATTACHMENT_FILE_EXTENSIONS[number];

interface MediaPolicy {
    mimeTypes: ReadonlySet<string>;
    hasSignature(content: Uint8Array): boolean;
}

export interface FetchDiscordAttachmentOptions {
    deadline?: number;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
}

export interface DownloadedDiscordAttachment {
    content: Uint8Array;
    extension: SupportedAttachmentExtension;
}

function startsWith(content: Uint8Array, signature: readonly number[], offset = 0): boolean {
    return content.byteLength >= offset + signature.length
        && signature.every((byte, index) => content[offset + index] === byte);
}

function asciiAt(content: Uint8Array, expected: string, offset = 0): boolean {
    return content.byteLength >= offset + expected.length
        && [...expected].every((character, index) => content[offset + index] === character.charCodeAt(0));
}

function hasMp3Signature(content: Uint8Array): boolean {
    if (asciiAt(content, "ID3") && content.byteLength >= 10)
        return (content[6] | content[7] | content[8] | content[9]) < 0x80;

    if (content.byteLength < 4 || content[0] !== 0xff || (content[1] & 0xe0) !== 0xe0) return false;
    const version = (content[1] >> 3) & 0x03;
    const layer = (content[1] >> 1) & 0x03;
    const bitrate = (content[2] >> 4) & 0x0f;
    const sampleRate = (content[2] >> 2) & 0x03;
    return version !== 0x01 && layer !== 0 && bitrate !== 0 && bitrate !== 0x0f && sampleRate !== 0x03;
}

function hasMp4Signature(content: Uint8Array): boolean {
    if (content.byteLength < 12 || !asciiAt(content, "ftyp", 4)) return false;
    const boxSize = ((content[0] << 24) | (content[1] << 16) | (content[2] << 8) | content[3]) >>> 0;
    return boxSize >= 12 && boxSize <= content.byteLength;
}

const MEDIA_POLICIES: Record<SupportedAttachmentExtension, MediaPolicy> = {
    png: {
        mimeTypes: new Set(["image/png"]),
        hasSignature: content => startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    },
    jpg: {
        mimeTypes: new Set(["image/jpeg"]),
        hasSignature: content => startsWith(content, [0xff, 0xd8, 0xff])
    },
    jpeg: {
        mimeTypes: new Set(["image/jpeg"]),
        hasSignature: content => startsWith(content, [0xff, 0xd8, 0xff])
    },
    gif: {
        mimeTypes: new Set(["image/gif"]),
        hasSignature: content => asciiAt(content, "GIF87a") || asciiAt(content, "GIF89a")
    },
    webp: {
        mimeTypes: new Set(["image/webp"]),
        hasSignature: content => asciiAt(content, "RIFF") && asciiAt(content, "WEBP", 8)
    },
    mp4: {
        mimeTypes: new Set(["application/mp4", "audio/mp4", "video/mp4"]),
        hasSignature: hasMp4Signature
    },
    webm: {
        mimeTypes: new Set(["audio/webm", "video/webm"]),
        hasSignature: content => startsWith(content, [0x1a, 0x45, 0xdf, 0xa3])
    },
    mp3: {
        mimeTypes: new Set(["audio/mp3", "audio/mpeg"]),
        hasSignature: hasMp3Signature
    },
    ogg: {
        mimeTypes: new Set(["application/ogg", "audio/ogg", "video/ogg"]),
        hasSignature: content => asciiAt(content, "OggS") && content[4] === 0
    },
    wav: {
        mimeTypes: new Set(["audio/wav", "audio/wave", "audio/x-wav"]),
        hasSignature: content => asciiAt(content, "RIFF") && asciiAt(content, "WAVE", 8)
    }
};

export function isSupportedAttachmentExtension(extension: string): extension is SupportedAttachmentExtension {
    return Object.hasOwn(MEDIA_POLICIES, extension);
}

export function parseAllowedAttachmentExtensions(value: unknown): SupportedAttachmentExtension[] {
    if (typeof value !== "string" || value.length > MAX_ALLOWED_EXTENSIONS_LENGTH) return [];
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "none") return [];

    const result: SupportedAttachmentExtension[] = [];
    const seen = new Set<string>();
    for (const rawExtension of normalized.split(",")) {
        if (result.length >= SUPPORTED_ATTACHMENT_FILE_EXTENSIONS.length) break;
        const extension = rawExtension.trim().replace(/^\./u, "");
        if (!isSupportedAttachmentExtension(extension) || seen.has(extension)) continue;
        seen.add(extension);
        result.push(extension);
    }
    return result;
}

export function normalizeAttachmentSizeLimitMegabytes(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES)
        throw new Error(`Attachment size limit must be an integer from 1 to ${MAX_ATTACHMENT_SIZE_LIMIT_MEGABYTES} MB`);
    return value as number;
}

export function attachmentSizeLimitMegabytesOrDefault(value: unknown): number {
    try {
        return normalizeAttachmentSizeLimitMegabytes(value);
    } catch {
        return DEFAULT_ATTACHMENT_SIZE_LIMIT_MEGABYTES;
    }
}

export function isTrustedDiscordRendererEvent(event: IpcMainInvokeEvent): boolean {
    const rawUrl = event?.senderFrame?.url;
    if (typeof rawUrl !== "string" || rawUrl.length < 1 || rawUrl.length > MAX_ATTACHMENT_URL_LENGTH) return false;
    try {
        const url = new URL(rawUrl);
        return url.protocol === "https:" && !url.username && !url.password && !url.port
            && ALLOWED_RENDERER_ORIGINS.has(url.origin);
    } catch {
        return false;
    }
}

export function validateDiscordAttachmentUrl(value: unknown, expectedAttachmentId: string): URL {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_ATTACHMENT_URL_LENGTH)
        throw new Error("Invalid Discord attachment URL");

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Invalid Discord attachment URL");
    }

    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
        || !ALLOWED_ATTACHMENT_HOSTS.has(url.hostname))
        throw new Error("Untrusted Discord attachment URL");

    const match = /^\/(?:attachments|ephemeral-attachments)\/(\d{1,20})\/(\d{1,20})\/([^/]{1,1024})$/u.exec(url.pathname);
    if (!match) throw new Error("Invalid Discord attachment path");

    let channelId: string;
    let attachmentId: string;
    try {
        channelId = normalizeAttachmentId(match[1]);
        attachmentId = normalizeAttachmentId(match[2]);
    } catch {
        throw new Error("Invalid Discord attachment path");
    }
    if (!channelId || attachmentId !== expectedAttachmentId) throw new Error("Discord attachment ID mismatch");

    let filename: string;
    try {
        filename = decodeURIComponent(match[3]);
    } catch {
        throw new Error("Invalid Discord attachment filename");
    }
    if (filename.length < 1 || filename.length > MAX_ATTACHMENT_FILENAME_LENGTH || filename === "." || filename === ".."
        || /[\u0000-\u001f\u007f/\\]/u.test(filename))
        throw new Error("Invalid Discord attachment filename");

    return url;
}

export function assertAttachmentContent(
    extension: string,
    content: Uint8Array,
    contentType?: string
): asserts extension is SupportedAttachmentExtension {
    if (!(content instanceof Uint8Array) || content.byteLength < 1) throw new Error("Attachment body is empty");
    if (!isSupportedAttachmentExtension(extension)) throw new Error("Unsupported attachment media type");

    const policy = MEDIA_POLICIES[extension];
    if (contentType !== undefined) {
        const mimeType = contentType.split(";", 1)[0].trim().toLowerCase();
        if (!policy.mimeTypes.has(mimeType)) throw new Error("Attachment Content-Type does not match its extension");
    }
    if (!policy.hasSignature(content)) throw new Error("Attachment signature does not match its extension");
}

export function detectAttachmentContent(
    requestedExtension: string,
    content: Uint8Array,
    contentType: string
): SupportedAttachmentExtension {
    try {
        assertAttachmentContent(requestedExtension, content, contentType);
        return requestedExtension;
    } catch (requestedError) {
        const mimeType = contentType.split(";", 1)[0].trim().toLowerCase();
        for (const extension of SUPPORTED_ATTACHMENT_FILE_EXTENSIONS) {
            const policy = MEDIA_POLICIES[extension];
            if (policy.mimeTypes.has(mimeType) && policy.hasSignature(content)) return extension;
        }
        throw requestedError;
    }
}

function parseDeclaredLength(value: string | null, maxBytes: number): number | null {
    if (value === null) return null;
    if (!/^\d+$/u.test(value)) throw new Error("Invalid attachment Content-Length");
    const length = Number(value);
    if (!Number.isSafeInteger(length) || length < 1) throw new Error("Invalid attachment Content-Length");
    if (length > maxBytes) throw new Error("Attachment exceeds the configured size limit");
    return length;
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!response.body) throw new Error("Attachment response has no body");
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
        await response.body.cancel().catch(() => undefined);
        throw new Error("Encoded attachment responses are not accepted");
    }
    let declaredLength: number | null;
    try {
        declaredLength = parseDeclaredLength(response.headers.get("content-length"), maxBytes);
    } catch (error) {
        await response.body.cancel().catch(() => undefined);
        throw error;
    }
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let totalBytes = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!chunk.value?.byteLength) continue;
            totalBytes += chunk.value.byteLength;
            if (totalBytes > maxBytes || declaredLength !== null && totalBytes > declaredLength) {
                await reader.cancel().catch(() => undefined);
                throw new Error("Attachment exceeded its declared size limit");
            }
            chunks.push(chunk.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }

    if (totalBytes < 1) throw new Error("Attachment body is empty");
    if (declaredLength !== null && totalBytes !== declaredLength) throw new Error("Attachment body was truncated");

    const content = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return content;
}

export async function fetchDiscordAttachment(
    initialUrl: URL,
    expectedAttachmentId: string,
    extension: string,
    options: FetchDiscordAttachmentOptions = {}
): Promise<DownloadedDiscordAttachment> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_DOWNLOAD_BYTES;
    const deadline = options.deadline ?? Date.now() + ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_DOWNLOAD_BYTES)
        throw new Error("Invalid attachment byte limit");
    if (!Number.isFinite(deadline)) throw new Error("Invalid attachment deadline");

    const controller = new AbortController();
    const remainingAtStart = Math.floor(deadline - Date.now());
    if (remainingAtStart <= 0) throw new Error("Attachment download timed out");
    const timeout = setTimeout(() => controller.abort(new Error("Attachment download timed out")), remainingAtStart);
    try {
        let current = validateDiscordAttachmentUrl(initialUrl.href, expectedAttachmentId);
        for (let redirect = 0; redirect <= MAX_ATTACHMENT_REDIRECTS; redirect++) {
            if (Date.now() >= deadline) throw new Error("Attachment download timed out");
            const response = await fetchImpl(current, {
                headers: { "accept-encoding": "identity" },
                redirect: "manual",
                signal: controller.signal
            });

            let unexpectedlyRedirected = response.redirected;
            if (response.url) {
                try {
                    unexpectedlyRedirected ||= new URL(response.url).href !== current.href;
                } catch {
                    unexpectedlyRedirected = true;
                }
            }
            if (unexpectedlyRedirected) {
                await response.body?.cancel().catch(() => undefined);
                throw new Error("Attachment fetch followed an unexpected redirect");
            }

            if (REDIRECT_STATUSES.has(response.status)) {
                const location = response.headers.get("location");
                await response.body?.cancel().catch(() => undefined);
                if (!location || redirect === MAX_ATTACHMENT_REDIRECTS)
                    throw new Error("Attachment redirected too many times");
                current = validateDiscordAttachmentUrl(new URL(location, current).href, expectedAttachmentId);
                continue;
            }
            if (response.status !== 200) {
                await response.body?.cancel().catch(() => undefined);
                throw new Error(`Discord attachment download failed with HTTP ${response.status}`);
            }

            const content = await readLimitedResponse(response, maxBytes);
            return {
                content,
                extension: detectAttachmentContent(extension, content, response.headers.get("content-type") ?? "")
            };
        }
        throw new Error("Attachment redirected too many times");
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

interface OperationWaiter {
    resolve(release: () => void): void;
    timer: ReturnType<typeof setTimeout>;
}

export class BoundedOperationLimiter {
    private active = 0;
    private readonly waiters: OperationWaiter[] = [];

    constructor(private readonly maximumActive: number, private readonly maximumQueued: number) {
        if (!Number.isSafeInteger(maximumActive) || maximumActive < 1 || !Number.isSafeInteger(maximumQueued) || maximumQueued < 0)
            throw new Error("Invalid operation limiter configuration");
    }

    private release = () => {
        this.active--;
        const waiter = this.waiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.active++;
        waiter.resolve(this.release);
    };

    private acquire(deadline: number): Promise<() => void> {
        if (this.active < this.maximumActive) {
            this.active++;
            return Promise.resolve(this.release);
        }
        if (this.waiters.length >= this.maximumQueued) return Promise.reject(new Error("Too many attachment operations are queued"));
        const remaining = Math.floor(deadline - Date.now());
        if (remaining <= 0) return Promise.reject(new Error("Attachment operation timed out while queued"));

        return new Promise((resolve, reject) => {
            const waiter: OperationWaiter = {
                resolve,
                timer: setTimeout(() => {
                    const index = this.waiters.indexOf(waiter);
                    if (index !== -1) this.waiters.splice(index, 1);
                    reject(new Error("Attachment operation timed out while queued"));
                }, remaining)
            };
            this.waiters.push(waiter);
        });
    }

    async run<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
        const release = await this.acquire(deadline);
        try {
            return await operation();
        } finally {
            release();
        }
    }
}
