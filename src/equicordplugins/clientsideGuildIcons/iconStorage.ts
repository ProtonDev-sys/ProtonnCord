/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface NormalizedGuildIcons {
    icons: Record<string, Blob>;
    needsWrite: boolean;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
    apng: "image/apng",
    avif: "image/avif",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
};

export function normalizeGuildIconFile(file: File): Blob | null {
    if (file.type.startsWith("image/")) return file;
    const extension = file.name.match(/\.(apng|avif|gif|jpe?g|png|webp)$/i)?.[1].toLowerCase();
    return extension ? file.slice(0, file.size, IMAGE_MIME_TYPES[extension]) : null;
}

export async function normalizeStoredGuildIcon(value: unknown): Promise<Blob | null> {
    if (value instanceof File) return normalizeGuildIconFile(value);
    if (value instanceof Blob) return value.type.startsWith("image/") ? value : null;
    if (typeof value !== "string" || !value.startsWith("data:image/")) return null;

    try {
        const blob = await fetch(value).then(response => response.blob());
        return blob.type.startsWith("image/") ? blob : null;
    } catch {
        return null;
    }
}

export async function normalizeStoredGuildIcons(value: unknown): Promise<NormalizedGuildIcons> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { icons: {}, needsWrite: value != null };
    }

    const icons: Record<string, Blob> = {};
    let needsWrite = false;

    for (const [guildId, storedIcon] of Object.entries(value)) {
        const icon = await normalizeStoredGuildIcon(storedIcon);
        if (icon) icons[guildId] = icon;
        if (!icon || icon !== storedIcon) needsWrite = true;
    }

    return { icons, needsWrite };
}
