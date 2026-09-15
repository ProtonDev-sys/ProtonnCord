/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadFFmpeg } from "@utils/ffmpeg";

let ffmpeg: FFmpeg | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;
let initializingFFmpeg: FFmpeg | null = null;
let ffmpegGeneration = 0;
let conversionCounter = 0;

export function stopApngConversion() {
    ffmpegGeneration++;
    ffmpeg?.terminate();
    initializingFFmpeg?.terminate();
    ffmpeg = null;
    initializingFFmpeg = null;
    ffmpegLoading = null;
}

async function getFFmpeg(): Promise<FFmpeg> {
    if (ffmpeg?.loaded) return ffmpeg;
    if (ffmpegLoading) return ffmpegLoading;

    const generation = ffmpegGeneration;
    ffmpegLoading = (async () => {
        const instance = new FFmpeg();
        initializingFFmpeg = instance;
        try {
            await loadFFmpeg(instance);
            if (generation !== ffmpegGeneration) throw new Error("APNG conversion was stopped");
            ffmpeg = instance;
            return instance;
        } catch (error) {
            instance.terminate();
            throw error;
        } finally {
            if (initializingFFmpeg === instance) initializingFFmpeg = null;
            if (generation === ffmpegGeneration) ffmpegLoading = null;
        }
    })();

    return ffmpegLoading;
}

export async function convertApngToGif(blob: Blob): Promise<Blob | null> {
    const id = conversionCounter++;
    const inputFilename = `input_${id}.png`;
    const outputFilename = `output_${id}.gif`;
    let ff: FFmpeg | null = null;

    try {
        ff = await getFFmpeg();

        const arrayBuffer = await blob.arrayBuffer();
        await ff.writeFile(inputFilename, new Uint8Array(arrayBuffer));

        const exitCode = await ff.exec([
            "-i", inputFilename,
            "-filter_complex", "split[s0][s1];[s0]palettegen=stats_mode=single:transparency_color=000000[p];[s1][p]paletteuse=new=1:alpha_threshold=10",
            outputFilename
        ]);
        if (exitCode !== 0) return null;

        const data = await ff.readFile(outputFilename);

        if (typeof data === "string") {
            console.error("[FileUpload] FFmpeg returned string instead of Uint8Array");
            return null;
        }

        return new Blob([new Uint8Array(data)], { type: "image/gif" });
    } catch (e) {
        console.error("[FileUpload] APNG to GIF conversion error:", e);
        return null;
    } finally {
        try {
            if (ff) {
                await Promise.allSettled([ff.deleteFile(inputFilename), ff.deleteFile(outputFilename)]);
            }
        } catch {
            // ignore cleanup errors ;P
        }
    }
}
