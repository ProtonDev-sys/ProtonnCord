/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

const ATTACHMENT_ID = /^\d{1,20}$/u;
const ATTACHMENT_EXTENSION = /^[a-z0-9]{1,16}$/u;

export interface ImageCacheFilename {
    attachmentId: string;
    extension: string;
}

export interface ImageCacheLimits {
    maxBytes: number;
    maxEntries: number;
}

let cacheWriteQueue: Promise<void> = Promise.resolve();

function runCacheWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = cacheWriteQueue.then(operation, operation);
    cacheWriteQueue = result.then(() => undefined, () => undefined);
    return result;
}

export function normalizeAttachmentId(attachmentId: unknown): string {
    if (typeof attachmentId !== "string" || !ATTACHMENT_ID.test(attachmentId) || BigInt(attachmentId) > 0xffffffffffffffffn) {
        throw new Error("Invalid attachment ID");
    }
    return attachmentId;
}

export function normalizeAttachmentExtension(extension: unknown): string {
    if (typeof extension !== "string") throw new Error("Invalid attachment extension");
    const normalized = (extension.startsWith(".") ? extension.slice(1) : extension).toLowerCase();
    if (!ATTACHMENT_EXTENSION.test(normalized)) throw new Error("Invalid attachment extension");
    return normalized;
}

export function parseImageCacheFilename(filename: unknown): ImageCacheFilename | null {
    if (typeof filename !== "string") return null;
    const separator = filename.lastIndexOf(".");
    if (separator <= 0 || separator === filename.length - 1) return null;

    try {
        const extension = filename.slice(separator + 1);
        const normalizedExtension = normalizeAttachmentExtension(extension);
        if (extension !== normalizedExtension) return null;
        return {
            attachmentId: normalizeAttachmentId(filename.slice(0, separator)),
            extension: normalizedExtension
        };
    } catch {
        return null;
    }
}

export function getImageCachePath(cacheDir: string, attachmentId: unknown, extension: unknown): string {
    if (typeof cacheDir !== "string" || !cacheDir) throw new Error("Invalid image cache directory");
    const root = path.resolve(cacheDir);
    const filename = `${normalizeAttachmentId(attachmentId)}.${normalizeAttachmentExtension(extension)}`;
    const imagePath = path.resolve(root, filename);
    if (path.dirname(imagePath) !== root || path.basename(imagePath) !== filename) throw new Error("Image cache path escaped its root");
    return imagePath;
}

export async function createImageCacheFile(
    cacheDir: string,
    attachmentId: unknown,
    extension: unknown,
    content: Uint8Array,
    limits?: ImageCacheLimits
): Promise<string> {
    if (!(content instanceof Uint8Array) || content.byteLength < 1) throw new TypeError("Invalid image cache content");
    if (limits && (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
        || !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1))
        throw new TypeError("Invalid image cache limits");
    const configuredPath = getImageCachePath(cacheDir, attachmentId, extension);
    const filename = path.basename(configuredPath);
    return runCacheWrite(async () => {
        await mkdir(path.dirname(configuredPath), { recursive: true });
        const root = await realpath(path.dirname(configuredPath));
        const imagePath = path.resolve(root, filename);
        if (path.dirname(imagePath) !== root || path.basename(imagePath) !== filename)
            throw new Error("Image cache path escaped its root");

        if (limits) {
            let cacheBytes = 0;
            let cacheEntries = 0;
            let scannedEntries = 0;
            for await (const entry of await opendir(root)) {
                scannedEntries++;
                if (scannedEntries > Math.min(100_000, limits.maxEntries * 2))
                    throw new Error("Image cache directory contains too many entries");
                if (!entry.isFile() || !parseImageCacheFilename(entry.name)) continue;
                const entryStats = await lstat(path.join(root, entry.name));
                if (!entryStats.isFile() || !Number.isSafeInteger(entryStats.size) || entryStats.size < 0)
                    throw new Error("Image cache contains an invalid file");
                cacheEntries++;
                if (entryStats.size > limits.maxBytes - cacheBytes) cacheBytes = limits.maxBytes + 1;
                else cacheBytes += entryStats.size;
            }
            if (cacheEntries >= limits.maxEntries) throw new Error("Image cache entry quota exceeded");
            if (cacheBytes > limits.maxBytes || content.byteLength > limits.maxBytes - cacheBytes)
                throw new Error("Image cache byte quota exceeded");
        }

        let handle;
        try {
            handle = await open(imagePath, "wx", 0o600);
            await handle.writeFile(content);
            await handle.sync();
            await handle.close();
            handle = undefined;
            return imagePath;
        } catch (error) {
            await handle?.close().catch(() => undefined);
            if (handle) await unlink(imagePath).catch(() => undefined);
            throw error;
        }
    });
}

export async function getBoundedImageCacheFileSize(imagePath: string, maxBytes: number): Promise<number> {
    if (typeof imagePath !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new TypeError("Invalid bounded cache read");
    const stats = await lstat(imagePath);
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maxBytes)
        throw new Error("Cached attachment exceeds its safe size");
    return stats.size;
}

export async function readBoundedImageCacheFile(imagePath: string, maxBytes: number): Promise<Buffer> {
    const initialStats = await lstat(imagePath);
    if (!initialStats.isFile() || !Number.isSafeInteger(initialStats.size) || initialStats.size < 1 || initialStats.size > maxBytes)
        throw new Error("Cached attachment exceeds its safe size");

    const handle = await open(imagePath, "r");
    try {
        const openedStats = await handle.stat();
        if (!openedStats.isFile() || openedStats.dev !== initialStats.dev || openedStats.ino !== initialStats.ino
            || openedStats.size !== initialStats.size)
            throw new Error("Cached attachment changed before it could be read");

        const content = Buffer.allocUnsafe(openedStats.size);
        let offset = 0;
        while (offset < content.byteLength) {
            const length = Math.min(1024 * 1024, content.byteLength - offset);
            const { bytesRead } = await handle.read(content, offset, length, offset);
            if (bytesRead < 1) throw new Error("Cached attachment was truncated");
            offset += bytesRead;
        }

        const trailing = Buffer.allocUnsafe(1);
        if ((await handle.read(trailing, 0, 1, content.byteLength)).bytesRead !== 0)
            throw new Error("Cached attachment grew while it was being read");
        const finalStats = await handle.stat();
        if (finalStats.size !== openedStats.size) throw new Error("Cached attachment changed while it was being read");
        return content;
    } finally {
        await handle.close();
    }
}
