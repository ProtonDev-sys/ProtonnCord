/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { FileHandle, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import { dialog, IpcMainInvokeEvent } from "electron";

import { LogSessionStore } from "./logSessions";

interface ImportFile {
    handle: FileHandle;
    decoder: StringDecoder;
    busy: boolean;
}

const activeFiles = new LogSessionStore<ImportFile>(file => file.handle.close());
const MAX_CHUNK_BYTES = 1024 * 1024;

export async function startNativeLogImport(event: IpcMainInvokeEvent, defaultPath?: string) {
    const release = activeFiles.reserve(event);
    try {
        if (defaultPath !== undefined && (typeof defaultPath !== "string" || defaultPath.length > 32_768))
            throw new Error("Invalid import directory");
        const res = await dialog.showOpenDialog({
        title: "Import Logs",
        filters: [{ name: "Logs", extensions: ["json"] }],
        properties: ["openFile"],
        defaultPath
        });
        const [path] = res.filePaths;

        if (res.canceled || !path) throw Error("No file selected");

        const fileHandle = await open(path, "r");
        try {
            if (!(await fileHandle.stat()).isFile()) throw new Error("Import must be a regular file");
            const fileId = randomUUID();
            activeFiles.add(event, fileId, { handle: fileHandle, decoder: new StringDecoder("utf8"), busy: false });
            return fileId;
        } catch (error) {
            await fileHandle.close().catch(() => undefined);
            throw error;
        }
    } finally {
        release();
    }
}

export async function readNativeLogChunk(event: IpcMainInvokeEvent, fileId: string, size: number = 64 * 1024): Promise<string | null> {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CHUNK_BYTES) throw new Error("Invalid log chunk size");
    const file = activeFiles.get(event, fileId);
    if (!file) return null;
    if (file.busy) throw new Error("Log file read already in progress");
    file.busy = true;
    try {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await file.handle.read(buffer, 0, size);
        if (bytesRead === 0) {
            const tail = file.decoder.end();
            await closeNativeLogImport(event, fileId);
            return tail || null;
        }
        return file.decoder.write(buffer.subarray(0, bytesRead));
    } catch (error) {
        await closeNativeLogImport(event, fileId).catch(() => undefined);
        throw error;
    } finally {
        file.busy = false;
    }
}

export async function closeNativeLogImport(event: IpcMainInvokeEvent, fileId: string) {
    const file = activeFiles.take(event, fileId);
    await file?.handle.close();
}
