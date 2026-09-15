/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { isRecognizedAudioContainer } from "./audioValidation";

// we love CORS
export async function fetchAudio(_: IpcMainInvokeEvent, url: string): Promise<Uint8Array> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net"))
        throw new Error("Blocked an untrusted voice-message URL");

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);

    const contentLength = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024)
        throw new Error("Voice message exceeds the 25 MB transcription limit");

    if (!res.body) throw new Error("Voice message response has no body");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 25 * 1024 * 1024) throw new Error("Voice message exceeds the 25 MB transcription limit");
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const audio = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
    if (!isRecognizedAudioContainer(audio))
        throw new Error("Discord returned an unsupported or invalid audio file");

    return audio;
}
