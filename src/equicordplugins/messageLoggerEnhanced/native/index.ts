/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { opendir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { dialog, IpcMainInvokeEvent, shell } from "electron";

import { getSettings, updateSettings } from "./settings";
export * from "./export";
export * from "./import";

import { blockedExts } from "../list";
import { LoggedAttachment } from "../types";
import { DEFAULT_ATTACHMENT_FILE_EXTENSIONS, LOGS_DATA_FILENAME } from "../utils/constants";
import {
    assertAttachmentContent,
    ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    BoundedOperationLimiter,
    fetchDiscordAttachment,
    isSupportedAttachmentExtension,
    isTrustedDiscordRendererEvent,
    MAX_ATTACHMENT_DOWNLOAD_BYTES,
    MAX_IMAGE_CACHE_BYTES,
    MAX_IMAGE_CACHE_ENTRIES,
    normalizeAttachmentSizeLimitMegabytes,
    parseAllowedAttachmentExtensions,
    validateDiscordAttachmentUrl
} from "./attachmentDownload";
import {
    createImageCacheFile,
    getBoundedImageCacheFileSize,
    normalizeAttachmentExtension,
    normalizeAttachmentId,
    parseImageCacheFilename,
    readBoundedImageCacheFile
} from "./cacheFile";
import { ensureDirectoryExists } from "./utils";

export function messageLoggerEnhancedUniqueIdThingyIdkMan() { }

const nativeSavedImages = new Map<string, string>();
const inFlightDownloads = new Map<string, Promise<DownloadAttachmentResult>>();
const downloadLimiter = new BoundedOperationLimiter(2, 32);
const cacheReadLimiter = new BoundedOperationLimiter(2, 32);
let cacheOperationQueue: Promise<void> = Promise.resolve();
let cacheGeneration = 0;
let initPromise: Promise<void> | null = null;

interface DownloadAttachmentResult {
    error: string | null;
    path: string | null;
}

let logsDir: string;
let imageCacheDir: string;

async function initDirs() {
    const { logsDir: ld, imageCacheDir: icd } = await getSettings();

    logsDir = ld || await getDefaultNativeDataDir();
    imageCacheDir = icd || await getDefaultNativeImageDir();
}
const dirsReady = initDirs().catch(() => undefined);
const getImageCacheDir = async () => {
    await dirsReady;
    return imageCacheDir ?? await getDefaultNativeImageDir();
};
const getLogsDir = async () => {
    await dirsReady;
    return logsDir ?? await getDefaultNativeDataDir();
};

export async function getSettingsNative(event: IpcMainInvokeEvent) {
    if (!isTrustedDiscordRendererEvent(event)) throw new Error("Untrusted settings request");
    return getSettings();
}

function runCacheOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = cacheOperationQueue.then(operation, operation);
    cacheOperationQueue = result.then(() => undefined, () => undefined);
    return result;
}

export async function init(event: IpcMainInvokeEvent) {
    if (!isTrustedDiscordRendererEvent(event)) return;
    if (initPromise) return initPromise;
    initPromise = runCacheOperation(async () => {
        const imageDir = await getImageCacheDir();
        await replaceImageCacheIndex(imageDir);
    }).finally(() => initPromise = null);
    return initPromise;
}

async function replaceImageCacheIndex(imageDir: string): Promise<void> {
    await ensureDirectoryExists(imageDir);
    const canonicalImageDir = await realpath(imageDir);
    const indexedImages = new Map<string, string>();
    let indexedBytes = 0;
    let indexedEntries = 0;
    let scannedEntries = 0;
    for await (const file of await opendir(canonicalImageDir)) {
        scannedEntries++;
        if (scannedEntries > MAX_IMAGE_CACHE_ENTRIES * 2) break;
        if (!file.isFile()) continue;
        const parsed = parseImageCacheFilename(file.name);
        if (!parsed || !isSupportedAttachmentExtension(parsed.extension)) continue;
        const imagePath = path.join(canonicalImageDir, file.name);
        if (indexedImages.has(parsed.attachmentId) || indexedEntries >= MAX_IMAGE_CACHE_ENTRIES) {
            await unlink(imagePath).catch(() => undefined);
            continue;
        }
        try {
            const fileSize = await getBoundedImageCacheFileSize(imagePath, MAX_ATTACHMENT_DOWNLOAD_BYTES);
            if (fileSize > MAX_IMAGE_CACHE_BYTES - indexedBytes) {
                await unlink(imagePath).catch(() => undefined);
                continue;
            }
            indexedImages.set(parsed.attachmentId, imagePath);
            indexedBytes += fileSize;
            indexedEntries++;
        } catch {
            await unlink(imagePath).catch(() => undefined);
        }
    }
    nativeSavedImages.clear();
    for (const entry of indexedImages) nativeSavedImages.set(...entry);
}

async function readValidatedCachedImage(attachmentId: string, removeInvalid = false): Promise<Buffer | null> {
    const imagePath = nativeSavedImages.get(attachmentId);
    if (!imagePath) return null;
    const generation = cacheGeneration;
    try {
        const parsed = parseImageCacheFilename(path.basename(imagePath));
        if (!parsed || parsed.attachmentId !== attachmentId || !isSupportedAttachmentExtension(parsed.extension))
            throw new Error("Invalid cached attachment path");
        const content = await readBoundedImageCacheFile(imagePath, MAX_ATTACHMENT_DOWNLOAD_BYTES);
        assertAttachmentContent(parsed.extension, content);
        if (generation !== cacheGeneration || nativeSavedImages.get(attachmentId) !== imagePath) return null;
        return content;
    } catch {
        if (nativeSavedImages.get(attachmentId) === imagePath) nativeSavedImages.delete(attachmentId);
        if (removeInvalid) await unlink(imagePath).catch(() => undefined);
        return null;
    }
}

export async function getImageNative(event: IpcMainInvokeEvent, attachmentId: string): Promise<Uint8Array | Buffer | null> {
    if (!isTrustedDiscordRendererEvent(event)) return null;
    try {
        attachmentId = normalizeAttachmentId(attachmentId);
    } catch {
        return null;
    }
    try {
        return await cacheReadLimiter.run(
            Date.now() + ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
            () => runCacheOperation(() => readValidatedCachedImage(attachmentId, true))
        );
    } catch {
        return null;
    }
}

export async function deleteFileNative(event: IpcMainInvokeEvent, attachmentId: string) {
    if (!isTrustedDiscordRendererEvent(event)) return;
    try {
        attachmentId = normalizeAttachmentId(attachmentId);
    } catch {
        return;
    }
    await runCacheOperation(async () => {
        const imagePath = nativeSavedImages.get(attachmentId);
        if (!imagePath) return;
        await unlink(imagePath);
        if (nativeSavedImages.get(attachmentId) === imagePath) nativeSavedImages.delete(attachmentId);
    });
}

export async function writeLogs(_event: IpcMainInvokeEvent, contents: string) {
    const logsDir = await getLogsDir();

    writeFile(path.join(logsDir, LOGS_DATA_FILENAME), contents);
}

export async function getDefaultNativeImageDir(): Promise<string> {
    return path.join(await getDefaultNativeDataDir(), "savedImages");
}

export async function getDefaultNativeDataDir(): Promise<string> {
    return path.join(DATA_DIR, "MessageLoggerData");
}

export async function getDefaultAttachmentFileExtensions(): Promise<string> {
    return DEFAULT_ATTACHMENT_FILE_EXTENSIONS;
}

export async function chooseDir(event: IpcMainInvokeEvent, logKey: "logsDir" | "imageCacheDir") {
    if (!isTrustedDiscordRendererEvent(event)) throw new Error("Untrusted directory settings request");
    if (logKey !== "logsDir" && logKey !== "imageCacheDir") throw new Error("Invalid directory setting");
    const settings = await getSettings();
    const defaultPath = settings[logKey] || await getDefaultNativeDataDir();

    const res = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: defaultPath });
    const dir = res.filePaths[0];

    if (!dir) throw Error("Invalid Directory");

    await updateSettings({ [logKey]: dir });

    if (logKey === "logsDir") {
        logsDir = dir;
    } else {
        await runCacheOperation(async () => {
            imageCacheDir = dir;
            cacheGeneration++;
            nativeSavedImages.clear();
            await replaceImageCacheIndex(dir);
        });
    }

    return dir;
}

export async function showItemInFolder(_event: IpcMainInvokeEvent) {
    shell.showItemInFolder(await getImageCacheDir());
}

export async function chooseFile(_event: IpcMainInvokeEvent, title: string, filters: Electron.FileFilter[], defaultPath?: string) {
    const res = await dialog.showOpenDialog({ title, filters, properties: ["openFile"], defaultPath });
    const [path] = res.filePaths;

    if (!path) throw Error("Invalid file");

    return await readFile(path, "utf-8");
}

async function performAttachmentDownload(
    attachmentId: string,
    cleanExt: string,
    candidateUrls: URL[],
    allowedExtensions: readonly string[],
    maxBytes: number,
    deadline: number
): Promise<DownloadAttachmentResult> {
    const existingImage = await runCacheOperation(async () => {
        const imagePath = nativeSavedImages.get(attachmentId);
        if (!imagePath) return null;
        if (await readValidatedCachedImage(attachmentId, true)) return imagePath;
        nativeSavedImages.delete(attachmentId);
        await unlink(imagePath).catch(() => undefined);
        return null;
    });
    if (existingImage) return { error: null, path: existingImage };

    let lastError: unknown = new Error("Discord attachment download failed");
    for (const candidateUrl of candidateUrls) {
        try {
            const { content, extension } = await fetchDiscordAttachment(candidateUrl, attachmentId, cleanExt, { deadline, maxBytes });
            if (!allowedExtensions.includes(extension))
                throw new Error(`Returned file type .${extension} is blocked by settings configurations.`);
            const finalPath = await runCacheOperation(async () => {
                const generation = cacheGeneration;
                const cacheDir = await getImageCacheDir();
                const result = await createImageCacheFile(cacheDir, attachmentId, extension, content, {
                    maxBytes: MAX_IMAGE_CACHE_BYTES,
                    maxEntries: MAX_IMAGE_CACHE_ENTRIES
                });
                if (generation !== cacheGeneration || cacheDir !== await getImageCacheDir()) {
                    await unlink(result).catch(() => undefined);
                    throw new Error("Image cache directory changed during attachment download");
                }
                nativeSavedImages.set(attachmentId, result);
                return result;
            });
            return { error: null, path: finalPath };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

export async function downloadAttachment(event: IpcMainInvokeEvent, attachment: LoggedAttachment): Promise<DownloadAttachmentResult> {
    try {
        if (!isTrustedDiscordRendererEvent(event)) return { error: "Untrusted attachment request", path: null };
        if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)
            || typeof attachment.url !== "string" || typeof attachment.oldUrl !== "string" || typeof attachment.id !== "string"
            || !Number.isSafeInteger(attachment.size) || attachment.size < 1)
            return { error: "Invalid Attachment", path: null };

        if (typeof attachment.fileExtension !== "string" || attachment.fileExtension.length > 17)
            return { error: "Invalid attachment filename", path: null };

        let attachmentId: string;
        let cleanExt: string;
        try {
            attachmentId = normalizeAttachmentId(attachment.id);
            cleanExt = normalizeAttachmentExtension(attachment.fileExtension);
        } catch {
            return { error: "Invalid attachment filename", path: null };
        }

        if (!isSupportedAttachmentExtension(cleanExt))
            return { error: `File type .${cleanExt} is not a supported media format.`, path: null };

        let candidateUrls: URL[];
        try {
            candidateUrls = [...new Map([
                validateDiscordAttachmentUrl(attachment.url, attachmentId),
                validateDiscordAttachmentUrl(attachment.oldUrl, attachmentId)
            ].map(url => [url.href, url])).values()];
        } catch {
            return { error: "Invalid Discord attachment URL", path: null };
        }

        const existingDownload = inFlightDownloads.get(attachmentId);
        if (existingDownload) return existingDownload;

        const deadline = Date.now() + ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
        const download = downloadLimiter.run(deadline, async () => {
            const settings = await getSettings();
            const attachmentSizeLimitMegabytes = normalizeAttachmentSizeLimitMegabytes(settings.attachmentSizeLimitInMegabytes);
            const configuredMaxBytes = attachmentSizeLimitMegabytes * 1024 * 1024;
            if (attachment.size > configuredMaxBytes)
                return { error: `Attachment exceeds the configured ${attachmentSizeLimitMegabytes} MB size limit.`, path: null };
            const allowedList = parseAllowedAttachmentExtensions(settings.attachmentFileExtensions)
                .filter(extension => !blockedExts.includes(extension));
            if (allowedList.length === 0)
                return { error: "All attachment downloads are currently blocked by settings configurations.", path: null };
            if (!allowedList.includes(cleanExt))
                return { error: `File type .${cleanExt} is blocked by settings configurations.`, path: null };
            return performAttachmentDownload(attachmentId, cleanExt, candidateUrls, allowedList, configuredMaxBytes, deadline);
        });
        inFlightDownloads.set(attachmentId, download);
        try {
            return await download;
        } finally {
            if (inFlightDownloads.get(attachmentId) === download) inFlightDownloads.delete(attachmentId);
        }

    } catch (error: any) {
        return { error: error instanceof Error ? error.message : "Attachment download failed", path: null };
    }
}

export async function updateAllowedExtensions(event: IpcMainInvokeEvent, cleanExtensionsString: string | undefined) {
    if (!isTrustedDiscordRendererEvent(event)) throw new Error("Untrusted attachment settings request");
    const validatedExtensions = parseAllowedAttachmentExtensions(cleanExtensionsString)
        .filter(extension => !blockedExts.includes(extension));
    await updateSettings({ attachmentFileExtensions: validatedExtensions.join(",") || "none" });
}

export async function updateAttachmentSizeLimit(event: IpcMainInvokeEvent, value: unknown): Promise<number> {
    if (!isTrustedDiscordRendererEvent(event)) throw new Error("Untrusted attachment settings request");
    const normalized = normalizeAttachmentSizeLimitMegabytes(value);
    await updateSettings({ attachmentSizeLimitInMegabytes: normalized });
    return normalized;
}
