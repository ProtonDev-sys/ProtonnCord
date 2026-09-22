/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const encoder = new TextEncoder();

function truncateUtf8(value: string, maximumBytes: number): string {
    let result = "";
    let bytes = 0;
    for (const character of value) {
        const { length } = encoder.encode(character);
        if (bytes + length > maximumBytes) break;
        result += character;
        bytes += length;
    }
    return result;
}

export function safeDownloadFilename(value: string, duplicate = 0): string {
    let filename = value.normalize("NFC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
        .replace(/[. ]+$/gu, "");
    if (!filename || filename === "." || filename === "..") filename = "encrypted-attachment";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)) filename = `_${filename}`;

    // Separators were removed above; a leading dot alone is not an extension.
    const extensionIndex = filename.lastIndexOf(".");
    const rawExtension = extensionIndex > 0 ? filename.slice(extensionIndex) : "";
    const extension = truncateUtf8(rawExtension, 32);
    const stem = filename.slice(0, filename.length - rawExtension.length);
    const suffix = duplicate === 0 ? "" : ` (${duplicate})`;
    return `${truncateUtf8(stem, 220 - encoder.encode(extension).length - encoder.encode(suffix).length)}${suffix}${extension}`;
}
