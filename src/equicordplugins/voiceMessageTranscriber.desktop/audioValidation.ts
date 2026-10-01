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

export const MAX_AUDIO_SAMPLES = 16_000 * 600;

export function encodePhononAudio(audio: Float32Array): Uint8Array {
    if (!(audio instanceof Float32Array) || !audio.length || audio.length > MAX_AUDIO_SAMPLES)
        throw new Error("Phonon-2 requires between one sample and ten minutes of 16 kHz mono audio");
    const bytes = new Uint8Array(44 + audio.length * 2);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF"));
    view.setUint32(4, bytes.length - 8, true);
    bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    bytes.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, audio.length * 2, true);
    for (let index = 0; index < audio.length; index++) {
        if (!Number.isFinite(audio[index])) throw new Error("Audio contains invalid samples");
        const sample = Math.max(-1, Math.min(1, audio[index]));
        view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return bytes;
}
