/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadFFmpeg } from "@utils/ffmpeg";
import { Logger } from "@utils/Logger";

const logger = new Logger("ClipUpload");

let ffmpeg: FFmpeg | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;
let conversionCounter = 0;
let generation = 0;

export function disposeFFmpeg() {
    generation++;
    ffmpeg?.terminate();
    ffmpeg = null;
    ffmpegLoading = null;
}

async function getFFmpeg() {
    if (ffmpeg?.loaded) return ffmpeg;
    if (ffmpegLoading) return ffmpegLoading;

    const loadGeneration = generation;
    ffmpegLoading = (async () => {
        const instance = new FFmpeg();
        ffmpeg = instance;
        try {
            await loadFFmpeg(instance);
            if (generation !== loadGeneration) throw new Error("Clip conversion canceled.");

            ffmpeg = instance;
            logger.info("FFmpeg loaded.");
            return instance;
        } catch (error) {
            instance.terminate();
            if (ffmpeg === instance) ffmpeg = null;
            throw error;
        } finally {
            if (generation === loadGeneration) ffmpegLoading = null;
        }
    })();

    return ffmpegLoading;
}

function getInputName(fileName: string, id: number) {
    return `input_${id}${fileName.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? ".video"}`;
}

export async function convertClipToMp4(file: File, fileName: string) {
    const id = conversionCounter++;
    const inputName = getInputName(file.name, id);
    const outputName = `output_${id}.mp4`;
    const ff = await getFFmpeg();

    try {
        await ff.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

        const exitCode = await ff.exec([
            "-i", inputName,
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-profile:v", "high",
            "-level:v", "4.0",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            outputName
        ]);

        if (exitCode !== 0) throw new Error("Couldn't convert the selected file.");

        const data = await ff.readFile(outputName);
        if (typeof data === "string") throw new Error("Couldn't read the converted file.");

        return new File([new Uint8Array(data)], fileName, { type: "video/mp4" });
    } finally {
        await Promise.all([
            ff.deleteFile(inputName).catch(() => undefined),
            ff.deleteFile(outputName).catch(() => undefined)
        ]);
    }
}
