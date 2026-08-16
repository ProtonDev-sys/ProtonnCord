/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";

import {
    attachmentBundleRoot,
    type AttachmentMetadata,
    DETACHED_TEXT_FILENAME,
    DETACHED_TEXT_MIME_TYPE,
    encodedImageDimensions,
    encryptAttachmentBytes,
    encryptedAttachmentCiphertextSize,
    encryptedAttachmentFilename,
    generateAttachmentBundleMaterial,
    isValidAttachmentWaveform,
    MAX_ATTACHMENT_CIPHERTEXT_BYTES,
    MAX_ATTACHMENT_COUNT,
    MAX_DETACHED_TEXT_BYTES,
    MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES,
    type SecureStickerItem,
    serializeSecurePlaintext,
} from "./attachments";

interface MutableCloudUpload extends CloudUpload {
    allowOptimization: boolean;
    setFilename(value: string): void;
}

interface UploadSource {
    durationSecs: number | undefined;
    encryptedFile?: File;
    file: File;
    filename: string;
    mimeType: string;
    waveform: string | undefined;
}

interface UploadMediaMetadata {
    duration: number | null;
    height: number | null;
    width: number | null;
}

const uploadSources = new WeakMap<CloudUpload, UploadSource>();
const MEDIA_METADATA_TIMEOUT_MS = 5_000;

export interface PreparedEncryptedAttachments {
    apply(): void;
    files: Array<{ filename: string; size: number; }>;
    plaintext: string;
    totalUploadBytes: number;
}

export class EncryptedAttachmentUploadLimitError extends Error {
    constructor(
        public readonly filename: string,
        public readonly encryptedBytes: number,
        public readonly limitBytes: number,
    ) {
        super(`Encrypted attachment ${filename} requires ${encryptedBytes} bytes but Discord allows ${limitBytes}`);
        this.name = "EncryptedAttachmentUploadLimitError";
    }
}

function assertUpload(upload: CloudUpload): asserts upload is MutableCloudUpload {
    if (!upload || upload.status !== "NOT_STARTED" || upload.isThumbnail || upload.uploadedFilename || upload.responseUrl ||
        upload.item?.platform !== CloudUploadPlatform.WEB || !(upload.item.file instanceof File) || upload.item.file.size < 1)
        throw new Error("Secure Messaging can only encrypt attachments before Discord starts uploading them");
}

async function imageDimensions(file: File): Promise<{ height: number; width: number; } | null> {
    if (!file.type.startsWith("image/")) return null;
    const encoded = encodedImageDimensions(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()));
    if (encoded) return encoded;
    if (typeof createImageBitmap !== "function") return null;
    try {
        const bitmap = await createImageBitmap(file);
        try {
            if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 32_768 || bitmap.height > 32_768) return null;
            return { height: bitmap.height, width: bitmap.width };
        } finally {
            bitmap.close();
        }
    } catch {
        return null;
    }
}

function validDuration(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 604_800
        ? value
        : null;
}

function validMediaDuration(value: unknown): number | null {
    const duration = validDuration(value);
    return duration !== null && duration > 0 ? duration : null;
}

async function mediaMetadata(file: File): Promise<UploadMediaMetadata> {
    const dimensions = await imageDimensions(file);
    if (dimensions) return { ...dimensions, duration: null };
    const isVideo = file.type.startsWith("video/");
    if (!isVideo && !file.type.startsWith("audio/"))
        return { duration: null, height: null, width: null };

    const media = document.createElement(isVideo ? "video" : "audio");
    const video = isVideo ? media as HTMLVideoElement : null;
    media.preload = "auto";
    if (video) {
        video.muted = true;
        video.playsInline = true;
    }
    const url = URL.createObjectURL(file);
    return new Promise(resolve => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        let latest: UploadMediaMetadata = { duration: null, height: null, width: null };
        const finish = (result: UploadMediaMetadata) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            media.removeEventListener("durationchange", onMetadataAvailable);
            media.removeEventListener("loadeddata", onMetadataAvailable);
            media.removeEventListener("loadedmetadata", onLoadedMetadata);
            media.removeEventListener("seeked", onMetadataAvailable);
            media.removeEventListener("error", onError);
            media.removeAttribute("src");
            media.load();
            URL.revokeObjectURL(url);
            resolve(result);
        };
        const captureMetadata = () => {
            const width = video?.videoWidth ?? null;
            const height = video?.videoHeight ?? null;
            const validDimensions = width !== null && height !== null && Number.isInteger(width) && Number.isInteger(height) &&
                width >= 1 && height >= 1 && width <= 32_768 && height <= 32_768;
            latest = {
                duration: validMediaDuration(media.duration),
                height: validDimensions ? height : null,
                width: validDimensions ? width : null,
            };
            return latest;
        };
        const onMetadataAvailable = () => {
            const result = captureMetadata();
            if (result.duration !== null && (!video || result.width !== null)) finish(result);
        };
        const onLoadedMetadata = () => {
            onMetadataAvailable();
            if (settled || validMediaDuration(media.duration) !== null) return;
            try {
                // Chromium may report Infinity for duration-only WebM metadata until it seeks the local blob once.
                media.currentTime = 604_800;
            } catch {
                // The bounded metadata timer still returns authenticated dimensions if seeking is unsupported.
            }
        };
        const onError = () => finish(latest);
        media.addEventListener("durationchange", onMetadataAvailable);
        media.addEventListener("loadeddata", onMetadataAvailable);
        media.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
        media.addEventListener("seeked", onMetadataAvailable);
        media.addEventListener("error", onError, { once: true });
        timer = setTimeout(() => finish(captureMetadata()), MEDIA_METADATA_TIMEOUT_MS);
        media.src = url;
        media.load();
    });
}

function sourceForUpload(upload: CloudUpload): UploadSource {
    const currentFile = upload.item.file;
    const existing = uploadSources.get(upload);
    if (existing?.encryptedFile === currentFile) return existing;

    const source = {
        durationSecs: upload.durationSecs,
        file: currentFile,
        filename: upload.filename || currentFile.name,
        mimeType: currentFile.type || upload.mimeType || "application/octet-stream",
        waveform: upload.waveform,
    };
    uploadSources.set(upload, source);
    return source;
}

async function metadataForUpload(upload: CloudUpload, source: UploadSource): Promise<AttachmentMetadata> {
    const providedDuration = validMediaDuration(source.durationSecs);
    const metadata = providedDuration !== null && source.file.type.startsWith("audio/")
        ? { duration: providedDuration, height: null, width: null }
        : await mediaMetadata(source.file);
    return {
        name: source.filename,
        mimeType: source.mimeType,
        size: source.file.size,
        spoiler: upload.spoiler,
        description: upload.description,
        width: metadata.width,
        height: metadata.height,
        duration: providedDuration ?? metadata.duration,
        waveform: isValidAttachmentWaveform(source.waveform) ? source.waveform : null,
    };
}

export async function prepareEncryptedAttachments(
    uploads: CloudUpload[],
    text: string,
    channelId: string,
    senderUserId: string,
    stickers: SecureStickerItem[] = [],
    detachedTextIndex: number | null = null,
    maxEncryptedFileBytes = MAX_ATTACHMENT_CIPHERTEXT_BYTES,
): Promise<PreparedEncryptedAttachments> {
    if (uploads.length < 1 || uploads.length > MAX_ATTACHMENT_COUNT)
        throw new Error(`Secure Messaging supports 1 to ${MAX_ATTACHMENT_COUNT} attachments per message`);
    if (!Number.isSafeInteger(maxEncryptedFileBytes) || maxEncryptedFileBytes < 21 ||
        maxEncryptedFileBytes > MAX_ATTACHMENT_CIPHERTEXT_BYTES)
        throw new Error("Discord's encrypted attachment upload limit is invalid");
    for (const upload of uploads) assertUpload(upload);
    const sources = uploads.map(sourceForUpload);

    if (detachedTextIndex !== null && (!Number.isInteger(detachedTextIndex) ||
        detachedTextIndex < 0 || detachedTextIndex >= uploads.length || sources[detachedTextIndex].file.size > MAX_DETACHED_TEXT_BYTES))
        throw new Error("The encrypted message text attachment is invalid or too large");
    const metadata = await Promise.all(uploads.map((upload, index) => metadataForUpload(upload, sources[index])));
    if (detachedTextIndex !== null) {
        metadata[detachedTextIndex] = {
            name: DETACHED_TEXT_FILENAME,
            mimeType: DETACHED_TEXT_MIME_TYPE,
            size: sources[detachedTextIndex].file.size,
            spoiler: false,
            description: null,
            width: null,
            height: null,
            duration: null,
            waveform: null,
        };
    }
    const plannedSizes = metadata.map(encryptedAttachmentCiphertextSize);
    const oversizedIndex = plannedSizes.findIndex(size => size > maxEncryptedFileBytes);
    if (oversizedIndex !== -1)
        throw new EncryptedAttachmentUploadLimitError(
            metadata[oversizedIndex].name,
            plannedSizes[oversizedIndex],
            maxEncryptedFileBytes,
        );
    const totalUploadBytes = plannedSizes.reduce((total, size) => total + size, 0);
    if (!Number.isSafeInteger(totalUploadBytes) || totalUploadBytes > MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES)
        throw new Error("Secure Messaging encrypted attachments exceed the 500 MiB per-message safety limit");
    const { descriptor, keyBytes } = generateAttachmentBundleMaterial(uploads.length);
    const ciphertexts: Uint8Array[] = [];
    try {
        for (let index = 0; index < uploads.length; index++) {
            const upload = uploads[index];
            const source = sources[index];
            const plaintext = new Uint8Array(await source.file.arrayBuffer());
            try {
                ciphertexts.push(await encryptAttachmentBytes({
                    bundleId: descriptor.id,
                    channelId,
                    count: uploads.length,
                    data: plaintext,
                    index,
                    masterKey: keyBytes,
                    metadata: metadata[index],
                    senderUserId,
                }));
            } finally {
                plaintext.fill(0);
            }
        }

        const root = await attachmentBundleRoot(descriptor.id, ciphertexts);
        const replacements = ciphertexts.map((ciphertext, index) => {
            const filename = encryptedAttachmentFilename(descriptor.id, index);
            const encryptedFile = new File([Uint8Array.from(ciphertext).buffer], filename, {
                type: "application/octet-stream",
                lastModified: Date.now(),
            });
            return { encryptedFile, filename, upload: uploads[index] as MutableCloudUpload };
        });
        return {
            apply() {
                for (let index = 0; index < replacements.length; index++) {
                    const { encryptedFile, filename, upload } = replacements[index];
                    sources[index].encryptedFile = encryptedFile;
                    upload.item.file = encryptedFile;
                    upload.setFilename(filename);
                    upload.mimeType = encryptedFile.type;
                    upload.classification = "unknown";
                    upload.isImage = false;
                    upload.isVideo = false;
                    upload.allowOptimization = false;
                    upload.durationSecs = undefined;
                    upload.currentSize = encryptedFile.size;
                    upload.preCompressionSize = encryptedFile.size;
                    upload.postCompressionSize = undefined;
                    upload.waveform = undefined;
                }
            },
            files: replacements.map(({ encryptedFile, filename }) => ({ filename, size: encryptedFile.size })),
            plaintext: serializeSecurePlaintext(text, { ...descriptor, root }, stickers, detachedTextIndex),
            totalUploadBytes,
        };
    } finally {
        keyBytes.fill(0);
        for (const ciphertext of ciphertexts) ciphertext.fill(0);
    }
}
