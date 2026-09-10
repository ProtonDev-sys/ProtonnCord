/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, WriteStream } from "node:fs";

import { dialog, IpcMainInvokeEvent } from "electron";

import { LogSessionStore } from "./logSessions";

interface ExportStream {
    stream: WriteStream;
    busy: boolean;
    error?: Error;
}

const activeStreams = new LogSessionStore<ExportStream>(entry => { entry.stream.destroy(); });
const MAX_CHUNK_BYTES = 1024 * 1024;

export async function startNativeLogExport(event: IpcMainInvokeEvent, filename: string) {
    const release = activeStreams.reserve(event);
    try {
        if (filename !== undefined && (typeof filename !== "string" || filename.length > 32_768))
            throw new Error("Invalid export filename");
        const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath: filename ?? "message-logger-logs-idb.json",
        filters: [{ name: "JSON", extensions: ["json"] }]
        });

        if (canceled || !filePath) throw new Error("No file path selected");

        const stream = createWriteStream(filePath, { flags: "w", encoding: "utf-8", mode: 0o600 });
        const entry: ExportStream = { stream, busy: false };
        stream.on("error", error => { entry.error = error; });
        const streamId = randomUUID();
        try {
            activeStreams.add(event, streamId, entry);
            return streamId;
        } catch (error) {
            stream.destroy();
            throw error;
        }
    } finally {
        release();
    }
}

export async function writeNativeLogChunk(event: IpcMainInvokeEvent, streamId: string, chunk: string) {
    const entry = activeStreams.get(event, streamId);
    if (!entry) throw new Error("Stream not found or closed");
    if (typeof chunk !== "string" || Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) throw new Error("Invalid log chunk size");
    if (entry.error) throw entry.error;
    if (entry.busy) throw new Error("Log file write already in progress");
    entry.busy = true;
    try {
        await new Promise<void>((resolve, reject) => entry.stream.write(chunk, error => error ? reject(error) : resolve()));
    } finally {
        entry.busy = false;
    }
}

export async function finishNativeLogExport(event: IpcMainInvokeEvent, streamId: string) {
    const entry = activeStreams.get(event, streamId);
    if (!entry) throw new Error("Stream not found or closed");
    if (entry.busy) throw new Error("Log file write already in progress");
    activeStreams.take(event, streamId);
    if (entry.error) throw entry.error;
    return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        entry.stream.once("error", onError);
        entry.stream.end(() => {
            entry.stream.removeListener("error", onError);
            resolve();
        });
    });
}
