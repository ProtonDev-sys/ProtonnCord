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
    if (parsed.protocol !== "https:" || (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net"))
        throw new Error("Blocked an untrusted voice-message URL");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);

    const contentLength = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024)
        throw new Error("Voice message exceeds the 25 MB transcription limit");

    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength > 25 * 1024 * 1024)
        throw new Error("Voice message exceeds the 25 MB transcription limit");
    if (!isRecognizedAudioContainer(audio))
        throw new Error("Discord returned an unsupported or invalid audio file");

    return audio;
}
