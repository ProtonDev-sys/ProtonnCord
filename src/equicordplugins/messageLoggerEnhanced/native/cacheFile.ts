/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const ATTACHMENT_ID = /^\d{1,20}$/u;
const ATTACHMENT_EXTENSION = /^[a-z0-9]{1,16}$/u;

export interface ImageCacheFilename {
    attachmentId: string;
    extension: string;
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
    content: Uint8Array
): Promise<string> {
    if (!(content instanceof Uint8Array)) throw new TypeError("Invalid image cache content");
    const configuredPath = getImageCachePath(cacheDir, attachmentId, extension);
    const filename = path.basename(configuredPath);
    await mkdir(path.dirname(configuredPath), { recursive: true });
    const root = await realpath(path.dirname(configuredPath));
    const imagePath = path.resolve(root, filename);
    if (path.dirname(imagePath) !== root || path.basename(imagePath) !== filename) throw new Error("Image cache path escaped its root");
    await writeFile(imagePath, content, { flag: "wx" });
    return imagePath;
}
