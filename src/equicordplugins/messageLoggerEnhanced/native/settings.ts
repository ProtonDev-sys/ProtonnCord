/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getDefaultAttachmentFileExtensions, getDefaultNativeDataDir, getDefaultNativeImageDir } from ".";
import { attachmentSizeLimitMegabytesOrDefault, parseAllowedAttachmentExtensions } from "./attachmentDownload";
import { ensureDirectoryExists } from "./utils";

const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_DIRECTORY_PATH_LENGTH = 32_768;
let cachedSettings: MLSettings | null = null;
let settingsOperationQueue: Promise<void> = Promise.resolve();

export interface MLSettings {
    [key: string]: unknown;
    logsDir: string;
    imageCacheDir: string;
    attachmentFileExtensions?: string;
    attachmentSizeLimitInMegabytes?: number;
}

function runSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = settingsOperationQueue.then(operation, operation);
    settingsOperationQueue = result.then(() => undefined, () => undefined);
    return result;
}

async function normalizeSettings(value: Partial<MLSettings> | null | undefined): Promise<MLSettings> {
    if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value)))
        throw new Error("Invalid Message Logger settings object");
    const defaultLogsDir = await getDefaultNativeDataDir();
    const defaultImageCacheDir = await getDefaultNativeImageDir();
    const defaultExtensions = await getDefaultAttachmentFileExtensions();
    const normalizeDirectory = (candidate: unknown, fallback: string) =>
        typeof candidate === "string" && candidate.length >= 1 && candidate.length <= MAX_DIRECTORY_PATH_LENGTH
            ? candidate
            : fallback;
    const extensions = value?.attachmentFileExtensions === undefined
        ? defaultExtensions
        : parseAllowedAttachmentExtensions(value.attachmentFileExtensions).join(",") || "none";
    return {
        ...value,
        logsDir: normalizeDirectory(value?.logsDir, defaultLogsDir),
        imageCacheDir: normalizeDirectory(value?.imageCacheDir, defaultImageCacheDir),
        attachmentFileExtensions: extensions,
        attachmentSizeLimitInMegabytes: attachmentSizeLimitMegabytesOrDefault(value?.attachmentSizeLimitInMegabytes)
    };
}

async function readSettingsFile(): Promise<unknown> {
    const handle = await fs.open(await getSettingsFilePath(), "r");
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 2 || stats.size > MAX_SETTINGS_BYTES)
            throw new Error("Message Logger settings file exceeds its safe size");
        const content = Buffer.allocUnsafe(stats.size);
        let offset = 0;
        while (offset < content.byteLength) {
            const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
            if (bytesRead < 1) throw new Error("Message Logger settings file was truncated");
            offset += bytesRead;
        }
        if ((await handle.read(Buffer.allocUnsafe(1), 0, 1, content.byteLength)).bytesRead !== 0)
            throw new Error("Message Logger settings file grew while being read");
        const parsed = JSON.parse(content.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Message Logger settings object");
        return parsed;
    } finally {
        await handle.close();
    }
}

async function writeSettingsFile(settings: MLSettings): Promise<void> {
    const serialized = JSON.stringify(settings, null, 4);
    if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new Error("Message Logger settings exceed their safe size");
    const settingsPath = await getSettingsFilePath();
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await fs.rename(temporaryPath, settingsPath);
    } finally {
        await fs.unlink(temporaryPath).catch(() => undefined);
    }
}

export async function getSettings(): Promise<MLSettings> {
    return runSettingsOperation(async () => {
        if (cachedSettings) return structuredClone(cachedSettings);
        try {
            cachedSettings = await normalizeSettings(await readSettingsFile() as Partial<MLSettings>);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const defaults = await normalizeSettings(null);
            await writeSettingsFile(defaults);
            cachedSettings = defaults;
        }
        return structuredClone(cachedSettings);
    });
}

export async function updateSettings(update: Partial<MLSettings>): Promise<MLSettings> {
    return runSettingsOperation(async () => {
        if (!cachedSettings) {
            try {
                cachedSettings = await normalizeSettings(await readSettingsFile() as Partial<MLSettings>);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                cachedSettings = await normalizeSettings(null);
            }
        }

        const normalized = await normalizeSettings({ ...cachedSettings, ...update });
        await writeSettingsFile(normalized);
        cachedSettings = normalized;
        return structuredClone(normalized);
    });
}

async function getSettingsFilePath() {
    const MlDataDir = await getDefaultNativeDataDir();
    await ensureDirectoryExists(MlDataDir);
    return path.join(MlDataDir, "mlSettings.json");
}
