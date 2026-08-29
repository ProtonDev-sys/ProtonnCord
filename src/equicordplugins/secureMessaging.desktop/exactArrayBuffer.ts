/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
    const { buffer, byteLength, byteOffset } = value;
    if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) return buffer;

    const copy = new Uint8Array(byteLength);
    copy.set(value);
    return copy.buffer;
}
