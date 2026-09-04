/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadFFmpeg } from "@utils/ffmpeg";

let ffmpeg: FFmpeg | null = null;
let ffmpegLoaded = false;
let ffmpegLoading: Promise<FFmpeg> | null = null;
let conversionCounter = 0;

async function getFFmpeg(): Promise<FFmpeg> {
    if (ffmpegLoaded && ffmpeg) {
        return ffmpeg;
    }

    if (ffmpegLoading) {
        return ffmpegLoading;
    }

    ffmpegLoading = (async () => {
        ffmpeg = new FFmpeg();

        await loadFFmpeg(ffmpeg);

        ffmpegLoaded = true;

        return ffmpeg;
    })();

    return ffmpegLoading;
}

export async function convertApngToGif(blob: Blob): Promise<Blob | null> {
    const id = conversionCounter++;
    const inputFilename = `input_${id}.png`;
    const outputFilename = `output_${id}.gif`;

    try {
        const ff = await getFFmpeg();

        const arrayBuffer = await blob.arrayBuffer();
        await ff.writeFile(inputFilename, new Uint8Array(arrayBuffer));

        await ff.exec([
            "-i", inputFilename,
            "-filter_complex", "split[s0][s1];[s0]palettegen=stats_mode=single:transparency_color=000000[p];[s1][p]paletteuse=new=1:alpha_threshold=10",
            outputFilename
        ]);

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
            const ff = ffmpeg;
            if (ff) {
                await ff.deleteFile(inputFilename);
                await ff.deleteFile(outputFilename);
            }
        } catch {
            // ignore cleanup errors ;P
        }
    }
}
