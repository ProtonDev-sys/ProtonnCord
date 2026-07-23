/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
    return signature.every((value, index) => bytes[offset + index] === value);
}

export function detectAudioMimeType(bytes: Uint8Array): string | null {
    if (bytes.byteLength < 12) return null;
    if (matches(bytes, 0, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
    if (matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, 8, [0x57, 0x41, 0x56, 0x45])) return "audio/wav";
    if (matches(bytes, 0, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac";
    if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
    if (matches(bytes, 0, [0x49, 0x44, 0x33])) return "audio/mpeg";
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
    if (matches(bytes, 4, [0x66, 0x74, 0x79, 0x70])) return "audio/mp4";
    return null;
}

export function isRecognizedAudioContainer(bytes: Uint8Array): boolean {
    return detectAudioMimeType(bytes) !== null;
}
