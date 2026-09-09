/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { Logger } from "@utils/Logger";

const STORAGE_KEY = "ScattrdCustomSounds";
export const MAX_AUDIO_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_FILE_MIB = MAX_AUDIO_FILE_BYTES / 1024 / 1024;

const logger = new Logger("CustomSounds");

export interface StoredAudioFile {
    id: string;
    name: string;
    buffer?: ArrayBuffer;
    type: string;
    dataUri?: string;
}

let cachedAudioFiles: Record<string, StoredAudioFile> | null = null;
let audioFilesLoadPromise: Promise<Record<string, StoredAudioFile>> | null = null;
let audioFilesMutationQueue = Promise.resolve();

async function loadAudioFiles(): Promise<Record<string, StoredAudioFile>> {
    if (cachedAudioFiles) return cachedAudioFiles;

    audioFilesLoadPromise ??= get<Record<string, StoredAudioFile>>(STORAGE_KEY)
        .then(files => {
            cachedAudioFiles = files ?? {};
            return cachedAudioFiles;
        })
        .finally(() => {
            audioFilesLoadPromise = null;
        });

    return audioFilesLoadPromise;
}

function updateAudioFiles(update: (files: Record<string, StoredAudioFile>) => void) {
    const mutation = audioFilesMutationQueue.then(async () => {
        const files = { ...await loadAudioFiles() };
        update(files);
        await set(STORAGE_KEY, files);
        cachedAudioFiles = files;
    });
    audioFilesMutationQueue = mutation.catch(() => void 0);
    return mutation;
}

export async function saveAudio(file: File): Promise<string> {
    if (file.size > MAX_AUDIO_FILE_BYTES) {
        throw new Error(`Audio file is larger than ${MAX_AUDIO_FILE_MIB} MiB.`);
    }

    const id = crypto.randomUUID();
    const buffer = await file.arrayBuffer();

    const dataUri = await generateDataURI(buffer, file.type, file.name);

    await updateAudioFiles(current => {
        current[id] = { id, name: file.name, type: file.type, dataUri };
    });
    return id;
}

export async function getAllAudio(): Promise<Record<string, StoredAudioFile>> {
    return { ...await loadAudioFiles() };
}

async function generateDataURI(buffer: ArrayBuffer, type: string, name: string): Promise<string> {
    let mimeType = type;

    if (!mimeType || mimeType === "application/octet-stream") {
        const extension = name.split(".").pop()?.toLowerCase();
        switch (extension) {
            case "ogg": mimeType = "audio/ogg"; break;
            case "mp3": mimeType = "audio/mpeg"; break;
            case "wav": mimeType = "audio/wav"; break;
            case "m4a":
            case "mp4": mimeType = "audio/mp4"; break;
            case "flac": mimeType = "audio/flac"; break;
            case "aac": mimeType = "audio/aac"; break;
            case "webm": mimeType = "audio/webm"; break;
            case "wma": mimeType = "audio/x-ms-wma"; break;
            default: mimeType = "audio/mpeg";
        }
    }

    try {
        const uint8Array = new Uint8Array(buffer);
        const blob = new Blob([uint8Array], { type: mimeType });

        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        logger.error("Error generating data URI:", error);

        const uint8Array = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 8192;

        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.slice(i, i + chunkSize);
            binary += String.fromCharCode(...chunk);
        }

        const base64 = btoa(binary);
        return `data:${mimeType};base64,${base64}`;
    }
}

export async function getAudioDataURI(id: string): Promise<string | undefined> {
    const all = await getAllAudio();
    const entry = all[id];
    if (!entry) return undefined;

    if (entry.dataUri) {
        if (entry.buffer) {
            await updateAudioFiles(current => {
                if (current[id]?.buffer) {
                    const { buffer: _, ...entryWithoutBuffer } = current[id];
                    current[id] = entryWithoutBuffer;
                }
            });
        }

        return entry.dataUri;
    }

    if (!entry.buffer) return undefined;

    const dataUri = await generateDataURI(entry.buffer, entry.type, entry.name);

    await updateAudioFiles(current => {
        if (current[id]) {
            const { buffer: _, ...entryWithoutBuffer } = current[id];
            current[id] = { ...entryWithoutBuffer, dataUri };
        }
    });

    return dataUri;
}

export async function deleteAudio(id: string): Promise<void> {
    await updateAudioFiles(all => { delete all[id]; });
}
