/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SoundOverride } from "./types";

const reservedIds = new Set(["enabled", "isFavorite", "overrides", "__proto__", "constructor", "prototype"]);

export function parseImportedOverrides(text: string): { id: string; override: SoundOverride; }[] {
    const imported = JSON.parse(text);
    if (!imported || !Array.isArray(imported.overrides)) throw new Error("Expected a sound overrides array.");

    return imported.overrides.map((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid sound override.");
        const { id, enabled = false, selectedSound = "default", selectedFileId, volume = 100, ...extra } = entry as Record<string, unknown>;
        if (typeof id !== "string" || !id.trim() || reservedIds.has(id)) throw new Error("Invalid sound identifier.");
        if (typeof enabled !== "boolean" || typeof selectedSound !== "string"
            || (selectedFileId != null && typeof selectedFileId !== "string")
            || typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) {
            throw new Error(`Invalid override for ${id}.`);
        }

        return { id, override: { ...extra, enabled, selectedSound, selectedFileId: selectedFileId ?? undefined, volume, useFile: false } };
    });
}
