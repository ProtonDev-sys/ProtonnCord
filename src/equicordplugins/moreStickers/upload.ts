/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { _handlePreSend, type MessageContentOptions, type MessageObject, type SendMessageOptions, type SendMessageProps } from "@api/MessageEvents";
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { ChannelStore, CloudUploader, DraftStore, FluxDispatcher, MessageActions, PendingReplyStore, SelectedChannelStore, UploadHandler, UserStore } from "@webpack/common";

import { settings } from ".";
import { FFmpegState, Sticker } from "./types";
import { corsFetch } from "./utils";

type SendStickerOptions = {
    channelId: string;
    sticker: Sticker;
    ctrlKey: boolean;
    shiftKey: boolean;
    ffmpegState?: FFmpegState;
};

let generation = 0;
let active = false;
const workers = new Set<FFmpeg>();
const conversionQueues = new WeakMap<FFmpeg, Promise<unknown>>();

export function startStickerUploads() { active = true; generation++; }
export function stopStickerUploads() {
    active = false;
    generation++;
    for (const worker of workers) {
        try { worker.terminate(); } catch { }
    }
    workers.clear();
}
export function registerStickerWorker(worker: FFmpeg) {
    workers.add(worker);
    return () => {
        workers.delete(worker);
        try { worker.terminate(); } catch { }
    };
}
export function isStickerWorkerCurrent(worker: FFmpeg) { return active && workers.has(worker); }

async function resizeImage(url: string) {
    const originalImage = new Image();
    originalImage.crossOrigin = "anonymous"; // If the image is hosted on a different domain, enable CORS

    const loadImage = new Promise((resolve, reject) => {
        originalImage.onload = resolve;
        originalImage.onerror = reject;
        originalImage.src = url;
    });

    await loadImage;
    if (!originalImage.width || !originalImage.height) throw new Error("Invalid sticker dimensions");

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context");

    // Determine the target size of the processed image (160x160)
    const targetSize = 160;

    // Calculate the scale factor to resize the image
    const scaleFactor = Math.min(targetSize / originalImage.width, targetSize / originalImage.height);

    // Calculate the dimensions for resizing the image while maintaining aspect ratio
    const resizedWidth = originalImage.width * scaleFactor;
    const resizedHeight = originalImage.height * scaleFactor;

    // Set the canvas size to the target dimensions
    canvas.width = targetSize;
    canvas.height = targetSize;

    // Draw the resized image onto the canvas
    ctx.drawImage(originalImage, 0, 0, resizedWidth, resizedHeight);

    // Convert the canvas to a Blob
    const blob: Blob | null = await new Promise(resolve => {
        canvas.toBlob(resolve, "image/png");
    });
    if (!blob) throw new Error("Could not convert canvas to blob");

    // return the object URL representing the Blob
    return blob;
}

async function toGIF(url: string, ffmpeg: FFmpeg): Promise<File> {
    const token = crypto.randomUUID();
    const filename = `${token}.input`;
    const res = await corsFetch(url);
    if (!res.ok) throw new Error("Failed to fetch image for GIF conversion");
    const arr = new Uint8Array(await res.arrayBuffer());
    const outputFilename = `${token}.gif`;
    try {
        await ffmpeg.writeFile(filename, arr);
        const status = await ffmpeg.exec(["-i", filename,
        "-filter_complex", `split[s0][s1];
        [s0]palettegen=
          stats_mode=single:
          transparency_color=000000[p];
        [s1][p]paletteuse=
          new=1:
          alpha_threshold=10`,
            outputFilename]);
        if (status !== 0) throw new Error("Could not convert sticker to GIF");

        const data = await ffmpeg.readFile(outputFilename);
        if (typeof data === "string") throw new Error("Could not read file");

        const uint8 = new Uint8Array(data.length);
        uint8.set(data);

        return new File([uint8], "sticker.gif", { type: "image/gif" });
    } finally {
        await Promise.allSettled([filename, outputFilename].map(name => Promise.resolve().then(() => ffmpeg.deleteFile(name))));
    }
}

export async function sendSticker({ channelId, sticker, ctrlKey, shiftKey, ffmpegState }: SendStickerOptions): Promise<boolean> {
    const currentGeneration = generation;
    const accountId = UserStore.getCurrentUser()?.id;
    const isCurrent = () => active && currentGeneration === generation && !!accountId
        && UserStore.getCurrentUser()?.id === accountId && SelectedChannelStore.getChannelId() === channelId;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel || !isCurrent()) return false;
    const reply = PendingReplyStore.getPendingReply(channelId);
    const draft = DraftStore.getDraft(channelId, 0) ?? "";
    let file: File | undefined;

    if (shiftKey && ctrlKey) {
        insertTextIntoChatInputBox((draft && !/\s$/.test(draft) ? " " : "") + sticker.image);
        return true;
    }

    if (!shiftKey && sticker.isAnimated) {
        if (!ffmpegState?.ffmpeg || !ffmpegState.isLoaded) throw new Error("FFmpeg not ready");
        const worker = ffmpegState.ffmpeg;
        const conversion = (conversionQueues.get(worker) ?? Promise.resolve()).catch(() => undefined).then(() => {
            if (!isCurrent()) throw new Error("Sticker upload cancelled");
            return toGIF(sticker.image, worker);
        });
        conversionQueues.set(worker, conversion);
        file = await conversion;
    } else if (!shiftKey) {
        const res = await corsFetch(sticker.image);
        if (!res.ok) throw new Error("Failed to fetch sticker image");
        const blobUrl = URL.createObjectURL(await res.blob());
        try {
            const processed = await resizeImage(blobUrl);
            const sourceName = sticker.filename ?? new URL(sticker.image).pathname.split("/").pop() ?? "sticker";
            file = new File([processed], sourceName.replace(/\.[^.]*$/, "") + ".png", { type: "image/png" });
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }

    if (!isCurrent()) return false;
    if (file && (settings.store.promptToUpload || DraftStore.getDraft(channelId, 0))) {
        await UploadHandler.promptToUpload([file], channel, 0);
        return true;
    }
    const uploads = file ? [new CloudUploader({ file, platform: CloudUploadPlatform.WEB }, channelId)] : [];
    const content = shiftKey ? sticker.image : "";
    const message: MessageObject = { content, invalidEmojis: [], validNonShortcutEmojis: [], tts: false };
    const contentOptions: MessageContentOptions = { channelId, command: null, content, uploads };
    const options: SendMessageOptions = {
        ...contentOptions,
        ...(reply ? MessageActions.getSendMessageOptionsForReply(reply) ?? {} : {}),
        attachmentsToUpload: uploads,
        location: "MoreStickers", stickerIds: [], flags: 0,
    };
    const props: SendMessageProps = { channel, content, hasAttachments: !!file, hasStickers: false, openWarningPopout: () => undefined };
    if (await _handlePreSend(channelId, message, options, props, contentOptions) || !isCurrent()) return false;
    await MessageActions.sendMessage(channelId, message, true, options);
    if (reply && isCurrent() && PendingReplyStore.getPendingReply(channelId) === reply)
        FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
    return true;
}
